/**
 * "Explain this rule in my own words" action (task 15, PRD F4, ADR-005).
 *
 * Takes the offending sentence plus the Harper lint and routes them through
 * the coaching provider for a plain-language explanation of the underlying
 * rule in the writer's own sentence — never a rewrite. Because it egresses,
 * it passes through the consent chokepoint (task 13) and is recorded as a
 * `cloud_send`.
 *
 * The explain-rule flow:
 *
 *   diagnostic → ensureConsent('explain_rule') → provider.explainRule()
 *     → no-rewrite check → read-only explanation
 *
 * Design decisions:
 * - The core logic is a pure function with DI seams (`ExplainRuleDeps`),
 *   matching the pattern of `runCoachingTurn`, `ConsentGate`, etc.
 * - The no-rewrite check reuses the guard's `extractNgrams`/`ngramOverlap`
 *   (already exported from `src/guard/index.ts`).
 * - The code-action entry point (command handler) lives in `codeActions.ts`;
 *   this module is the business logic layer.
 * - UI rendering (hover/output channel) is deferred to task 17.
 */

import type { ConsentGate } from '../consent/index';
import { extractNgrams, ngramOverlap } from '../guard/index';
import type { CoachingProvider, ProviderError } from '../providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input to the explain-rule action: the sentence containing the issue and
 * the lint metadata from Harper.
 */
export interface ExplainRuleInput {
  /** The sentence containing the grammar issue. */
  readonly sentence: string;
  /** The Harper lint category key (e.g. "Spelling"). */
  readonly lintKind: string;
  /** Human-readable lint category (e.g. "Spelling"). */
  readonly lintKindPretty: string;
  /** The diagnostic message from Harper. */
  readonly message: string;
}

/** Machine-readable error categories for the explain-rule action. */
export type ExplainRuleErrorKind = 'consent' | 'provider' | 'rewrite_detected' | 'empty_sentence';

/** A typed error from the explain-rule action. */
export interface ExplainRuleError {
  readonly kind: ExplainRuleErrorKind;
  readonly message: string;
}

/** The outcome of the explain-rule action. */
export type ExplainRuleResult =
  | { ok: true; explanation: string }
  | { ok: false; error: ExplainRuleError };

/**
 * Dependencies injected into the explain-rule action — kept structural for
 * testability. Matches the DI pattern used by `CoachingTurnDeps`,
 * `ConsentDeps`, etc.
 */
export interface ExplainRuleDeps {
  /** The consent gate (task 13) — gates first egress and records cloud_send. */
  readonly consentGate: ConsentGate;
  /** The coaching provider (task 09) — the only module that talks to the cloud. */
  readonly provider: CoachingProvider;
}

// ---------------------------------------------------------------------------
// No-rewrite check
// ---------------------------------------------------------------------------

/**
 * Default n-gram size for the rewrite overlap check. Trigrams provide a good
 * balance between sensitivity and false positives for short explanations.
 */
const REWRITE_NGRAM_SIZE = 3;

/**
 * Overlap threshold: if ≥40% of the explanation's trigrams appear in the
 * original sentence, the response is considered a rewrite. Slightly lower
 * than the guard's 50% because the explanation is expected to reference the
 * sentence's words (it talks about the grammar in context), but a true
 * explanation should be substantially different from the original.
 */
const REWRITE_OVERLAP_THRESHOLD = 0.4;

/**
 * Minimum number of words required for a meaningful overlap check. Short
 * sentences or explanations can't produce enough n-grams for a reliable
 * score, so they are allowed through.
 */
const MIN_WORDS_FOR_OVERLAP = 6;

/**
 * Check whether an explanation contains a rewrite of the original sentence.
 *
 * Uses trigram containment: if a large fraction of the explanation's trigrams
 * also appear in the original sentence, the explanation is likely a
 * rewrite rather than a genuine rule explanation. The threshold is set lower
 * than the coaching guard's overlap check because a valid explanation may
 * legitimately reference words from the original sentence.
 *
 * @returns `true` if the explanation appears to contain a rewrite.
 */
export function containsRewrite(explanation: string, sentence: string): boolean {
  const explainWords = explanation.toLowerCase().split(/\s+/);
  const sentenceWords = sentence.toLowerCase().split(/\s+/);

  // Skip overlap check for very short texts — not enough signal.
  if (explainWords.length < MIN_WORDS_FOR_OVERLAP || sentenceWords.length < MIN_WORDS_FOR_OVERLAP) {
    return false;
  }

  const explainNgrams = extractNgrams(explanation, REWRITE_NGRAM_SIZE);
  const sentenceNgrams = extractNgrams(sentence, REWRITE_NGRAM_SIZE);

  const overlap = ngramOverlap(explainNgrams, sentenceNgrams);
  return overlap >= REWRITE_OVERLAP_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Main explain-rule action
// ---------------------------------------------------------------------------

/**
 * Explain a grammar rule in the context of the writer's own sentence.
 *
 * Flow:
 *   1. Validate input (non-empty sentence).
 *   2. Pass through the consent gate (ensures consent + records cloud_send).
 *   3. Call the provider for a plain-language explanation.
 *   4. Check the response does not contain a rewrite.
 *
 * @param deps    Dependencies (consent gate + provider).
 * @param input   The sentence and lint metadata.
 * @returns An explanation string on success, or a typed error on failure.
 */
export async function explainRule(
  deps: ExplainRuleDeps,
  input: ExplainRuleInput,
): Promise<ExplainRuleResult> {
  // --- 1. Validate input ---
  if (!input.sentence || input.sentence.trim().length === 0) {
    return {
      ok: false,
      error: { kind: 'empty_sentence', message: 'No sentence provided to explain.' },
    };
  }

  // --- 2. Consent gate (first egress: key setup + disclosure + cloud_send) ---
  const consentResult = await deps.consentGate.ensureConsent('explain_rule');
  if (!consentResult.ok) {
    return {
      ok: false,
      error: { kind: 'consent', message: consentResult.reason },
    };
  }

  // --- 3. Provider call ---
  const providerResult = await deps.provider.explainRule(input.sentence, {
    lintKind: input.lintKind,
    lintKindPretty: input.lintKindPretty,
    message: input.message,
  });

  if (!providerResult.ok) {
    return {
      ok: false,
      error: providerErrorToExplainError(providerResult.error),
    };
  }

  // --- 4. No-rewrite check ---
  if (containsRewrite(providerResult.value, input.sentence)) {
    return {
      ok: false,
      error: {
        kind: 'rewrite_detected',
        message:
          'The explanation contained a rewrite of your sentence rather than a rule explanation. Please try again.',
      },
    };
  }

  return { ok: true, explanation: providerResult.value };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a `ProviderError` to an `ExplainRuleError`. Preserves the message
 * but reclassifies into the explain-rule error taxonomy.
 */
function providerErrorToExplainError(error: ProviderError): ExplainRuleError {
  return {
    kind: 'provider',
    message: error.message,
  };
}
