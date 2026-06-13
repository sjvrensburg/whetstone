/**
 * Word-level n-gram extraction and overlap — ported from V1
 * `src/guard/deterministic.ts` (surface-agnostic, walking-skeleton spec §7).
 */

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
 * Compute the containment ratio: what fraction of `candidate`'s n-grams
 * appear in `source`? Returns a value in [0, 1].
 */
export function ngramOverlap(candidate: Map<string, number>, source: Map<string, number>): number {
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
