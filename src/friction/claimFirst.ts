/**
 * Claim-first commitment gate — instrument C (ADR-008, task 22).
 *
 * Before the writer pulls coaching on a passage, they state their own point
 * in a sentence. At "required" dial the coaching command is gated on it; at
 * "off" it does nothing. Forces the writer to own the claim before the tool
 * engages.
 *
 * The captured claim is passed as context into the coaching turn (the coaching
 * orchestrator already accepts optional context, task 12) and recorded to the
 * ledger as a `claim_captured` event (metadata only — never prose beyond the
 * claim itself, which is the writer's own words).
 *
 * Pure logic; no `vscode` import. The caller wires this into the coaching
 * command handler in `ui/commands.ts`.
 */

import type { ClaimFirstState } from './presets';

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

/**
 * UI interaction seam for the claim-first capture. The production
 * implementation wraps `vscode.window.showInputBox()`; tests inject a stub.
 * Follows the same DI pattern as `BriefPrompter` (task 14).
 */
export interface ClaimPrompter {
  /**
   * Show the claim-first input. Return the entered text, or `undefined` if
   * the user cancelled (Escape).
   */
  showClaimInput(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * The outcome of the claim-first gate check.
 *
 * - `{ ok: true, claim }` — claim captured (or dial is "off" so no claim
 *   needed); coaching may proceed.
 * - `{ ok: false, reason }` — dial is "required" and the writer did not
 *   provide a claim; coaching must be blocked.
 */
export type ClaimGateResult =
  | { ok: true; claim?: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies injected for testability. Follows the same DI pattern as
 * `PasteQuarantineDeps` (task 21).
 */
export interface ClaimFirstGateDeps {
  /** The friction dial — reads `claimFirst` instrument state. */
  readonly dial: { instrumentState(name: 'claimFirst'): ClaimFirstState };
  /** The ledger — receives claim_captured events (only `append` is needed). */
  readonly ledger: { append(e: { ts: string; type: string; payload: unknown }): Promise<void> };
  /** Returns the current ISO timestamp (injectable for tests). */
  readonly now: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The prompt shown to the writer when the claim-first gate is active. */
export const CLAIM_PROMPT =
  'State your point for this passage in one sentence before coaching begins.';
export const CLAIM_PLACEHOLDER =
  'e.g., "I am arguing that the method section needs to justify the sample size"';
export const CLAIM_TITLE = 'Claim-first — own your point';

// ---------------------------------------------------------------------------
// ClaimFirstGate — the main service
// ---------------------------------------------------------------------------

/**
 * Manages the claim-first commitment gate. Gates coaching on the friction
 * dial's `claimFirst` instrument state:
 *
 *   - **off**:     no gate; coaching runs unchanged
 *   - **required**: coaching is blocked until the writer provides a claim
 *
 * The captured claim is returned to the caller (the coaching command) so it
 * can be passed as context into the coaching turn and recorded to the ledger.
 */
export class ClaimFirstGate {
  constructor(private readonly deps: ClaimFirstGateDeps) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run the claim-first gate check. At "off", returns immediately with no
   * claim. At "required", prompts the writer via the injected prompter and
   * blocks until a claim is provided.
   *
   * @param prompter — the UI seam for showing the claim input
   * @returns `{ ok: true, claim }` when coaching may proceed,
   *          `{ ok: false, reason }` when coaching must be blocked
   */
  async gate(prompter: ClaimPrompter): Promise<ClaimGateResult> {
    const dialState = this.deps.dial.instrumentState('claimFirst');

    // At "off" — no gate, no prompt, no ledger event
    if (dialState === 'off') {
      return { ok: true };
    }

    // At "required" — prompt the writer
    const input = await prompter.showClaimInput();

    // User cancelled or provided empty input — block coaching
    if (input === undefined || input.trim().length === 0) {
      return {
        ok: false,
        reason: 'A claim is required before coaching. State your point in one sentence.',
      };
    }

    const claim = input.trim();

    // Record the claim_captured ledger event (metadata only)
    await this.deps.ledger.append({
      ts: this.deps.now(),
      type: 'claim_captured',
      payload: {
        claimLength: claim.length,
        dialState,
      },
    });

    return { ok: true, claim };
  }

  /**
   * The current dial state for claim-first.
   */
  get dialState(): ClaimFirstState {
    return this.deps.dial.instrumentState('claimFirst');
  }
}
