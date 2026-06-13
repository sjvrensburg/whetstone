/**
 * Teach-back checkpoints — instrument D (slice 8), ported from V1
 * `src/friction/teachBack.ts`.
 *
 * After a stretch of drafting, the writer summarizes their own argument in
 * one line. If they can't, that IS the signal of disconnection from their
 * own thinking. Supportive, never blocking: the prompt is dismissible and
 * writing continues regardless. The outcome is journaled as metadata only —
 * never the summary prose.
 */

import type { ProcessEventInput } from '../service/types';

export type TeachBackOutcome = 'given' | 'skipped' | 'disconnect-flagged';

/** Minimum characters for a meaningful summary; below this is a disconnect. */
export const MIN_SUMMARY_LENGTH = 10;

/** Non-answers that indicate the writer couldn't articulate the argument. */
const PLACEHOLDER_PATTERNS = [
  /^idk$/i,
  /^i don'?t know$/i,
  /^nothing$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^na$/i,
  /^nil$/i,
  /^\.*$/, // just dots
  /^-+$/, // just dashes
];

/**
 * Detect a "disconnect" signal: empty, too short, or a placeholder — the
 * writer's response suggests they could not articulate their argument.
 */
export function isDisconnect(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < MIN_SUMMARY_LENGTH) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Classify a teach-back response (undefined = the writer dismissed). */
export function classifyTeachBack(input: string | undefined): {
  outcome: TeachBackOutcome;
  disconnect: boolean;
} {
  if (input === undefined) return { outcome: 'skipped', disconnect: false };
  if (isDisconnect(input)) return { outcome: 'disconnect-flagged', disconnect: true };
  return { outcome: 'given', disconnect: false };
}

export const TEACH_BACK_PROMPT =
  "Teach-back: summarize what you've argued so far in one line. If you can't, that's OK — it's a signal worth noticing.";
export const DISCONNECT_NUDGE =
  "No worries — if it's hard to summarize, the argument may not be clear yet. That's the signal.";

// ---------------------------------------------------------------------------
// Scheduler + instrument
// ---------------------------------------------------------------------------

/** Checkpoint after every N newly completed paragraphs. */
export const TEACH_BACK_EVERY_PARAGRAPHS = 3;

export interface TeachBackDeps {
  /** Journal sink (Service-stamped). */
  emit: (e: ProcessEventInput) => void;
  /** UI seam: show the summary input; undefined = dismissed. */
  prompt: () => Promise<string | undefined>;
  every?: number;
}

export interface TeachBackResult {
  triggered: boolean;
  outcome?: TeachBackOutcome;
  disconnect?: boolean;
}

/**
 * Counts newly completed paragraphs and runs a checkpoint every Nth one.
 * The caller feeds it the current paragraph count at idle boundaries.
 */
export class TeachBackInstrument {
  private knownParagraphs = 0;
  private sinceCheckpoint = 0;
  private prompting = false;
  private readonly every: number;

  constructor(private readonly deps: TeachBackDeps) {
    this.every = deps.every ?? TEACH_BACK_EVERY_PARAGRAPHS;
  }

  /**
   * Called at idle with the current paragraph count. Returns the checkpoint
   * result; `triggered: false` when no checkpoint was due.
   */
  async onIdle(paragraphCount: number): Promise<TeachBackResult> {
    if (this.prompting) return { triggered: false };

    if (paragraphCount > this.knownParagraphs) {
      this.sinceCheckpoint += paragraphCount - this.knownParagraphs;
    }
    this.knownParagraphs = paragraphCount;

    if (this.sinceCheckpoint < this.every) {
      return { triggered: false };
    }

    this.sinceCheckpoint = 0;
    this.prompting = true;
    let input: string | undefined;
    try {
      input = await this.deps.prompt();
    } finally {
      this.prompting = false;
    }

    const { outcome, disconnect } = classifyTeachBack(input);
    // Metadata only — the summary prose never enters the journal.
    this.deps.emit({
      type: 'teach_back',
      size: input?.trim().length ?? 0,
      meta: { outcome, disconnect },
    });

    return { triggered: true, outcome, disconnect };
  }
}
