/**
 * Unit tests for `src/friction/mirror.ts` — live process self-mirror
 * (instrument E, ADR-008, task 25).
 *
 * Tests:
 * - Composition proportions compute correctly from a fixture event stream
 * - Integrity status reflects the ledger `verify()` result
 * - Visibility follows the dial (hidden/live)
 * - No label asserts a "human score" or proof of personhood (asserted)
 * - No prose is surfaced in the mirror (metadata only)
 * - Integration: the mirror snapshot updates live without blocking
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ProcessMirror,
  MirrorViewDataProvider,
  MirrorItem,
  computeComposition,
  LABELS,
  assertNoProofOfPersonhoodLanguage,
} from '../../src/friction/mirror';
import type { ProcessMirrorDeps, CompositionSnapshot, MirrorSnapshot } from '../../src/friction/mirror';
import type { LedgerEventType, TransparencyReport } from '../../src/shared/types';
import { SCOPING_NOTE } from '../../src/ledger/report';
import { Dial } from '../../src/friction/dial';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDial(mirrorState: 'hidden' | 'live'): Dial {
  if (mirrorState === 'hidden') {
    // Level 1 (Coach): mirror = 'hidden'
    return new Dial({ level: 1, floor: 0, overrides: {} });
  } else {
    // Level 3 (Deep Work): mirror = 'live'
    return new Dial({ level: 3, floor: 0, overrides: {} });
  }
}

function zeroedCounts(): Record<LedgerEventType, number> {
  return {
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
  };
}

function makeReport(counts: Partial<Record<LedgerEventType, number>> = {}): TransparencyReport {
  const countsByType = zeroedCounts();
  for (const [key, value] of Object.entries(counts)) {
    countsByType[key as LedgerEventType] = value!;
  }
  return {
    countsByType,
    cloudSends: [],
    integrity: { intact: true },
    declarableCount: 0,
    nonDeclarableCount: 0,
    externalInserts: [],
    scopingNote: SCOPING_NOTE,
  };
}

function makeDeps(
  options: {
    mirrorState?: 'hidden' | 'live';
    report?: TransparencyReport;
    integrity?: { intact: boolean; brokenAt?: number };
  } = {},
): { deps: ProcessMirrorDeps; dial: Dial } {
  const dial = makeDial(options.mirrorState ?? 'hidden');
  const report = options.report ?? makeReport();
  const integrity = options.integrity ?? { intact: true };

  const deps: ProcessMirrorDeps = {
    dial,
    report: vi.fn(async () => report),
    verify: vi.fn(async () => integrity),
  };

  return { deps, dial };
}

// ---------------------------------------------------------------------------
// computeComposition — pure function tests
// ---------------------------------------------------------------------------

describe('computeComposition', () => {
  it('returns null when no compositional events exist', () => {
    const result = computeComposition(zeroedCounts());
    expect(result).toBeNull();
  });

  it('returns null when only operational events exist (cloud_send, paused, resumed)', () => {
    const counts = zeroedCounts();
    counts.cloud_send = 5;
    counts.ledger_paused = 2;
    counts.ledger_resumed = 2;
    const result = computeComposition(counts);
    expect(result).toBeNull();
  });

  it('computes own-bursts from suggestion_acted + teach_back + claim_captured + paste_claim', () => {
    const counts = zeroedCounts();
    counts.suggestion_acted = 3;
    counts.teach_back = 2;
    counts.claim_captured = 1;
    counts.paste_claim = 1;
    const result = computeComposition(counts);
    expect(result).not.toBeNull();
    expect(result!.ownBursts).toBe(7);
    expect(result!.total).toBe(7);
    expect(result!.ownBurstsRatio).toBe(1);
  });

  it('computes pasted/quarantined from external_insert + paste_quarantine', () => {
    const counts = zeroedCounts();
    counts.external_insert = 2;
    counts.paste_quarantine = 1;
    const result = computeComposition(counts);
    expect(result).not.toBeNull();
    expect(result!.pastedOrQuarantined).toBe(3);
    expect(result!.total).toBe(3);
    expect(result!.pastedOrQuarantinedRatio).toBe(1);
  });

  it('computes coached-on from ai_consult + push_coaching', () => {
    const counts = zeroedCounts();
    counts.ai_consult = 4;
    counts.push_coaching = 2;
    const result = computeComposition(counts);
    expect(result).not.toBeNull();
    expect(result!.coachedOn).toBe(6);
    expect(result!.total).toBe(6);
    expect(result!.coachedOnRatio).toBe(1);
  });

  it('computes mixed composition with correct proportions', () => {
    const counts = zeroedCounts();
    counts.suggestion_acted = 5;   // own
    counts.teach_back = 3;          // own
    counts.external_insert = 2;     // pasted
    counts.ai_consult = 4;          // coached
    counts.push_coaching = 1;       // coached
    const result = computeComposition(counts);

    expect(result).not.toBeNull();
    expect(result!.ownBursts).toBe(8);
    expect(result!.pastedOrQuarantined).toBe(2);
    expect(result!.coachedOn).toBe(5);
    expect(result!.total).toBe(15);
    expect(result!.ownBurstsRatio).toBeCloseTo(8 / 15);
    expect(result!.pastedOrQuarantinedRatio).toBeCloseTo(2 / 15);
    expect(result!.coachedOnRatio).toBeCloseTo(5 / 15);
  });

  it('all ratios sum to 1 when events exist', () => {
    const counts = zeroedCounts();
    counts.suggestion_acted = 10;
    counts.external_insert = 3;
    counts.ai_consult = 7;
    const result = computeComposition(counts);

    const sum = result!.ownBurstsRatio + result!.pastedOrQuarantinedRatio + result!.coachedOnRatio;
    expect(sum).toBeCloseTo(1);
  });

  it('handles a single event correctly', () => {
    const counts = zeroedCounts();
    counts.ai_consult = 1;
    const result = computeComposition(counts);

    expect(result!.ownBursts).toBe(0);
    expect(result!.pastedOrQuarantined).toBe(0);
    expect(result!.coachedOn).toBe(1);
    expect(result!.total).toBe(1);
    expect(result!.ownBurstsRatio).toBe(0);
    expect(result!.coachedOnRatio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Labels — mirror-not-grade framing (ADR-008)
// ---------------------------------------------------------------------------

describe('Labels — mirror-not-grade framing', () => {
  it('all label values pass the no-proof-of-personhood check', () => {
    const allLabels = Object.values(LABELS);
    for (const label of allLabels) {
      expect(assertNoProofOfPersonhoodLanguage(label)).toBe(true);
    }
  });

  it('viewTitle is non-judgmental', () => {
    expect(LABELS.viewTitle).toContain('mirror');
    expect(LABELS.viewTitle).not.toContain('score');
    expect(LABELS.viewTitle).not.toContain('grade');
  });

  it('scopingNote states mirror-not-grade', () => {
    expect(LABELS.scopingNote).toContain('process');
    expect(LABELS.scopingNote).toContain('not a score');
  });

  it('ownBursts label is descriptive, not evaluative', () => {
    expect(LABELS.ownBursts).toBe('Your engagement');
    expect(LABELS.ownBursts).not.toContain('good');
    expect(LABELS.ownBursts).not.toContain('bad');
    expect(LABELS.ownBursts).not.toContain('human');
  });

  it('pastedOrQuarantined label is descriptive, not evaluative', () => {
    expect(LABELS.pastedOrQuarantined).toBe('External inserts');
    expect(LABELS.pastedOrQuarantined).not.toContain('bad');
    expect(LABELS.pastedOrQuarantined).not.toContain('cheating');
  });

  it('coachedOn label is descriptive, not evaluative', () => {
    expect(LABELS.coachedOn).toBe('AI coaching');
    expect(LABELS.coachedOn).not.toContain('reliance');
    expect(LABELS.coachedOn).not.toContain('dependency');
  });
});

// ---------------------------------------------------------------------------
// assertNoProofOfPersonhoodLanguage
// ---------------------------------------------------------------------------

describe('assertNoProofOfPersonhoodLanguage', () => {
  it('returns true for clean text', () => {
    expect(assertNoProofOfPersonhoodLanguage('Your engagement: 80%')).toBe(true);
  });

  it('returns false for "human score"', () => {
    expect(assertNoProofOfPersonhoodLanguage('Your human score is 95')).toBe(false);
  });

  it('returns false for "proof of personhood"', () => {
    expect(assertNoProofOfPersonhoodLanguage('This is proof of personhood')).toBe(false);
  });

  it('returns false for "verified human"', () => {
    expect(assertNoProofOfPersonhoodLanguage('You are verified human')).toBe(false);
  });

  it('returns false for "humanness"', () => {
    expect(assertNoProofOfPersonhoodLanguage('Your humanness level')).toBe(false);
  });

  it('returns false for "grade"', () => {
    expect(assertNoProofOfPersonhoodLanguage('Your grade is A')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(assertNoProofOfPersonhoodLanguage('HUMAN SCORE: 100')).toBe(false);
    expect(assertNoProofOfPersonhoodLanguage('Proof Of Human')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProcessMirror — dial state "hidden"
// ---------------------------------------------------------------------------

describe('ProcessMirror — dial "hidden"', () => {
  it('visible returns false', () => {
    const { deps } = makeDeps({ mirrorState: 'hidden' });
    const mirror = new ProcessMirror(deps);
    expect(mirror.visible).toBe(false);
  });

  it('dialState returns "hidden"', () => {
    const { deps } = makeDeps({ mirrorState: 'hidden' });
    const mirror = new ProcessMirror(deps);
    expect(mirror.dialState).toBe('hidden');
  });

  it('snapshot returns visible:false with no composition data', async () => {
    const { deps } = makeDeps({ mirrorState: 'hidden' });
    const mirror = new ProcessMirror(deps);
    const snapshot = await mirror.snapshot();

    expect(snapshot.visible).toBe(false);
    expect(snapshot.composition).toBeNull();
    expect(snapshot.integrity.intact).toBe(true);
  });

  it('snapshot does not call report() when hidden', async () => {
    const { deps } = makeDeps({ mirrorState: 'hidden' });
    const mirror = new ProcessMirror(deps);
    await mirror.snapshot();

    expect(deps.report).not.toHaveBeenCalled();
  });

  it('snapshot does not call verify() when hidden', async () => {
    const { deps } = makeDeps({ mirrorState: 'hidden' });
    const mirror = new ProcessMirror(deps);
    await mirror.snapshot();

    expect(deps.verify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ProcessMirror — dial state "live"
// ---------------------------------------------------------------------------

describe('ProcessMirror — dial "live"', () => {
  it('visible returns true', () => {
    const { deps } = makeDeps({ mirrorState: 'live' });
    const mirror = new ProcessMirror(deps);
    expect(mirror.visible).toBe(true);
  });

  it('dialState returns "live"', () => {
    const { deps } = makeDeps({ mirrorState: 'live' });
    const mirror = new ProcessMirror(deps);
    expect(mirror.dialState).toBe('live');
  });

  it('snapshot calls report() and verify()', async () => {
    const { deps } = makeDeps({ mirrorState: 'live' });
    const mirror = new ProcessMirror(deps);
    await mirror.snapshot();

    expect(deps.report).toHaveBeenCalledOnce();
    expect(deps.verify).toHaveBeenCalledOnce();
  });

  it('snapshot returns composition when events exist', async () => {
    const report = makeReport({ suggestion_acted: 5, ai_consult: 3, external_insert: 2 });
    const { deps } = makeDeps({ mirrorState: 'live', report });
    const mirror = new ProcessMirror(deps);
    const snapshot = await mirror.snapshot();

    expect(snapshot.visible).toBe(true);
    expect(snapshot.composition).not.toBeNull();
    expect(snapshot.composition!.ownBursts).toBe(5);
    expect(snapshot.composition!.coachedOn).toBe(3);
    expect(snapshot.composition!.pastedOrQuarantined).toBe(2);
    expect(snapshot.composition!.total).toBe(10);
  });

  it('snapshot returns integrity from verify()', async () => {
    const integrity = { intact: false, brokenAt: 42 };
    const { deps } = makeDeps({ mirrorState: 'live', integrity });
    const mirror = new ProcessMirror(deps);
    const snapshot = await mirror.snapshot();

    expect(snapshot.integrity.intact).toBe(false);
    expect(snapshot.integrity.brokenAt).toBe(42);
  });

  it('snapshot returns null composition when no events exist', async () => {
    const report = makeReport();
    const { deps } = makeDeps({ mirrorState: 'live', report });
    const mirror = new ProcessMirror(deps);
    const snapshot = await mirror.snapshot();

    expect(snapshot.visible).toBe(true);
    expect(snapshot.composition).toBeNull();
  });

  it('snapshot returns intact integrity when verify succeeds', async () => {
    const { deps } = makeDeps({ mirrorState: 'live', integrity: { intact: true } });
    const mirror = new ProcessMirror(deps);
    const snapshot = await mirror.snapshot();

    expect(snapshot.integrity.intact).toBe(true);
    expect(snapshot.integrity.brokenAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProcessMirror — dynamic dial changes
// ---------------------------------------------------------------------------

describe('ProcessMirror — dynamic dial changes', () => {
  it('responds to dial changes at runtime', async () => {
    const dial = makeDial('hidden');
    const report = makeReport({ suggestion_acted: 5 });
    const deps: ProcessMirrorDeps = {
      dial,
      report: vi.fn(async () => report),
      verify: vi.fn(async () => ({ intact: true })),
    };
    const mirror = new ProcessMirror(deps);

    // Initially hidden
    expect(mirror.visible).toBe(false);
    const snapshotHidden = await mirror.snapshot();
    expect(snapshotHidden.visible).toBe(false);

    // Change to level 3 — mirror = 'live'
    dial.setLevel(3);
    expect(mirror.visible).toBe(true);

    const snapshotLive = await mirror.snapshot();
    expect(snapshotLive.visible).toBe(true);
    expect(snapshotLive.composition).not.toBeNull();
  });

  it('uses an override to force live even at level 1', async () => {
    const dial = makeDial('hidden'); // Level 1 — mirror = 'hidden'
    dial.setOverride('mirror', 'live');

    const report = makeReport({ ai_consult: 2 });
    const deps: ProcessMirrorDeps = {
      dial,
      report: vi.fn(async () => report),
      verify: vi.fn(async () => ({ intact: true })),
    };
    const mirror = new ProcessMirror(deps);

    expect(mirror.visible).toBe(true);
    const snapshot = await mirror.snapshot();
    expect(snapshot.composition).not.toBeNull();
    expect(snapshot.composition!.coachedOn).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ProcessMirror.formatSummary
// ---------------------------------------------------------------------------

describe('ProcessMirror.formatSummary', () => {
  it('formats a composition snapshot as a readable summary', () => {
    const snapshot: CompositionSnapshot = {
      ownBursts: 8,
      pastedOrQuarantined: 2,
      coachedOn: 5,
      total: 15,
      ownBurstsRatio: 8 / 15,
      pastedOrQuarantinedRatio: 2 / 15,
      coachedOnRatio: 5 / 15,
    };

    const summary = ProcessMirror.formatSummary(snapshot);

    expect(summary).toContain('53%'); // own bursts ≈ 53%
    expect(summary).toContain('13%'); // pasted ≈ 13%
    expect(summary).toContain('33%'); // coached ≈ 33%
  });

  it('formats a 100% own-bursts composition', () => {
    const snapshot: CompositionSnapshot = {
      ownBursts: 10,
      pastedOrQuarantined: 0,
      coachedOn: 0,
      total: 10,
      ownBurstsRatio: 1,
      pastedOrQuarantinedRatio: 0,
      coachedOnRatio: 0,
    };

    const summary = ProcessMirror.formatSummary(snapshot);
    expect(summary).toContain('100%');
    expect(summary).toContain('0%');
  });

  it('summary does not contain proof-of-personhood language', () => {
    const snapshot: CompositionSnapshot = {
      ownBursts: 5,
      pastedOrQuarantined: 3,
      coachedOn: 2,
      total: 10,
      ownBurstsRatio: 0.5,
      pastedOrQuarantinedRatio: 0.3,
      coachedOnRatio: 0.2,
    };

    const summary = ProcessMirror.formatSummary(snapshot);
    expect(assertNoProofOfPersonhoodLanguage(summary)).toBe(true);
  });

  it('summary does not contain any prose', () => {
    const snapshot: CompositionSnapshot = {
      ownBursts: 1,
      pastedOrQuarantined: 1,
      coachedOn: 1,
      total: 3,
      ownBurstsRatio: 1 / 3,
      pastedOrQuarantinedRatio: 1 / 3,
      coachedOnRatio: 1 / 3,
    };

    const summary = ProcessMirror.formatSummary(snapshot);
    // Should only contain labels + percentages — no sentences, no prose
    expect(summary).not.toMatch(/\.[A-Z]/); // No sentence boundaries
    expect(summary).not.toContain('You should');
    expect(summary).not.toContain('We recommend');
  });
});

// ---------------------------------------------------------------------------
// MirrorViewDataProvider — TreeView rendering
// ---------------------------------------------------------------------------

describe('MirrorViewDataProvider', () => {
  it('returns empty children when no state is set', () => {
    const provider = new MirrorViewDataProvider();
    expect(provider.getChildren()).toEqual([]);
  });

  it('returns empty children when state is hidden', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: false,
      composition: null,
      integrity: { intact: true },
    });
    expect(provider.getChildren()).toEqual([]);
  });

  it('renders composition items when visible with data', () => {
    const provider = new MirrorViewDataProvider();
    const state: MirrorSnapshot = {
      visible: true,
      composition: {
        ownBursts: 8,
        pastedOrQuarantined: 2,
        coachedOn: 5,
        total: 15,
        ownBurstsRatio: 8 / 15,
        pastedOrQuarantinedRatio: 2 / 15,
        coachedOnRatio: 5 / 15,
      },
      integrity: { intact: true },
    };

    provider.setState(state);
    const children = provider.getChildren();

    // scoping + own + pasted + coached + total + integrity = 6 items
    expect(children).toHaveLength(6);

    // First item is the scoping note
    expect(children[0].key).toBe('scoping');
    expect(children[0].label).toBe(LABELS.viewTitle);
    expect(children[0].description).toBe(LABELS.scopingNote);

    // Composition items
    expect(children[1].key).toBe('own');
    expect(children[1].description).toContain('8');
    expect(children[1].description).toContain('53%');

    expect(children[2].key).toBe('pasted');
    expect(children[2].description).toContain('2');

    expect(children[3].key).toBe('coached');
    expect(children[3].description).toContain('5');

    expect(children[4].key).toBe('total');
    expect(children[4].description).toBe('15');

    // Last item is integrity
    expect(children[5].key).toBe('integrity');
    expect(children[5].description).toContain('Intact');
  });

  it('renders empty message when visible but no composition data', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: true,
      composition: null,
      integrity: { intact: true },
    });

    const children = provider.getChildren();

    // scoping + empty + integrity = 3 items
    expect(children).toHaveLength(3);
    expect(children[1].key).toBe('empty');
    expect(children[1].description).toBe(LABELS.empty);
  });

  it('renders broken integrity status', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: true,
      composition: null,
      integrity: { intact: false, brokenAt: 42 },
    });

    const children = provider.getChildren();
    const integrityItem = children.find(c => c.key === 'integrity');
    expect(integrityItem).toBeDefined();
    expect(integrityItem!.description).toContain('Broken');
    expect(integrityItem!.description).toContain('42');
  });

  it('refresh fires change event', () => {
    const provider = new MirrorViewDataProvider();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.refresh();
    expect(fired).toBe(true);
  });

  it('setState fires change event', () => {
    const provider = new MirrorViewDataProvider();
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setState({
      visible: true,
      composition: null,
      integrity: { intact: true },
    });
    expect(fired).toBe(true);
  });

  it('getTreeItem returns the element itself', () => {
    const provider = new MirrorViewDataProvider();
    const item = new MirrorItem('test', 'Label', 'Desc', undefined);
    expect(provider.getTreeItem(item)).toBe(item);
  });

  it('no tree item contains proof-of-personhood language', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: true,
      composition: {
        ownBursts: 5,
        pastedOrQuarantined: 3,
        coachedOn: 2,
        total: 10,
        ownBurstsRatio: 0.5,
        pastedOrQuarantinedRatio: 0.3,
        coachedOnRatio: 0.2,
      },
      integrity: { intact: true },
    });

    const children = provider.getChildren();
    for (const child of children) {
      const text = `${child.label} ${child.description}`;
      expect(assertNoProofOfPersonhoodLanguage(text)).toBe(true);
    }
  });

  it('tree items have accessibility information', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: true,
      composition: null,
      integrity: { intact: true },
    });

    const children = provider.getChildren();
    for (const child of children) {
      expect(child.accessibilityInformation).toBeDefined();
      expect(child.accessibilityInformation!.role).toBe('treeitem');
      expect(child.accessibilityInformation!.label).toContain(child.label!);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: mirror updates live without blocking
// ---------------------------------------------------------------------------

describe('Mirror integration — live updates', () => {
  it('snapshot resolves quickly (non-blocking)', async () => {
    const { deps } = makeDeps({ mirrorState: 'live' });
    const mirror = new ProcessMirror(deps);

    const start = Date.now();
    const snapshot = await mirror.snapshot();
    const elapsed = Date.now() - start;

    expect(snapshot.visible).toBe(true);
    // Should resolve in under 100ms (no real I/O, just mock calls)
    expect(elapsed).toBeLessThan(100);
  });

  it('multiple snapshots reflect updated report data', async () => {
    const dial = makeDial('live');

    let reportData = makeReport({ suggestion_acted: 3 });
    const deps: ProcessMirrorDeps = {
      dial,
      report: vi.fn(async () => reportData),
      verify: vi.fn(async () => ({ intact: true })),
    };
    const mirror = new ProcessMirror(deps);

    // First snapshot — 3 own bursts
    const snap1 = await mirror.snapshot();
    expect(snap1.composition!.ownBursts).toBe(3);

    // Simulate more activity
    reportData = makeReport({ suggestion_acted: 3, ai_consult: 2, external_insert: 1 });
    const snap2 = await mirror.snapshot();
    expect(snap2.composition!.ownBursts).toBe(3);
    expect(snap2.composition!.coachedOn).toBe(2);
    expect(snap2.composition!.pastedOrQuarantined).toBe(1);
    expect(snap2.composition!.total).toBe(6);
  });

  it('view provider updates live as mirror state changes', () => {
    const provider = new MirrorViewDataProvider();

    // Initially no state
    expect(provider.getChildren()).toEqual([]);

    // Set state with composition
    provider.setState({
      visible: true,
      composition: {
        ownBursts: 10,
        pastedOrQuarantined: 0,
        coachedOn: 0,
        total: 10,
        ownBurstsRatio: 1,
        pastedOrQuarantinedRatio: 0,
        coachedOnRatio: 0,
      },
      integrity: { intact: true },
    });
    let children = provider.getChildren();
    expect(children).toHaveLength(6);
    expect(children[4].description).toBe('10');

    // Update with new data
    provider.setState({
      visible: true,
      composition: {
        ownBursts: 12,
        pastedOrQuarantined: 1,
        coachedOn: 2,
        total: 15,
        ownBurstsRatio: 12 / 15,
        pastedOrQuarantinedRatio: 1 / 15,
        coachedOnRatio: 2 / 15,
      },
      integrity: { intact: true },
    });
    children = provider.getChildren();
    expect(children[4].description).toBe('15');
  });

  it('end-to-end: dial hidden→live→hidden transitions correctly', async () => {
    const dial = makeDial('hidden');
    const report = makeReport({ suggestion_acted: 5, ai_consult: 3 });
    const deps: ProcessMirrorDeps = {
      dial,
      report: vi.fn(async () => report),
      verify: vi.fn(async () => ({ intact: true })),
    };
    const mirror = new ProcessMirror(deps);
    const provider = new MirrorViewDataProvider();

    // Hidden — empty view
    const snap1 = await mirror.snapshot();
    provider.setState(snap1);
    expect(provider.getChildren()).toEqual([]);

    // Live — shows composition
    dial.setLevel(3);
    const snap2 = await mirror.snapshot();
    provider.setState(snap2);
    expect(snap2.visible).toBe(true);
    expect(snap2.composition).not.toBeNull();
    const children = provider.getChildren();
    expect(children.length).toBeGreaterThan(0);

    // Back to hidden — empty again
    dial.setLevel(1);
    const snap3 = await mirror.snapshot();
    provider.setState(snap3);
    expect(snap3.visible).toBe(false);
    expect(provider.getChildren()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No prose surfaced — metadata only (asserted)
// ---------------------------------------------------------------------------

describe('No prose surfaced — metadata only', () => {
  it('MirrorState contains no prose fields', () => {
    const state: MirrorSnapshot = {
      visible: true,
      composition: {
        ownBursts: 5,
        pastedOrQuarantined: 2,
        coachedOn: 3,
        total: 10,
        ownBurstsRatio: 0.5,
        pastedOrQuarantinedRatio: 0.2,
        coachedOnRatio: 0.3,
      },
      integrity: { intact: true },
    };

    // Verify no prose fields exist
    const stateKeys = Object.keys(state);
    expect(stateKeys).toContain('visible');
    expect(stateKeys).toContain('composition');
    expect(stateKeys).toContain('integrity');
    expect(stateKeys).not.toContain('text');
    expect(stateKeys).not.toContain('prose');
    expect(stateKeys).not.toContain('summary');
    expect(stateKeys).not.toContain('passage');
  });

  it('CompositionSnapshot contains only numerical fields', () => {
    const comp: CompositionSnapshot = {
      ownBursts: 5,
      pastedOrQuarantined: 2,
      coachedOn: 3,
      total: 10,
      ownBurstsRatio: 0.5,
      pastedOrQuarantinedRatio: 0.2,
      coachedOnRatio: 0.3,
    };

    for (const [, value] of Object.entries(comp)) {
      expect(typeof value).toBe('number');
    }
  });

  it('tree item descriptions contain only numbers and labels', () => {
    const provider = new MirrorViewDataProvider();
    provider.setState({
      visible: true,
      composition: {
        ownBursts: 5,
        pastedOrQuarantined: 2,
        coachedOn: 3,
        total: 10,
        ownBurstsRatio: 0.5,
        pastedOrQuarantinedRatio: 0.2,
        coachedOnRatio: 0.3,
      },
      integrity: { intact: true },
    });

    const children = provider.getChildren();
    for (const child of children) {
      // Descriptions should not contain sentence-like prose
      if (child.key !== 'scoping' && child.key !== 'empty') {
        // Composition items: "5 (50%)" or "10" — no prose
        expect(child.description).not.toMatch(/^[A-Z].*\.$/); // No sentence pattern
      }
    }
  });
});
