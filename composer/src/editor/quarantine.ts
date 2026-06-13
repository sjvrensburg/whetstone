/**
 * Paste-quarantine — instrument B (walking-skeleton spec §5).
 *
 * Hooks CodeMirror's paste path: a paste of ≥ PASTE_THRESHOLD chars is
 * inserted but visibly marked (decoration). The mark clears two ways:
 *
 *   - **Claim-to-own** — the writer revises the region until little of the
 *     ORIGINAL survives in the current text (audit-corrected containment
 *     direction; see `core/ownership.ts`) → `paste_claimed`.
 *   - **Attribute** — wrap the region as a quotation with a citation
 *     placeholder → `paste_attributed` (honestly disclosed, not owned).
 *
 * Because the composer owns its own paste event (`input.paste` user-event
 * annotation), quarantine sees real pastes — no diff-shape guessing (the V1
 * detector's false-positive/negative class disappears).
 *
 * Structure: a `transactionExtender` turns qualifying pastes into `addRegion`
 * effects on the SAME transaction; a `StateField` tracks regions (mapped
 * through edits) and provides decorations; an update listener journals events
 * and runs the claim check, deferring its `clearRegion` dispatch to a
 * microtask (dispatch-during-update is not allowed).
 */

import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { isClaimedToOwn, survivalRatio } from '../core/ownership';
import type { ProcessEventInput } from '../service/types';
import type { EmitEvent } from './typingBurst';

/** Pastes at or above this many chars are quarantined (spec §5). */
export const PASTE_THRESHOLD = 40;

/** A tracked quarantined span. Positions live in the current document. */
export interface QuarantineRegion {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  /** The original pasted text — kept for the survival comparison only. */
  readonly originalText: string;
}

export interface QuarantineOptions {
  emit: EmitEvent;
  threshold?: number;
  idGenerator?: () => string;
}

export interface Quarantine {
  extension: Extension;
  /** Attribute a region: wrap as quotation + citation placeholder, clear the mark. */
  attribute(view: EditorView, regionId: string): boolean;
  /** Current regions (unclaimed, unattributed) in a state. */
  getRegions(state: EditorState): readonly QuarantineRegion[];
}

// ---------------------------------------------------------------------------
// Effects & field
// ---------------------------------------------------------------------------

export const addRegion = StateEffect.define<QuarantineRegion>({
  map: (r, m) => ({ ...r, from: m.mapPos(r.from, -1), to: m.mapPos(r.to, 1) }),
});

export const clearRegion = StateEffect.define<string>();

/**
 * Region positions are mapped inclusively (insertions at either boundary join
 * the region) so in-place rewriting keeps the region covering the writer's
 * revision. Regions whose text is entirely deleted vanish here; the listener
 * journals them as claimed (survival 0).
 */
export const quarantineField = StateField.define<readonly QuarantineRegion[]>({
  create: () => [],
  update(regions, tr) {
    let next = regions;
    if (tr.docChanged) {
      next = next
        .map((r) => ({
          ...r,
          from: tr.changes.mapPos(r.from, -1),
          to: tr.changes.mapPos(r.to, 1),
        }))
        .filter((r) => r.to > r.from);
    }
    for (const e of tr.effects) {
      if (e.is(addRegion)) {
        next = [...next, e.value];
      } else if (e.is(clearRegion)) {
        next = next.filter((r) => r.id !== e.value);
      }
    }
    return next;
  },
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Inserted spans of a transaction, in new-document coordinates. */
export function insertedSpans(tr: Transaction): { from: number; to: number; text: string }[] {
  const spans: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    spans.push({ from: fromB, to: toB, text: inserted.toString() });
  });
  return spans;
}

/** Decide which pre-existing regions a finished edit claimed or merely revised. */
export function classifyRevisions(
  before: readonly QuarantineRegion[],
  after: readonly QuarantineRegion[],
  tr: Transaction,
  doc: { sliceString(from: number, to: number): string },
): { claimed: QuarantineRegion[]; revised: { region: QuarantineRegion; survival: number }[] } {
  const beforeIds = new Set(before.map((r) => r.id));
  const claimed: QuarantineRegion[] = [];
  const revised: { region: QuarantineRegion; survival: number }[] = [];

  for (const r of after) {
    if (!beforeIds.has(r.id)) continue; // added by this very transaction — skip
    let touched = false;
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (fromB <= r.to && toB >= r.from) touched = true;
    });
    if (!touched) continue;

    const current = doc.sliceString(r.from, r.to);
    if (isClaimedToOwn(current, r.originalText)) {
      claimed.push(r);
    } else {
      revised.push({ region: r, survival: survivalRatio(current, r.originalText) });
    }
  }

  return { claimed, revised };
}

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

