/**
 * ICMJE-style AI-use disclosure paragraph computation — a read-side function
 * over the ledger (ADR-006, ADR-002, F6).
 *
 * Produces a paste-ready paragraph with the three ICMJE elements:
 *   1. Tool name
 *   2. Per-use purpose
 *   3. Oversight extent
 *
 * Plus the honest scoping line ("evidence of process, not proof of
 * personhood"). Distinguishes declarable cloud coaching from non-declarable
 * local grammar (ADR-002).
 *
 * Pure function; no I/O, no side effects, no `vscode` import.
 */

import type { LedgerEvent } from '../shared/types';
import { SCOPING_NOTE } from './report';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The tool name as it appears in the disclosure. */
export const TOOL_NAME = 'Whetstone';

/** Human-readable description of what the tool does (no prose generation). */
export const TOOL_DESCRIPTION =
  'a VS Code writing-coach extension that provides Socratic coaching questions ' +
  'and structural observations about argument clarity; it does not generate prose and does not rewrite prose';

/** The oversight description — author retains full editorial control. */
export const OVERSIGHT_DESCRIPTION =
  'The author(s) reviewed all AI-generated coaching suggestions and retained ' +
  'full editorial control over all writing and editorial decisions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique provider+model pairs observed in cloud_send events. */
export interface ProviderUsage {
  provider: string;
  model: string;
  purpose: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract unique provider+model+purpose tuples from cloud_send events.
 * Deduplicates so each provider-model combination appears once.
 */
function extractProviderUsages(events: LedgerEvent[]): ProviderUsage[] {
  const seen = new Set<string>();
  const usages: ProviderUsage[] = [];

  for (const event of events) {
    if (event.type !== 'cloud_send') {
      continue;
    }
    const p = event.payload as Record<string, unknown> | null;
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p.provider !== 'string' ||
      typeof p.model !== 'string' ||
      typeof p.purpose !== 'string'
    ) {
      continue;
    }
    const key = `${p.provider}|${p.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      usages.push({
        provider: p.provider as string,
        model: p.model as string,
        purpose: p.purpose as string,
      });
    }
  }

  return usages;
}

/** Count the number of `ai_consult` events (coaching sessions). */
function countConsultations(events: LedgerEvent[]): number {
  return events.filter((e) => e.type === 'ai_consult').length;
}

/** Format provider usages into a human-readable list. */
function formatProviders(usages: ProviderUsage[]): string {
  if (usages.length === 0) {
    return 'no cloud AI';
  }

  return usages.map((u) => `${u.provider} (${u.model}) for ${u.purpose}`).join('; ');
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

/**
 * Compute a paste-ready ICMJE-style AI-use disclosure paragraph.
 *
 * The paragraph contains:
 * 1. **Tool name**: "Whetstone, a VS Code writing-coach extension"
 * 2. **Per-use purpose**: how many coaching sessions, which provider/model
 * 3. **Oversight extent**: the author reviewed all suggestions, full control
 *
 * Followed by the honest scoping note.
 *
 * @param events  All events parsed from `ledger.jsonl`.
 * @returns  The disclosure paragraph, ready to paste before a manuscript's
 *           references.
 */
export function computeDisclosureText(events: LedgerEvent[]): string {
  const sessions = countConsultations(events);
  const usages = extractProviderUsages(events);
  const providerList = formatProviders(usages);

  if (sessions === 0) {
    // No cloud AI coaching occurred — local grammar only (non-declarable).
    return [
      `The author(s) used ${TOOL_NAME}, ${TOOL_DESCRIPTION}, during the preparation of this manuscript.`,
      `No cloud-based AI assistance was used; all assistance was local (grammar checking only).`,
      `${OVERSIGHT_DESCRIPTION}.`,
      SCOPING_NOTE,
    ].join(' ');
  }

  const sessionPhrase = sessions === 1 ? '1 coaching session' : `${sessions} coaching sessions`;

  return [
    `The author(s) used ${TOOL_NAME}, ${TOOL_DESCRIPTION}, for ${sessionPhrase} during the preparation of this manuscript.`,
    `Cloud-based AI assistance was provided by ${providerList}.`,
    `${OVERSIGHT_DESCRIPTION}.`,
    `This statement is provided in accordance with ICMJE recommendations on artificial intelligence.`,
    SCOPING_NOTE,
  ].join(' ');
}
