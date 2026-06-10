/**
 * Cryptographic primitives for the provenance ledger (ADR-006): the SHA-256
 * hash-chain helper and Ed25519 keygen / sign / verify. Built on Node's
 * `crypto` and the canonical serializer in `./json`; depends on nothing outside
 * the `shared/` module so it stays testable in pure Node (never imports VS Code
 * or any other module — Component Overview: `shared/` has no module deps).
 *
 * These are the only primitives the ledger consumes: `chainHash` produces each
 * entry's tamper-evident hash, and the Ed25519 helpers sign/verify the periodic
 * checkpoints (`sig = Ed25519(latestHash)`) with a per-device key held in
 * SecretStorage.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { canonicalize } from './json';

/** Lowercase hex SHA-256 digest of a UTF-8 string. */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * The minimum shape `chainHash` needs from a ledger entry: the previous entry's
 * hash. The full entry is any JSON-serializable object carrying it — the ledger
 * passes its entry without the `hash` field.
 */
export interface ChainEntry {
  /** Hash of the previous entry; the empty string for the genesis entry. */
  readonly prevHash: string;
}

/**
 * Compute a ledger entry's chain hash:
 * `SHA-256(prevHash + canonicalize(entry-without-hash))` (ADR-006).
 *
 * `entry` is the entry without its own `hash` field; it still carries
 * `prevHash`, which is both prepended (linking this entry to the previous one)
 * and part of the canonicalized body, exactly as the formula specifies.
 * Canonicalization makes the result independent of key insertion order, so two
 * structurally-equal entries always hash identically.
 */
export function chainHash(entry: ChainEntry): string {
  return sha256Hex(entry.prevHash + canonicalize(entry));
}

/** An Ed25519 keypair as PEM strings, suitable for VS Code SecretStorage. */
export interface Ed25519KeyPair {
  /** SPKI PEM — shared/stored to verify signatures. */
  readonly publicKey: string;
  /** PKCS#8 PEM — kept secret (SecretStorage); signs checkpoints. */
  readonly privateKey: string;
}

/** Generate a per-device Ed25519 keypair (PEM-encoded). */
export function generateKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Sign a message with an Ed25519 private key (PKCS#8 PEM); returns the
 * signature base64-encoded. Ledger checkpoints sign the latest chain hash.
 */
export function sign(message: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return nodeSign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/**
 * Verify a base64 Ed25519 signature against a message and a public key (SPKI
 * PEM). Returns `false` — never throws — for a bad signature, the wrong key, or
 * a malformed key/signature, so callers can treat every failure uniformly.
 */
export function verify(message: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return nodeVerify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
