import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PHRASES,
  assertNoForbiddenLabels,
  findForbiddenLabels,
  hasNoForbiddenLabels,
} from '../src/core/labels';

describe('forbidden-label guard', () => {
  it('passes clean text', () => {
    expect(hasNoForbiddenLabels('A record of how this piece was written.')).toBe(true);
    expect(findForbiddenLabels('Evidence of process, not proof of authorship.')).toEqual([]);
  });

  it('catches every forbidden phrase, case-insensitively', () => {
    for (const phrase of FORBIDDEN_PHRASES) {
      const text = `This document gives a ${phrase.toUpperCase()} of 97%.`;
      expect(hasNoForbiddenLabels(text)).toBe(false);
      expect(findForbiddenLabels(text)).toContain(phrase);
    }
  });

  it('assertNoForbiddenLabels throws with context and the offending phrase', () => {
    expect(() => assertNoForbiddenLabels('You are a Verified Human!', 'disclosure')).toThrow(
      /disclosure.*verified human/,
    );
    expect(() => assertNoForbiddenLabels('clean', 'disclosure')).not.toThrow();
  });
});
