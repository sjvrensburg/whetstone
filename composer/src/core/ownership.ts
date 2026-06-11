/**
 * Claim-to-own — has the writer meaningfully rewritten a quarantined paste?
 *
 * Uses the AUDIT-CORRECTED containment direction (walking-skeleton spec §5):
 * measure *how much of the original survives in the current text* — i.e. the
 * fraction of the ORIGINAL's n-grams still present in the current text.
 *
 * The V1 bug measured the reverse (how much of the current came from the
 * original), which let padding defeat the gate: append enough new prose
 * around an untouched paste and the current text's n-gram profile dilutes
 * below threshold while every word of the original survives verbatim.
 */

import { extractNgrams, ngramOverlap } from './ngram';

/**
 * N-gram size for the survival check. Trigrams (n=3) match the V1 guard
 * heuristic: bigrams are too noisy, 4-grams miss structural similarity.
 */
export const CLAIM_NGRAM_SIZE = 3;

/**
 * Survival threshold: the mark clears when fewer than 50% of the original
 * paste's trigrams survive in the current text.
 */
export const CLAIM_SURVIVAL_THRESHOLD = 0.5;

/**
 * Minimum words in the ORIGINAL paste to produce meaningful trigrams. Below
 * this the original can't be measured; such tiny pastes shouldn't have been
 * quarantined in the first place (threshold is 40 chars), but if one is,
 * treat it as claimable.
 */
export const MIN_WORDS_FOR_OVERLAP = 3;

/**
 * Fraction of the original paste's trigrams that survive in `currentText`.
 * 1 = the original is fully present; 0 = nothing of it survives.
 */
export function survivalRatio(currentText: string, originalText: string): number {
  const originalNgrams = extractNgrams(originalText, CLAIM_NGRAM_SIZE);
  if (originalNgrams.size === 0) return 0;
  const currentNgrams = extractNgrams(currentText, CLAIM_NGRAM_SIZE);
  return ngramOverlap(originalNgrams, currentNgrams);
}

/**
 * Whether the region is claimed-to-own: little of the original survives in
 * the current text. Padding cannot defeat this — adding text around an
 * untouched paste leaves the original's n-grams fully present (survival 1.0).
 */
export function isClaimedToOwn(
  currentText: string,
  originalText: string,
  threshold: number = CLAIM_SURVIVAL_THRESHOLD,
): boolean {
  const originalWords = originalText.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
  if (originalWords.length < MIN_WORDS_FOR_OVERLAP) {
    return true;
  }
  return survivalRatio(currentText, originalText) < threshold;
}
