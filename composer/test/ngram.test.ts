import { describe, expect, it } from 'vitest';
import { extractNgrams, ngramOverlap } from '../src/core/ngram';

describe('extractNgrams', () => {
  it('extracts lowercased word trigrams with counts', () => {
    const grams = extractNgrams('The quick brown fox the quick brown', 3);
    expect(grams.get('the quick brown')).toBe(2);
    expect(grams.get('quick brown fox')).toBe(1);
    expect(grams.get('brown fox the')).toBe(1);
    expect(grams.size).toBe(4);
  });

  it('splits on punctuation and ignores empty tokens', () => {
    const grams = extractNgrams('one, two; three!', 2);
    expect([...grams.keys()]).toEqual(['one two', 'two three']);
  });

  it('returns empty map when text is shorter than n', () => {
    expect(extractNgrams('one two', 3).size).toBe(0);
    expect(extractNgrams('', 3).size).toBe(0);
  });
});

describe('ngramOverlap', () => {
  it('is 1 when every candidate gram appears in the source', () => {
    const a = extractNgrams('alpha beta gamma delta', 3);
    expect(ngramOverlap(a, a)).toBe(1);
  });

  it('is 0 for disjoint texts', () => {
    const a = extractNgrams('alpha beta gamma', 3);
    const b = extractNgrams('one two three', 3);
    expect(ngramOverlap(a, b)).toBe(0);
  });

  it('is 0 when the candidate is empty', () => {
    expect(ngramOverlap(new Map(), extractNgrams('a b c d', 3))).toBe(0);
  });

  it('respects frequency: a repeated candidate gram only matches up to the source count', () => {
    const candidate = extractNgrams('a b c a b c', 3); // "a b c" x2 among 4 grams
    const source = extractNgrams('a b c', 3); // "a b c" x1
    // candidate grams: "a b c"(2), "b c a"(1), "c a b"(1) → total 4, matching 1
    expect(ngramOverlap(candidate, source)).toBeCloseTo(0.25);
  });
});
