/**
 * Proactive (push) coaching cadence — instrument A (slice 9), ported from V1
 * `src/friction/pushCadence.ts`.
 *
 * After the writer finishes a paragraph and pauses, the coach interjects with
 * structural questions ("after each paragraph, a review"). The failure mode
 * is the deadline-stressed writer abandoning the tool, so every choice
 * prioritises unobtrusiveness: settled boundaries only, rate-limited,
 * dismissible, easy to silence for the session.
 *
 * Egress rides on the Service's guarded `coach()` — same consent, same
 * guard, same metadata-only journaling. The push adds only cadence.
 */

import type { CoachResult, ProcessEventInput } from '../service/types';

// ---------------------------------------------------------------------------
// Paragraph-boundary detection (pure, ported)
// ---------------------------------------------------------------------------

/** Split text into paragraphs (blank-line separated, trimmed, non-empty). */
export function extractParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Detect a newly completed paragraph between old and new text. Returns the
 * paragraph and its offset, or null when none was added or it is too short.
 */
export function detectNewParagraph(
  oldText: string,
  newText: string,
  minChars: number,
): { text: string; offset: number } | null {
  const oldParagraphs = extractParagraphs(oldText);
  const newParagraphs = extractParagraphs(newText);

  if (newParagraphs.length <= oldParagraphs.length) return null;

  const lastPara = newParagraphs[newParagraphs.length - 1];
  if (lastPara.length < minChars) return null;

  const offset = newText.lastIndexOf(lastPara);
  if (offset < 0) return null;

  return { text: lastPara, offset };
}

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

export interface PushCadenceConfig {
  /** Minimum ms between pushes. Default 30 000. */
  rateLimitMs: number;
  /** Minimum paragraph length (chars) to qualify. Default 50. */
  minParagraphChars: number;
}

export const DEFAULT_PUSH_CONFIG: PushCadenceConfig = {
  rateLimitMs: 30_000,
  minParagraphChars: 50,
};

export interface PushCadenceDeps {
  /** The Service's guarded coaching call (consent + guard + journal inside). */
  coach: (selectionText: string) => Promise<CoachResult>;
  /** Whether coaching is currently available (provider configured + consented). */
  available: () => boolean;
  /** Journal sink for push_coaching cadence metadata. */
  emit: (e: ProcessEventInput) => void;
  /** Injectable clock (ms). */
  now: () => number;
}

export type PushResult =
  | { triggered: false; reason: string }
  | { triggered: true; result: CoachResult; offset: number };

export class PushCadenceInstrument {
  private previousText = '';
  private currentText = '';
  private lastPushAtMs = 0;
  private sessionSilenced = false;
  private dismissed = false;

  constructor(
    private readonly deps: PushCadenceDeps,
    private readonly config: PushCadenceConfig = DEFAULT_PUSH_CONFIG,
  ) {}

  /** Feed the current document text on every change; resets dismissal. */
  feedChange(text: string): void {
    if (this.currentText === '') {
      // First feed: existing text is not "new" paragraphs.
      this.previousText = text;
    } else {
      this.previousText = this.currentText;
    }
    this.currentText = text;
    this.dismissed = false;
  }

  /** Run the gated push check at an idle boundary. */
  async onIdle(): Promise<PushResult> {
    if (!this.deps.available()) {
      return { triggered: false, reason: 'Coaching not configured.' };
    }
    if (this.sessionSilenced) {
      return { triggered: false, reason: 'Session silenced.' };
    }
    if (this.dismissed) {
      return { triggered: false, reason: 'Push dismissed.' };
    }

    const boundary = detectNewParagraph(
      this.previousText,
      this.currentText,
      this.config.minParagraphChars,
    );
    if (!boundary) {
      return { triggered: false, reason: 'No new paragraph boundary.' };
    }

    const nowMs = this.deps.now();
    if (this.lastPushAtMs > 0 && nowMs - this.lastPushAtMs < this.config.rateLimitMs) {
      return { triggered: false, reason: 'Rate limited.' };
    }

    // Consume the boundary so the same paragraph can't re-trigger.
    this.previousText = this.currentText;

    const result = await this.deps.coach(boundary.text);
    this.lastPushAtMs = nowMs;

    this.deps.emit({
      type: 'push_coaching',
      size: boundary.text.length,
      location: { from: boundary.offset, to: boundary.offset + boundary.text.length },
      meta: {
        refused: !result.ok,
        observations: result.ok ? result.observations.length : 0,
      },
    });

    return { triggered: true, result, offset: boundary.offset };
  }

  /** Silence pushes for the rest of the session. */
  silenceSession(): void {
    this.sessionSilenced = true;
  }

  /** Re-enable pushes for the session. */
  unsilenceSession(): void {
    this.sessionSilenced = false;
  }

  /** Dismiss the current pending push; next change resets. */
  dismiss(): void {
    this.dismissed = true;
  }

  get isSilenced(): boolean {
    return this.sessionSilenced;
  }
}
