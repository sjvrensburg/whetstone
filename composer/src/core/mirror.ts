/**
 * Live process self-mirror — instrument E, ported/reframed from V1
 * `src/friction/mirror.ts` for the metadata-only process journal.
 *
 * Surfaces the writer's own process back to them, live. Framing invariant
 * (ADR-008 honest-claim constraint): no label implies a "human score" or
 * proof of personhood; metadata only; the mirror reflects, never grades.
 */

import { computeComposition, type Composition } from './disclosure';
import type { ProcessEvent } from '../service/types';

export interface MirrorSnapshot {
  readonly composition: Composition;
  /** Coaching consults that returned observations. */
  readonly coachConsults: number;
  /** Consults the guard or provider refused (still disclosed activity). */
  readonly coachRefused: number;
}

export function computeMirror(events: ProcessEvent[]): MirrorSnapshot {
  let coachConsults = 0;
  let coachRefused = 0;
  for (const e of events) {
    if (e.type !== 'coach_consult') continue;
    if (e.meta?.refused === true) coachRefused++;
    else coachConsults++;
  }
  return { composition: computeComposition(events), coachConsults, coachRefused };
}

/**
 * Mirror labels — descriptive and non-judgmental; they describe what
 * happened, not whether the writer was "good". Tests run the forbidden-label
 * guard over every value here.
 */
export const MIRROR_LABELS = {
  typed: 'Typed by you',
  pasted: 'Pasted from outside',
  unresolved: 'Pastes still marked',
  coached: 'Coaching consults',
  scopingNote: 'This reflects your writing process — it is not a score.',
} as const;

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** One-line summary for the mirror panel. */
export function formatMirrorSummary(snapshot: MirrorSnapshot): string {
  const { composition: c } = snapshot;
  const parts = [
    `${MIRROR_LABELS.typed}: ${pct(c.typedRatio)}`,
    `${MIRROR_LABELS.pasted}: ${pct(1 - c.typedRatio)}`,
  ];
  if (c.pastesUnclaimed > 0) {
    parts.push(`${MIRROR_LABELS.unresolved}: ${c.pastesUnclaimed}`);
  }
  if (snapshot.coachConsults + snapshot.coachRefused > 0) {
    parts.push(`${MIRROR_LABELS.coached}: ${snapshot.coachConsults + snapshot.coachRefused}`);
  }
  return parts.join(' · ');
}
