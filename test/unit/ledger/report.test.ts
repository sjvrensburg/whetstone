import { describe, it, expect } from 'vitest';
import {
  computeReport,
  SCOPING_NOTE,
  DECLARABLE_TYPES,
} from '../../../src/ledger/report';
import type { LedgerEvent, LedgerEventType, TransparencyReport } from '../../../src/shared/types';
import { chainHash } from '../../../src/shared/crypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a valid genesis LedgerEvent with the given type and payload. */
function makeEvent(
  seq: number,
  type: LedgerEventType,
  payload: unknown = {},
  prevHash: string = '',
): LedgerEvent {
  const entry = { seq, ts: `2026-06-11T10:00:0${seq}Z`, type, payload, prevHash };
  const hash = chainHash(entry);
  return { ...entry, hash };
}

/** Build a chain of events where each links to the previous. */
function makeEventChain(
  specs: Array<{ type: LedgerEventType; payload?: unknown }>,
): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let prevHash = '';
  for (let i = 0; i < specs.length; i++) {
    const event = makeEvent(i, specs[i].type, specs[i].payload ?? {}, prevHash);
    events.push(event);
    prevHash = event.hash;
  }
  return events;
}

const INTACT = { intact: true } as const;
const BROKEN = { intact: false, brokenAt: 3 } as const;

// ---------------------------------------------------------------------------
// computeReport — basic shape
// ---------------------------------------------------------------------------

