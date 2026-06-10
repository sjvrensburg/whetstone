/**
 * Deterministic generators for the canonical-JSON property tests. Everything is
 * driven by a seeded PRNG so a failing case is reproducible from its seed — no
 * `Math.random`, so runs never flake. Not production code; lives under
 * `test/support/` and is excluded from the coverage gate like the vscode stub.
 */

/** A small, fast, seeded PRNG (mulberry32) — returns a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEY_POOL = ['seq', 'ts', 'type', 'payload', 'a', 'b', 'Z', 'á', 'name', '1', 'nested'];

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** A JSON scalar drawn from a spread of string / number / boolean / null cases. */
function randomScalar(rng: () => number): unknown {
  switch (randomInt(rng, 5)) {
    case 0:
      return ['', 'plain', 'with "quote"', 'tab\tnewline\n', 'unicode-é'][randomInt(rng, 5)];
    case 1:
      return randomInt(rng, 1000) - 500; // integers, including negatives
    case 2:
      return (randomInt(rng, 100000) - 50000) / 1000; // decimals
    case 3:
      return rng() < 0.5;
    default:
      return null;
  }
}

/**
 * Build a random JSON-safe value up to `depth` levels of nesting. Object keys
 * are drawn from a fixed pool (including non-ASCII) so the same structure can
 * later be rebuilt with keys inserted in a different order.
 */
export function randomJsonValue(rng: () => number, depth: number): unknown {
  if (depth <= 0 || rng() < 0.4) {
    return randomScalar(rng);
  }
  if (rng() < 0.5) {
    const length = randomInt(rng, 4);
    return Array.from({ length }, () => randomJsonValue(rng, depth - 1));
  }
  const size = randomInt(rng, 5);
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    const key = KEY_POOL[randomInt(rng, KEY_POOL.length)];
    obj[key] = randomJsonValue(rng, depth - 1);
  }
  return obj;
}

/**
 * Deep-clone `value`, re-inserting every object's keys in a PRNG-shuffled order.
 * The clone is structurally identical to the input but its key *insertion*
 * order differs — the exact thing canonicalization must neutralize.
 */
export function shuffleKeysDeep(value: unknown, rng: () => number): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => shuffleKeysDeep(element, rng));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // Fisher–Yates shuffle of the key/value pairs.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = randomInt(rng, i + 1);
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = shuffleKeysDeep(val, rng);
    }
    return out;
  }
  return value;
}
