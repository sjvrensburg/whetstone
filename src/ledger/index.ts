/**
 * `ledger/` — Append-only hash chain, Ed25519 checkpoints, `verify()`,
 * read-side report/export. Single append chokepoint; the tamper-evident
 * provenance substrate (ADR-006, PRD F3).
 *
 * This module is the task-07 + task-16 deliverable: `LedgerImpl` implements
 * `Ledger` from `shared/types`, consuming the task-03 crypto surface and the
 * task-04 SecretStorage key provider. The read-side computations (`report()`,
 * `exportDisclosure()`) are implemented in `./report` and `./disclosure`,
 * wired here with checkpoint-on-export semantics (ADR-006).
 */

import { buildEntry, verifyEntryHash } from './chain';
import { type Checkpoint, shouldCheckpoint, signCheckpoint, verifyCheckpoint } from './checkpoints';
import { LedgerStore } from './store';
import { computeReport } from './report';
import { computeDisclosureText } from './disclosure';
import type { Ed25519KeyPair } from '../shared/crypto';
import type { Ledger, LedgerEvent, TransparencyReport } from '../shared/types';

export { resolveLedgerDir, type StorageLocationDeps } from './store';
export type { Checkpoint } from './checkpoints';
export type { AppendInput } from './chain';
export { SCOPING_NOTE, DECLARABLE_TYPES } from './report';
export { computeReport } from './report';
export { TOOL_NAME, computeDisclosureText } from './disclosure';
export { renderReportDocument, renderDisclosureDocument } from './documents';

// ---------------------------------------------------------------------------
// Prose validation
// ---------------------------------------------------------------------------

/**
 * Maximum string length allowed anywhere in a ledger payload.
 * Set to the same cap as `REFLECTION_MAX_LENGTH` (280 chars) — payloads are
 * metadata only; user prose must never appear in a ledger entry.
 */
const MAX_PAYLOAD_STRING_LENGTH = 280;

/**
 * Recursively check whether a value contains a string longer than the
 * metadata-only limit. Returns `true` when prose is detected.
 */
function containsProse(value: unknown, maxLen: number): boolean {
  if (typeof value === 'string') {
    return value.length > maxLen;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsProse(item, maxLen));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => containsProse(v, maxLen));
  }
  return false;
}

/**
 * Validate that a payload contains no prose (no string longer than the
 * metadata limit). Throws if prose is detected — the single chokepoint
 * enforces this before any write.
 */
export function validateNoProse(payload: unknown): void {
  if (containsProse(payload, MAX_PAYLOAD_STRING_LENGTH)) {
    throw new Error(
      `Ledger payload contains prose (string > ${MAX_PAYLOAD_STRING_LENGTH} chars). ` +
        'Ledger payloads must be metadata only.',
    );
  }
}

// ---------------------------------------------------------------------------
// Ledger state machine
// ---------------------------------------------------------------------------

type LedgerState = 'active' | 'paused' | 'disabled';

// ---------------------------------------------------------------------------
// Ledger implementation
// ---------------------------------------------------------------------------

/** Dependencies injected into `LedgerImpl` — kept structurally so tests pass fakes. */
export interface LedgerDeps {
  /** The append-only JSONL store. */
  store: LedgerStore;
  /** Returns the per-device Ed25519 keypair (from SecretStorage in production). */
  keyProvider: () => Promise<Ed25519KeyPair>;
  /** Checkpoint interval: sign every N events. 0 disables automatic checkpoints. */
  checkpointInterval: number;
}

/**
 * The tamper-evident provenance ledger (ADR-006).
 *
 * - `append()` is the single chokepoint: prose validation → hash chain →
 *   atomic write → optional checkpoint.
 * - `verify()` walks the chain and checks checkpoint signatures on demand.
 * - The constructor runs verify-on-load and surfaces the result via
 *   `integrityStatus`.
 * - Pause/resume/disable control the recording lifecycle.
 */
export class LedgerImpl implements Ledger {
  private state: LedgerState = 'active';
  private lastSeq = -1;
  private lastHash = '';
  private _integrityStatus: { intact: boolean; brokenAt?: number } = { intact: true };

