/**
 * Disclosure export — render a human-readable "how this was written" record
 * from the process-event stream (walking-skeleton spec §6).
 *
 * Metadata-only by construction: the input stream never contains prose, so
 * neither can the output. The forbidden-label guard runs over the rendered
 * document before it is returned.
 */

import type { DisclosureDoc, ProcessEvent } from '../service/types';
import { assertNoForbiddenLabels } from './labels';

/**
 * The honest scoping note (spec §6) — friction, not proof (ADR-009).
 */
export const SCOPING_NOTE =
  'This is a record of how the piece was written in Whetstone — evidence of process, ' +
  'not proof of authorship. The record is local and self-reported.';

/** Composition breakdown derivable from the metadata-only event stream. */
export interface Composition {
  /** Characters typed in the composer (sum of typing_burst sizes). */
  typedChars: number;
  /** Characters pasted at-or-above the quarantine threshold. */
  pastedChars: number;
  /** Of the quarantined pastes: how many were rewritten until owned. */
  pastesClaimed: number;
  /** Of the quarantined pastes: how many were attributed as quotations. */
  pastesAttributed: number;
  /** Quarantined pastes whose mark was never cleared. */
  pastesUnclaimed: number;
  /** Total quarantined paste count. */
  pasteCount: number;
  /** Fraction of (typed + pasted) chars that were typed. 1 when nothing entered. */
  typedRatio: number;
}

/** Compute the composition breakdown from a document's event stream. */
export function computeComposition(events: ProcessEvent[]): Composition {
  let typedChars = 0;
  let pastedChars = 0;
  let pasteCount = 0;
  const resolved = new Map<string, 'claimed' | 'attributed'>();
  const quarantined = new Set<string>();

  for (const e of events) {
    const regionId = typeof e.meta?.regionId === 'string' ? e.meta.regionId : undefined;
    switch (e.type) {
      case 'typing_burst':
        typedChars += e.size ?? 0;
        break;
      case 'paste_quarantined':
        pastedChars += e.size ?? 0;
        pasteCount++;
        if (regionId) quarantined.add(regionId);
        break;
      case 'paste_claimed':
        if (regionId) resolved.set(regionId, 'claimed');
        break;
      case 'paste_attributed':
        if (regionId) resolved.set(regionId, 'attributed');
        break;
    }
  }

  let pastesClaimed = 0;
  let pastesAttributed = 0;
  for (const outcome of resolved.values()) {
    if (outcome === 'claimed') pastesClaimed++;
    else pastesAttributed++;
  }
  const pastesUnclaimed = Math.max(0, pasteCount - pastesClaimed - pastesAttributed);

  const total = typedChars + pastedChars;
  return {
    typedChars,
    pastedChars,
    pastesClaimed,
    pastesAttributed,
    pastesUnclaimed,
    pasteCount,
    typedRatio: total === 0 ? 1 : typedChars / total,
  };
}

/** The stated claim, from the most recent `claim_set` event (if any). */
export function extractClaim(events: ProcessEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'claim_set' && typeof e.meta?.claim === 'string') {
      return e.meta.claim;
    }
  }
  return undefined;
}

/** Session span (first event → last event), human-readable. */
export function sessionSpan(events: ProcessEvent[]): { start?: string; end?: string; minutes: number } {
  if (events.length === 0) return { minutes: 0 };
  const start = events[0].ts;
  const end = events[events.length - 1].ts;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return { start, end, minutes: Math.max(0, Math.round(ms / 60000)) };
}

/** Summary of cloud-coaching usage, derived from `coach_consult` events. */
export function summarizeCoaching(events: ProcessEvent[]): {
  total: number;
  refused: number;
  providers: string[];
} {
  let total = 0;
  let refused = 0;
  const providers = new Set<string>();
  for (const e of events) {
    if (e.type !== 'coach_consult') continue;
    total++;
    if (e.meta?.refused === true) refused++;
    if (typeof e.meta?.provider === 'string' && typeof e.meta?.model === 'string') {
      providers.add(`${e.meta.provider}: ${e.meta.model}`);
    }
  }
  return { total, refused, providers: [...providers] };
}

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * Render the disclosure document. Throws if the result would contain
 * proof-of-personhood language (forbidden-label guard, spec §6).
 */
export function renderDisclosure(docId: string, events: ProcessEvent[]): DisclosureDoc {
  const claim = extractClaim(events);
  const comp = computeComposition(events);
  const span = sessionSpan(events);

  const lines: string[] = [
    '# How this was written',
    '',
    `Document: \`${docId}\``,
  ];

  if (span.start && span.end) {
    lines.push(`Session: ${span.start} → ${span.end} (~${span.minutes} min)`);
  }

  lines.push('', '## Stated claim', '');
  lines.push(claim ? `> ${claim}` : '_No claim was recorded._');

  lines.push('', '## AI assistance', '');
  const coaching = summarizeCoaching(events);
  if (coaching.total === 0) {
    lines.push('No AI assistance was used.');
  } else {
    const consultPhrase = coaching.total === 1 ? '1 coaching consult' : `${coaching.total} coaching consults`;
    lines.push(
      `- ${consultPhrase} (${coaching.providers.join('; ')}). Coaching returns structural ` +
        'observations and questions only; the tool does not write or rewrite prose.',
    );
    if (coaching.refused > 0) {
      lines.push(`- ${coaching.refused} response(s) were withheld by the coaching guard.`);
    }
  }

  lines.push('', '## Composition', '');
  lines.push(`- Typed in the composer: **${comp.typedChars}** characters (${pct(comp.typedRatio)})`);
  lines.push(`- Pasted from outside: **${comp.pastedChars}** characters (${pct(1 - comp.typedRatio)})`);
  if (comp.pasteCount > 0) {
    lines.push(`  - Pastes rewritten until owned: ${comp.pastesClaimed}`);
    lines.push(`  - Pastes attributed as quotations: ${comp.pastesAttributed}`);
    lines.push(`  - Pastes still marked (unresolved): ${comp.pastesUnclaimed}`);
  }

  lines.push('', '## Scope of this record', '');
  lines.push(SCOPING_NOTE);

  const markdown = lines.join('\n');
  assertNoForbiddenLabels(markdown, 'disclosure export');

  return { markdown, scopingNote: SCOPING_NOTE };
}
