import { describe, expect, it } from 'vitest';
import { hasNoForbiddenLabels } from '../src/core/labels';
import { computeMirror, formatMirrorSummary, MIRROR_LABELS } from '../src/core/mirror';
import type { ProcessEvent, ProcessEventType } from '../src/service/types';

let n = 0;
const ev = (type: ProcessEventType, extra: Partial<ProcessEvent> = {}): ProcessEvent => ({
  id: `e${++n}`,
  ts: '2026-06-11T10:00:00.000Z',
  type,
  ...extra,
});

describe('computeMirror', () => {
  it('combines composition with coach-consult counts', () => {
    const snapshot = computeMirror([
      ev('typing_burst', { size: 300 }),
      ev('paste_quarantined', { size: 100, meta: { regionId: 'r1' } }),
      ev('coach_consult', { meta: { refused: false, provider: 'zai', model: 'glm-5.1' } }),
      ev('coach_consult', { meta: { refused: true, layer: 'schema' } }),
    ]);
    expect(snapshot.composition.typedChars).toBe(300);
    expect(snapshot.coachConsults).toBe(1);
    expect(snapshot.coachRefused).toBe(1);
  });
});

describe('formatMirrorSummary', () => {
  it('reads as a mirror, not a grade', () => {
    const summary = formatMirrorSummary(
      computeMirror([
        ev('typing_burst', { size: 300 }),
        ev('paste_quarantined', { size: 100, meta: { regionId: 'r1' } }),
        ev('coach_consult', { meta: { refused: false } }),
      ]),
    );
    expect(summary).toContain(`${MIRROR_LABELS.typed}: 75%`);
    expect(summary).toContain(`${MIRROR_LABELS.unresolved}: 1`);
    expect(summary).toContain(`${MIRROR_LABELS.coached}: 1`);
  });

  it('every mirror label passes the forbidden-label guard', () => {
    for (const label of Object.values(MIRROR_LABELS)) {
      expect(hasNoForbiddenLabels(label)).toBe(true);
    }
  });
});
