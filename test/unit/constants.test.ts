import { describe, it, expect } from 'vitest';
import {
  MAX_OBSERVATIONS,
  OBSERVATION_KINDS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
} from '../../src/shared/constants';

describe('shared constants (move taxonomy + length caps)', () => {
  it('exposes exactly the three coaching move kinds', () => {
    expect([...OBSERVATION_KINDS]).toEqual(['implicit_claim', 'intended_move', 'logic_fork']);
  });

  it('exposes positive length/count caps the guard reuses', () => {
    expect(REFLECTION_MAX_LENGTH).toBeGreaterThan(0);
    expect(QUESTION_MAX_LENGTH).toBeGreaterThan(0);
    expect(MAX_OBSERVATIONS).toBeGreaterThan(0);
  });
});
