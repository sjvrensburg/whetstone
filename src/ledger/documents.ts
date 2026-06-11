/**
 * Document rendering for the transparency report and ICMJE disclosure
 * (ADR-007, F6). Both are rendered as generated Markdown/text documents
 * suitable for opening in a VS Code editor tab — inherently paste-ready
 * and accessible.
 *
 * Pure functions; no I/O, no side effects, no `vscode` import.
 */

import type { TransparencyReport } from '../shared/types';
import { SCOPING_NOTE } from './report';

// ---------------------------------------------------------------------------
// Report document
// ---------------------------------------------------------------------------

/**
 * Render a `TransparencyReport` as a human-readable Markdown document.
 *
 * Sections:
 * 1. Header + scoping note
 * 2. Integrity status
 * 3. Event counts by type
 * 4. Declarable vs non-declarable split
 * 5. Cloud-send log
 * 6. External-insertion log
 */
export function renderReportDocument(report: TransparencyReport): string {
  const lines: string[] = [];

  // Header
  lines.push('# Whetstone Transparency Report');
  lines.push('');
  lines.push(`> ${SCOPING_NOTE}`);
  lines.push('');

  // Integrity status
  const integrityStatus = report.integrity.intact ? 'Intact ✓' : `Broken at event ${report.integrity.brokenAt ?? 'unknown'}`;
  lines.push('## Ledger Integrity');
  lines.push('');
  lines.push(`- **Status:** ${integrityStatus}`);
  lines.push('');

  // Event counts
  lines.push('## Event Counts');
  lines.push('');
  lines.push('| Event Type | Count |');
  lines.push('|---|---|');
  for (const [type, count] of Object.entries(report.countsByType)) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');

  // Declarable split
  lines.push('## AI Use Classification');
  lines.push('');
  lines.push(`- **Declarable (cloud AI):** ${report.declarableCount} event(s)`);
  lines.push(`- **Non-declarable (local):** ${report.nonDeclarableCount} event(s)`);
  lines.push('');

  // Cloud-send log
  if (report.cloudSends.length > 0) {
    lines.push('## Cloud Send Log');
    lines.push('');
    lines.push('| Timestamp | Provider | Model | Purpose | Retention |');
    lines.push('|---|---|---|---|---|');
    for (const cs of report.cloudSends) {
      lines.push(`| ${cs.ts} | ${cs.provider} | ${cs.model} | ${cs.purpose} | ${cs.retention} |`);
    }
    lines.push('');
  }

  // External-insertion log
  if (report.externalInserts.length > 0) {
    lines.push('## External Text Insertions');
    lines.push('');
    lines.push('> Recorded for transparency — not a claim about authorship.');
    lines.push('');
    lines.push('| Timestamp | Size (chars) | Location |');
    lines.push('|---|---|---|');
    for (const ei of report.externalInserts) {
      lines.push(`| ${ei.ts} | ${ei.size} | ${ei.location} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Disclosure document
// ---------------------------------------------------------------------------

/**
 * Render the ICMJE disclosure paragraph as a paste-ready text document.
 *
 * The disclosure is plain text (not Markdown) because it will be pasted
 * directly into a manuscript before the references section. The scoping note
 * is appended on a new line.
 */
export function renderDisclosureDocument(disclosureText: string): string {
  return disclosureText;
}
