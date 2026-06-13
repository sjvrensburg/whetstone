/**
 * Proactive (push) coaching cadence — instrument A (ADR-008, task 24).
 *
 * When the friction dial's `coachingCadence` instrument is set to "push", the
 * coach interjects at paragraph boundaries after an idle debounce — the Warren
 * model ("after each paragraph, a review"). Each push is consent-gated (it is
 * egress), rate-limited, dismissible, and easy to silence per-document or
 * per-session.
 *
 * The failure mode is the deadline-stressed writer abandoning the tool
 * (ADR-008 risk: friction → abandonment). Every design choice prioritises
 * unobtrusiveness:
 *   - Only fires on settled paragraph boundaries after an idle interval
 *   - Rate-limited so rapid successive paragraphs don't nag
 *   - Per-document and per-session silence controls
 *   - Dismiss cancels the pending push; next change resets
 *
 * Pure logic; no `vscode` import. The caller wires this into a document-change
 * observer and a timer, then surfaces results through the coaching view.
 */

import type { CoachingCadenceState } from './presets';
import type { ConsentPurpose, ConsentResult } from '../consent';
import type {
  Brief,
  DocumentLanguage,
  StructuredCoaching,
} from '../shared/types';
import type {
  CoachingTurnDeps,
  CoachingTurnInput,
} from '../coaching';
import { runCoachingTurn } from '../coaching';

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

/**
 * Dependencies injected for testability. Follows the same DI pattern as
 * `ClaimFirstGateDeps` (task 22) and `TeachBackDeps` (task 23).
 */
