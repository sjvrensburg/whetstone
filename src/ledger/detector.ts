/**
 * External-text-insertion detector — watches the document-change stream and
 * records paste-shaped inserts as `external_insert` ledger events (ADR-006).
 *
 * The heuristic is deliberately simple and honest: a single change inserting
 * more than a configurable threshold of characters with no replacement range
 * is classified as "paste-shaped." This never asserts AI authorship — the
 * event records size and location metadata only (ADR-006: record, don't
 * certify).
 *
 * Pure logic; no `vscode` import. The caller wires this to
 * `onDidChangeTextDocument` in extension.ts (task 17).
 */

import type { Ledger } from '../shared/types';

// ---------------------------------------------------------------------------
// Observed change — the detector's input
// ---------------------------------------------------------------------------

/**
 * A single text-document content change observed from the editor. This is the
 * subset of `vscode.TextDocumentContentChangeEvent` the detector needs,
 * stripped of the VS Code dependency so the logic is unit-testable.
 */
export interface ObservedChange {
  /** Character offset where the change starts. */
  readonly rangeOffset: number;
  /** Length of text being replaced. 0 for a pure insert. */
  readonly rangeLength: number;
  /** The text inserted (or replacing the range). */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Paste-shape heuristic
// ---------------------------------------------------------------------------

/**
 * Classify a single content change as paste-shaped or incremental.
 *
 * A paste-shaped change is a pure insert (`rangeLength === 0`) where the
 * inserted text exceeds the threshold. This naturally excludes:
 * - Character-by-character typing (1 char at a time)
 * - Deletions (empty or short `text`)
 * - Replacements (`rangeLength > 0`)
 */
export function isPasteShaped(change: ObservedChange, threshold: number): boolean {
  return change.rangeLength === 0 && change.text.length >= threshold;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/** Dependencies injected into the detector for testability. */
export interface DetectorDeps {
  /** The ledger to append events to. */
  readonly ledger: Ledger;
  /** Returns the current character threshold for paste detection. */
  readonly getThreshold: () => number;
}

/**
 * Observes document changes and records paste-shaped inserts as
 * `external_insert` ledger events. Each event carries only size and location
 * metadata — no prose, no authorship claim.
 */
export class ExternalInsertDetector {
  constructor(private readonly deps: DetectorDeps) {}

  /**
   * Process a batch of content changes from a single document edit.
   * For each paste-shaped change, appends an `external_insert` event.
   *
   * @param changes - The content changes from one document edit.
   * @param documentUri - The URI of the document that changed (for location).
   */
  async onDocumentChange(changes: readonly ObservedChange[], documentUri: string): Promise<void> {
    const threshold = this.deps.getThreshold();

    for (const change of changes) {
      if (!isPasteShaped(change, threshold)) {
        continue;
      }

      await this.deps.ledger.append({
        ts: new Date().toISOString(),
        type: 'external_insert',
        payload: {
          size: change.text.length,
          location: `offset:${change.rangeOffset} uri:${documentUri}`,
        },
      });
    }
  }
}
