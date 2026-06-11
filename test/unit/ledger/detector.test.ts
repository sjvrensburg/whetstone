import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, type Ed25519KeyPair } from '../../../src/shared/crypto';
import { LedgerImpl, type LedgerDeps } from '../../../src/ledger/index';
import { LedgerStore } from '../../../src/ledger/store';
import {
  ExternalInsertDetector,
  isPasteShaped,
  type ObservedChange,
} from '../../../src/ledger/detector';
import type { LedgerEvent } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'whetstone-detector-'));
}

function makeLedger(dir: string, keyPair: Ed25519KeyPair): LedgerImpl {
  const deps: LedgerDeps = {
    store: new LedgerStore(dir),
    keyProvider: () => Promise.resolve(keyPair),
    checkpointInterval: 0,
  };
  return new LedgerImpl(deps);
}

/** Build a pure-insert change (rangeLength = 0). */
function insertChange(offset: number, text: string): ObservedChange {
  return { rangeOffset: offset, rangeLength: 0, text };
}

/** Build a replacement change (rangeLength > 0). */
function replaceChange(offset: number, rangeLength: number, text: string): ObservedChange {
  return { rangeOffset: offset, rangeLength, text };
}

/** Build a delete change (rangeLength > 0, empty text). */
function deleteChange(offset: number, rangeLength: number): ObservedChange {
  return { rangeOffset: offset, rangeLength, text: '' };
}

// ---------------------------------------------------------------------------
// isPasteShaped — unit tests
// ---------------------------------------------------------------------------

