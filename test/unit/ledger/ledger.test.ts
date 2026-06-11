import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, sign, type Ed25519KeyPair } from '../../../src/shared/crypto';
import { LedgerImpl, validateNoProse, type LedgerDeps } from '../../../src/ledger/index';
import { LedgerStore, resolveLedgerDir } from '../../../src/ledger/store';
import type { LedgerEvent } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'whetstone-ledger-'));
}

function makeDeps(
  dir: string,
  checkpointInterval = 10,
): { deps: LedgerDeps; keyPair: Ed25519KeyPair } {
  const keyPair = generateKeyPair();
  return {
    keyPair,
    deps: {
      store: new LedgerStore(dir),
      keyProvider: () => Promise.resolve(keyPair),
      checkpointInterval,
    },
  };
}

/** Convenience: append a simple event and return it. */
async function appendSimple(
  ledger: LedgerImpl,
  type: LedgerEvent['type'] = 'ai_consult',
  payload: unknown = {},
): Promise<void> {
  await ledger.append({ ts: new Date().toISOString(), type, payload });
}

// ---------------------------------------------------------------------------
// validateNoProse
// ---------------------------------------------------------------------------

describe('validateNoProse', () => {
  it('passes for an empty payload', () => {
    expect(() => validateNoProse({})).not.toThrow();
  });

  it('passes for short metadata strings', () => {
    expect(() => validateNoProse({ provider: 'anthropic', model: 'glm-5.1' })).not.toThrow();
  });

  it('passes for numbers and booleans', () => {
    expect(() => validateNoProse({ count: 42, enabled: true })).not.toThrow();
  });

  it('passes for nested short metadata', () => {
    expect(() => validateNoProse({ outer: { inner: 'short value', n: 1 } })).not.toThrow();
  });

  it('throws for a long string (prose)', () => {
    const longString = 'a'.repeat(281);
    expect(() => validateNoProse({ text: longString })).toThrow(/prose/);
  });

  it('throws for a long string nested in an array', () => {
    const longString = 'b'.repeat(300);
    expect(() => validateNoProse({ items: [longString] })).toThrow(/prose/);
  });

  it('throws for a long string deeply nested', () => {
    const longString = 'c'.repeat(500);
    expect(() => validateNoProse({ a: { b: { c: longString } } })).toThrow(/prose/);
  });

  it('passes for strings at exactly the limit (280 chars)', () => {
    const exactString = 'x'.repeat(280);
    expect(() => validateNoProse({ text: exactString })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LedgerImpl — happy path
// ---------------------------------------------------------------------------

describe('LedgerImpl — happy path', () => {
  let dir: string;
  let ledger: LedgerImpl;

  beforeEach(() => {
    dir = makeTempDir();
    const { deps } = makeDeps(dir);
    ledger = new LedgerImpl(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a single event and verifies intact', async () => {
    await appendSimple(ledger);
    const result = await ledger.verify();
    expect(result.intact).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it('appends N events and verify reports intact', async () => {
    for (let i = 0; i < 25; i++) {
      await appendSimple(ledger, 'ai_consult', { index: i });
    }
    const result = await ledger.verify();
    expect(result.intact).toBe(true);
  });

  it('populates integrityStatus after construction from existing file', async () => {
    await appendSimple(ledger);
    await appendSimple(ledger);

    // Create a new LedgerImpl reading the same directory.
    const { deps } = makeDeps(dir);
    const loaded = new LedgerImpl(deps);

    // Wait for verify-on-load to complete.
    await new Promise((r) => setTimeout(r, 50));

    expect(loaded.integrityStatus.intact).toBe(true);
  });

  it('records events into the correct default storage location', async () => {
    // Use resolveLedgerDir to get the default directory pattern.
    const resolved = resolveLedgerDir({
      globalStoragePath: '/global',
      workspaceFolders: [{ uri: { fsPath: '/project' } }],
      ledgerInWorkspace: false,
    });
    expect(resolved).toMatch(/^\/global\/ledger\/[0-9a-f]{16}$/);

    // And verify the ledger actually writes to the given directory.
    await appendSimple(ledger);
    const store = new LedgerStore(dir);
    expect(store.readLines().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

describe('LedgerImpl — tamper detection', () => {
  let dir: string;
  let ledger: LedgerImpl;

  beforeEach(() => {
    dir = makeTempDir();
    const result = makeDeps(dir);
    ledger = new LedgerImpl(result.deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("editing a single line sets brokenAt to that event's seq", async () => {
    await appendSimple(ledger, 'ai_consult', { v: 1 }); // seq 0
    await appendSimple(ledger, 'ai_consult', { v: 2 }); // seq 1
    await appendSimple(ledger, 'ai_consult', { v: 3 }); // seq 2

    // Tamper with seq 1's payload.
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    const event1 = JSON.parse(lines[1]) as LedgerEvent;
    event1.payload = { v: 999 }; // tampered
    lines[1] = JSON.stringify(event1);

    // Overwrite the file.
    writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf8');

    const { deps } = makeDeps(dir);
    const tamperedLedger = new LedgerImpl(deps);
    const result = await tamperedLedger.verify();
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('detects truncation of events past a checkpoint', async () => {
    // Checkpoint every 5 events → checkpoint at seq 4.
    const { deps } = makeDeps(dir, 5);
    const cpLedger = new LedgerImpl(deps);

    for (let i = 0; i < 10; i++) {
      await appendSimple(cpLedger, 'ai_consult', { i });
    }

    // Truncate the file to 3 events (before the checkpoint at seq 4).
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    writeFileSync(join(dir, 'ledger.jsonl'), lines.slice(0, 3).join('\n') + '\n', 'utf8');

    const { deps: deps2 } = makeDeps(dir, 5);
    const truncatedLedger = new LedgerImpl(deps2);
    const result = await truncatedLedger.verify();
    expect(result.intact).toBe(false);
  });

  it('a forged event without a valid checkpoint signature fails verification', async () => {
    // Checkpoint every 3 events.
    const { deps } = makeDeps(dir, 3);
    const cpLedger = new LedgerImpl(deps);

    for (let i = 0; i < 3; i++) {
      await appendSimple(cpLedger, 'ai_consult', { i });
    }
    // Checkpoint at seq 2.

    // Forge a checkpoint with a different key.
    const forgedKey = generateKeyPair();
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    const lastEvent = JSON.parse(lines[lines.length - 1]) as LedgerEvent;

    // Append a forged checkpoint.
    const forgedCp = {
      seq: lastEvent.seq,
      latestHash: lastEvent.hash,
      sig: sign(lastEvent.hash, forgedKey.privateKey),
    };
    store.appendCheckpointLine(JSON.stringify(forgedCp));

    const { deps: deps2 } = makeDeps(dir, 3);
    const forgedLedger = new LedgerImpl(deps2);
    const result = await forgedLedger.verify();
    expect(result.intact).toBe(false);
  });

  it('detects a completely corrupted (unparseable) line', async () => {
    await appendSimple(ledger);
    await appendSimple(ledger);

    // Corrupt the second line.
    const store = new LedgerStore(dir);
    writeFileSync(join(dir, 'ledger.jsonl'), store.readLines()[0] + '\nNOT-JSON\n', 'utf8');

    const { deps } = makeDeps(dir);
    const corruptedLedger = new LedgerImpl(deps);
    const result = await corruptedLedger.verify();
    expect(result.intact).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('verify-on-load surfaces integrity status after a tampered file', async () => {
    await appendSimple(ledger);
    await appendSimple(ledger);

    // Tamper with the first event.
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    const event0 = JSON.parse(lines[0]) as LedgerEvent;
    event0.payload = { tampered: true };
    lines[0] = JSON.stringify(event0);

    writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf8');

    // Create a new LedgerImpl (simulates verify-on-load).
    const { deps } = makeDeps(dir);
    const loaded = new LedgerImpl(deps);

    // Wait for async verify-on-load.
    await new Promise((r) => setTimeout(r, 50));

    expect(loaded.integrityStatus.intact).toBe(false);
    expect(loaded.integrityStatus.brokenAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pause / resume / disable
// ---------------------------------------------------------------------------

describe('LedgerImpl — pause / resume / disable', () => {
  let dir: string;
  let ledger: LedgerImpl;

  beforeEach(() => {
    dir = makeTempDir();
    const { deps } = makeDeps(dir);
    ledger = new LedgerImpl(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pause stops appends; resume records a ledger_resumed event', async () => {
    await appendSimple(ledger, 'ai_consult', { before: true }); // seq 0

    await ledger.pause();
    expect(ledger.isPaused).toBe(true);

    // This append should be silently dropped.
    await appendSimple(ledger, 'ai_consult', { during: true });

    // Verify the paused event was recorded (seq 1).
    const store = new LedgerStore(dir);
    const linesBeforeResume = store.readLines();
    expect(linesBeforeResume.length).toBe(2); // initial + ledger_paused
    const pausedEvent = JSON.parse(linesBeforeResume[1]) as LedgerEvent;
    expect(pausedEvent.type).toBe('ledger_paused');

    await ledger.resume();
    expect(ledger.isPaused).toBe(false);

    // The resumed event should be recorded.
    const linesAfterResume = store.readLines();
    expect(linesAfterResume.length).toBe(3); // initial + paused + resumed
    const resumedEvent = JSON.parse(linesAfterResume[2]) as LedgerEvent;
    expect(resumedEvent.type).toBe('ledger_resumed');
  });

  it('pause is idempotent', async () => {
    await ledger.pause();
    await ledger.pause(); // second call is a no-op
    expect(ledger.isPaused).toBe(true);

    // Only one ledger_paused event.
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    expect(lines.length).toBe(1);
  });

  it('resume on an active ledger is a no-op', async () => {
    await ledger.resume(); // not paused — no-op
    expect(ledger.isPaused).toBe(false);
  });

  it('disable prevents any further appends', async () => {
    await appendSimple(ledger);
    ledger.disable();
    expect(ledger.isDisabled).toBe(true);

    await expect(appendSimple(ledger)).rejects.toThrow(/disabled/);
  });

  it('verify still works on a disabled ledger', async () => {
    await appendSimple(ledger);
    ledger.disable();

    const result = await ledger.verify();
    expect(result.intact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No prose in payloads
// ---------------------------------------------------------------------------

describe('LedgerImpl — prose exclusion', () => {
  let dir: string;
  let ledger: LedgerImpl;

  beforeEach(() => {
    dir = makeTempDir();
    const { deps } = makeDeps(dir);
    ledger = new LedgerImpl(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an append with prose in the payload', async () => {
    const prose = 'This is a long prose passage that a user might write in their paper. '.repeat(
      10,
    );
    await expect(
      ledger.append({ ts: new Date().toISOString(), type: 'ai_consult', payload: { text: prose } }),
    ).rejects.toThrow(/prose/);
  });

  it('no appended payload contains prose (metadata-only assertion)', async () => {
    const payloads = [
      { provider: 'anthropic', model: 'glm-5.1' },
      { observationCount: 3, duration: 1200 },
      { size: 450, location: 'paragraph 3' },
      { provider: 'anthropic', model: 'glm-5.1', purpose: 'coaching', retention: '30 days' },
      {},
    ];

    for (const payload of payloads) {
      await ledger.append({ ts: new Date().toISOString(), type: 'ai_consult', payload });
    }

    // Read back and verify no payload contains prose.
    const store = new LedgerStore(dir);
    const lines = store.readLines();
    for (const line of lines) {
      const event = JSON.parse(line) as LedgerEvent;
      expect(() => validateNoProse(event.payload)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Checkpoint signing
// ---------------------------------------------------------------------------

describe('LedgerImpl — checkpoint creation', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates checkpoints at the configured interval', async () => {
    const { deps } = makeDeps(dir, 3);
    const ledger = new LedgerImpl(deps);

    for (let i = 0; i < 6; i++) {
      await appendSimple(ledger);
    }

    // Should have checkpoints at seq 2 and seq 5.
    const store = new LedgerStore(dir);
    const cpLines = store.readCheckpointLines();
    expect(cpLines.length).toBe(2);

    const cp0 = JSON.parse(cpLines[0]);
    const cp1 = JSON.parse(cpLines[1]);
    expect(cp0.seq).toBe(2);
    expect(cp1.seq).toBe(5);
  });

  it('does not create checkpoints when interval is 0', async () => {
    const { deps } = makeDeps(dir, 0);
    const ledger = new LedgerImpl(deps);

    for (let i = 0; i < 20; i++) {
      await appendSimple(ledger);
    }

    const store = new LedgerStore(dir);
    expect(store.readCheckpointLines().length).toBe(0);
  });
});