export function createQuarantine(options: QuarantineOptions): Quarantine {
  const { emit } = options;
  const threshold = options.threshold ?? PASTE_THRESHOLD;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());

  // --- attribution -------------------------------------------------------

  function attribute(view: EditorView, regionId: string): boolean {
    const region = view.state.field(quarantineField).find((r) => r.id === regionId);
    if (!region) return false;

    view.dispatch({
      changes: [
        { from: region.from, insert: '"' },
        { from: region.to, insert: '" (citation needed)' },
      ],
      effects: clearRegion.of(region.id),
    });

    emit({
      type: 'paste_attributed',
      size: region.to - region.from,
      location: { from: region.from, to: region.to },
      meta: { regionId: region.id },
    });
    return true;
  }

  // --- decorations -------------------------------------------------------

  class AttributeWidget extends WidgetType {
    constructor(private readonly regionId: string) {
      super();
    }
    override eq(other: AttributeWidget): boolean {
      return other.regionId === this.regionId;
    }
    toDOM(view: EditorView): HTMLElement {
      const btn = document.createElement('button');
      btn.className = 'ws-attribute-btn';
      btn.type = 'button';
      btn.textContent = 'quote it';
      btn.title =
        'Pasted text — rewrite it in your own words to claim it, or mark it as a quotation';
      btn.onmousedown = (ev) => {
        ev.preventDefault();
        attribute(view, this.regionId);
      };
      return btn;
    }
    override ignoreEvent(): boolean {
      return false;
    }
  }

  function buildDecorations(regions: readonly QuarantineRegion[]): DecorationSet {
    const ranges = regions.flatMap((r) => [
      Decoration.mark({ class: 'ws-quarantine' }).range(r.from, r.to),
      Decoration.widget({ widget: new AttributeWidget(r.id), side: 1 }).range(r.to),
    ]);
    return Decoration.set(ranges, true);
  }

  const decorations = EditorView.decorations.compute([quarantineField], (state) =>
    buildDecorations(state.field(quarantineField)),
  );

  // --- paste interception (same-transaction effects) ----------------------

  const pasteExtender = EditorState.transactionExtender.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent('input.paste')) return null;

    const effects: StateEffect<QuarantineRegion>[] = [];
    for (const span of insertedSpans(tr)) {
      if (span.text.length >= threshold) {
        effects.push(
          addRegion.of({
            id: idGenerator(),
            from: span.from,
            to: span.to,
            originalText: span.text,
          }),
        );
      }
    }
    return effects.length > 0 ? { effects } : null;
  });

  // --- journaling + claim check -------------------------------------------

  const listener = EditorView.updateListener.of((update) => {
    const pendingEvents: ProcessEventInput[] = [];
    const toClear: QuarantineRegion[] = [];

    for (const tr of update.transactions) {
      // Journal pastes (every real paste; quarantined ones additionally).
      if (tr.isUserEvent('input.paste')) {
        for (const span of insertedSpans(tr)) {
          pendingEvents.push({
            type: 'paste_detected',
            size: span.text.length,
            location: { from: span.from, to: span.to },
          });
        }
        for (const e of tr.effects) {
          if (e.is(addRegion)) {
            pendingEvents.push({
              type: 'paste_quarantined',
              size: e.value.to - e.value.from,
              location: { from: e.value.from, to: e.value.to },
              meta: { regionId: e.value.id },
            });
          }
        }
      }

      if (!tr.docChanged) continue;

      const before = tr.startState.field(quarantineField, false) ?? [];
      const after = tr.state.field(quarantineField, false) ?? [];

      // Regions cleared by an explicit effect (attribution) are already journaled.
      const explicitlyCleared = new Set(
        tr.effects.filter((e) => e.is(clearRegion)).map((e) => e.value as string),
      );

      // Regions that vanished because their text was deleted: survival 0 → claimed.
      const afterIds = new Set(after.map((r) => r.id));
      for (const r of before) {
        if (!afterIds.has(r.id) && !explicitlyCleared.has(r.id)) {
          pendingEvents.push({
            type: 'paste_claimed',
            size: 0,
            meta: { regionId: r.id, survival: 0, deleted: true },
          });
        }
      }

      const { claimed, revised } = classifyRevisions(before, after, tr, tr.state.doc);
      for (const r of claimed) {
        toClear.push(r);
        pendingEvents.push({
          type: 'paste_claimed',
          size: r.to - r.from,
          location: { from: r.from, to: r.to },
          meta: {
            regionId: r.id,
            survival: survivalRatio(tr.state.doc.sliceString(r.from, r.to), r.originalText),
          },
        });
      }
      for (const { region, survival } of revised) {
        pendingEvents.push({
          type: 'region_revised',
          size: region.to - region.from,
          location: { from: region.from, to: region.to },
          meta: { regionId: region.id, survival },
        });
      }
    }

    for (const e of pendingEvents) emit(e);

    if (toClear.length > 0) {
      const view = update.view;
      // Dispatching inside an update callback is illegal; defer one microtask.
      queueMicrotask(() => {
        const live = new Set(view.state.field(quarantineField).map((r) => r.id));
        const effects = toClear.filter((r) => live.has(r.id)).map((r) => clearRegion.of(r.id));
        if (effects.length > 0) view.dispatch({ effects });
      });
    }
  });

  return {
    extension: [quarantineField, decorations, pasteExtender, listener],
    attribute,
    getRegions: (state) => state.field(quarantineField),
  };
}
