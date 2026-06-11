/**
 * Deterministic guard checks (ADR-003, layer 2 of the refusal guard).
 *
 * Pure-TypeScript validators that run locally and reject:
 *   - per-field span-length overruns
 *   - imperative-rewrite patterns ("change X to…", "try writing…")
 *   - high n-gram overlap with the writer's own passage (anti-"rephrase")
 *
 * These checks are individually testable and independent of any cloud judge.
 * The coaching schema validator (`validateStructuredCoaching`) already enforces
 * structural constraints and length caps; this layer adds the *semantic*
 * heuristics that the schema cannot express.
 *
 * Each check returns `{ ok: true }` or `{ ok: false; reason }` so the
 * `screen()` boundary can short-circuit on first failure.
 */

import {
  MAX_OBSERVATIONS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
} from '../shared/constants';
import type { DocumentContext, StructuredCoaching } from '../shared/types';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Outcome of an individual deterministic check. */
export type CheckResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 10.1 Span-length caps
// ---------------------------------------------------------------------------

/**
 * Re-validate per-field length caps. The schema validator enforces these at
 * the structural level; the guard re-checks as a defense-in-depth layer so
 * that even if a provider bypasses schema validation, the guard still catches
 * over-length fields.
 */
export function checkSpanLengths(coaching: StructuredCoaching): CheckResult {
  if (coaching.observations.length > MAX_OBSERVATIONS) {
    return { ok: false, reason: `observations count exceeds ${MAX_OBSERVATIONS}` };
  }

  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;

    if (obs.reflection.length > REFLECTION_MAX_LENGTH) {
      return { ok: false, reason: `${at}.reflection exceeds ${REFLECTION_MAX_LENGTH} characters` };
    }
    if (obs.question.length > QUESTION_MAX_LENGTH) {
      return { ok: false, reason: `${at}.question exceeds ${QUESTION_MAX_LENGTH} characters` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 10.1 Imperative-rewrite patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate the model is issuing a rewrite instruction rather
 * than a coaching observation. Matches case-insensitively across the
 * reflection and question fields of every observation.
 *
 * These patterns catch the most common instruction-leakage shapes:
 *   - Direct rewrite commands: "change X to Y", "replace … with …"
 *   - Writing suggestions: "try writing", "you could write", "write this as"
 *   - Rephrasing offers: "rephrase this", "a better version would be"
 *   - Prose delivery: "here's a revision", "here is a rewrite"
 */
const REWRITE_PATTERNS: readonly RegExp[] = [
  /\bchange\s+.+\s+to\b/i,
  /\breplace\s+.+\s+with\b/i,
  /\btry\s+writing\b/i,
  /\byou\s+could\s+write\b/i,
  /\bwrite\s+this\s+as\b/i,
  /\brephrase\s+this\b/i,
  /\ba\s+better\s+version\s+would\s+be\b/i,
  /\bhere'?s\s+a\s+revision\b/i,
  /\bhere\s+is\s+a\s+rewrite\b/i,
  /\byou\s+should\s+write\b/i,
  /\bconsider\s+writing\b/i,
  /\binstead\s+(?:of|try)\s+this\b/i,
  /\bsuggested\s+rewrite\b/i,
  /\bimproved\s+version\b/i,
  /\btry\s+(?:this|the)\s+instead\b/i,
];

/**
 * Check all observations for imperative-rewrite patterns. Returns a failure
 * on the first match so the guard can surface which field triggered the reject.
 */
export function checkRewritePatterns(coaching: StructuredCoaching): CheckResult {
  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;

    for (const field of ['reflection', 'question'] as const) {
      const text = obs[field];
      for (const pattern of REWRITE_PATTERNS) {
        if (pattern.test(text)) {
          return {
            ok: false,
            reason: `${at}.${field} matches rewrite pattern "${pattern.source}"`,
          };
        }
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 10.2 N-gram overlap
// ---------------------------------------------------------------------------

/**
 * Extract word-level n-grams from a string. Words are extracted by splitting
 * on non-alphanumeric characters and lowercased for comparison. Returns a
 * `Map<string, number>` counting each n-gram's frequency (needed for proper
 * overlap computation).
 */
export function extractNgrams(text: string, n: number): Map<string, number> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

  const ngrams = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n).join(' ');
    ngrams.set(gram, (ngrams.get(gram) ?? 0) + 1);
  }
  return ngrams;
}

/**
 * Compute the overlap ratio between two n-gram frequency maps. Uses the
 * *containment* metric: what fraction of the candidate's n-grams appear in
 * the source? This is the right measure for "does the response paraphrase the
 * source?" because the source is typically much longer than a single
 * reflection/question.
 *
 * Returns a value in [0, 1]: 0 means no overlap, 1 means every candidate
 * n-gram appears in the source.
 */
export function ngramOverlap(
  candidate: Map<string, number>,
  source: Map<string, number>,
): number {
  if (candidate.size === 0) return 0;

  let matching = 0;
  let total = 0;
  for (const [gram, count] of candidate) {
    total += count;
    const sourceCount = source.get(gram);
    if (sourceCount !== undefined) {
      matching += Math.min(count, sourceCount);
    }
  }

  return total === 0 ? 0 : matching / total;
}

/**
 * Default n-gram size for the overlap check. Trigrams (n=3) are a good
 * balance: bigrams are too noisy, 4-grams miss legitimate structural
 * similarity.
 */
const DEFAULT_NGRAM_SIZE = 3;

/**
 * Default overlap threshold: if ≥50% of a field's trigrams appear in the
 * source passage, it is considered a paraphrase. This threshold is tuned to
 * be conservative (few false positives) while catching near-verbatim
 * rephrasing.
 */
const DEFAULT_OVERLAP_THRESHOLD = 0.5;

/**
 * Check all observation fields for high n-gram overlap with the writer's
 * source passage. Each `reflection` and `question` is tested individually
 * against `doc.selectionText`. The overlap uses trigrams by default and a
 * containment threshold of 0.5.
 */
export function checkNgramOverlap(
  coaching: StructuredCoaching,
  doc: DocumentContext,
  n: number = DEFAULT_NGRAM_SIZE,
  threshold: number = DEFAULT_OVERLAP_THRESHOLD,
): CheckResult {
  const sourceNgrams = extractNgrams(doc.selectionText, n);

  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;

    for (const field of ['reflection', 'question'] as const) {
      const text = obs[field];
      // Skip very short fields — they can't produce enough n-grams for a
      // meaningful overlap score, and short questions/reflections are fine.
      const words = text.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
      if (words.length < n) continue;

      const fieldNgrams = extractNgrams(text, n);
      const overlap = ngramOverlap(fieldNgrams, sourceNgrams);

      if (overlap >= threshold) {
        return {
          ok: false,
          reason: `${at}.${field} has ${(overlap * 100).toFixed(0)}% n-gram overlap with source (threshold ${threshold * 100}%)`,
        };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Composed deterministic check
// ---------------------------------------------------------------------------

/**
 * Run all deterministic checks in order: span-length → rewrite-patterns →
 * n-gram overlap. Returns on the first failure. The `screen()` boundary calls
 * this after injection screening.
 */
export function runDeterministicChecks(
  coaching: StructuredCoaching,
  doc: DocumentContext,
): CheckResult {
  const spanResult = checkSpanLengths(coaching);
  if (!spanResult.ok) return spanResult;

  const rewriteResult = checkRewritePatterns(coaching);
  if (!rewriteResult.ok) return rewriteResult;

  const overlapResult = checkNgramOverlap(coaching, doc);
  if (!overlapResult.ok) return overlapResult;

  return { ok: true };
}
