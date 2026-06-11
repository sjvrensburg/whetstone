/**
 * Teach-back checkpoints — instrument D (ADR-008, task 23).
 *
 * After a section, the writer summarizes their own argument in one line.
 * If they can't, that *is* the signal of disconnection from their own
 * thinking. Supportive, not punitive: it surfaces the gap, it does not
 * block by default. Dial-gated (off → per-section).
 *
 * Pure logic; no `vscode` import. The caller wires this into the document
 * change handler and section-boundary detector in `ui/commands.ts`.
 */

import type { TeachBackState } from './presets';

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

/**
 * UI interaction seam for the teach-back summary capture. The production
 * implementation wraps `vscode.window.showInputBox()`; tests inject a stub.
 * Follows the same DI pattern as `ClaimPrompter` (task 22) and
 * `BriefPrompter` (task 14).
 */
export interface SummaryPrompter {
  /**
   * Show the teach-back summary input. Return the entered text, or
   * `undefined` if the user dismissed/skipped (Escape or dismiss button).
   */
  showSummaryInput(sectionTitle: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** The outcome of a teach-back checkpoint. */
export type TeachBackOutcome = 'given' | 'skipped' | 'disconnect-flagged';

/**
 * The result of running a teach-back checkpoint.
 *
 * - `triggered: false` — dial is "off", no checkpoint occurred.
 * - `triggered: true` — checkpoint ran; `outcome` and `disconnect` are set.
 *
 * The checkpoint is **never blocking**: `dismissed` is true when the writer
 * skips the prompt (Escape/dismiss), and writing continues regardless.
 */
export interface TeachBackResult {
  /** Whether the checkpoint was triggered (dial was not "off"). */
  triggered: boolean;
  /** The outcome when triggered. */
  outcome?: TeachBackOutcome;
  /** Whether a disconnect signal was detected (empty/too-short/placeholder). */
  disconnect?: boolean;
  /** The summary text when provided (not stored in ledger — metadata only). */
  summary?: string;
  /** The section title that triggered the checkpoint. */
  sectionTitle?: string;
}

// ---------------------------------------------------------------------------
// Disconnect signal detection
// ---------------------------------------------------------------------------

/**
 * Minimum character length for a meaningful summary. Below this, the input
 * is considered a "disconnect" signal — the writer couldn't articulate their
 * argument, which is itself valuable information.
 */
export const MIN_SUMMARY_LENGTH = 10;

/**
 * Placeholder patterns that indicate the writer typed a non-answer rather
 * than engaging with the teach-back prompt. Case-insensitive.
 */
const PLACEHOLDER_PATTERNS = [
  /^idk$/i,
  /^i don'?t know$/i,
  /^nothing$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^na$/i,
  /^nil$/i,
  /^\.*$/,       // just dots
  /^-+$/,        // just dashes
];

/**
 * Detect a "disconnect" signal: the summary is empty, too short, or matches
 * a placeholder pattern. Returns `true` when the writer's response suggests
 * they could not articulate their argument — a mirror moment (ADR-008).
 */
export function isDisconnect(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < MIN_SUMMARY_LENGTH) return true;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The prompt shown to the writer when the teach-back checkpoint is active. */
export const SUMMARY_TITLE = 'Teach-back — what was your point?';
export const SUMMARY_PROMPT =
  'Summarize this section\'s argument in one line. If you can\'t, that\'s OK — it\'s a signal worth noticing.';
export const SUMMARY_PLACEHOLDER = 'e.g., "This section argues that sample size must be justified"';
export const DISCONNECT_NUDGE =
  'No worries — the fact that it\'s hard to summarize might mean the argument isn\'t clear yet. That\'s the signal.';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies injected for testability. Follows the same DI pattern as
 * `ClaimFirstGateDeps` (task 22).
 */
export interface TeachBackDeps {
  /** The friction dial — reads `teachBack` instrument state. */
  readonly dial: { instrumentState(name: 'teachBack'): TeachBackState };
  /** The ledger — receives teach-back outcome events (only `append` is needed). */
  readonly ledger: { append(e: { ts: string; type: string; payload: unknown }): Promise<void> };
  /** Returns the current ISO timestamp (injectable for tests). */
  readonly now: () => string;
}

// ---------------------------------------------------------------------------
// TeachBackCheckpoint — the main service
// ---------------------------------------------------------------------------

/**
 * Manages teach-back checkpoints. At section boundaries, when the friction
 * dial's `teachBack` instrument is enabled (`per-section`), prompts the
 * writer to summarize the section's argument in one line.
 *
 *   - **off**:         no checkpoint
 *   - **per-section**: prompt at each section boundary
 *
 * The checkpoint is always dismissible — it never blocks writing.
 * A "disconnect" signal is detected when the summary is empty, too short,
 * or a placeholder, and is surfaced as a supportive nudge (ADR-008).
 *
 * The outcome is recorded to the ledger as metadata only — never the
 * summary prose itself (ADR-001: honest evidence of process).
 */
export class TeachBackCheckpoint {
  constructor(private readonly deps: TeachBackDeps) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run a teach-back checkpoint for a section boundary.
   *
   * At "off", returns immediately with `triggered: false`.
   * At "per-section", prompts the writer via the injected prompter.
   *
   * The checkpoint is always dismissible: skipping (Escape) records a
   * "skipped" outcome and writing continues. A disconnect signal is
   * detected when the input is empty/too-short/placeholder, recorded as
   * "disconnect-flagged", and surfaced supportively — never as a block.
   *
   * @param prompter — the UI seam for showing the summary input
   * @param sectionTitle — the heading/title of the section just completed
   * @returns `TeachBackResult` describing the outcome
   */
  async checkpoint(prompter: SummaryPrompter, sectionTitle: string): Promise<TeachBackResult> {
    const dialState = this.deps.dial.instrumentState('teachBack');

    // At "off" — no checkpoint, no prompt, no ledger event
    if (dialState === 'off') {
      return { triggered: false };
    }

    // At "per-section" — prompt the writer
    const input = await prompter.showSummaryInput(sectionTitle);

    // Writer dismissed/skipped — not a disconnect, just a skip
    if (input === undefined) {
      await this.recordOutcome('skipped', false, sectionTitle);
      return {
        triggered: true,
        outcome: 'skipped',
        disconnect: false,
        sectionTitle,
      };
    }

    const trimmed = input.trim();

    // Empty input after showing — disconnect signal
    if (trimmed.length === 0) {
      await this.recordOutcome('disconnect-flagged', true, sectionTitle);
      return {
        triggered: true,
        outcome: 'disconnect-flagged',
        disconnect: true,
        sectionTitle,
      };
    }

    // Check for disconnect signal (too-short or placeholder)
    if (isDisconnect(trimmed)) {
      await this.recordOutcome('disconnect-flagged', true, sectionTitle);
      return {
        triggered: true,
        outcome: 'disconnect-flagged',
        disconnect: true,
        summary: trimmed,
        sectionTitle,
      };
    }

    // Meaningful summary provided — record as "given"
    await this.recordOutcome('given', false, sectionTitle);
    return {
      triggered: true,
      outcome: 'given',
      disconnect: false,
      summary: trimmed,
      sectionTitle,
    };
  }

  /**
   * The current dial state for teach-back.
   */
  get dialState(): TeachBackState {
    return this.deps.dial.instrumentState('teachBack');
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Record a teach-back outcome to the ledger. Metadata only — never the
   * summary prose (ADR-001: honest evidence of process, not prose storage).
   */
  private async recordOutcome(
    outcome: TeachBackOutcome,
    disconnect: boolean,
    sectionTitle: string,
  ): Promise<void> {
    await this.deps.ledger.append({
      ts: this.deps.now(),
      type: 'teach_back',
      payload: {
        outcome,
        disconnect,
        sectionTitleLength: sectionTitle.length,
        dialState: this.deps.dial.instrumentState('teachBack'),
      },
    });
  }
}
