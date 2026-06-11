import { describe, it, expect } from 'vitest';
import { isStructuredCoaching } from '../../src/coaching/schema';
import type {
  Brief,
  CoachingRequest,
  DocumentContext,
  GuardResult,
  GuardVerdict,
  Ledger,
  LedgerEvent,
  Observation,
  StructuredCoaching,
  TransparencyReport,
} from '../../src/shared/types';

const report: TransparencyReport = {
  countsByType: {
    ai_consult: 1,
    suggestion_acted: 0,
    external_insert: 0,
    cloud_send: 1,
    ledger_paused: 0,
    ledger_resumed: 0,
    paste_quarantine: 0,
    paste_claim: 0,
  },
  cloudSends: [
    {
      ts: '2026-06-10T00:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      purpose: 'coaching',
      retention: 'not retained',
    },
  ],
  integrity: { intact: true },
  declarableCount: 1,
  nonDeclarableCount: 0,
  externalInserts: [],
  scopingNote: 'Evidence of process — not proof a human wrote this.',
};

describe('shared domain types', () => {
  it('models a coaching request with an optional brief', () => {
    const brief: Brief = {
      purposeClaim: 'Argue X causes Y',
      updatedAt: '2026-06-10T00:00:00.000Z',
    };
    const request: CoachingRequest = {
      selectionText: 'A tangled paragraph.',
      anchorBase: 42,
      brief,
      documentLanguage: 'latex',
    };
    expect(request.brief?.purposeClaim).toBe('Argue X causes Y');
    expect(request.documentLanguage).toBe('latex');
  });

  it('models an anchored observation and structured coaching', () => {
    const observation: Observation = {
      anchor: { start: 0, end: 10 },
      kind: 'logic_fork',
      reflection: 'The argument branches here without resolving the alternative.',
      question: 'Which branch carries your thesis?',
    };
    const coaching: StructuredCoaching = { observations: [observation] };
    expect(isStructuredCoaching(coaching)).toBe(true);
  });

  it('models guard verdicts and the result discriminated union', () => {
    const pass: GuardResult = { ok: true, coaching: { observations: [] } };
    const fail: GuardResult = { ok: false, reason: 'paste-ready prose', layer: 'judge' };
    const verdict: GuardVerdict = { refused: true, reason: 'rewrite detected' };
    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(verdict.refused).toBe(true);
  });

  it('models a ledger event with the hash-chain shape', () => {
    const genesis: LedgerEvent = {
      seq: 0,
      ts: '2026-06-10T00:00:00.000Z',
      type: 'ai_consult',
      payload: { provider: 'anthropic' },
      prevHash: '',
      hash: 'sha256-...',
    };
    expect(genesis.prevHash).toBe('');
    expect(genesis.type).toBe('ai_consult');
  });

  it('models the read-side transparency report', () => {
    expect(report.countsByType.ai_consult).toBe(1);
    expect(report.scopingNote).toMatch(/process/);
  });

  it('models the document context and Ledger service surface', () => {
    const context: DocumentContext = { selectionText: 'x', documentLanguage: 'markdown' };
    const appended: Array<Omit<LedgerEvent, 'seq' | 'prevHash' | 'hash'>> = [];
    const ledger: Ledger = {
      append: async (event) => {
        appended.push(event);
      },
      verify: async () => ({ intact: true }),
      report: async () => report,
      exportDisclosure: async () => 'ICMJE disclosure paragraph',
    };
    expect(context.documentLanguage).toBe('markdown');
    return Promise.all([
      ledger.append({ ts: report.cloudSends[0].ts, type: 'cloud_send', payload: {} }),
      ledger.verify(),
      ledger.report(),
      ledger.exportDisclosure(),
    ]).then(([, integrity, builtReport, disclosure]) => {
      expect(appended).toHaveLength(1);
      expect(integrity.intact).toBe(true);
      expect(builtReport).toBe(report);
      expect(disclosure).toContain('ICMJE');
    });
  });

  it('re-exports the new surface from the shared and coaching barrels', async () => {
    const shared = await import('../../src/shared');
    const coaching = await import('../../src/coaching');
    expect(shared.OBSERVATION_KINDS).toEqual(['implicit_claim', 'intended_move', 'logic_fork']);
    expect(coaching.COACHING_JSON_SCHEMA).toBeDefined();
    expect(typeof coaching.isStructuredCoaching).toBe('function');
  });
});
