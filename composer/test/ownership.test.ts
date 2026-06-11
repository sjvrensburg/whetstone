import { describe, expect, it } from 'vitest';
import { isClaimedToOwn, survivalRatio } from '../src/core/ownership';

const PASTE =
  'The industrial revolution fundamentally transformed European labor markets ' +
  'by displacing artisanal production with mechanized factory systems.';

describe('survivalRatio (audit-corrected direction)', () => {
  it('is 1.0 when the original is untouched', () => {
    expect(survivalRatio(PASTE, PASTE)).toBe(1);
  });

  it('stays 1.0 under the padding attack — V1 regression', () => {
    // V1 measured how much of the CURRENT came from the original, so padding
    // around an untouched paste diluted the score below threshold. The
    // corrected direction measures how much of the ORIGINAL survives.
    const padding =
      'In this essay I will explore many ideas about history and society and ' +
      'economics and culture and technology and progress over many centuries. ';
    const padded = padding + PASTE + ' ' + padding + padding;
    expect(survivalRatio(padded, PASTE)).toBe(1);
    expect(isClaimedToOwn(padded, PASTE)).toBe(false);
  });

  it('drops to 0 when nothing of the original remains', () => {
    expect(survivalRatio('Something written entirely in my own words here.', PASTE)).toBe(0);
  });
});

describe('isClaimedToOwn', () => {
  it('is false right after the paste', () => {
    expect(isClaimedToOwn(PASTE, PASTE)).toBe(false);
  });

  it('is true after a genuine rewrite', () => {
    const rewrite =
      'Mechanized factories displaced craft workshops, and that shift reshaped ' +
      'how Europeans found and kept work during industrialization.';
    expect(isClaimedToOwn(rewrite, PASTE)).toBe(true);
  });

  it('is false after a partial rewrite that keeps most of the original', () => {
    const partial = PASTE.replace('fundamentally transformed', 'reshaped');
    expect(isClaimedToOwn(partial, PASTE)).toBe(false);
  });

  it('is true when the region was deleted entirely', () => {
    expect(isClaimedToOwn('', PASTE)).toBe(true);
  });

  it('treats originals too short to measure as claimable', () => {
    expect(isClaimedToOwn('whatever text', 'two words')).toBe(true);
  });

  it('honors a custom threshold', () => {
    const half = PASTE.slice(0, PASTE.length / 2) + ' my own conclusion in my own words now.';
    const ratio = survivalRatio(half, PASTE);
    expect(isClaimedToOwn(half, PASTE, ratio + 0.01)).toBe(true);
    expect(isClaimedToOwn(half, PASTE, ratio - 0.01)).toBe(false);
  });
});
