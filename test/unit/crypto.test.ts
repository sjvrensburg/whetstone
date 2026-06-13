import { describe, it, expect } from 'vitest';
import { chainHash, generateKeyPair, sha256Hex, sign, verify } from '../../src/shared/crypto';
import { canonicalize } from '../../src/shared/json';

describe('sha256Hex — known test vectors', () => {
  it('matches the NIST FIPS-180 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the vector for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is a 64-char lowercase hex digest', () => {
    expect(sha256Hex('whetstone')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('chainHash — SHA-256(prevHash + canonicalize(entry))', () => {
  const entry = {
    seq: 0,
    ts: '2026-06-10T00:00:00Z',
    type: 'ai_consult',
    payload: { n: 1 },
    prevHash: '',
  };

  it('matches the literal formula for a fixed entry', () => {
    expect(chainHash(entry)).toBe(sha256Hex(entry.prevHash + canonicalize(entry)));
  });

  it('is independent of key insertion order in the entry', () => {
    const reordered = {
      prevHash: '',
      payload: { n: 1 },
      type: 'ai_consult',
      ts: '2026-06-10T00:00:00Z',
      seq: 0,
    };
    expect(chainHash(reordered)).toBe(chainHash(entry));
  });

  it('changes when prevHash changes (the chain link)', () => {
    const linked = { ...entry, prevHash: chainHash(entry) };
    expect(chainHash(linked)).not.toBe(chainHash(entry));
  });

  it('changes when any payload field changes (tamper-evidence)', () => {
    const tampered = { ...entry, payload: { n: 2 } };
    expect(chainHash(tampered)).not.toBe(chainHash(entry));
  });
});

describe('Ed25519 keygen / sign / verify', () => {
  it('generates a PEM keypair', () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(publicKey).toContain('BEGIN PUBLIC KEY');
    expect(privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('round-trips: a signature verifies against its own message and key', () => {
    const kp = generateKeyPair();
    const message = 'latest-hash-deadbeef';
    const signature = sign(message, kp.privateKey);
    expect(verify(message, signature, kp.publicKey)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const kp = generateKeyPair();
    const message = 'latest-hash-deadbeef';
    const signature = sign(message, kp.privateKey);

    const raw = Buffer.from(signature, 'base64');
    raw[0] ^= 0xff; // flip a byte of the signature
    const tampered = raw.toString('base64');

    expect(tampered).not.toBe(signature);
    expect(verify(message, tampered, kp.publicKey)).toBe(false);
  });

  it('rejects a signature checked against the wrong public key', () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const message = 'latest-hash-deadbeef';
    const signature = sign(message, signer.privateKey);

    expect(verify(message, signature, other.publicKey)).toBe(false);
  });

  it('rejects a signature checked against a tampered message', () => {
    const kp = generateKeyPair();
    const signature = sign('the-original-message', kp.privateKey);
    expect(verify('the-altered-message', signature, kp.publicKey)).toBe(false);
  });

  it('returns false (never throws) for a malformed key or signature', () => {
    const kp = generateKeyPair();
    const signature = sign('m', kp.privateKey);
    expect(verify('m', signature, 'not-a-pem-key')).toBe(false);
    expect(verify('m', 'not-base64-@@@', kp.publicKey)).toBe(false);
  });
});
