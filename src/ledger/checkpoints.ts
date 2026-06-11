/**
 * Ed25519 signed checkpoints for the provenance ledger (ADR-006).
 *
 * Every N events (and on disclosure export) a checkpoint signs the latest
 * chain hash with the per-device Ed25519 key held in SecretStorage, making
 * post-checkpoint truncation and edits detectable.
 *
 * Pure functions; no I/O, no side effects.
 */

import { sign, verify as cryptoVerify } from '../shared/crypto';

/** A signed checkpoint stored in `checkpoints.jsonl`. */
export interface Checkpoint {
  /** The sequence number of the latest event covered. */
  seq: number;
  /** The `hash` field of the event at `seq`. */
  latestHash: string;
  /** `Ed25519(latestHash)` — base64 signature using the device private key. */
  sig: string;
}

/**
 * Sign a checkpoint: `sig = Ed25519(latestHash)` using the device private key.
 */
export function signCheckpoint(seq: number, latestHash: string, privateKeyPem: string): Checkpoint {
  const sig = sign(latestHash, privateKeyPem);
  return { seq, latestHash, sig };
}

/**
 * Verify a checkpoint's Ed25519 signature against a public key.
 * Returns `false` (never throws) for a bad signature, wrong key, or
 * malformed input — matching the `shared/crypto.verify` contract.
 */
export function verifyCheckpoint(cp: Checkpoint, publicKeyPem: string): boolean {
  return cryptoVerify(cp.latestHash, cp.sig, publicKeyPem);
}

/**
 * Whether a checkpoint should be written after appending event `seq`.
 * A checkpoint fires every `interval` events (e.g. every 10).
 * `interval <= 0` disables automatic checkpointing.
 */
export function shouldCheckpoint(seq: number, interval: number): boolean {
  return interval > 0 && (seq + 1) % interval === 0;
}
