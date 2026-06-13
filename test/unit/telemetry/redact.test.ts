/**
 * Unit tests for telemetry redaction (task 18.1) — `src/telemetry/redact.ts`.
 *
 * The invariant under test (ADR-004, task spec): no prose or keys appear in
 * any telemetry event. Redaction is the chokepoint that enforces it.
 */
import { describe, it, expect } from 'vitest';
import {
  redact,
  isLikelyKey,
  PROSE_REDACTION_THRESHOLD,
  REDACTED_PROSE,
  REDACTED_KEY,
} from '../../../src/telemetry/redact';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A string of exactly `n` characters. */
function chars(n: number): string {
  return 'a'.repeat(n);
}

// ---------------------------------------------------------------------------
// Prose redaction
// ---------------------------------------------------------------------------

describe('redact — prose', () => {
  it('redacts a string longer than the prose threshold', () => {
    const prose = chars(PROSE_REDACTION_THRESHOLD + 1);
    expect(redact(prose)).toBe(REDACTED_PROSE);
  });

  it('preserves a string at exactly the threshold', () => {
    const atThreshold = chars(PROSE_REDACTION_THRESHOLD);
    expect(redact(atThreshold)).toBe(atThreshold);
  });

  it('preserves short metadata strings', () => {
    expect(redact('pass')).toBe('pass');
    expect(redact('judge')).toBe('judge');
    expect(redact('coaching')).toBe('coaching');
  });

  it('preserves an empty string', () => {
    expect(redact('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Key redaction — by field name
// ---------------------------------------------------------------------------

describe('redact — keys by field name', () => {
  it('redacts an apiKey field', () => {
    expect(redact({ apiKey: 'gl-my-secret-key' })).toEqual({ apiKey: REDACTED_KEY });
  });

  it('redacts a secret field', () => {
    expect(redact({ clientSecret: 'whatever' })).toEqual({ clientSecret: REDACTED_KEY });
  });

  it('redacts a token field', () => {
    expect(redact({ authToken: 'abc' })).toEqual({ authToken: REDACTED_KEY });
  });

  it('redacts a password field', () => {
    expect(redact({ password: 'hunter2' })).toEqual({ password: REDACTED_KEY });
  });

  it('redacts a credential field', () => {
    expect(redact({ credential: 'x' })).toEqual({ credential: REDACTED_KEY });
  });

  it('redacts a nested signing key without recursing into it', () => {
    const out = redact({ device: { signingKey: 'supersecret' } });
    expect(out).toEqual({ device: { signingKey: REDACTED_KEY } });
  });
});

// ---------------------------------------------------------------------------
// Key redaction — by content
// ---------------------------------------------------------------------------

describe('redact — keys by content', () => {
  it('redacts a known provider key prefix regardless of field', () => {
    expect(redact({ note: 'sk-ant-abc123' })).toEqual({ note: REDACTED_KEY });
    expect(redact({ note: 'Bearer someopaquevalue' })).toEqual({ note: REDACTED_KEY });
  });

  it('redacts a bare opaque token value', () => {
    const token = 'abcdefghij1234567890ABCDEFGHij1234567890'; // 42 chars, mixed, no spaces
    expect(redact(token)).toBe(REDACTED_KEY);
    expect(redact({ value: token })).toEqual({ value: REDACTED_KEY });
  });

  it('does not treat short metadata as a key', () => {
    expect(redact('coaching')).toBe('coaching');
    expect(redact('deterministic')).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// isLikelyKey
// ---------------------------------------------------------------------------

describe('isLikelyKey', () => {
  it('recognizes known key prefixes', () => {
    expect(isLikelyKey('sk-live-abc')).toBe(true);
    expect(isLikelyKey('gl-abc123')).toBe(true);
    expect(isLikelyKey('Bearer xyz')).toBe(true);
    expect(isLikelyKey('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('recognizes long opaque tokens', () => {
    expect(isLikelyKey('a'.repeat(32) + '1')).toBe(true);
  });

  it('rejects normal strings', () => {
    expect(isLikelyKey('pass')).toBe(false);
    expect(isLikelyKey('coaching')).toBe(false);
    expect(isLikelyKey('a sentence with spaces and words')).toBe(false);
  });

  it('rejects strings that are long but contain spaces (prose, not a key)', () => {
    expect(isLikelyKey('this is a long sentence but it has spaces so not a key')).toBe(false);
  });

  it('rejects letter-only or digit-only tokens without mixing', () => {
    expect(isLikelyKey('a'.repeat(40))).toBe(false); // letters only
    expect(isLikelyKey('1'.repeat(40))).toBe(false); // digits only
  });
});

// ---------------------------------------------------------------------------
// Recursion
// ---------------------------------------------------------------------------

describe('redact — recursion', () => {
  it('redacts prose and keys nested in arrays', () => {
    const out = redact({
      items: [chars(300), 'short', { apiKey: 'x' }],
    });
    expect(out).toEqual({
      items: [REDACTED_PROSE, 'short', { apiKey: REDACTED_KEY }],
    });
  });

  it('preserves numbers, booleans, and null', () => {
    expect(redact({ a: 1, b: true, c: null, d: false })).toEqual({
      a: 1,
      b: true,
      c: null,
      d: false,
    });
  });

  it('handles deeply nested objects', () => {
    const out = redact({ l1: { l2: { l3: { prose: chars(400) } } } });
    expect(out).toEqual({ l1: { l2: { l3: { prose: REDACTED_PROSE } } } });
  });

  it('does not throw on cyclic structures', () => {
    const obj: Record<string, unknown> = { name: 'cycle' };
    obj.self = obj;
    // Should not hang or throw; the cycle is replaced with a redaction marker.
    const out = redact(obj) as Record<string, unknown>;
    expect(out.name).toBe('cycle');
    expect(typeof out.self).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Realistic event payloads
// ---------------------------------------------------------------------------

describe('redact — realistic payloads', () => {
  it('strips prose and keys from a coaching event carrying both', () => {
    const payload = {
      outcome: 'pass',
      layer: 'judge',
      selectionText:
        'The rapid advancement of large language models has raised significant concerns about ' +
        'academic integrity and the potential for AI-generated content to undermine traditional ' +
        'assessment methods in higher education across many disciplines worldwide today, and ' +
        'this sentence is intentionally long enough to exceed the prose redaction threshold.',
      apiKey: 'sk-test-1234567890',
    };
    expect(payload.selectionText.length).toBeGreaterThan(280);
    const out = redact(payload) as Record<string, unknown>;
    expect(out.outcome).toBe('pass');
    expect(out.layer).toBe('judge');
    expect(out.selectionText).toBe(REDACTED_PROSE);
    expect(out.apiKey).toBe(REDACTED_KEY);
  });
});
