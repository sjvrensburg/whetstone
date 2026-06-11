/**
 * The refusal guard boundary — `RefusalGuard.screen()` (ADR-003).
 *
 * This is the composable entry point that the coaching turn pipeline (task 12)
 * calls with the model's output and the document context. The guard runs in
 * layers:
 *
 *   1. Injection screening on the document input (untrusted channel).
 *   2. Deterministic checks (span-length, rewrite patterns, n-gram overlap).
 *   3. Cloud judge (provider's cheap model, refuse-by-default, optional
 *      majority-of-N).
 *
 * On any failure the suspect text is never rendered and the guard result
 * carries the offending layer and reason.
 */

import type { CoachingProvider } from '../providers/types';
import type { DocumentContext, GuardResult, StructuredCoaching } from '../shared/types';
import { runDeterministicChecks } from './deterministic';
import { type JudgeOptions, runJudgeLayer } from './judge';
import { screenInjection } from './injection';

export { checkSpanLengths, checkRewritePatterns, checkNgramOverlap, extractNgrams, ngramOverlap } from './deterministic';
export { type JudgeOptions, runJudgeLayer, singleJudge, majorityJudge } from './judge';
export { wrapUntrusted, screenInjection } from './injection';

// ---------------------------------------------------------------------------
// RefusalGuard
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the refusal guard. The provider is optional —
 * when absent, only the deterministic layer runs (useful for testing and for
 * setups where no cloud provider is configured).
 */
export interface RefusalGuardDeps {
  /** The coaching provider whose judge model to call. Optional for testability. */
  provider?: CoachingProvider;
  /** Judge configuration: rounds (majority-of-N) and per-call timeout. */
  judgeOptions?: JudgeOptions;
}

/**
 * The non-bypassable refusal guard (F2). Runs deterministic checks first,
 * then the cloud judge. On any failure the suspect text is never rendered
 * and the guard result carries the offending layer and reason.
 *
 * Usage:
 * ```ts
 * const guard = createRefusalGuard({ provider, judgeOptions: { rounds: 3, timeoutMs: 5000 } });
 * const result = await guard.screen(coachingOutput, documentContext);
 * if (!result.ok) { /* suppress, log reason *\/ }
 * ```
 */
export class RefusalGuard {
  private readonly provider?: CoachingProvider;
  private readonly judgeOptions?: JudgeOptions;

  constructor(deps?: RefusalGuardDeps) {
    this.provider = deps?.provider;
    this.judgeOptions = deps?.judgeOptions;
  }

  /**
   * Screen a coaching output against the document context.
   *
   * 1. Screen document input for injection patterns.
   * 2. Run deterministic checks (span-length, rewrite patterns, n-gram overlap).
   * 3. Run cloud judge (refuse-by-default, fail-closed on error/timeout).
   *
   * Returns `{ ok: true, coaching }` when all checks pass, or
   * `{ ok: false, layer, reason }` on failure at any layer.
   */
  async screen(out: StructuredCoaching, doc: DocumentContext): Promise<GuardResult> {
    // Layer 1: Injection screening on the document input (untrusted channel).
    const injectionResult = screenInjection(doc.selectionText);
    if (!injectionResult.ok) {
      return { ok: false, layer: 'deterministic', reason: injectionResult.reason };
    }

    // Layer 2: Deterministic checks on the coaching output.
    const detResult = runDeterministicChecks(out, doc);
    if (!detResult.ok) {
      return { ok: false, layer: 'deterministic', reason: detResult.reason };
    }

    // Layer 3: Cloud judge (if a provider is configured).
    if (this.provider) {
      const judgeResult = await runJudgeLayer(this.provider, out, this.judgeOptions);
      if (!judgeResult.ok) return judgeResult;
    }

    return { ok: true, coaching: out };
  }
}

/**
 * Create a `RefusalGuard` instance. Accepts optional dependencies for
 * judge integration (provider + judge config).
 */
export function createRefusalGuard(deps?: RefusalGuardDeps): RefusalGuard {
  return new RefusalGuard(deps);
}