describe('computeReport — basic shape', () => {
  it('returns a valid TransparencyReport for an empty ledger', () => {
    const report = computeReport([], INTACT);

    expect(report.scopingNote).toBe(SCOPING_NOTE);
    expect(report.integrity).toEqual(INTACT);
    expect(report.declarableCount).toBe(0);
    expect(report.nonDeclarableCount).toBe(0);
    expect(report.cloudSends).toEqual([]);
    expect(report.externalInserts).toEqual([]);

    // All counts zero.
    for (const count of Object.values(report.countsByType)) {
      expect(count).toBe(0);
    }
  });

  it('includes the scoping note on every report', () => {
    const report = computeReport([], INTACT);
    expect(report.scopingNote).toContain('evidence of process');
    expect(report.scopingNote).toContain('not proof');
    expect(report.scopingNote).not.toContain('verified human');
    expect(report.scopingNote).not.toContain('proof a human wrote');
  });

  it('passes through the integrity status unchanged', () => {
    const broken = computeReport([], BROKEN);
    expect(broken.integrity).toEqual(BROKEN);
    expect(broken.integrity.intact).toBe(false);
    expect(broken.integrity.brokenAt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeReport — counts by type
// ---------------------------------------------------------------------------

describe('computeReport — counts by type', () => {
  it('counts events correctly across all types', () => {
    const events = makeEventChain([
      { type: 'ai_consult' },
      { type: 'ai_consult' },
      { type: 'cloud_send' },
      { type: 'suggestion_acted' },
      { type: 'external_insert' },
      { type: 'ledger_paused' },
      { type: 'ledger_resumed' },
    ]);

    const report = computeReport(events, INTACT);

    expect(report.countsByType.ai_consult).toBe(2);
    expect(report.countsByType.cloud_send).toBe(1);
    expect(report.countsByType.suggestion_acted).toBe(1);
    expect(report.countsByType.external_insert).toBe(1);
    expect(report.countsByType.ledger_paused).toBe(1);
    expect(report.countsByType.ledger_resumed).toBe(1);
  });

  it('counts match a fixture ledger with mixed events', () => {
    const events = makeEventChain([
      { type: 'ai_consult', payload: { observationCount: 3 } },
      { type: 'cloud_send', payload: { provider: 'zai', model: 'glm-5.1', purpose: 'coaching', retention: '30 days', ts: '2026-06-11T10:00:00Z' } },
      { type: 'ai_consult', payload: { observationCount: 2 } },
      { type: 'cloud_send', payload: { provider: 'zai', model: 'glm-5.1', purpose: 'coaching', retention: '30 days', ts: '2026-06-11T11:00:00Z' } },
      { type: 'suggestion_acted', payload: { observationIndex: 0 } },
      { type: 'external_insert', payload: { size: 500, location: 'paragraph 3', ts: '2026-06-11T12:00:00Z' } },
      { type: 'ledger_paused', payload: {} },
      { type: 'ledger_resumed', payload: {} },
    ]);

    const report = computeReport(events, INTACT);

    expect(report.countsByType.ai_consult).toBe(2);
    expect(report.countsByType.cloud_send).toBe(2);
    expect(report.countsByType.suggestion_acted).toBe(1);
    expect(report.countsByType.external_insert).toBe(1);
    expect(report.countsByType.ledger_paused).toBe(1);
    expect(report.countsByType.ledger_resumed).toBe(1);

    // Total: 8 events
    const total = Object.values(report.countsByType).reduce((a, b) => a + b, 0);
    expect(total).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// computeReport — declarable vs non-declarable
// ---------------------------------------------------------------------------

describe('computeReport — declarable vs non-declarable split', () => {
  it('a ledger with only grammar/non-cloud events yields a non-declarable-only report', () => {
    // "Grammar events" = events that don't involve cloud AI.
    // Local grammar itself doesn't produce ledger entries, but suggestion_acted
    // and lifecycle events are non-declarable.
    const events = makeEventChain([
      { type: 'suggestion_acted', payload: { observationIndex: 0 } },
      { type: 'suggestion_acted', payload: { observationIndex: 1 } },
      { type: 'external_insert', payload: { size: 200, location: 'intro', ts: '2026-06-11T10:00:00Z' } },
      { type: 'ledger_paused', payload: {} },
    ]);

    const report = computeReport(events, INTACT);

    expect(report.declarableCount).toBe(0);
    expect(report.nonDeclarableCount).toBe(4);
  });

  it('ai_consult and cloud_send are declarable; everything else is not', () => {
    const events = makeEventChain([
      { type: 'ai_consult' },          // declarable
      { type: 'cloud_send' },          // declarable
      { type: 'suggestion_acted' },    // non-declarable
      { type: 'external_insert' },     // non-declarable
      { type: 'ledger_paused' },       // non-declarable
      { type: 'ledger_resumed' },      // non-declarable
    ]);

    const report = computeReport(events, INTACT);
    expect(report.declarableCount).toBe(2);
    expect(report.nonDeclarableCount).toBe(4);
  });

  it('DECLARABLE_TYPES contains exactly ai_consult and cloud_send', () => {
    expect(DECLARABLE_TYPES.has('ai_consult')).toBe(true);
    expect(DECLARABLE_TYPES.has('cloud_send')).toBe(true);
    expect(DECLARABLE_TYPES.has('suggestion_acted')).toBe(false);
    expect(DECLARABLE_TYPES.has('external_insert')).toBe(false);
    expect(DECLARABLE_TYPES.has('ledger_paused')).toBe(false);
    expect(DECLARABLE_TYPES.has('ledger_resumed')).toBe(false);
    expect(DECLARABLE_TYPES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeReport — cloud-send log
// ---------------------------------------------------------------------------

describe('computeReport — cloud-send log', () => {
  it('extracts CloudSendLogEntry from cloud_send events', () => {
    const events = makeEventChain([
      {
        type: 'cloud_send',
        payload: {
          ts: '2026-06-11T10:00:00Z',
          provider: 'zai',
          model: 'glm-5.1',
          purpose: 'coaching',
          retention: '30 days',
        },
      },
      {
        type: 'cloud_send',
        payload: {
          ts: '2026-06-11T11:00:00Z',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          purpose: 'judge',
          retention: 'not stored',
        },
      },
    ]);

    const report = computeReport(events, INTACT);

    expect(report.cloudSends.length).toBe(2);
    expect(report.cloudSends[0]).toEqual({
      ts: '2026-06-11T10:00:00Z',
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
      retention: '30 days',
    });
    expect(report.cloudSends[1]).toEqual({
      ts: '2026-06-11T11:00:00Z',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      purpose: 'judge',
      retention: 'not stored',
    });
  });

  it('skips malformed cloud_send payloads', () => {
    const events = makeEventChain([
      { type: 'cloud_send', payload: { provider: 'zai' } }, // missing fields
      { type: 'cloud_send', payload: 'not-an-object' },
      { type: 'cloud_send', payload: null },
    ]);

    const report = computeReport(events, INTACT);
    expect(report.cloudSends.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeReport — external-insertion log
// ---------------------------------------------------------------------------

describe('computeReport — external-insertion log', () => {
  it('extracts ExternalInsertLogEntry from external_insert events', () => {
    const events = makeEventChain([
      {
        type: 'external_insert',
        payload: { ts: '2026-06-11T10:00:00Z', size: 500, location: 'paragraph 3' },
      },
      {
        type: 'external_insert',
        payload: { ts: '2026-06-11T11:00:00Z', size: 1200, location: 'section 2' },
      },
    ]);

    const report = computeReport(events, INTACT);

    expect(report.externalInserts.length).toBe(2);
    expect(report.externalInserts[0]).toEqual({
      ts: '2026-06-11T10:00:00Z',
      size: 500,
      location: 'paragraph 3',
    });
    expect(report.externalInserts[1]).toEqual({
      ts: '2026-06-11T11:00:00Z',
      size: 1200,
      location: 'section 2',
    });
  });

  it('skips malformed external_insert payloads', () => {
    const events = makeEventChain([
      { type: 'external_insert', payload: { size: 100 } }, // missing ts, location
      { type: 'external_insert', payload: null },
    ]);

    const report = computeReport(events, INTACT);
    expect(report.externalInserts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeReport — no overclaim
// ---------------------------------------------------------------------------

describe('computeReport — no overclaim language', () => {
  it('the scoping note never asserts "verified human" or "proof a human wrote"', () => {
    expect(SCOPING_NOTE).not.toContain('verified human');
    expect(SCOPING_NOTE).not.toContain('proof a human wrote');
    expect(SCOPING_NOTE).not.toContain('proof of humanity');
  });

  it('no field in the report contains overclaim language', () => {
    const events = makeEventChain([
      { type: 'ai_consult', payload: { observationCount: 3 } },
      { type: 'cloud_send', payload: { ts: '2026-06-11T10:00:00Z', provider: 'zai', model: 'glm-5.1', purpose: 'coaching', retention: '30 days' } },
    ]);
    const report = computeReport(events, INTACT);

    const serialized = JSON.stringify(report).toLowerCase();
    expect(serialized).not.toContain('verified human');
    expect(serialized).not.toContain('proof a human wrote');
    expect(serialized).not.toContain('proof of humanity');
  });
});
