/**
 * Unit tests for the refusal guard's deterministic layer (task 10).
 *
 * Tests the individual checks (span-length, rewrite-pattern, n-gram overlap)
 * and the composed `runDeterministicChecks` independently of any judge.
 */

import { describe, it, expect } from 'vitest';
import {
  checkSpanLengths,
  checkRewritePatterns,
  checkNgramOverlap,
  extractNgrams,
  ngramOverlap,
  runDeterministicChecks,
} from '../../src/guard/deterministic';
import type { DocumentContext, StructuredCoaching } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obs(
  reflection: string,
  question: string,
  anchor: { start: number; end: number } = { start: 0, end: 10 },
  kind: 'implicit_claim' | 'intended_move' | 'logic_fork' = 'implicit_claim',
) {
  return { anchor, kind, reflection, question };
}

function coaching(...observations: ReturnType<typeof obs>[]): StructuredCoaching {
  return { observations };
}

const doc: DocumentContext = {
  selectionText:
    'The rapid advancement of large language models has raised significant concerns about academic integrity.',
  documentLanguage: 'markdown',
};

// ---------------------------------------------------------------------------
// checkSpanLengths
// ---------------------------------------------------------------------------

describe('checkSpanLengths', () => {
  it('accepts a valid coaching output within all caps', () => {
    const result = checkSpanLengths(
      coaching(obs('A structural observation.', 'What is the implicit claim?')),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an over-length reflection', () => {
    const longReflection = 'A'.repeat(281); // 1 over REFLECTION_MAX_LENGTH (280)
    const result = checkSpanLengths(coaching(obs(longReflection, 'What is the claim?')));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('reflection exceeds 280');
    }
  });

  it('rejects an over-length question', () => {
    const longQuestion = 'Q'.repeat(201); // 1 over QUESTION_MAX_LENGTH (200)
    const result = checkSpanLengths(coaching(obs('A valid reflection.', longQuestion)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('question exceeds 200');
    }
  });

  it('rejects when too many observations', () => {
    // MAX_OBSERVATIONS = 7
    const observations = Array.from({ length: 8 }, (_, i) =>
      obs(`Reflection ${i}.`, `Question ${i}?`),
    );
    const result = checkSpanLengths(coaching(...observations));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('observations count exceeds 7');
    }
  });

  it('accepts exactly MAX_OBSERVATIONS (7) observations', () => {
    const observations = Array.from({ length: 7 }, (_, i) =>
      obs(`Reflection ${i}.`, `Question ${i}?`),
    );
    const result = checkSpanLengths(coaching(...observations));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkRewritePatterns
// ---------------------------------------------------------------------------

describe('checkRewritePatterns', () => {
  it('accepts clean coaching text', () => {
    const result = checkRewritePatterns(
      coaching(obs('The paragraph positions LLMs as a threat.', 'What is at stake?')),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects "change X to Y" in reflection', () => {
    const result = checkRewritePatterns(
      coaching(
        obs('Change the first sentence to "A stronger opening would be…"', 'Would this help?'),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rewrite pattern');
    }
  });

  it('rejects "try writing" in reflection', () => {
    const result = checkRewritePatterns(
      coaching(obs('Try writing this in a more direct voice.', 'Does this help?')),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects "you could write" in question', () => {
    const result = checkRewritePatterns(
      coaching(
        obs('A structural observation.', 'You could write this more concisely, what do you think?'),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects "rephrase this" in reflection', () => {
    const result = checkRewritePatterns(
      coaching(obs('Rephrase this sentence for clarity.', 'Does it read better?')),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects "a better version would be" in reflection', () => {
    const result = checkRewritePatterns(
      coaching(
        obs('A better version would be "The results demonstrate…"', 'What do you think?'),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects "suggested rewrite" in question', () => {
    const result = checkRewritePatterns(
      coaching(
        obs(
          'A claim about data.',
          'Here is a suggested rewrite: "The data shows…" — what do you think?',
        ),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('scans both reflection and question fields', () => {
    // Pattern only in the question field
    const result = checkRewritePatterns(
      coaching(
        obs(
          'Clean reflection about structure.',
          'Consider writing a topic sentence that frames the argument.',
        ),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it('accepts text that mentions writing abstractly without a rewrite', () => {
    const result = checkRewritePatterns(
      coaching(
        obs(
          'The paragraph transitions from evidence to claim.',
          'How does the writing strategy here serve the argument?',
        ),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractNgrams / ngramOverlap
// ---------------------------------------------------------------------------

describe('extractNgrams', () => {
  it('extracts trigrams from a simple sentence', () => {
    const ngrams = extractNgrams('the cat sat on the mat', 3);
    expect(ngrams.get('the cat sat')).toBe(1);
    expect(ngrams.get('cat sat on')).toBe(1);
    expect(ngrams.get('sat on the')).toBe(1);
    expect(ngrams.get('on the mat')).toBe(1);
    expect(ngrams.size).toBe(4);
  });

  it('counts repeated n-grams', () => {
    const ngrams = extractNgrams('the the the the', 2);
    expect(ngrams.get('the the')).toBe(3);
  });

  it('returns empty map for text shorter than n words', () => {
    const ngrams = extractNgrams('two words', 3);
    expect(ngrams.size).toBe(0);
  });

  it('handles punctuation by splitting on non-alphanumeric', () => {
    const ngrams = extractNgrams('Hello, world! How are you?', 2);
    expect(ngrams.get('hello world')).toBe(1);
    expect(ngrams.get('world how')).toBe(1);
  });

  it('lowercases all n-grams', () => {
    const ngrams = extractNgrams('The Cat Sat', 2);
    expect(ngrams.get('the cat')).toBe(1);
    expect(ngrams.get('cat sat')).toBe(1);
  });
});

describe('ngramOverlap', () => {
  it('returns 0 for completely disjoint n-grams', () => {
    const candidate = extractNgrams('alpha beta gamma', 2);
    const source = extractNgrams('delta epsilon zeta', 2);
    expect(ngramOverlap(candidate, source)).toBe(0);
  });

  it('returns 1 when all candidate n-grams are in source', () => {
    const candidate = extractNgrams('the cat sat', 2);
    const source = extractNgrams('the cat sat on the mat', 2);
    expect(ngramOverlap(candidate, source)).toBe(1);
  });

  it('returns 0 for empty candidate', () => {
    const candidate = new Map<string, number>();
    const source = extractNgrams('the cat sat', 2);
    expect(ngramOverlap(candidate, source)).toBe(0);
  });

  it('computes partial overlap correctly', () => {
    const candidate = extractNgrams('a b c d', 2); // a-b, b-c, c-d
    const source = extractNgrams('x a b c y', 2); // x-a, a-b, b-c, c-y
    // candidate: a-b, b-c, c-d → 2 out of 3 match → 0.667
    const overlap = ngramOverlap(candidate, source);
    expect(overlap).toBeCloseTo(2 / 3, 2);
  });
});

// ---------------------------------------------------------------------------
// checkNgramOverlap
// ---------------------------------------------------------------------------

describe('checkNgramOverlap', () => {
  it('accepts when observations are structurally distinct from source', () => {
    const result = checkNgramOverlap(
      coaching(obs('The paragraph positions LLMs as a threat to integrity.', 'What is at stake?')),
      doc,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects when reflection paraphrases the source (high overlap)', () => {
    const result = checkNgramOverlap(
      coaching(
        obs(
          'The rapid advancement of large language models has raised significant concerns about academic integrity.',
          'What is the core tension?',
        ),
      ),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('n-gram overlap');
    }
  });

  it('rejects when question has high overlap with source', () => {
    const result = checkNgramOverlap(
      coaching(
        obs(
          'A structural observation.',
          // Mirrors most of the source trigrams to exceed threshold
          'What about the rapid advancement of large language models that has raised significant concerns about academic integrity?',
        ),
      ),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('n-gram overlap');
    }
  });

  it('skips short fields that cannot produce enough n-grams', () => {
    // A very short reflection (1 word) can't produce trigrams
    const result = checkNgramOverlap(coaching(obs('Interesting.', 'Why?')), doc);
    expect(result.ok).toBe(true);
  });

  it('uses configurable n-gram size and threshold', () => {
    // With bigrams and a high threshold, a moderately overlapping text passes
    const result = checkNgramOverlap(
      coaching(
        obs(
          'The argument raises concerns about the advancement of language models.',
          'What specific concerns emerge from this framing?',
        ),
      ),
      doc,
      2, // bigrams
      0.9, // very high threshold
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDeterministicChecks (composed)
// ---------------------------------------------------------------------------

describe('runDeterministicChecks', () => {
  it('accepts clean coaching output', () => {
    const result = runDeterministicChecks(
      coaching(
        obs(
          'The paragraph positions LLMs as a threat without examining mitigating factors.',
          'What if the argument addressed both threats and opportunities — where would the balance fall?',
        ),
      ),
      doc,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects on span-length failure first', () => {
    const result = runDeterministicChecks(
      coaching(obs('A'.repeat(281), 'What is the claim?')),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('exceeds');
    }
  });

  it('rejects on rewrite pattern', () => {
    const result = runDeterministicChecks(
      coaching(obs('Change the opening to "A better start."', 'Does this work?')),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rewrite pattern');
    }
  });

  it('rejects on n-gram overlap', () => {
    const result = runDeterministicChecks(
      coaching(
        obs(
          'The rapid advancement of large language models has raised significant concerns about academic integrity.',
          'What is the core argument?',
        ),
      ),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('n-gram overlap');
    }
  });

  it('checks run in order: span → rewrite → overlap', () => {
    // This has both over-length AND a rewrite pattern — span should fail first
    const result = runDeterministicChecks(
      coaching(obs('Change this to ' + 'A'.repeat(280), 'What?')),
      doc,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('exceeds'); // span check fires first
    }
  });
});
