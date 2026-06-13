import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/shared/json';
import { mulberry32, randomJsonValue, shuffleKeysDeep } from '../support/json-gen';

describe('canonicalize — stable key ordering', () => {
  it('is order-independent: keys in different insertion order produce identical bytes', () => {
    const a = { seq: 0, ts: '2026-06-10T00:00:00Z', type: 'ai_consult' };
    const b = { type: 'ai_consult', ts: '2026-06-10T00:00:00Z', seq: 0 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"seq":0,"ts":"2026-06-10T00:00:00Z","type":"ai_consult"}');
  });

  it('sorts keys at every level of nesting', () => {
    const nested = { z: { d: 1, a: 2 }, a: [{ y: 1, b: 2 }] };
    expect(canonicalize(nested)).toBe('{"a":[{"b":2,"y":1}],"z":{"a":2,"d":1}}');
  });

  it('preserves array element order (arrays are not sorted)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize(['b', 'a', 'c'])).toBe('["b","a","c"]');
  });

  it('is stable across repeated runs for the same input', () => {
    const value = { b: [1, { d: 4, c: 3 }], a: 'x', z: true };
    const first = canonicalize(value);
    for (let i = 0; i < 50; i++) {
      expect(canonicalize(value)).toBe(first);
    }
  });
});

describe('canonicalize — consistent scalar encoding', () => {
  it('encodes numbers the way JSON.stringify does (canonical, deterministic)', () => {
    expect(canonicalize(1.0)).toBe('1');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize(0.5)).toBe('0.5');
  });

  it('escapes strings consistently', () => {
    expect(canonicalize('a"b\n\t')).toBe('"a\\"b\\n\\t"');
    expect(canonicalize('é')).toBe('"é"');
  });

  it('encodes booleans and null', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(null)).toBe('null');
  });

  it('maps non-finite numbers to null, as JSON.stringify does', () => {
    expect(canonicalize(NaN)).toBe('null');
    expect(canonicalize(Infinity)).toBe('null');
    expect(canonicalize(-Infinity)).toBe('null');
  });
});

describe('canonicalize — JSON.stringify-compatible omission rules', () => {
  it('omits object properties with undefined / function / symbol values', () => {
    const value = { a: 1, b: undefined, c: () => 0, d: Symbol('s'), e: 2 };
    expect(canonicalize(value)).toBe('{"a":1,"e":2}');
  });

  it('coerces undefined / function / symbol array elements to null', () => {
    expect(canonicalize([1, undefined, () => 0, Symbol('s'), 2])).toBe('[1,null,null,null,2]');
  });

  it('honors toJSON() (e.g. Date serializes to its ISO string)', () => {
    const date = new Date('2026-06-10T12:34:56.000Z');
    expect(canonicalize(date)).toBe('"2026-06-10T12:34:56.000Z"');
    expect(canonicalize({ ts: date })).toBe('{"ts":"2026-06-10T12:34:56.000Z"}');
  });

  it('throws a TypeError for BigInt and for a non-serializable top-level value', () => {
    expect(() => canonicalize(10n)).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(TypeError);
    expect(() => canonicalize(() => 0)).toThrow(TypeError);
  });

  it('produces valid JSON that round-trips structurally (modulo key order)', () => {
    const value = { b: 2, a: { d: [1, 2], c: 'x' }, list: [true, null, 'z'] };
    expect(JSON.parse(canonicalize(value))).toEqual(value);
  });
});

describe('canonicalize — determinism property (order- and run-stable)', () => {
  // Property: for any JSON value, canonicalization is invariant under object
  // key re-ordering and identical across repeated runs. Seeded so any failure
  // is reproducible from its iteration index.
  it('canonical form is invariant under key re-ordering for generated structures', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = mulberry32(seed);
      const original = randomJsonValue(rng, 4);
      const reordered = shuffleKeysDeep(original, mulberry32(seed * 7 + 1));

      const canonical = canonicalize(original);

      // Order-independence: a key-shuffled clone canonicalizes identically.
      expect(canonicalize(reordered)).toBe(canonical);
      // Run-stability: recomputing the same input yields the same bytes.
      expect(canonicalize(original)).toBe(canonical);
      // Sanity: the canonical form is parseable JSON matching the input value.
      expect(JSON.parse(canonical)).toEqual(JSON.parse(JSON.stringify(original)));
    }
  });
});
