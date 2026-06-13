import { describe, it, expect } from 'vitest';
import { buildEntry, verifyEntryHash } from '../../../src/ledger/chain';
import { chainHash } from '../../../src/shared/crypto';
import type { LedgerEvent } from '../../../src/shared/types';

describe('buildEntry', () => {
  it('computes the correct hash for a genesis entry (seq 0, prevHash "")', () => {
    const input = { ts: '2026-06-11T00:00:00Z', type: 'ai_consult' as const, payload: { n: 1 } };
    const entry = buildEntry(input, '', 0);

    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe('');
    expect(entry.ts).toBe(input.ts);
    expect(entry.type).toBe(input.type);
    expect(entry.payload).toEqual(input.payload);

    // Hash matches the explicit formula.
    const { hash: _, ...withoutHash } = entry;
    expect(entry.hash).toBe(chainHash(withoutHash));
  });

  it('links to the previous entry via prevHash', () => {
    const first = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: {} },
      '',
      0,
    );
    const second = buildEntry(
      { ts: '2026-06-11T00:00:01Z', type: 'suggestion_acted', payload: { idx: 0 } },
      first.hash,
      1,
    );

    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it('produces different hashes for different payloads', () => {
    const a = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: { x: 1 } },
      '',
      0,
    );
    const b = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: { x: 2 } },
      '',
      0,
    );
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('verifyEntryHash', () => {
  it('returns true for a correctly built entry', () => {
    const entry = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: { ok: true } },
      '',
      0,
    );
    expect(verifyEntryHash(entry)).toBe(true);
  });

  it('returns false when the payload is tampered', () => {
    const entry = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: { v: 1 } },
      '',
      0,
    );
    const tampered: LedgerEvent = { ...entry, payload: { v: 999 } };
    expect(verifyEntryHash(tampered)).toBe(false);
  });

  it('returns false when the hash field is corrupted', () => {
    const entry = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: {} },
      '',
      0,
    );
    const corrupted: LedgerEvent = { ...entry, hash: 'deadbeef' };
    expect(verifyEntryHash(corrupted)).toBe(false);
  });

  it('returns false when prevHash is changed', () => {
    const entry = buildEntry(
      { ts: '2026-06-11T00:00:00Z', type: 'ai_consult', payload: {} },
      'some-previous-hash',
      5,
    );
    const broken: LedgerEvent = { ...entry, prevHash: 'wrong' };
    expect(verifyEntryHash(broken)).toBe(false);
  });
});
