/**
 * Paste quarantine & claim-to-own — instrument B (ADR-008, task 21).
 *
 * Turns the passive external-insert detector into active friction:
 *   - Paste-shaped / external text enters **visibly marked** and logged.
 *   - At "quarantine" dial: must be **claimed-to-own** (rewritten in the
 *     writer's words, n-gram overlap below threshold) to lose the mark.
 *   - At "block" dial: best-effort — immediately detect, mark, offer
 *     quote-wrap / extract. True pre-insertion blocking is a composer-only
 *     capability (ADR-008 surface boundary).
 *   - The tool never rewrites for the writer — it only marks and gates.
 *
 * Builds on the document-change detector (task 08) and the n-gram overlap
 * heuristic from the guard (task 10). Reads dial state from `task 20`.
 * Records quarantine/claim events to the ledger.
 *
 * Pure logic; no `vscode` import. The caller wires this to
 * `onDidChangeTextDocument` in extension.ts.
 */

import { extractNgrams, ngramOverlap } from '../guard/deterministic';
import type { Ledger } from '../shared/types';
import type { PasteHandlingState } from './presets';
import { isPasteShaped, type ObservedChange } from '../ledger/detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tracked quarantine region — a paste-shaped insert that has been marked
 * and may require claim-to-own before the mark clears.
 */
export interface QuarantineRegion {
  /** Unique identifier for this region. */
  readonly id: string;
  /** Character offset where the paste starts in the document. */
  readonly offset: number;
  /** Length of the pasted text at time of insertion. */
  readonly length: number;
  /** The original pasted text (needed for claim-to-own comparison). */
  readonly originalText: string;
  /** Whether the writer has claimed ownership (meaningful rewrite). */
  claimed: boolean;
  /** ISO 8601 timestamp of when the region was quarantined. */
  readonly createdAt: string;
}

/**
 * A decoration for a quarantined region — non-alarming, theme-aware metadata
 * that the host (extension.ts) maps to a VS Code diagnostic/decoration.
 */
export interface PasteDecoration {
  /** The region being decorated. */
  readonly region: QuarantineRegion;
  /** The current paste-handling state driving the decoration. */
  readonly dialState: PasteHandlingState;
  /** A non-alarming human-readable message for the mark. */
  readonly message: string;
}

/**
 * Result of a block-mode action — what the host should do with blocked text.
 * In block mode, the tool cannot truly prevent paste insertion (VS Code host
 * limitation); instead it detects immediately and suggests containment.
 */
export interface BlockModeSuggestion {
  /** The action the host should take. */
  readonly action: 'quote_wrap' | 'extract';
  /** The original pasted text. */
  readonly originalText: string;
  /** Offset where the paste occurred. */
  readonly offset: number;
  /** Length of the pasted text. */
  readonly length: number;
}

/**
 * Dependencies injected for testability.
 */
export interface PasteQuarantineDeps {
  /** The friction dial — reads `pasteHandling` instrument state. */
  readonly dial: { instrumentState(name: 'pasteHandling'): PasteHandlingState };
  /** The ledger — receives quarantine/claim events. */
  readonly ledger: Ledger;
  /** Returns the current character threshold for paste detection. */
  readonly getThreshold: () => number;
  /** Returns the current ISO timestamp (injectable for tests). */
  readonly now: () => string;
  /** Generates unique IDs for quarantine regions (injectable for tests). */
  readonly idGenerator: () => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default overlap threshold for claim-to-own. If ≥50% of the current text's
 * trigrams appear in the original paste, it is NOT yet "owned" — the writer
 * hasn't meaningfully rewritten it. Below this threshold = claimed.
 */
export const CLAIM_OVERLAP_THRESHOLD = 0.5;

/**
 * N-gram size for the claim-to-own overlap check. Trigrams (n=3) match the
 * guard's overlap heuristic.
 */
export const CLAIM_NGRAM_SIZE = 3;

/**
 * Minimum number of words in the current text to produce meaningful trigrams.
 * Shorter texts cannot produce enough n-grams for a reliable overlap score
 * and are automatically considered "claimed" (they're too short to be
 * concerning as unoriginal prose).
 */
export const MIN_WORDS_FOR_OVERLAP = 3;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Compute the n-gram overlap ratio between current text and the original paste.
 * Reuses the guard's `extractNgrams` and `ngramOverlap` (task 10).
 *
 * Returns a value in [0, 1]: 0 means no overlap (fully rewritten),
 * 1 means identical n-gram profile.
 */
export function computeRewriteOverlap(currentText: string, originalText: string): number {
  const currentNgrams = extractNgrams(currentText, CLAIM_NGRAM_SIZE);
  const originalNgrams = extractNgrams(originalText, CLAIM_NGRAM_SIZE);

  if (currentNgrams.size === 0) return 0;

  return ngramOverlap(currentNgrams, originalNgrams);
}

/**
 * Check whether a region has been "claimed-to-own" — i.e. the writer has
 * meaningfully rewritten the original pasted text.
 *
 * A region is claimed when the n-gram overlap drops below the threshold,
 * meaning the current text is sufficiently different from the original.
 * Very short texts (fewer than MIN_WORDS_FOR_OVERLAP words) are automatically
 * claimed because they can't produce enough n-grams for a meaningful check.
 */
export function isClaimedToOwn(
  currentText: string,
  originalText: string,
  threshold: number = CLAIM_OVERLAP_THRESHOLD,
): boolean {
  const words = currentText.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
  if (words.length < MIN_WORDS_FOR_OVERLAP) {
    return true; // Too short to be meaningful unoriginal prose
  }

  const overlap = computeRewriteOverlap(currentText, originalText);
  return overlap < threshold;
}

/**
 * Create a non-alarming decoration message for a quarantine mark.
 * The message is different per dial state to guide the writer appropriately.
 */
export function decorationMessage(dialState: PasteHandlingState): string {
  switch (dialState) {
    case 'flag':
      return 'External text detected';
    case 'quarantine':
      return 'Quarantined — rewrite in your own words to claim';
    case 'block':
      return 'External text — consider quoting or extracting';
    default:
      return 'External text detected';
  }
}

// ---------------------------------------------------------------------------
// PasteQuarantine — the main manager
// ---------------------------------------------------------------------------

/**
 * Manages paste quarantine regions for a document. Gates behavior on the
 * friction dial's `pasteHandling` instrument state:
 *
 *   - **off**:     no decoration, no quarantine, no logging
 *   - **flag**:    decorate the paste region; log the event
 *   - **quarantine**: decorate + require claim-to-own to clear
 *   - **block**:   best-effort block — decorate + suggest quote-wrap/extract
 *                  (true pre-insertion blocking is composer-only; ADR-008)
 *
 * The tool NEVER rewrites the writer's prose. It marks and gates only.
 */
export class PasteQuarantine {
  private readonly regions = new Map<string, QuarantineRegion>();

