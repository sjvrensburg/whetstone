/**
 * SHA-256 hash-chain construction for the append-only provenance ledger
 * (ADR-006). Each `LedgerEvent` links to its predecessor via `prevHash`,
 * and its own `hash` is `SHA-256(prevHash + canonicalize(entry-without-hash))`
 * — recomputed by `verify()` to detect edits and truncation.
 *
 * Pure functions; no I/O, no side effects, no `vscode` import.
 */

import { chainHash } from '../shared/crypto';
import type { LedgerEvent } from '../shared/types';

/** The subset of a `LedgerEvent` the caller supplies — `seq`, `prevHash`, `hash` are derived. */
export type AppendInput = Omit<LedgerEvent, 'seq' | 'prevHash' | 'hash'>;

/**
 * Build a complete `LedgerEvent` with computed chain hash.
 *
 * `prevHash` is the empty string for the genesis entry (seq 0) and the
 * previous entry's `hash` for every later entry.
 */
export function buildEntry(input: AppendInput, prevHash: string, seq: number): LedgerEvent {
  const entry: Omit<LedgerEvent, 'hash'> = {
    seq,
    ts: input.ts,
    type: input.type,
    payload: input.payload,
    prevHash,
  };
  const hash = chainHash(entry);
  return { ...entry, hash };
}

/**
 * Recompute the expected hash for an existing event and compare.
 * Returns `true` when the stored `hash` matches the recomputed one.
 */
export function verifyEntryHash(event: LedgerEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hash: _storedHash, ...entryWithoutHash } = event;
  const expected = chainHash(entryWithoutHash);
  return expected === event.hash;
}
