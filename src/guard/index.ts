/**
 * The refusal guard boundary — `RefusalGuard.screen()` (ADR-003).
 *
 * This is the composable entry point that the coaching turn pipeline (task 12)
 * calls with the model's output and the document context. The deterministic
 * layer runs first; on failure, `{ ok: false, layer: "deterministic" }` is
 * returned immediately and no judge is invoked.
 *
 * Task 11 extends this boundary with the cloud-judge layer as a second pass;
 * this module exports the deterministic-first `screen()` that the judge layer
 * composes onto.
 */

import type { DocumentContext, GuardResult, StructuredCoaching } from '../shared/types';
import { runDeterministicChecks } from './deterministic';
import { screenInjection } from './injection';

export { checkSpanLengths, checkRewritePatterns, checkNgramOverlap, extractNgrams, ngramOverlap } from './deterministic';
export { wrapUntrusted, screenInjection } from './injection';

// ---------------------------------------------------------------------------
// RefusalGuard
// ---------------------------------------------------------------------------

/**
 * The non-bypassable refusal guard (F2). Runs deterministic checks first,
 * then (in task 11) the cloud judge. On any failure the suspect text is never
 * rendered and the guard result carries the offending layer and reason.
 *
 * Usage:
 * ```ts
 * const result = await guard.screen(coachingOutput, documentContext);
 * if (!result.ok) { /* suppress, log reason *\/ }
 * ```
 */
export class RefusalGuard {
  /**
   * Screen a coaching output against the document context.
   *
   * 1. Screen document input for injection patterns.
   * 2. Run deterministic checks (span-length, rewrite patterns, n-gram overlap).
   * 3. (Task 11: add cloud judge as second layer here.)
   *
   * Returns `{ ok: true, coaching }` when all checks pass, or
   * `{ ok: false, layer: "deterministic", reason }` on deterministic-layer
   * failure.
   */
  async screen(out: StructuredCoaching, doc: DocumentContext): Promise<GuardResult> {
    // Injection screening on the document input (untrusted channel).
    const injectionResult = screenInjection(doc.selectionText);
    if (!injectionResult.ok) {
      return { ok: false, layer: 'deterministic', reason: injectionResult.reason };
    }

    // Deterministic checks on the coaching output.
    const detResult = runDeterministicChecks(out, doc);
    if (!detResult.ok) {
      return { ok: false, layer: 'deterministic', reason: detResult.reason };
    }

    // Task 11 will add: judge layer here. For now, deterministic pass = ok.
    return { ok: true, coaching: out };
  }
}

/**
 * Create a `RefusalGuard` instance. Accepts optional dependencies for
 * future extensibility (e.g., a judge provider injection in task 11).
 */
export function createRefusalGuard(): RefusalGuard {
  return new RefusalGuard();
}