  constructor(private readonly deps: LedgerDeps) {
    this.loadState();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Whether the ledger is currently recording. */
  get isPaused(): boolean {
    return this.state === 'paused';
  }

  /** Whether the ledger has been permanently disabled. */
  get isDisabled(): boolean {
    return this.state === 'disabled';
  }

  /** The integrity status from the last verify-on-load or explicit `verify()`. */
  get integrityStatus(): { intact: boolean; brokenAt?: number } {
    return this._integrityStatus;
  }

  /**
   * Pause recording. Normal `append()` calls are silently dropped while
   * paused. A `ledger_paused` event is recorded before the state changes.
   */
  async pause(): Promise<void> {
    if (this.state !== 'active') {
      return;
    }
    await this.appendLifecycleEvent('ledger_paused');
    this.state = 'paused';
  }

  /**
   * Resume recording. Sets state to active and records a `ledger_resumed`
   * event so the chain shows the gap.
   */
  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      return;
    }
    this.state = 'active';
    await this.appendLifecycleEvent('ledger_resumed');
  }

  /**
   * Permanently disable the ledger. No further appends are possible
   * (including lifecycle events). `verify()` still works.
   */
  disable(): void {
    this.state = 'disabled';
  }

  // -----------------------------------------------------------------------
  // Ledger interface
  // -----------------------------------------------------------------------

  /**
   * Append an event to the ledger — the single chokepoint (ADR-006).
   *
   * 1. Validate payload (no prose).
   * 2. Build the chain entry (seq, prevHash, computed hash).
   * 3. Atomic write + fsync.
   * 4. Optionally sign a checkpoint.
   *
   * Silently returns if the ledger is paused; throws if disabled.
   */
  async append(e: Omit<LedgerEvent, 'seq' | 'prevHash' | 'hash'>): Promise<void> {
    if (this.state === 'paused') {
      return;
    }
    if (this.state === 'disabled') {
      throw new Error('Ledger is disabled — no further appends are possible.');
    }

    validateNoProse(e.payload);

    const seq = this.lastSeq + 1;
    const prevHash = this.lastHash;
    const entry = buildEntry(e, prevHash, seq);

    this.deps.store.appendLine(JSON.stringify(entry));

    this.lastSeq = seq;
    this.lastHash = entry.hash;

    if (shouldCheckpoint(seq, this.deps.checkpointInterval)) {
      await this.writeCheckpoint(seq, entry.hash);
    }
  }

  /**
   * Walk the hash chain and verify all checkpoint signatures.
   * Returns `{ intact: true }` when the chain is consistent, or
   * `{ intact: false, brokenAt: <seq> }` at the first break.
   */
  async verify(): Promise<{ intact: boolean; brokenAt?: number }> {
    const lines = this.deps.store.readLines();

    // Empty ledger is trivially intact.
    if (lines.length === 0) {
      this._integrityStatus = { intact: true };
      return this._integrityStatus;
    }

    // Parse events.
    const events: LedgerEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      let parsed: LedgerEvent;
      try {
        parsed = JSON.parse(lines[i]) as LedgerEvent;
      } catch {
        this._integrityStatus = { intact: false, brokenAt: i };
        return this._integrityStatus;
      }
      events.push(parsed);
    }

    // Walk the hash chain.
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Sequence must be consecutive from 0.
      if (event.seq !== i) {
        this._integrityStatus = { intact: false, brokenAt: i };
        return this._integrityStatus;
      }

      // prevHash must be "" for genesis, else the previous event's hash.
      const expectedPrev = i === 0 ? '' : events[i - 1].hash;
      if (event.prevHash !== expectedPrev) {
        this._integrityStatus = { intact: false, brokenAt: i };
        return this._integrityStatus;
      }

      // Recompute and compare the hash.
      if (!verifyEntryHash(event)) {
        this._integrityStatus = { intact: false, brokenAt: i };
        return this._integrityStatus;
      }
    }

    // Verify checkpoints.
    const keyPair = await this.deps.keyProvider();
    const checkpointLines = this.deps.store.readCheckpointLines();
    for (const line of checkpointLines) {
      let cp: Checkpoint;
      try {
        cp = JSON.parse(line) as Checkpoint;
      } catch {
        // Unparseable checkpoint line → integrity failure at the end of the chain.
        this._integrityStatus = { intact: false, brokenAt: events[events.length - 1].seq };
        return this._integrityStatus;
      }

      // The checkpoint's seq must reference an existing event.
      if (cp.seq < 0 || cp.seq >= events.length) {
        this._integrityStatus = { intact: false, brokenAt: Math.min(cp.seq, events.length - 1) };
        return this._integrityStatus;
      }

      // The checkpoint's latestHash must match the event at that seq.
      if (events[cp.seq].hash !== cp.latestHash) {
        this._integrityStatus = { intact: false, brokenAt: cp.seq };
        return this._integrityStatus;
      }

      // Signature must verify.
      if (!verifyCheckpoint(cp, keyPair.publicKey)) {
        this._integrityStatus = { intact: false, brokenAt: cp.seq };
        return this._integrityStatus;
      }
    }

    this._integrityStatus = { intact: true };
    return this._integrityStatus;
  }

  // -----------------------------------------------------------------------
  // Read-side computations (task 16 — ADR-006, F6)
  // -----------------------------------------------------------------------

  /**
   * Compute the transparency report by streaming over all ledger events.
   * Runs `verify()` first to get an up-to-date integrity status, then
   * passes the parsed events to the pure `computeReport` function.
   */
  async report(): Promise<TransparencyReport> {
    const events = this.readAllEvents();
    const integrity = await this.verify();
    return computeReport(events, integrity);
  }

  /**
   * Compute the paste-ready ICMJE disclosure paragraph and write a
   * checkpoint (ADR-006: "checkpoint on disclosure export").
   *
   * The checkpoint makes the disclosure export itself tamper-evident:
   * if someone tampers with the ledger after the disclosure was generated,
   * the next verify will detect it.
   */
  async exportDisclosure(): Promise<string> {
    const events = this.readAllEvents();
    const text = computeDisclosureText(events);

    // Checkpoint on export (ADR-006).
    if (this.lastSeq >= 0 && this.state !== 'disabled') {
      await this.writeCheckpoint(this.lastSeq, this.lastHash);
    }

    return text;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Read and parse all events from the store. Used by read-side
   * computations (`report()`, `exportDisclosure()`).
   */
  private readAllEvents(): LedgerEvent[] {
    const lines = this.deps.store.readLines();
    const events: LedgerEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as LedgerEvent);
      } catch {
        // Skip unparseable lines — `verify()` handles integrity.
      }
    }
    return events;
  }

  /** Record a lifecycle event (pause/resume) bypassing the state check. */
  private async appendLifecycleEvent(type: 'ledger_paused' | 'ledger_resumed'): Promise<void> {
    validateNoProse({});
    const seq = this.lastSeq + 1;
    const prevHash = this.lastHash;
    const entry = buildEntry({ ts: new Date().toISOString(), type, payload: {} }, prevHash, seq);

    this.deps.store.appendLine(JSON.stringify(entry));

    this.lastSeq = seq;
    this.lastHash = entry.hash;

    if (shouldCheckpoint(seq, this.deps.checkpointInterval)) {
      await this.writeCheckpoint(seq, entry.hash);
    }
  }

  /** Sign and persist a checkpoint. */
  private async writeCheckpoint(seq: number, latestHash: string): Promise<void> {
    const keyPair = await this.deps.keyProvider();
    const cp = signCheckpoint(seq, latestHash, keyPair.privateKey);
    this.deps.store.appendCheckpointLine(JSON.stringify(cp));
  }

  /**
   * Load the last seq and hash from the existing file, and run
   * verify-on-load to surface integrity status.
   */
  private loadState(): void {
    const lines = this.deps.store.readLines();
    if (lines.length === 0) {
      return;
    }

    // Parse the last line to recover seq and hash.
    try {
      const last = JSON.parse(lines[lines.length - 1]) as LedgerEvent;
      this.lastSeq = last.seq;
      this.lastHash = last.hash;
    } catch {
      // Corrupt last line — best-effort: scan backwards for a parseable line.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]) as LedgerEvent;
          this.lastSeq = event.seq;
          this.lastHash = event.hash;
          return;
        } catch {
          continue;
        }
      }
    }

    // Verify-on-load (fire-and-forget — result is available via integrityStatus
    // after the next microtick). Errors during verify are swallowed so the
    // constructor never throws; the status will reflect the failure.
    this.verify().catch(() => {
      this._integrityStatus = { intact: false };
    });
  }
}
