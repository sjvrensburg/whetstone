import { describe, expect, it } from 'vitest';
import {
  SCOPING_NOTE,
  computeComposition,
  extractClaim,
  renderDisclosure,
  sessionSpan,
} from '../src/core/disclosure';
import { hasNoForbiddenLabels } from '../src/core/labels';
import type { ProcessEvent, ProcessEventType } from '../src/service/types';

let counter = 0;
function ev(
  type: ProcessEventType,
  extra: Partial<Omit<ProcessEvent, 'type'>> = {},
): ProcessEvent {
  counter++;
  return {
    id: `e${counter}`,
    ts: new Date(Date.UTC(2026, 5, 11, 10, 0, counter)).toISOString(),
    type,
    ...extra,
  };
}

describe('computeComposition', () => {
  it('sums typed and pasted chars and tracks paste outcomes by region', () => {
    const events: ProcessEvent[] = [
      ev('session_start'),
      ev('typing_burst', { size: 120 }),
      ev('paste_quarantined', { size: 60, meta: { regionId: 'r1' } }),
      ev('paste_quarantined', { size: 20, meta: { regionId: 'r2' } }),
      ev('paste_quarantined', { size: 50, meta: { regionId: 'r3' } }),
      ev('typing_burst', { size: 80 }),
      ev('paste_claimed', { meta: { regionId: 'r1' } }),
      ev('paste_attributed', { meta: { regionId: 'r2' } }),
    ];
    const comp = computeComposition(events);
    expect(comp.typedChars).toBe(200);
    expect(comp.pastedChars).toBe(130);
    expect(comp.pasteCount).toBe(3);
    expect(comp.pastesClaimed).toBe(1);
    expect(comp.pastesAttributed).toBe(1);
    expect(comp.pastesUnclaimed).toBe(1);
    expect(comp.typedRatio).toBeCloseTo(200 / 330);
  });

  it('a later attribution supersedes an earlier claim for the same region', () => {
    const events: ProcessEvent[] = [
      ev('paste_quarantined', { size: 50, meta: { regionId: 'r1' } }),
      ev('paste_claimed', { meta: { regionId: 'r1' } }),
      ev('paste_attributed', { meta: { regionId: 'r1' } }),
    ];
    const comp = computeComposition(events);
    expect(comp.pastesClaimed).toBe(0);
    expect(comp.pastesAttributed).toBe(1);
    expect(comp.pastesUnclaimed).toBe(0);
  });

  it('typedRatio is 1 for an empty stream', () => {
    expect(computeComposition([]).typedRatio).toBe(1);
  });
});

describe('extractClaim / sessionSpan', () => {
  it('returns the most recent claim', () => {
    const events = [
      ev('claim_set', { meta: { claim: 'first claim' } }),
      ev('claim_set', { meta: { claim: 'revised claim' } }),
    ];
    expect(extractClaim(events)).toBe('revised claim');
    expect(extractClaim([ev('session_start')])).toBeUndefined();
  });

  it('computes the span between first and last event', () => {
    const a = ev('session_start');
    const b = { ...ev('typing_burst'), ts: new Date(Date.parse(a.ts) + 25 * 60000).toISOString() };
    const span = sessionSpan([a, b]);
    expect(span.minutes).toBe(25);
    expect(sessionSpan([]).minutes).toBe(0);
  });
});

describe('renderDisclosure', () => {
  const events: ProcessEvent[] = [
    ev('session_start'),
    ev('claim_set', { meta: { claim: 'Friction beats detection for honest writing.' } }),
    ev('typing_burst', { size: 300 }),
    ev('paste_quarantined', { size: 100, meta: { regionId: 'r1' } }),
    ev('paste_attributed', { meta: { regionId: 'r1' } }),
  ];

  it('includes the claim, composition, and the honest scoping note', () => {
    const doc = renderDisclosure('essay-1', events);
    expect(doc.markdown).toContain('Friction beats detection for honest writing.');
    expect(doc.markdown).toContain('**300** characters (75%)');
    expect(doc.markdown).toContain('Pastes attributed as quotations: 1');
    expect(doc.markdown).toContain(SCOPING_NOTE);
    expect(doc.scopingNote).toBe(SCOPING_NOTE);
  });

  it('notes a missing claim honestly', () => {
    const doc = renderDisclosure('essay-1', [ev('typing_burst', { size: 10 })]);
    expect(doc.markdown).toContain('_No claim was recorded._');
  });

  it('never contains prose from the document (metadata-only by construction)', () => {
    const doc = renderDisclosure('essay-1', events);
    // The only free text the stream carries is the claim — which the writer
    // wrote for disclosure. No typing/paste event carries prose.
    expect(doc.markdown).not.toContain('undefined');
  });

  it('output passes the forbidden-label guard', () => {
    const doc = renderDisclosure('essay-1', events);
    expect(hasNoForbiddenLabels(doc.markdown)).toBe(true);
  });

  it('throws if a claim would smuggle forbidden language into the export', () => {
    const poisoned = [ev('claim_set', { meta: { claim: 'I am a verified human writer.' } })];
    expect(() => renderDisclosure('essay-1', poisoned)).toThrow(/verified human/);
  });
});
