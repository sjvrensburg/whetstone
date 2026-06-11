/**
 * Cloud-judge layer of the refusal guard (ADR-003, layer 3).
 *
 * Routes anything passing the deterministic gate to the provider's cheap judge
 * model as an adversarial "does any field contain paste-ready prose? refuse-by-
 * default" classifier. Optional majority-of-N voting for boundary cases.
 *
 * Key semantics:
 *   - **Refuse-by-default**: if the judge returns `refused: true` OR the judge
 *     call fails/errors/times out, the candidate is suppressed. Suspect text is
 *     never rendered.
 *   - **Fail-closed**: any provider error, network failure, or timeout is
 *     treated as a refusal — never as a pass.
 *   - **Majority-of-N** (optional): run N judge calls; if a majority refuse,
 *     the candidate is rejected. On a tie, refuse (fail-closed).
 */

import type { CoachingProvider, ProviderResult } from '../providers/types';
import type { GuardResult, GuardVerdict, StructuredCoaching } from '../shared/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options controlling judge behaviour. */
export interface JudgeOptions {
  /**
   * Number of judge rounds for majority-of-N voting.
   * `1` (default) means a single judge call; `3` means best-of-3, etc.
   */
  rounds?: number;
  /**
   * Per-call timeout in milliseconds. If a judge call does not resolve within
   * this window it is treated as a refusal (fail-closed).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Single judge call
// ---------------------------------------------------------------------------

/**
 * Run a single judge call with fail-closed semantics.
 *
 * Returns `{ ok: false, layer: "judge" }` on:
 *   - explicit refusal (`refused: true`)
 *   - provider error (auth, network, validation, timeout, etc.)
 *   - call-level timeout
 *
 * Returns `{ ok: true, coaching }` only when the judge explicitly returns
 * `refused: false`.
 */
export async function singleJudge(
  provider: CoachingProvider,
  candidate: StructuredCoaching,
  timeoutMs?: number,
): Promise<GuardResult> {
  let result: ProviderResult<GuardVerdict>;

  try {
    if (timeoutMs !== undefined && timeoutMs > 0) {
      result = await callWithTimeout(provider, candidate, timeoutMs);
    } else {
      result = await provider.judge(candidate);
    }
  } catch (err: unknown) {
    // Timeout or unexpected exception → fail closed.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timed out')) {
      return { ok: false, layer: 'judge', reason: `judge timed out: ${message}` };
    }
    return { ok: false, layer: 'judge', reason: `judge call failed: ${message}` };
  }

  // Provider returned a typed failure → fail closed.
  if (!result.ok) {
    return { ok: false, layer: 'judge', reason: `judge error: ${result.error.message}` };
  }

  // Refuse-by-default: anything other than an explicit `refused: false` is
  // treated as a refusal. This covers the "unsure" case — the judge prompt
  // instructs the model to set refused=true when unsure, but we also guard
  // against malformed responses where refused might be undefined or null.
  const verdict = result.value;
  if (verdict.refused !== false) {
    return {
      ok: false,
      layer: 'judge',
      reason: verdict.reason || 'judge refused (default on uncertainty)',
    };
  }

  return { ok: true, coaching: candidate };
}

// ---------------------------------------------------------------------------
// Majority-of-N judging
// ---------------------------------------------------------------------------

/**
 * Run N independent judge calls and take the majority vote.
 *
 * Each call is run concurrently (they are independent). A candidate passes
 * only when a strict majority of calls return `ok: true`. On a tie, or when
 * any call fails/throws, the outcome leans toward refusal (fail-closed).
 *
 * Returns the aggregated result as a single `GuardResult`.
 */
export async function majorityJudge(
  provider: CoachingProvider,
  candidate: StructuredCoaching,
  rounds: number,
  timeoutMs?: number,
): Promise<GuardResult> {
  const votes = await Promise.all(
    Array.from({ length: rounds }, () => singleJudge(provider, candidate, timeoutMs)),
  );

  let passCount = 0;
  let refuseCount = 0;
  let lastRefuseReason = 'judge majority refused';

  for (const vote of votes) {
    if (vote.ok) {
      passCount++;
    } else {
      refuseCount++;
      lastRefuseReason = vote.reason;
    }
  }

  if (passCount > refuseCount) {
    return { ok: true, coaching: candidate };
  }

  // Tie or majority refusal → fail closed.
  return { ok: false, layer: 'judge', reason: lastRefuseReason };
}

// ---------------------------------------------------------------------------
// Top-level entry point (composed into screen())
// ---------------------------------------------------------------------------

/**
 * Run the judge layer against a candidate that has already passed the
 * deterministic gate. Uses single-judge by default; set `options.rounds > 1`
 * for majority-of-N.
 *
 * This is the function `screen()` calls after the deterministic layer passes.
 */
export async function runJudgeLayer(
  provider: CoachingProvider,
  candidate: StructuredCoaching,
  options?: JudgeOptions,
): Promise<GuardResult> {
  const rounds = options?.rounds ?? 1;

  if (rounds <= 1) {
    return singleJudge(provider, candidate, options?.timeoutMs);
  }

  return majorityJudge(provider, candidate, rounds, options?.timeoutMs);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Call `provider.judge()` with a timeout wrapper. Resolves with the provider
 * result or rejects on timeout (which the caller treats as fail-closed).
 */
function callWithTimeout(
  provider: CoachingProvider,
  candidate: StructuredCoaching,
  timeoutMs: number,
): Promise<ProviderResult<GuardVerdict>> {
  return new Promise<ProviderResult<GuardVerdict>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`judge timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    provider
      .judge(candidate)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
