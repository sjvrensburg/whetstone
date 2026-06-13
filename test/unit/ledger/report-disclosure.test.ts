/**
 * Integration tests for report() and exportDisclosure() on LedgerImpl.
 * Verifies that the read-side computations work end-to-end with the actual
 * ledger (hash chain, store, checkpoints).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, type Ed25519KeyPair } from '../../../src/shared/crypto';
import { LedgerImpl, type LedgerDeps } from '../../../src/ledger/index';
import { LedgerStore } from '../../../src/ledger/store';
import { SCOPING_NOTE } from '../../../src/ledger/report';
import { TOOL_NAME } from '../../../src/ledger/disclosure';
import type { LedgerEvent } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'whetstone-report-'));
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

async function appendEvent(
  ledger: LedgerImpl,
  type: LedgerEvent['type'],
  payload: unknown = {},
): Promise<void> {
  await ledger.append({ ts: new Date().toISOString(), type, payload });
}

// ---------------------------------------------------------------------------
// report() integration
// ---------------------------------------------------------------------------

describe('LedgerImpl.report() — integration', () => {
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

  it('returns a report with correct counts from a populated ledger', async () => {
    await appendEvent(ledger, 'ai_consult', { observationCount: 3 });
    await appendEvent(ledger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });
    await appendEvent(ledger, 'suggestion_acted', { observationIndex: 0 });
    await appendEvent(ledger, 'external_insert', {
      size: 500,
      location: 'paragraph 3',
      ts: '2026-06-11T12:00:00Z',
    });

    const report = await ledger.report();

    expect(report.countsByType.ai_consult).toBe(1);
    expect(report.countsByType.cloud_send).toBe(1);
    expect(report.countsByType.suggestion_acted).toBe(1);
    expect(report.countsByType.external_insert).toBe(1);
    expect(report.integrity.intact).toBe(true);
    expect(report.declarableCount).toBe(2);
    expect(report.nonDeclarableCount).toBe(2);
    expect(report.scopingNote).toBe(SCOPING_NOTE);
    expect(report.cloudSends.length).toBe(1);
    expect(report.externalInserts.length).toBe(1);
  });

  it('returns an empty report for an empty ledger', async () => {
    const report = await ledger.report();

    expect(report.countsByType.ai_consult).toBe(0);
    expect(report.integrity.intact).toBe(true);
    expect(report.declarableCount).toBe(0);
    expect(report.nonDeclarableCount).toBe(0);
    expect(report.cloudSends).toEqual([]);
    expect(report.externalInserts).toEqual([]);
  });

  it('report counts match a fixture ledger with mixed events', async () => {
    // 3 coaching sessions + 3 cloud sends + 2 suggestion_acted + 1 external + pause/resume
    for (let i = 0; i < 3; i++) {
      await appendEvent(ledger, 'ai_consult', { observationCount: 2 + i });
      await appendEvent(ledger, 'cloud_send', {
        provider: 'zai',
        model: 'glm-5.1',
        purpose: 'coaching',
        retention: '30 days',
        ts: `2026-06-11T10:0${i}:00Z`,
      });
    }
    await appendEvent(ledger, 'suggestion_acted', {});
    await appendEvent(ledger, 'suggestion_acted', {});
    await appendEvent(ledger, 'external_insert', {
      size: 200,
      location: 'intro',
      ts: '2026-06-11T14:00:00Z',
    });
    await ledger.pause();
    await ledger.resume();

    const report = await ledger.report();

    expect(report.countsByType.ai_consult).toBe(3);
    expect(report.countsByType.cloud_send).toBe(3);
    expect(report.countsByType.suggestion_acted).toBe(2);
    expect(report.countsByType.external_insert).toBe(1);
    expect(report.countsByType.ledger_paused).toBe(1);
    expect(report.countsByType.ledger_resumed).toBe(1);
    expect(report.declarableCount).toBe(6); // 3 ai_consult + 3 cloud_send
    expect(report.nonDeclarableCount).toBe(5); // 2 suggestion_acted + 1 external_insert + 1 ledger_paused + 1 ledger_resumed
  });

  it('a ledger with only grammar/non-cloud events yields a non-declarable-only report', async () => {
    await appendEvent(ledger, 'suggestion_acted', { observationIndex: 0 });
    await appendEvent(ledger, 'suggestion_acted', { observationIndex: 1 });
    await appendEvent(ledger, 'external_insert', {
      size: 200,
      location: 'intro',
      ts: '2026-06-11T10:00:00Z',
    });

    const report = await ledger.report();

    expect(report.declarableCount).toBe(0);
    expect(report.nonDeclarableCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// exportDisclosure() integration
// ---------------------------------------------------------------------------

describe('LedgerImpl.exportDisclosure() — integration', () => {
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

  it('produces the ICMJE three-element disclosure with coaching sessions', async () => {
    await appendEvent(ledger, 'ai_consult', {});
    await appendEvent(ledger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });

    const disclosure = await ledger.exportDisclosure();

    // Three ICMJE elements.
    expect(disclosure).toContain(TOOL_NAME); // 1. Tool name
    expect(disclosure).toContain('1 coaching session'); // 2. Per-use purpose
    expect(disclosure).toContain('editorial control'); // 3. Oversight extent
    expect(disclosure).toContain(SCOPING_NOTE);
  });

  it('writes a ledger checkpoint on disclosure export', async () => {
    await appendEvent(ledger, 'ai_consult', {});
    await appendEvent(ledger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });

    // Before export: no checkpoints (interval=10, only 2 events).
    const store = new LedgerStore(dir);
    expect(store.readCheckpointLines().length).toBe(0);

    await ledger.exportDisclosure();

    // After export: one checkpoint was written.
    const cpLines = store.readCheckpointLines();
    expect(cpLines.length).toBe(1);

    // Verify the checkpoint references the latest event.
    const cp = JSON.parse(cpLines[0]);
    expect(cp.seq).toBe(1); // last event is seq 1
    expect(cp.latestHash).toBeTruthy();
  });

  it('does not write a checkpoint for an empty ledger', async () => {
    const disclosure = await ledger.exportDisclosure();

    expect(disclosure).toContain('No cloud-based AI');

    const store = new LedgerStore(dir);
    expect(store.readCheckpointLines().length).toBe(0);
  });

  it('no artifact contains overclaim language', async () => {
    await appendEvent(ledger, 'ai_consult', {});
    await appendEvent(ledger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });

    const report = await ledger.report();
    const disclosure = await ledger.exportDisclosure();

    const reportText = JSON.stringify(report).toLowerCase();
    const disclosureLower = disclosure.toLowerCase();

    expect(reportText).not.toContain('verified human');
    expect(reportText).not.toContain('proof a human wrote');
    expect(disclosureLower).not.toContain('verified human');
    expect(disclosureLower).not.toContain('proof a human wrote');
  });

  it('generates a paste-ready disclosure document', async () => {
    await appendEvent(ledger, 'ai_consult', {});
    await appendEvent(ledger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });

    const disclosure = await ledger.exportDisclosure();

    // The disclosure is plain text, paste-ready.
    expect(typeof disclosure).toBe('string');
    expect(disclosure.length).toBeGreaterThan(0);
    expect(disclosure).toContain('ICMJE');
    expect(disclosure).toContain(TOOL_NAME);
  });

  it('checkpoint on export works even when auto-checkpoints are disabled', async () => {
    // Create a ledger with checkpointInterval = 0 (disabled).
    const noCpDir = makeTempDir();
    const { deps } = makeDeps(noCpDir, 0);
    const noCpLedger = new LedgerImpl(deps);

    await appendEvent(noCpLedger, 'ai_consult', {});
    await appendEvent(noCpLedger, 'cloud_send', {
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
      ts: '2026-06-11T10:00:00Z',
    });

    // No auto-checkpoints.
    const store = new LedgerStore(noCpDir);
    expect(store.readCheckpointLines().length).toBe(0);

    await noCpLedger.exportDisclosure();

    // But export still writes a checkpoint!
    const cpLines = store.readCheckpointLines();
    expect(cpLines.length).toBe(1);

    rmSync(noCpDir, { recursive: true, force: true });
  });
});
