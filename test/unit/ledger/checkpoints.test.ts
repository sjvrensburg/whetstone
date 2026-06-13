import { describe, it, expect } from 'vitest';
import {
  signCheckpoint,
  verifyCheckpoint,
  shouldCheckpoint,
} from '../../../src/ledger/checkpoints';
import { generateKeyPair } from '../../../src/shared/crypto';

describe('signCheckpoint / verifyCheckpoint', () => {
  it('signs and verifies a checkpoint round-trip', () => {
    const kp = generateKeyPair();
    const cp = signCheckpoint(9, 'hash-of-event-9', kp.privateKey);

    expect(cp.seq).toBe(9);
    expect(cp.latestHash).toBe('hash-of-event-9');
    expect(typeof cp.sig).toBe('string');
    expect(verifyCheckpoint(cp, kp.publicKey)).toBe(true);
  });

  it('rejects a checkpoint verified with the wrong public key', () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const cp = signCheckpoint(0, 'some-hash', signer.privateKey);

    expect(verifyCheckpoint(cp, other.publicKey)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const cp = signCheckpoint(5, 'hash-5', kp.privateKey);

    // Corrupt the signature.
    const raw = Buffer.from(cp.sig, 'base64');
    raw[0] ^= 0xff;
    const tampered = { ...cp, sig: raw.toString('base64') };

    expect(verifyCheckpoint(tampered, kp.publicKey)).toBe(false);
  });

  it('rejects a checkpoint with a tampered latestHash', () => {
    const kp = generateKeyPair();
    const cp = signCheckpoint(3, 'original-hash', kp.privateKey);
    const tampered = { ...cp, latestHash: 'tampered-hash' };

    expect(verifyCheckpoint(tampered, kp.publicKey)).toBe(false);
  });

  it('returns false (never throws) for malformed inputs', () => {
    const kp = generateKeyPair();
    const cp = signCheckpoint(0, 'x', kp.privateKey);

    expect(verifyCheckpoint(cp, 'not-a-pem')).toBe(false);
    expect(verifyCheckpoint({ ...cp, sig: '@@@bad@@@' }, kp.publicKey)).toBe(false);
  });
});

describe('shouldCheckpoint', () => {
  it('fires every N events', () => {
    expect(shouldCheckpoint(9, 10)).toBe(true); // seq 9 → 10th event
    expect(shouldCheckpoint(19, 10)).toBe(true); // seq 19 → 20th event
    expect(shouldCheckpoint(0, 10)).toBe(false);
    expect(shouldCheckpoint(5, 10)).toBe(false);
  });

  it('disables when interval is 0', () => {
    expect(shouldCheckpoint(9, 0)).toBe(false);
    expect(shouldCheckpoint(99, 0)).toBe(false);
  });

  it('disables when interval is negative', () => {
    expect(shouldCheckpoint(9, -1)).toBe(false);
  });

  it('fires at every event when interval is 1', () => {
    for (let i = 0; i < 5; i++) {
      expect(shouldCheckpoint(i, 1)).toBe(true);
    }
  });
});
