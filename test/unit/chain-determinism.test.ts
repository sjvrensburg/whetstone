import { describe, it, expect } from 'vitest';
import { chainHash, generateKeyPair, sign, verify } from '../../src/shared/crypto';
import { mulberry32, shuffleKeysDeep } from '../support/json-gen';

/**
 * The determinism-under-volume check the ledger (task 07) relies on: a chain of
 * many events must hash to the exact same sequence when its entries are rebuilt
 * and re-serialized with keys in a different order — otherwise `verify()` would
 * see phantom breakage. Pure Node (no VS Code), so it runs in the vitest suite.
 */

const TYPES = ['ai_consult', 'suggestion_acted', 'external_insert', 'cloud_send'] as const;

interface ChainEvent {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

/** Build an N-event hash chain, each entry linked to the previous one's hash. */
function buildChain(count: number, rng: () => number): ChainEvent[] {
  const events: ChainEvent[] = [];
  let prevHash = '';
  for (let seq = 0; seq < count; seq++) {
    const entry = {
      seq,
      ts: `2026-06-10T00:${String(seq % 60).padStart(2, '0')}:00.000Z`,
      type: TYPES[seq % TYPES.length],
      payload: { index: seq, note: `event-${seq}`, meta: { a: seq * 2, b: rng() < 0.5 } },
      prevHash,
    };
    const hash = chainHash(entry);
    events.push({ ...entry, hash });
    prevHash = hash;
  }
  return events;
}

describe('100-event chain — determinism under volume', () => {
  it('re-serializing every entry with shuffled key order reproduces the same hashes', () => {
    const events = buildChain(100, mulberry32(42));

    events.forEach((event, i) => {
      // Rebuild the entry-without-hash with its keys inserted in a shuffled
      // order (and payload recursively re-keyed), mimicking a fresh read.
      const { hash: _hash, ...entryWithoutHash } = event;
      const reSerialized = shuffleKeysDeep(entryWithoutHash, mulberry32(i + 1)) as {
        prevHash: string;
      };
      expect(chainHash(reSerialized)).toBe(event.hash);
    });
  });

  it('forms an intact chain (each prevHash equals the previous hash)', () => {
    const events = buildChain(100, mulberry32(42));
    expect(events[0].prevHash).toBe('');
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prevHash).toBe(events[i - 1].hash);
    }
  });

  it('produces a byte-identical chain across independent builds of the same input', () => {
    const first = buildChain(100, mulberry32(42)).map((e) => e.hash);
    const second = buildChain(100, mulberry32(42)).map((e) => e.hash);
    expect(second).toEqual(first);
  });

  it('an Ed25519 checkpoint over the latest hash verifies (and detects truncation)', () => {
    const events = buildChain(100, mulberry32(42));
    const latestHash = events[events.length - 1].hash;
    const kp = generateKeyPair();

    const checkpointSig = sign(latestHash, kp.privateKey);
    expect(verify(latestHash, checkpointSig, kp.publicKey)).toBe(true);

    // A truncated chain has a different latest hash, so the checkpoint fails.
    const truncatedLatest = events[events.length - 2].hash;
    expect(verify(truncatedLatest, checkpointSig, kp.publicKey)).toBe(false);
  });
});