  constructor(private readonly deps: PasteQuarantineDeps) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Process a batch of document changes. For each paste-shaped change at or
   * above the "flag" dial state, creates a quarantine region, records a
   * ledger event, and returns the decorations to apply.
   *
   * Returns the decorations for the host to render, plus any block-mode
   * suggestions when the dial is at "block".
   */
  async onDocumentChange(
    changes: readonly ObservedChange[],
    documentUri: string,
  ): Promise<{ decorations: PasteDecoration[]; blockSuggestions: BlockModeSuggestion[] }> {
    const dialState = this.deps.dial.instrumentState('pasteHandling');

    // At "off" — do nothing
    if (dialState === 'off') {
      return { decorations: [], blockSuggestions: [] };
    }

    const threshold = this.deps.getThreshold();
    const decorations: PasteDecoration[] = [];
    const blockSuggestions: BlockModeSuggestion[] = [];

    for (const change of changes) {
      if (!isPasteShaped(change, threshold)) {
        continue;
      }

      // Create and track the quarantine region
      const region = this.createRegion(change.rangeOffset, change.text);
      this.regions.set(region.id, region);

      // Record the quarantine event to the ledger
      await this.deps.ledger.append({
        ts: this.deps.now(),
        type: 'paste_quarantine',
        payload: {
          regionId: region.id,
          size: region.length,
          location: `offset:${region.offset} uri:${documentUri}`,
          dialState,
        },
      });

      // Decoration
      decorations.push({
        region,
        dialState,
        message: decorationMessage(dialState),
      });

      // Block-mode: suggest containment
      if (dialState === 'block') {
        blockSuggestions.push({
          action: 'quote_wrap',
          originalText: change.text,
          offset: change.rangeOffset,
          length: change.text.length,
        });
      }
    }

    return { decorations, blockSuggestions };
  }

  /**
   * Check whether a quarantined region has been claimed-to-own (meaningfully
   * rewritten). If the overlap drops below the threshold, marks the region
   * as claimed, records a ledger event, and returns `true`.
   *
   * Returns `false` if the region is still not sufficiently rewritten, or
   * if the region doesn't exist, or if the dial is not at "quarantine".
   */
  async checkClaim(regionId: string, currentText: string): Promise<boolean> {
    const dialState = this.deps.dial.instrumentState('pasteHandling');

    // Claim-to-own only applies at "quarantine"
    if (dialState !== 'quarantine') {
      return false;
    }

    const region = this.regions.get(regionId);
    if (!region) {
      return false;
    }

    if (region.claimed) {
      return true; // Already claimed
    }

    const claimed = isClaimedToOwn(currentText, region.originalText);
    if (!claimed) {
      return false;
    }

    // Mark as claimed
    region.claimed = true;

    // Record the claim event
    await this.deps.ledger.append({
      ts: this.deps.now(),
      type: 'paste_claim',
      payload: {
        regionId: region.id,
        size: region.length,
        location: `offset:${region.offset}`,
        overlap: computeRewriteOverlap(currentText, region.originalText),
      },
    });

    return true;
  }

  /**
   * Get all currently tracked quarantine regions.
   * Unclaimed regions at "quarantine" or "block" still have marks.
   */
  getRegions(): readonly QuarantineRegion[] {
    return Array.from(this.regions.values());
  }

  /**
   * Get the active (unclaimed) quarantine regions.
   */
  getUnclaimedRegions(): readonly QuarantineRegion[] {
    return Array.from(this.regions.values()).filter((r) => !r.claimed);
  }

  /**
   * Get a specific region by ID.
   */
  getRegion(id: string): QuarantineRegion | undefined {
    return this.regions.get(id);
  }

  /**
   * Remove a region from tracking (e.g. when the text is deleted).
   */
  removeRegion(id: string): boolean {
    return this.regions.delete(id);
  }

  /**
   * Clear all tracked regions.
   */
  clearRegions(): void {
    this.regions.clear();
  }

  /**
   * The current dial state for paste handling.
   */
  get dialState(): PasteHandlingState {
    return this.deps.dial.instrumentState('pasteHandling');
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private createRegion(offset: number, text: string): QuarantineRegion {
    return {
      id: this.deps.idGenerator(),
      offset,
      length: text.length,
      originalText: text,
      claimed: false,
      createdAt: this.deps.now(),
    };
  }
}
