import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  PASTE_THRESHOLD,
  classifyRevisions,
  createQuarantine,
  quarantineField,
} from '../src/editor/quarantine';
import type { ProcessEventInput } from '../src/service/types';

const LONG_PASTE =
  'The industrial revolution fundamentally transformed European labor markets ' +
  'by displacing artisanal production with mechanized factory systems.';

function setup() {
  const events: ProcessEventInput[] = [];
  let n = 0;
  const quarantine = createQuarantine({
    emit: (e) => events.push(e),
    idGenerator: () => `region-${++n}`,
  });
  const state = EditorState.create({ doc: '', extensions: quarantine.extension });
  return { events, quarantine, state };
}

function paste(state: EditorState, at: number, text: string): EditorState {
  return state.update({
    changes: { from: at, insert: text },
    userEvent: 'input.paste',
  }).state;
}

describe('paste interception (transactionExtender, headless)', () => {
  it(`quarantines a paste of >= ${PASTE_THRESHOLD} chars in the same transaction`, () => {
    const { state, quarantine } = setup();
    const next = paste(state, 0, LONG_PASTE);

    const regions = quarantine.getRegions(next);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ from: 0, to: LONG_PASTE.length, originalText: LONG_PASTE });
  });

  it('lets small pastes (a word, a citation key) pass untouched', () => {
    const { state, quarantine } = setup();
    const next = paste(state, 0, 'short snippet');
    expect(quarantine.getRegions(next)).toHaveLength(0);
  });

  it('ignores typed input entirely', () => {
    const { state, quarantine } = setup();
    const next = state.update({
      changes: { from: 0, insert: LONG_PASTE },
      userEvent: 'input.type',
    }).state;
    expect(quarantine.getRegions(next)).toHaveLength(0);
  });

  it('quarantines each qualifying span of a multi-range paste', () => {
    const { state, quarantine } = setup();
    const base = state.update({
      changes: { from: 0, insert: 'one two three four five six' },
    }).state;
    const next = base.update({
      changes: [
        { from: 0, insert: LONG_PASTE },
        { from: base.doc.length, insert: LONG_PASTE },
      ],
      userEvent: 'input.paste',
    }).state;
    expect(quarantine.getRegions(next)).toHaveLength(2);
  });
});

describe('region mapping through edits', () => {
  it('shifts a region when text is inserted before it', () => {
    const { state, quarantine } = setup();
    let s = state.update({
      changes: { from: 0, insert: 'Intro. ' },
      userEvent: 'input.type',
    }).state;
    s = paste(s, 'Intro. '.length, LONG_PASTE);
    s = s.update({ changes: { from: 0, insert: 'NEW ' }, userEvent: 'input.type' }).state;

    const [region] = quarantine.getRegions(s);
    expect(region.from).toBe('NEW Intro. '.length);
    expect(region.to).toBe('NEW Intro. '.length + LONG_PASTE.length);
  });

  it('grows the region for an insertion at its exact start boundary (inclusive mapping)', () => {
    const { state, quarantine } = setup();
    let s = paste(state, 0, LONG_PASTE);
    s = s.update({ changes: { from: 0, insert: 'Intro. ' }, userEvent: 'input.type' }).state;

    const [region] = quarantine.getRegions(s);
    expect(region.from).toBe(0);
    expect(region.to).toBe('Intro. '.length + LONG_PASTE.length);
  });

  it('grows the region for edits inside it (inclusive mapping)', () => {
    const { state, quarantine } = setup();
    let s = paste(state, 0, LONG_PASTE);
    s = s.update({ changes: { from: 10, insert: 'XYZ' }, userEvent: 'input.type' }).state;

    const [region] = quarantine.getRegions(s);
    expect(region.to - region.from).toBe(LONG_PASTE.length + 3);
  });

  it('drops a region whose text is deleted entirely', () => {
    const { state, quarantine } = setup();
    let s = paste(state, 0, LONG_PASTE);
    s = s.update({ changes: { from: 0, to: LONG_PASTE.length }, userEvent: 'delete' }).state;
    expect(quarantine.getRegions(s)).toHaveLength(0);
  });
});

describe('classifyRevisions (claim-to-own, audit-corrected)', () => {
  it('keeps an in-place-padded paste unclaimed (the V1 padding attack)', () => {
    const { state } = setup();
    let s = paste(state, 0, LONG_PASTE);
    const before = s.field(quarantineField);

    const padding =
      ' In my view this matters a great deal for how we think about work and history today, ' +
      'and many other aspects of social and economic life across many countries and eras.';
    const tr = s.update({
      changes: { from: LONG_PASTE.length, insert: padding },
      userEvent: 'input.type',
    });

    const { claimed, revised } = classifyRevisions(
      before,
      tr.state.field(quarantineField),
      tr,
      tr.state.doc,
    );
    expect(claimed).toHaveLength(0);
    expect(revised).toHaveLength(1);
    expect(revised[0].survival).toBe(1);
  });

  it('claims a region once the original is genuinely rewritten', () => {
    const { state } = setup();
    const s = paste(state, 0, LONG_PASTE);
    const before = s.field(quarantineField);

    const rewrite =
      'Mechanized factories displaced craft workshops, and that shift reshaped how ' +
      'Europeans found and kept work during industrialization.';
    const tr = s.update({
      changes: { from: 0, to: LONG_PASTE.length, insert: rewrite },
      userEvent: 'input.type',
    });

    const { claimed, revised } = classifyRevisions(
      before,
      tr.state.field(quarantineField),
      tr,
      tr.state.doc,
    );
    expect(claimed).toHaveLength(1);
    expect(revised).toHaveLength(0);
  });

  it('does not classify regions added by the same transaction', () => {
    const { state } = setup();
    const tr = state.update({
      changes: { from: 0, insert: LONG_PASTE },
      userEvent: 'input.paste',
    });
    const { claimed, revised } = classifyRevisions(
      [],
      tr.state.field(quarantineField),
      tr,
      tr.state.doc,
    );
    expect(claimed).toHaveLength(0);
    expect(revised).toHaveLength(0);
  });

  it('leaves untouched regions alone', () => {
    const { state } = setup();
    const s = paste(state, 0, LONG_PASTE);
    const before = s.field(quarantineField);

    const tr = s.update({
      changes: { from: s.doc.length, insert: ' tail typing far away' },
      userEvent: 'input.type',
    });
    // Inclusive end-mapping means an insert at the exact boundary joins the
    // region — so type past a separator first.
    const tr2 = tr.state.update({
      changes: { from: tr.state.doc.length, insert: ' more' },
      userEvent: 'input.type',
    });

    const { claimed } = classifyRevisions(
      before,
      tr2.state.field(quarantineField),
      tr2,
      tr2.state.doc,
    );
    expect(claimed).toHaveLength(0);
  });
});