describe('isPasteShaped', () => {
  const threshold = 50;

  it('flags a pure insert above the threshold', () => {
    const change = insertChange(0, 'a'.repeat(60));
    expect(isPasteShaped(change, threshold)).toBe(true);
  });

  it('flags a pure insert at exactly the threshold', () => {
    const change = insertChange(0, 'a'.repeat(50));
    expect(isPasteShaped(change, threshold)).toBe(true);
  });

  it('does not flag a pure insert below the threshold', () => {
    const change = insertChange(0, 'a'.repeat(49));
    expect(isPasteShaped(change, threshold)).toBe(false);
  });

  it('does not flag a single-character insert (typing)', () => {
    const change = insertChange(0, 'a');
    expect(isPasteShaped(change, threshold)).toBe(false);
  });

  it('does not flag an empty insert', () => {
    const change = insertChange(0, '');
    expect(isPasteShaped(change, threshold)).toBe(false);
  });

  it('does not flag a replacement even if the text is long', () => {
    const change = replaceChange(0, 10, 'a'.repeat(100));
    expect(isPasteShaped(change, threshold)).toBe(false);
  });

  it('does not flag a deletion', () => {
    const change = deleteChange(0, 100);
    expect(isPasteShaped(change, threshold)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExternalInsertDetector — unit tests
// ---------------------------------------------------------------------------

describe('ExternalInsertDetector', () => {
  let dir: string;
  let keyPair: Ed25519KeyPair;
  let ledger: LedgerImpl;
  let appendedEvents: LedgerEvent[];
  let detector: ExternalInsertDetector;

  beforeEach(() => {
    dir = makeTempDir();
    keyPair = generateKeyPair();
    ledger = makeLedger(dir, keyPair);
    appendedEvents = [];

    // Wrap the ledger to capture appended events for assertions.
    const origAppend = ledger.append.bind(ledger);
    ledger.append = async (e) => {
      await origAppend(e);
      // Read back the last event to capture the full entry with hash.
      const store = new LedgerStore(dir);
      const lines = store.readLines();
      if (lines.length > 0) {
        appendedEvents.push(JSON.parse(lines[lines.length - 1]) as LedgerEvent);
      }
    };

    detector = new ExternalInsertDetector({
      ledger,
      getThreshold: () => 50,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Unit: a single insert above threshold is flagged
  // -----------------------------------------------------------------------

  it('flags a single insert above the threshold', async () => {
    const text = 'This is a pasted paragraph with enough characters to exceed the threshold value.';
    await detector.onDocumentChange([insertChange(100, text)], 'file:///doc.md');

    expect(appendedEvents.length).toBe(1);
    expect(appendedEvents[0].type).toBe('external_insert');
  });

  // -----------------------------------------------------------------------
  // Unit: character-by-character typing below threshold is not flagged
  // -----------------------------------------------------------------------

  it('does not flag character-by-character typing below the threshold', async () => {
    // Simulate 20 single-character typing events.
    for (let i = 0; i < 20; i++) {
      await detector.onDocumentChange([insertChange(i, 'a')], 'file:///doc.md');
    }

    expect(appendedEvents.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Unit: a flagged paste records the correct size and location
  // -----------------------------------------------------------------------

  it('records the correct size and location for a flagged paste', async () => {
    const text = 'a'.repeat(75);
    await detector.onDocumentChange([insertChange(200, text)], 'file:///doc.md');

    expect(appendedEvents.length).toBe(1);
    const payload = appendedEvents[0].payload as { size: number; location: string };
    expect(payload.size).toBe(75);
    expect(payload.location).toBe('offset:200 uri:file:///doc.md');
  });

  // -----------------------------------------------------------------------
  // Unit: the emitted event payload contains no prose
  // -----------------------------------------------------------------------

  it('emits a payload with no prose (short metadata strings only)', async () => {
    const text = 'x'.repeat(100);
    await detector.onDocumentChange([insertChange(0, text)], 'file:///doc.md');

    const payload = appendedEvents[0].payload as { size: number; location: string };
    // size is a number — not prose.
    expect(typeof payload.size).toBe('number');
    // location is a short descriptor — well under the 280-char prose limit.
    expect(payload.location.length).toBeLessThan(280);
    // No text content from the document is included.
    expect(payload).not.toHaveProperty('text');
    expect(payload).not.toHaveProperty('content');
  });

  // -----------------------------------------------------------------------
  // Unit: neither event type nor labels assert AI authorship
  // -----------------------------------------------------------------------

  it('does not assert AI authorship in the event type', async () => {
    await detector.onDocumentChange([insertChange(0, 'a'.repeat(60))], 'file:///doc.md');

    expect(appendedEvents[0].type).toBe('external_insert');
    // The type name must not contain "ai", "artificial", "generated", "bot", etc.
    const typeLower = appendedEvents[0].type.toLowerCase();
    expect(typeLower).not.toContain('ai');
    expect(typeLower).not.toContain('artificial');
    expect(typeLower).not.toContain('generated');
    expect(typeLower).not.toContain('bot');
    expect(typeLower).not.toContain('authored');
  });

  it('does not assert AI authorship in the payload labels', async () => {
    await detector.onDocumentChange([insertChange(0, 'a'.repeat(60))], 'file:///doc.md');

    const payload = appendedEvents[0].payload as Record<string, unknown>;
    const payloadStr = JSON.stringify(payload).toLowerCase();
    expect(payloadStr).not.toContain('ai');
    expect(payloadStr).not.toContain('artificial');
    expect(payloadStr).not.toContain('generated');
    expect(payloadStr).not.toContain('bot');
    expect(payloadStr).not.toContain('authored');
    expect(payloadStr).not.toContain('gpt');
    expect(payloadStr).not.toContain('llm');
  });

  // -----------------------------------------------------------------------
  // Unit: replacements are not flagged even with long text
  // -----------------------------------------------------------------------

  it('does not flag a replacement even if the inserted text is long', async () => {
    const change = replaceChange(0, 20, 'a'.repeat(100));
    await detector.onDocumentChange([change], 'file:///doc.md');

    expect(appendedEvents.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Unit: deletions are not flagged
  // -----------------------------------------------------------------------

  it('does not flag deletions', async () => {
    await detector.onDocumentChange([deleteChange(0, 200)], 'file:///doc.md');

    expect(appendedEvents.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Unit: multiple changes in a single edit — only paste-shaped are flagged
  // -----------------------------------------------------------------------

  it('flags only the paste-shaped changes in a batch', async () => {
    const changes = [
      insertChange(0, 'a'), // typing — not flagged
      insertChange(1, 'b'.repeat(60)), // paste — flagged
      deleteChange(61, 5), // deletion — not flagged
      insertChange(56, 'c'.repeat(80)), // paste — flagged
    ];

    await detector.onDocumentChange(changes, 'file:///doc.md');

    expect(appendedEvents.length).toBe(2);
    expect((appendedEvents[0].payload as { size: number }).size).toBe(60);
    expect((appendedEvents[1].payload as { size: number }).size).toBe(80);
  });

  // -----------------------------------------------------------------------
  // Unit: configurable threshold
  // -----------------------------------------------------------------------

  it('respects a custom threshold from the settings accessor', async () => {
    const customDetector = new ExternalInsertDetector({
      ledger,
      getThreshold: () => 100,
    });

    // 80 chars — below custom threshold.
    await customDetector.onDocumentChange([insertChange(0, 'a'.repeat(80))], 'file:///doc.md');
    expect(appendedEvents.length).toBe(0);

    // 120 chars — above custom threshold.
    await customDetector.onDocumentChange([insertChange(0, 'a'.repeat(120))], 'file:///doc.md');
    expect(appendedEvents.length).toBe(1);
    expect((appendedEvents[0].payload as { size: number }).size).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Integration: detector + ledger pipeline
// ---------------------------------------------------------------------------

describe('ExternalInsertDetector — integration with LedgerImpl', () => {
  let dir: string;
  let keyPair: Ed25519KeyPair;
  let ledger: LedgerImpl;
  let detector: ExternalInsertDetector;

  beforeEach(() => {
    dir = makeTempDir();
    keyPair = generateKeyPair();
    ledger = makeLedger(dir, keyPair);
    detector = new ExternalInsertDetector({
      ledger,
      getThreshold: () => 50,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Read all events from the ledger store for assertions.
   */
  function readLedgerEvents(): LedgerEvent[] {
    const store = new LedgerStore(dir);
    return store.readLines().map((l) => JSON.parse(l) as LedgerEvent);
  }

  // -----------------------------------------------------------------------
  // Integration: pasting appends exactly one external_insert event
  // -----------------------------------------------------------------------

  it('pasting into a document appends exactly one external_insert event', async () => {
    const pastedText = 'This is a block of text that was pasted from an external source.';
    expect(pastedText.length).toBeGreaterThanOrEqual(50);

    await detector.onDocumentChange([insertChange(42, pastedText)], 'file:///paper.md');

    const events = readLedgerEvents();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('external_insert');
    expect(events[0].seq).toBe(0);
    expect(events[0].prevHash).toBe('');
    expect(typeof events[0].hash).toBe('string');
    expect(events[0].hash.length).toBeGreaterThan(0);

    const payload = events[0].payload as { size: number; location: string };
    expect(payload.size).toBe(pastedText.length);
    expect(payload.location).toContain('offset:42');
    expect(payload.location).toContain('file:///paper.md');
  });

  // -----------------------------------------------------------------------
  // Integration: pasted event has a valid hash chain entry
  // -----------------------------------------------------------------------

  it('the pasted event forms a valid hash chain entry', async () => {
    await detector.onDocumentChange([insertChange(0, 'a'.repeat(100))], 'file:///doc.md');

    const events = readLedgerEvents();
    expect(events.length).toBe(1);

    // Verify the hash chain is intact.
    const result = await ledger.verify();
    expect(result.intact).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Integration: rapid typing appends no external_insert events
  // -----------------------------------------------------------------------

  it('rapid typing into the document appends no external_insert events', async () => {
    // Simulate rapid typing: 50 individual single-char inserts.
    for (let i = 0; i < 50; i++) {
      await detector.onDocumentChange([insertChange(i, 'x')], 'file:///doc.md');
    }

    const events = readLedgerEvents();
    expect(events.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Integration: mixed session — typing + pastes produce correct ledger
  // -----------------------------------------------------------------------

  it('a mixed session produces correct events in sequence', async () => {
    // Some typing (no events).
    await detector.onDocumentChange([insertChange(0, 'H')], 'file:///doc.md');
    await detector.onDocumentChange([insertChange(1, 'e')], 'file:///doc.md');
    await detector.onDocumentChange([insertChange(2, 'l')], 'file:///doc.md');

    // A paste (event seq 0).
    await detector.onDocumentChange([insertChange(3, 'a'.repeat(200))], 'file:///doc.md');

    // More typing (no events).
    await detector.onDocumentChange([insertChange(203, ' ')], 'file:///doc.md');

    // Another paste (event seq 1).
    await detector.onDocumentChange([insertChange(204, 'b'.repeat(150))], 'file:///doc.md');

    const events = readLedgerEvents();
    expect(events.length).toBe(2);

    expect(events[0].seq).toBe(0);
    expect(events[0].type).toBe('external_insert');
    expect((events[0].payload as { size: number }).size).toBe(200);

    expect(events[1].seq).toBe(1);
    expect(events[1].type).toBe('external_insert');
    expect((events[1].payload as { size: number }).size).toBe(150);

    // Hash chain should be intact.
    const result = await ledger.verify();
    expect(result.intact).toBe(true);
  });
});
