// @vitest-environment jsdom
/**
 * Integration tests for the quarantine instrument through a real EditorView:
 * journaling of paste events, the deferred claim-clearing dispatch, and the
 * attribute-as-quotation flow.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createQuarantine, type Quarantine } from '../src/editor/quarantine';
import type { ProcessEventInput } from '../src/service/types';

const LONG_PASTE =
  'The industrial revolution fundamentally transformed European labor markets ' +
  'by displacing artisanal production with mechanized factory systems.';

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function setup(): { view: EditorView; events: ProcessEventInput[]; quarantine: Quarantine } {
  const events: ProcessEventInput[] = [];
  let n = 0;
  const quarantine = createQuarantine({
    emit: (e) => events.push(e),
    idGenerator: () => `region-${++n}`,
  });
  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions: quarantine.extension }),
    parent: document.body,
  });
  views.push(view);
  return { view, events, quarantine };
}

const microtasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('quarantine through an EditorView', () => {
  it('journals paste_detected and paste_quarantined for a big paste', () => {
    const { view, events } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });

    const types = events.map((e) => e.type);
    expect(types).toContain('paste_detected');
    expect(types).toContain('paste_quarantined');
    const q = events.find((e) => e.type === 'paste_quarantined')!;
    expect(q.size).toBe(LONG_PASTE.length);
    expect(q.location).toEqual({ from: 0, to: LONG_PASTE.length });
    expect(q.meta?.regionId).toBe('region-1');
    // METADATA ONLY — the journal never carries the pasted prose.
    expect(JSON.stringify(events)).not.toContain('industrial revolution');
  });

  it('journals paste_detected but not paste_quarantined for a small paste', () => {
    const { view, events } = setup();
    view.dispatch({ changes: { from: 0, insert: 'tiny' }, userEvent: 'input.paste' });
    expect(events.map((e) => e.type)).toEqual(['paste_detected']);
  });

  it('marks the region with a decoration and renders the attribute affordance', () => {
    const { view } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });
    expect(view.dom.querySelector('.ws-quarantine')).toBeTruthy();
    expect(view.dom.querySelector('.ws-attribute-btn')).toBeTruthy();
  });

  it('clears the mark and journals paste_claimed after a genuine rewrite', async () => {
    const { view, events, quarantine } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });

    const rewrite =
      'Mechanized factories displaced craft workshops, and that shift reshaped how ' +
      'Europeans found and kept work during industrialization.';
    view.dispatch({
      changes: { from: 0, to: LONG_PASTE.length, insert: rewrite },
      userEvent: 'input.type',
    });
    await microtasks(); // the clearRegion dispatch is deferred

    expect(quarantine.getRegions(view.state)).toHaveLength(0);
    const claim = events.find((e) => e.type === 'paste_claimed');
    expect(claim?.meta?.regionId).toBe('region-1');
    expect(view.dom.querySelector('.ws-quarantine')).toBeFalsy();
  });

  it('journals region_revised (not claimed) for the padding attack', async () => {
    const { view, events, quarantine } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });

    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert:
          ' Plus a long run of my own padding words that say nothing about the pasted claim at all.',
      },
      userEvent: 'input.type',
    });
    await microtasks();

    expect(quarantine.getRegions(view.state)).toHaveLength(1);
    expect(events.some((e) => e.type === 'region_revised')).toBe(true);
    expect(events.some((e) => e.type === 'paste_claimed')).toBe(false);
  });

  it('journals paste_claimed (deleted) when the pasted text is removed wholesale', async () => {
    const { view, events } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });
    view.dispatch({ changes: { from: 0, to: LONG_PASTE.length }, userEvent: 'delete' });
    await microtasks();

    const claim = events.find((e) => e.type === 'paste_claimed');
    expect(claim?.meta?.deleted).toBe(true);
  });

  it('attribute() wraps the region as a quotation with a citation placeholder', () => {
    const { view, events, quarantine } = setup();
    view.dispatch({ changes: { from: 0, insert: LONG_PASTE }, userEvent: 'input.paste' });

    const ok = quarantine.attribute(view, 'region-1');
    expect(ok).toBe(true);
    expect(view.state.doc.toString()).toBe(`"${LONG_PASTE}" (citation needed)`);
    expect(quarantine.getRegions(view.state)).toHaveLength(0);
    expect(events.some((e) => e.type === 'paste_attributed')).toBe(true);
    // Attribution must not double-journal as a claim.
    expect(events.some((e) => e.type === 'paste_claimed')).toBe(false);
  });

  it('attribute() returns false for an unknown region', () => {
    const { view, quarantine } = setup();
    expect(quarantine.attribute(view, 'nope')).toBe(false);
  });
});