export interface PushCadenceDeps {
  /** The friction dial — reads `coachingCadence` instrument state. */
  readonly dial: { instrumentState(name: 'coachingCadence'): CoachingCadenceState };
  /** The consent gate — gates each push egress, records `cloud_send`. */
  readonly consentGate: { ensureConsent(purpose: ConsentPurpose): Promise<ConsentResult> };
  /** Build coaching deps lazily (after consent, when API key is available). */
  readonly buildCoachingDeps: () => Promise<CoachingTurnDeps>;
  /** Read the optional writing brief for coaching context. */
  readonly briefCapture: { read(): Promise<Brief | undefined> };
  /** The ledger — receives push_coaching metadata events. */
  readonly ledger: { append(e: { ts: string; type: string; payload: unknown }): Promise<void> };
  /** Returns the current ISO timestamp (injectable for tests). */
  readonly now: () => string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Push-cadence tuning knobs. */
export interface PushCadenceConfig {
  /** Minimum ms between push coaching events. Default: 30 000 (30 s). */
  rateLimitMs: number;
  /** Minimum paragraph length (chars) to qualify as non-trivial. Default: 50. */
  minParagraphChars: number;
}

/** Default configuration (unobtrusive by default). */
export const DEFAULT_PUSH_CONFIG: PushCadenceConfig = {
  rateLimitMs: 30_000,
  minParagraphChars: 50,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * The result of a push-cadence idle check.
 *
 * - `{ triggered: false, reason }` — no push fired (dial off, rate-limited,
 *   silenced, no boundary, consent declined, coaching failed).
 * - `{ triggered: true, coaching, anchorBase, input }` — push coaching
 *   succeeded; the caller should surface results in the coaching view.
 */
export type PushCadenceResult =
  | { triggered: false; reason: string }
  | {
      triggered: true;
      coaching: StructuredCoaching;
      anchorBase: number;
      input: CoachingTurnInput;
    };

// ---------------------------------------------------------------------------
// Paragraph-boundary detection (pure functions)
// ---------------------------------------------------------------------------

/**
 * Split document text into paragraphs. A paragraph is text separated by one
 * or more blank lines (`\n\n+`). Leading/trailing whitespace is stripped.
 */
export function extractParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Detect a new paragraph boundary between old and new document text.
 *
 * Returns the new paragraph and its character offset in the new text, or
 * `null` if no new paragraph was added or it is too short to qualify.
 *
 * Strategy: compare paragraph counts; if the count increased, the last
 * paragraph is the newly completed one. This is the simplest reliable
 * heuristic — it detects "the writer finished a paragraph and moved on".
 */
export function detectNewParagraph(
  oldText: string,
  newText: string,
  minChars: number,
): { text: string; offset: number } | null {
  const oldParagraphs = extractParagraphs(oldText);
  const newParagraphs = extractParagraphs(newText);

  if (newParagraphs.length <= oldParagraphs.length) {
    return null;
  }

  // The last paragraph in the new text is the newly completed one
  const lastPara = newParagraphs[newParagraphs.length - 1];
  if (lastPara.length < minChars) {
    return null;
  }

  // Find the character offset of this paragraph in the full text
  const offset = newText.lastIndexOf(lastPara);
  if (offset < 0) {
    return null;
  }

  return { text: lastPara, offset };
}

// ---------------------------------------------------------------------------
// PushCadence — the main service
// ---------------------------------------------------------------------------

/**
 * Manages the proactive push-coaching cadence (instrument A, ADR-008).
 *
 * At the "push" dial state, after the writer finishes a paragraph and pauses
 * (idle debounce handled externally), this service:
 *   1. Detects the new paragraph boundary
 *   2. Checks rate limit and silence controls
 *   3. Routes through `ensureConsent()` (cloud_send recorded)
 *   4. Runs the coaching turn pipeline (provider → guard → ai_consult)
 *   5. Records a `push_coaching` ledger event with metadata
 *
 * At "pull" (default), it does nothing — no push ever fires.
 */
export class PushCadence {
  private previousText = '';
  private currentText = '';
  private currentLanguage: DocumentLanguage = 'markdown';
  private currentUri = '';
  private lastPushAtMs = 0;
  private readonly silencedDocs: Set<string> = new Set();
  private sessionSilenced = false;
  private dismissed = false;

  constructor(
    private readonly deps: PushCadenceDeps,
    private readonly config: PushCadenceConfig = DEFAULT_PUSH_CONFIG,
  ) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Feed a document text change. Stores the current state so boundary
   * detection can compare when idle fires.
   *
   * The caller invokes this on every `onDidChangeTextDocument` event.
   * New changes reset the dismissal flag.
   */
  feedChange(text: string, language: DocumentLanguage, uri: string): void {
    // On the first feed (document loaded), initialise both states to the
    // same text so existing paragraphs are not treated as "new".
    if (this.currentText === '') {
      this.previousText = text;
    } else {
      this.previousText = this.currentText;
    }
    this.currentText = text;
    this.currentLanguage = language;
    this.currentUri = uri;
    this.dismissed = false;
  }

  /**
   * Called when the idle debounce period has elapsed with no further changes.
   *
   * Checks (in order):
   *   1. Dial state — must be "push"
   *   2. Silence controls — session, document, dismissal
   *   3. Paragraph boundary — a new paragraph must have been completed
   *   4. Rate limit — minimum interval between pushes
   *   5. Consent gate — egress must be consented (cloud_send recorded)
   *   6. Coaching pipeline — provider → guard → ledger
   *
   * @returns `PushCadenceResult` — `triggered: true` on success
   */
  async onIdle(): Promise<PushCadenceResult> {
    // 1. Dial gate
    const dialState = this.deps.dial.instrumentState('coachingCadence');
    if (dialState !== 'push') {
      return { triggered: false, reason: `Dial is "${dialState}", not "push".` };
    }

    // 2. Silence controls
    if (this.sessionSilenced) {
      return { triggered: false, reason: 'Session silenced.' };
    }
    if (this.silencedDocs.has(this.currentUri)) {
      return { triggered: false, reason: 'Document silenced.' };
    }
    if (this.dismissed) {
      return { triggered: false, reason: 'Push dismissed.' };
    }

    // 3. Paragraph boundary detection
    const boundary = detectNewParagraph(
      this.previousText,
      this.currentText,
      this.config.minParagraphChars,
    );
    if (!boundary) {
      return { triggered: false, reason: 'No new paragraph boundary.' };
    }

    // 4. Rate limit
    const nowMs = new Date(this.deps.now()).getTime();
    if (this.lastPushAtMs > 0 && nowMs - this.lastPushAtMs < this.config.rateLimitMs) {
      return { triggered: false, reason: 'Rate limited.' };
    }

    // 5. Consent gate — MUST run before any cloud egress (F7, ADR-004)
    const consentResult = await this.deps.consentGate.ensureConsent('coaching');
    if (!consentResult.ok) {
      return { triggered: false, reason: `Consent not granted: ${consentResult.reason}` };
    }

    // 6. Build coaching deps lazily (key available after consent)
    const coachingDeps = await this.deps.buildCoachingDeps();

    // 7. Build coaching input (no claim-first gate — push is unobtrusive)
    const brief = await this.deps.briefCapture.read();
    const input: CoachingTurnInput = {
      selectionText: boundary.text,
      anchorBase: boundary.offset,
      documentLanguage: this.currentLanguage,
      brief,
    };

    // 8. Run coaching turn (provider → guard → ai_consult ledger event)
    const turnResult = await runCoachingTurn(coachingDeps, input);

    if (!turnResult.ok) {
      return { triggered: false, reason: `Coaching failed: ${turnResult.error.message}` };
    }

    // 9. Record push_coaching metadata
    this.lastPushAtMs = nowMs;
    await this.deps.ledger.append({
      ts: this.deps.now(),
      type: 'push_coaching',
      payload: {
        paragraphLength: boundary.text.length,
        anchorBase: boundary.offset,
        documentLanguage: this.currentLanguage,
        dialState,
        observationCount: turnResult.coaching.observations.length,
      },
    });

    return {
      triggered: true,
      coaching: turnResult.coaching,
      anchorBase: boundary.offset,
      input,
    };
  }

  // -----------------------------------------------------------------------
  // Silence / dismiss controls
  // -----------------------------------------------------------------------

  /** Silence push coaching for a specific document URI. */
  silenceDocument(uri: string): void {
    this.silencedDocs.add(uri);
  }

  /** Silence push coaching for the rest of the session (all documents). */
  silenceSession(): void {
    this.sessionSilenced = true;
  }

  /** Dismiss the current pending push. The next `feedChange` resets this. */
  dismiss(): void {
    this.dismissed = true;
  }

  /** Whether push coaching is currently silenced (session or document). */
  get isSilenced(): boolean {
    return this.sessionSilenced || this.silencedDocs.has(this.currentUri);
  }

  /** The current dial state for the coaching cadence instrument. */
  get dialState(): CoachingCadenceState {
    return this.deps.dial.instrumentState('coachingCadence');
  }
}
