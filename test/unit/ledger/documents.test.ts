import { describe, it, expect } from 'vitest';
import { renderReportDocument, renderDisclosureDocument } from '../../../src/ledger/documents';
import { SCOPING_NOTE } from '../../../src/ledger/report';
import type { TransparencyReport } from '../../../src/shared/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<TransparencyReport> = {}): TransparencyReport {
  return {
    countsByType: {
      ai_consult: 0,
      suggestion_acted: 0,
      external_insert: 0,
      cloud_send: 0,
      ledger_paused: 0,
      ledger_resumed: 0,
      paste_quarantine: 0,
      paste_claim: 0,
      claim_captured: 0,
      teach_back: 0,
      push_coaching: 0,
    },
    cloudSends: [],
    integrity: { intact: true },
    declarableCount: 0,
    nonDeclarableCount: 0,
    externalInserts: [],
    scopingNote: SCOPING_NOTE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderReportDocument
// ---------------------------------------------------------------------------

describe('renderReportDocument', () => {
  it('renders a Markdown document with header and scoping note', () => {
    const report = makeReport();
    const doc = renderReportDocument(report);

    expect(doc).toContain('# Whetstone Transparency Report');
    expect(doc).toContain(SCOPING_NOTE);
  });

  it('renders integrity status as intact', () => {
    const report = makeReport({ integrity: { intact: true } });
    const doc = renderReportDocument(report);

    expect(doc).toContain('Intact');
    expect(doc).toContain('## Ledger Integrity');
  });

  it('renders integrity status as broken with sequence number', () => {
    const report = makeReport({ integrity: { intact: false, brokenAt: 7 } });
    const doc = renderReportDocument(report);

    expect(doc).toContain('Broken at event 7');
  });

  it('renders event counts as a Markdown table', () => {
    const report = makeReport({
      countsByType: {
        ai_consult: 3,
        suggestion_acted: 1,
        external_insert: 0,
        cloud_send: 2,
        ledger_paused: 0,
        ledger_resumed: 0,
        paste_quarantine: 0,
        paste_claim: 0,
        claim_captured: 0,
        teach_back: 0,
      push_coaching: 0,
      },
    });
    const doc = renderReportDocument(report);

    expect(doc).toContain('## Event Counts');
    expect(doc).toContain('| ai_consult | 3 |');
    expect(doc).toContain('| suggestion_acted | 1 |');
    expect(doc).toContain('| cloud_send | 2 |');
  });

  it('renders declarable vs non-declarable classification', () => {
    const report = makeReport({
      declarableCount: 5,
      nonDeclarableCount: 2,
    });
    const doc = renderReportDocument(report);

    expect(doc).toContain('## AI Use Classification');
    expect(doc).toContain('**Declarable (cloud AI):** 5 event(s)');
    expect(doc).toContain('**Non-declarable (local):** 2 event(s)');
  });

  it('renders cloud-send log when present', () => {
    const report = makeReport({
      cloudSends: [
        {
          ts: '2026-06-11T10:00:00Z',
          provider: 'zai',
          model: 'glm-5.1',
          purpose: 'coaching',
          retention: '30 days',
        },
      ],
    });
    const doc = renderReportDocument(report);

    expect(doc).toContain('## Cloud Send Log');
    expect(doc).toContain('zai');
    expect(doc).toContain('glm-5.1');
    expect(doc).toContain('coaching');
    expect(doc).toContain('30 days');
  });

  it('omits cloud-send log when empty', () => {
    const report = makeReport({ cloudSends: [] });
    const doc = renderReportDocument(report);

    expect(doc).not.toContain('## Cloud Send Log');
  });

  it('renders external-insertion log when present', () => {
    const report = makeReport({
      externalInserts: [{ ts: '2026-06-11T12:00:00Z', size: 500, location: 'paragraph 3' }],
    });
    const doc = renderReportDocument(report);

    expect(doc).toContain('## External Text Insertions');
    expect(doc).toContain('Recorded for transparency');
    expect(doc).toContain('500');
    expect(doc).toContain('paragraph 3');
  });

  it('omits external-insertion log when empty', () => {
    const report = makeReport({ externalInserts: [] });
    const doc = renderReportDocument(report);

    expect(doc).not.toContain('## External Text Insertions');
  });

  it('no artifact contains "verified human" / "proof a human wrote" language', () => {
    const report = makeReport({
      countsByType: {
        ai_consult: 3,
        suggestion_acted: 0,
        external_insert: 0,
        cloud_send: 3,
        ledger_paused: 0,
        ledger_resumed: 0,
        paste_quarantine: 0,
        paste_claim: 0,
        claim_captured: 0,
        teach_back: 0,
      push_coaching: 0,
      },
      cloudSends: [
        {
          ts: '2026-06-11T10:00:00Z',
          provider: 'zai',
          model: 'glm-5.1',
          purpose: 'coaching',
          retention: '30 days',
        },
      ],
      externalInserts: [{ ts: '2026-06-11T12:00:00Z', size: 500, location: 'p3' }],
    });
    const doc = renderReportDocument(report);

    const lower = doc.toLowerCase();
    expect(lower).not.toContain('verified human');
    expect(lower).not.toContain('proof a human wrote');
    expect(lower).not.toContain('proof of humanity');
    expect(lower).not.toContain('human wrote this');
  });
});

// ---------------------------------------------------------------------------
// renderDisclosureDocument
// ---------------------------------------------------------------------------

describe('renderDisclosureDocument', () => {
  it('returns the disclosure text as-is (paste-ready)', () => {
    const text = 'The author(s) used Whetstone for coaching.';
    const doc = renderDisclosureDocument(text);

    expect(doc).toBe(text);
  });

  it('preserves the full ICMJE disclosure without modification', () => {
    const text =
      'The author(s) used Whetstone for 2 coaching sessions. ' +
      'The author(s) reviewed all AI-generated coaching suggestions. ' +
      SCOPING_NOTE;
    const doc = renderDisclosureDocument(text);

    expect(doc).toBe(text);
    expect(doc).toContain('Whetstone');
    expect(doc).toContain(SCOPING_NOTE);
  });
});
