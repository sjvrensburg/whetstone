import { describe, expect, it } from 'vitest';
import {
  COACHING_JSON_SCHEMA,
  MAX_OBSERVATIONS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
  isInterrogative,
  validateStructuredCoaching,
  type Observation,
} from '../src/core/coaching';

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  anchor: { start: 0, end: 10 },
  kind: 'implicit_claim',
  reflection: 'This paragraph leans on an unstated premise.',
  question: 'What premise are you assuming here?',
  ...overrides,
});

describe('validateStructuredCoaching', () => {
  it('accepts a well-formed coaching turn', () => {
    expect(validateStructuredCoaching({ observations: [obs()] })).toEqual({ ok: true });
    expect(validateStructuredCoaching({ observations: [] })).toEqual({ ok: true });
  });

  it('rejects extra top-level fields (no field for prose)', () => {
    const result = validateStructuredCoaching({ observations: [obs()], rewrite: 'better prose' });
    expect(result.ok).toBe(false);
  });

  it('rejects extra observation fields', () => {
    const poisoned = { ...obs(), suggestedText: 'paste me' };
    expect(validateStructuredCoaching({ observations: [poisoned] }).ok).toBe(false);
  });

  it('rejects unknown kinds', () => {
    expect(
      validateStructuredCoaching({ observations: [obs({ kind: 'rewrite' as never })] }).ok,
    ).toBe(false);
  });

  it('enforces length caps', () => {
    expect(
      validateStructuredCoaching({
        observations: [obs({ reflection: 'x'.repeat(REFLECTION_MAX_LENGTH + 1) })],
      }).ok,
    ).toBe(false);
    expect(
      validateStructuredCoaching({
        observations: [obs({ question: `${'x'.repeat(QUESTION_MAX_LENGTH)}?` })],
      }).ok,
    ).toBe(false);
  });

  it('enforces the observation count cap', () => {
    const many = Array.from({ length: MAX_OBSERVATIONS + 1 }, () => obs());
    expect(validateStructuredCoaching({ observations: many }).ok).toBe(false);
  });

  it('requires interrogative questions', () => {
    expect(
      validateStructuredCoaching({
        observations: [obs({ question: 'You should clarify this.' })],
      }).ok,
    ).toBe(false);
    expect(isInterrogative('Why this order?')).toBe(true);
    expect(isInterrogative('?')).toBe(false);
  });

  it('rejects negative anchors and non-objects', () => {
    expect(
      validateStructuredCoaching({ observations: [obs({ anchor: { start: -1, end: 5 } })] }).ok,
    ).toBe(false);
    expect(validateStructuredCoaching('nope').ok).toBe(false);
    expect(validateStructuredCoaching(null).ok).toBe(false);
  });

  it('wire schema stays within the structured-output-safe subset', () => {
    const json = JSON.stringify(COACHING_JSON_SCHEMA);
    for (const unsupported of ['maxLength', 'maxItems', 'minimum', 'minLength']) {
      expect(json).not.toContain(unsupported);
    }
    expect(json).toContain('"additionalProperties":false');
  });
});
