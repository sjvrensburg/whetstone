/**
 * Unit tests for paste quarantine & claim-to-own — instrument B (task 21).
 *
 * Tests the paste decoration, claim-to-own clearing, trivial-edit rejection,
 * block-mode best-effort, dial gating, and the invariant that the tool never
 * rewrites the writer's prose.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PasteQuarantine,
  computeRewriteOverlap,
  isClaimedToOwn,
  decorationMessage,
  CLAIM_OVERLAP_THRESHOLD,
} from '../../src/friction/paste';
import type { PasteQuarantineDeps } from '../../src/friction/paste';
import type { PasteHandlingState } from '../../src/friction/presets';
import type { Ledger } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = () => `region-${++idCounter}`;
const fixedNow = () => '2026-06-11T12:00:00.000Z';

const defaultThreshold = 50;

function makeDeps(
  dialState: PasteHandlingState = 'flag',
  ledger?: Partial<Ledger>,
): PasteQuarantineDeps {
  return {
    dial: { instrumentState: () => dialState },
    ledger: {
      append: ledger?.append ?? vi.fn().mockResolvedValue(undefined),
      verify: ledger?.verify ?? vi.fn().mockResolvedValue({ intact: true }),
      report: ledger?.report ?? vi.fn(),
      exportDisclosure: ledger?.exportDisclosure ?? vi.fn(),
    },
    getThreshold: () => defaultThreshold,
    now: fixedNow,
    idGenerator: nextId,
  };
}

/** Create a paste-shaped change (pure insert above threshold). */
function pasteChange(text: string, offset = 0) {
  return { rangeOffset: offset, rangeLength: 0, text };
}

/** Create an incremental-typing change (below threshold). */
function typingChange(char: string, offset = 0) {
  return { rangeOffset: offset, rangeLength: 0, text: char };
}

// ---------------------------------------------------------------------------
// computeRewriteOverlap
// ---------------------------------------------------------------------------

describe('computeRewriteOverlap', () => {
  it('returns 1 for identical text', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(computeRewriteOverlap(text, text)).toBeCloseTo(1, 5);
  });

  it('returns 0 for completely unrelated text', () => {
    const original = 'The quick brown fox jumps over the lazy dog today';
    const current = 'Quantum computing leverages superposition for complex calculations';
    expect(computeRewriteOverlap(current, original)).toBeCloseTo(0, 5);
  });

  it('returns intermediate values for partially overlapping text', () => {
    const original = 'The quick brown fox jumps over the lazy dog today in the park';
    const current = 'The quick brown fox leaps above the sleepy cat today in the yard';
    const overlap = computeRewriteOverlap(current, original);
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });

  it('returns 0 for empty current text', () => {
    expect(computeRewriteOverlap('', 'some text here for trigram analysis')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isClaimedToOwn
// ---------------------------------------------------------------------------

describe('isClaimedToOwn', () => {
  it('returns true for completely different text (meaningful rewrite)', () => {
    const original = 'The rapid advancement of large language models raises concerns';
    const rewritten = 'Swift progress in massive neural architectures provokes worries';
    expect(isClaimedToOwn(rewritten, original)).toBe(true);
  });

  it('returns false for identical text (no rewrite)', () => {
    const original = 'The rapid advancement of large language models raises concerns';
    expect(isClaimedToOwn(original, original)).toBe(false);
  });

  it('returns false for trivial edits (high overlap)', () => {
    const original = 'The rapid advancement of large language models raises concerns about academic integrity';
    const trivial = 'The rapid advancement of large language models raises concerns about academic honesty';
    // Only one word changed — overlap should be high
    expect(isClaimedToOwn(trivial, original)).toBe(false);
  });

  it('returns true for very short text (too short for meaningful overlap)', () => {
    expect(isClaimedToOwn('hi', 'The original text was much longer')).toBe(true);
  });

  it('respects a custom threshold', () => {
    const original = 'The quick brown fox jumps over the lazy dog today';
    // Near-identical text: overlap is high (~0.875)
    const nearIdentical = 'The quick brown fox jumps over the lazy dog yesterday';
    // At threshold 0.5: overlap 0.875 >= 0.5 → NOT claimed (not enough rewrite)
    expect(isClaimedToOwn(nearIdentical, original, 0.5)).toBe(false);
    // At threshold 0.99: overlap 0.875 < 0.99 → IS claimed (very permissive)
    expect(isClaimedToOwn(nearIdentical, original, 0.99)).toBe(true);
    // Completely different text claimed at any reasonable threshold
    const different = 'Quantum computing leverages superposition for complex calculations';
    expect(isClaimedToOwn(different, original, 0.5)).toBe(true);
    expect(isClaimedToOwn(different, original, 0.1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decorationMessage
// ---------------------------------------------------------------------------

describe('decorationMessage', () => {
  it('returns flag message at "flag"', () => {
    expect(decorationMessage('flag')).toBe('External text detected');
  });

  it('returns quarantine message at "quarantine"', () => {
    expect(decorationMessage('quarantine')).toBe('Quarantined — rewrite in your own words to claim');
  });

  it('returns block message at "block"', () => {
    expect(decorationMessage('block')).toBe('External text — consider quoting or extracting');
  });

  it('returns default message for "off"', () => {
    expect(decorationMessage('off')).toBe('External text detected');
  });
});

// ---------------------------------------------------------------------------
// PasteQuarantine — dial gating
// ---------------------------------------------------------------------------

describe('PasteQuarantine — dial gating', () => {
  it('does nothing when dial is "off"', async () => {
    const deps = makeDeps('off');
    const pq = new PasteQuarantine(deps);
    const result = await pq.onDocumentChange(
      [pasteChange('This is a long pasted text that exceeds the default threshold for detection')],
      'file:///test.md',
    );
    expect(result.decorations).toHaveLength(0);
    expect(result.blockSuggestions).toHaveLength(0);
    expect(deps.ledger.append).not.toHaveBeenCalled();
    expect(pq.getRegions()).toHaveLength(0);
  });

  it('decorates and logs at "flag"', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('flag', { append });
    const pq = new PasteQuarantine(deps);
    const pastedText = 'This is a sufficiently long pasted text for detection to trigger';
    const result = await pq.onDocumentChange(
      [pasteChange(pastedText, 100)],
      'file:///test.md',
    );

    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0].dialState).toBe('flag');
    expect(result.decorations[0].message).toBe('External text detected');
    expect(result.decorations[0].region.originalText).toBe(pastedText);
    expect(result.decorations[0].region.offset).toBe(100);
    expect(result.blockSuggestions).toHaveLength(0);
    expect(append).toHaveBeenCalledTimes(1);

    const ledgerCall = append.mock.calls[0][0];
    expect(ledgerCall.type).toBe('paste_quarantine');
    expect(ledgerCall.payload).toMatchObject({
      size: pastedText.length,
      location: 'offset:100 uri:file:///test.md',
      dialState: 'flag',
    });
  });

  it('ignores incremental typing below threshold', async () => {
    const deps = makeDeps('flag');
    const pq = new PasteQuarantine(deps);
    const result = await pq.onDocumentChange(
      [typingChange('a', 0), typingChange('b', 1), typingChange('c', 2)],
      'file:///test.md',
    );
    expect(result.decorations).toHaveLength(0);
    expect(pq.getRegions()).toHaveLength(0);
  });

  it('handles multiple paste-shaped changes in one batch', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('flag', { append });
    const pq = new PasteQuarantine(deps);
    const result = await pq.onDocumentChange(
      [
        pasteChange('First pasted text that exceeds the threshold value', 0),
        pasteChange('Second pasted text that also exceeds the threshold', 500),
      ],
      'file:///test.md',
    );
    expect(result.decorations).toHaveLength(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(pq.getRegions()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PasteQuarantine — quarantine & claim-to-own
// ---------------------------------------------------------------------------

describe('PasteQuarantine — claim-to-own', () => {
  it('quarantine mark persists until meaningful rewrite clears it', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('quarantine', { append });
    const pq = new PasteQuarantine(deps);

    // Step 1: paste
    const originalText = 'The rapid advancement of large language models raises significant concerns';
    const result = await pq.onDocumentChange(
      [pasteChange(originalText, 0)],
      'file:///test.md',
    );
    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0].dialState).toBe('quarantine');

    const regionId = result.decorations[0].region.id;
    const region = pq.getRegion(regionId)!;
    expect(region.claimed).toBe(false);

    // Step 2: try to claim with identical text — should NOT clear
    const claimedIdentical = await pq.checkClaim(regionId, originalText);
    expect(claimedIdentical).toBe(false);
    expect(pq.getRegion(regionId)!.claimed).toBe(false);

    // Step 3: claim with a meaningful rewrite — should clear
    const rewrittenText = 'Swift progress in massive neural architectures provokes significant worries';
    const claimed = await pq.checkClaim(regionId, rewrittenText);
    expect(claimed).toBe(true);
    expect(pq.getRegion(regionId)!.claimed).toBe(true);

    // Ledger should have been called twice: quarantine + claim
    expect(append).toHaveBeenCalledTimes(2);
    const claimCall = append.mock.calls[1][0];
    expect(claimCall.type).toBe('paste_claim');
    expect(claimCall.payload.regionId).toBe(regionId);
  });

  it('a trivial edit does NOT clear the quarantine mark', async () => {
    const deps = makeDeps('quarantine');
    const pq = new PasteQuarantine(deps);

    const originalText = 'The rapid advancement of large language models raises significant concerns about integrity in academia';
    await pq.onDocumentChange([pasteChange(originalText, 0)], 'file:///test.md');

    const region = pq.getRegions()[0];

    // Only one word changed — overlap is still very high
    const trivialEdit = 'The rapid advancement of large language models raises significant concerns about integrity in scholarship';
    const claimed = await pq.checkClaim(region.id, trivialEdit);
    expect(claimed).toBe(false);
    expect(region.claimed).toBe(false);
  });

  it('returns false for non-existent region', async () => {
    const deps = makeDeps('quarantine');
    const pq = new PasteQuarantine(deps);
    const claimed = await pq.checkClaim('non-existent', 'some text');
    expect(claimed).toBe(false);
  });

  it('returns false when dial is not at "quarantine"', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('flag', { append });
    const pq = new PasteQuarantine(deps);

    const originalText = 'The rapid advancement of large language models raises significant concerns about integrity';
    await pq.onDocumentChange([pasteChange(originalText, 0)], 'file:///test.md');

    const region = pq.getRegions()[0];
    const rewritten = 'Swift progress in massive neural architectures provokes significant worries';
    const claimed = await pq.checkClaim(region.id, rewritten);
    expect(claimed).toBe(false);
  });

  it('already-claimed region returns true immediately', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('quarantine', { append });
    const pq = new PasteQuarantine(deps);

    const originalText = 'The rapid advancement of large language models raises significant concerns about academic integrity';
    await pq.onDocumentChange([pasteChange(originalText, 0)], 'file:///test.md');

    const region = pq.getRegions()[0];

    // Claim with a meaningful rewrite
    const rewritten = 'Swift progress in massive neural architectures provokes significant worries across academia';
    await pq.checkClaim(region.id, rewritten);
    expect(region.claimed).toBe(true);

    // Call again — should return true without another ledger append
    const appendCountBefore = append.mock.calls.length;
    const claimedAgain = await pq.checkClaim(region.id, 'anything');
    expect(claimedAgain).toBe(true);
    expect(append.mock.calls.length).toBe(appendCountBefore); // No new ledger event
  });
});

// ---------------------------------------------------------------------------
// PasteQuarantine — block mode
// ---------------------------------------------------------------------------

describe('PasteQuarantine — block mode (best-effort)', () => {
  it('at "block", external text is detected and quote-wrap suggestion returned', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('block', { append });
    const pq = new PasteQuarantine(deps);

    const pastedText = 'This is external text that has been pasted into the document unexpectedly';
    const result = await pq.onDocumentChange(
      [pasteChange(pastedText, 200)],
      'file:///test.md',
    );

    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0].dialState).toBe('block');

    // Block-mode suggestion
    expect(result.blockSuggestions).toHaveLength(1);
    const suggestion = result.blockSuggestions[0];
    expect(suggestion.action).toBe('quote_wrap');
    expect(suggestion.originalText).toBe(pastedText);
    expect(suggestion.offset).toBe(200);
    expect(suggestion.length).toBe(pastedText.length);

    // Ledger still records the event
    expect(append).toHaveBeenCalledTimes(1);
    const ledgerCall = append.mock.calls[0][0];
    expect(ledgerCall.type).toBe('paste_quarantine');
    expect(ledgerCall.payload.dialState).toBe('block');
  });

  it('block-mode does not actually modify the document text', async () => {
    const deps = makeDeps('block');
    const pq = new PasteQuarantine(deps);
    const result = await pq.onDocumentChange(
      [pasteChange('External text pasted into document that should not be modified')],
      'file:///test.md',
    );
    // The result contains only suggestions — never a rewrite
    for (const suggestion of result.blockSuggestions) {
      expect(suggestion.action).toMatch(/^(quote_wrap|extract)$/);
      // The suggestion contains the original text but no modified version
      expect(typeof suggestion.originalText).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// PasteQuarantine — the tool never rewrites (asserted invariant)
// ---------------------------------------------------------------------------

describe('PasteQuarantine — never rewrites (invariant)', () => {
  it('onDocumentChange never returns modified text', async () => {
    const deps = makeDeps('quarantine');
    const pq = new PasteQuarantine(deps);
    const pastedText = 'The original text pasted from an external source into the document';
    const result = await pq.onDocumentChange(
      [pasteChange(pastedText, 0)],
      'file:///test.md',
    );

    // The region stores the ORIGINAL text verbatim — no rewriting
    for (const dec of result.decorations) {
      expect(dec.region.originalText).toBe(pastedText);
    }
    // Block suggestions also carry original text only
    for (const sug of result.blockSuggestions) {
      expect(sug.originalText).toBe(pastedText);
    }
  });

  it('checkClaim never modifies the region text', async () => {
    const deps = makeDeps('quarantine');
    const pq = new PasteQuarantine(deps);
    const originalText = 'The original text pasted from an external source into the document';
    await pq.onDocumentChange([pasteChange(originalText, 0)], 'file:///test.md');

    const region = pq.getRegions()[0];
    const textBefore = region.originalText;

    // Check claim with various texts — the original is never modified
    await pq.checkClaim(region.id, 'Completely different text that rewrites everything meaningful');
    expect(region.originalText).toBe(textBefore);
    expect(region.originalText).toBe(originalText);

    await pq.checkClaim(region.id, 'Another attempt at rewriting the text completely');
    expect(region.originalText).toBe(originalText);
  });

  it('no tool-generated rewrite text exists in any return value', async () => {
    const deps = makeDeps('block');
    const pq = new PasteQuarantine(deps);
    const result = await pq.onDocumentChange(
      [pasteChange('Some pasted text that is quite long enough to exceed threshold')],
      'file:///test.md',
    );

    // Inspect every returned value — none should contain "suggested rewrite"
    // or any tool-generated prose
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('suggested_rewrite');
    expect(serialized).not.toContain('here is a revision');
    expect(serialized).not.toContain('try writing');
  });
});

// ---------------------------------------------------------------------------
// PasteQuarantine — region management
// ---------------------------------------------------------------------------

describe('PasteQuarantine — region management', () => {
  it('getRegions returns all tracked regions', async () => {
    const deps = makeDeps('flag');
    const pq = new PasteQuarantine(deps);
    await pq.onDocumentChange(
      [
        pasteChange('First pasted text for detection threshold exceeding', 0),
        pasteChange('Second pasted text also long enough to trigger detection', 500),
      ],
      'file:///test.md',
    );
    expect(pq.getRegions()).toHaveLength(2);
  });

  it('getUnclaimedRegions returns only unclaimed regions', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('quarantine', { append });
    const pq = new PasteQuarantine(deps);

    await pq.onDocumentChange(
      [
        pasteChange('First pasted text for detection threshold exceeding', 0),
        pasteChange('Second pasted text also long enough to trigger detection', 500),
      ],
      'file:///test.md',
    );

    expect(pq.getUnclaimedRegions()).toHaveLength(2);

    // Claim the first region
    const region = pq.getRegions()[0];
    await pq.checkClaim(region.id, 'Completely rewritten text that shares nothing with original source');

    expect(pq.getUnclaimedRegions()).toHaveLength(1);
    expect(pq.getUnclaimedRegions()[0].id).not.toBe(region.id);
  });

  it('removeRegion removes a tracked region', async () => {
    const deps = makeDeps('flag');
    const pq = new PasteQuarantine(deps);
    await pq.onDocumentChange(
      [pasteChange('Pasted text that is long enough to trigger detection threshold', 0)],
      'file:///test.md',
    );
    const region = pq.getRegions()[0];
    expect(pq.removeRegion(region.id)).toBe(true);
    expect(pq.getRegions()).toHaveLength(0);
    expect(pq.removeRegion(region.id)).toBe(false); // Already removed
  });

  it('clearRegions removes all tracked regions', async () => {
    const deps = makeDeps('flag');
    const pq = new PasteQuarantine(deps);
    await pq.onDocumentChange(
      [
        pasteChange('First pasted text for detection threshold exceeding', 0),
        pasteChange('Second pasted text also long enough to trigger detection', 500),
      ],
      'file:///test.md',
    );
    expect(pq.getRegions()).toHaveLength(2);
    pq.clearRegions();
    expect(pq.getRegions()).toHaveLength(0);
  });

  it('getRegion returns a specific region by ID', async () => {
    const deps = makeDeps('flag');
    const pq = new PasteQuarantine(deps);
    await pq.onDocumentChange(
      [pasteChange('Pasted text that is long enough to trigger detection threshold', 42)],
      'file:///test.md',
    );
    const region = pq.getRegions()[0];
    const found = pq.getRegion(region.id);
    expect(found).toBe(region);
    expect(pq.getRegion('nonexistent')).toBeUndefined();
  });

  it('dialState returns current dial state', () => {
    const deps = makeDeps('quarantine');
    const pq = new PasteQuarantine(deps);
    expect(pq.dialState).toBe('quarantine');
  });
});

// ---------------------------------------------------------------------------
// Integration: paste → mark → claim-to-own → mark clears + ledger
// ---------------------------------------------------------------------------

describe('Integration: paste → mark → claim-to-own → mark clears', () => {
  it('full flow with ledger recording both events', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps('quarantine', { append });
    const pq = new PasteQuarantine(deps);

    // Step 1: Paste occurs
    const originalText =
      'The rapid advancement of large language models has raised significant ' +
      'concerns about academic integrity across universities worldwide today';
    const pasteResult = await pq.onDocumentChange(
      [pasteChange(originalText, 0)],
      'file:///paper.md',
    );

    // Mark appears
    expect(pasteResult.decorations).toHaveLength(1);
    const decoration = pasteResult.decorations[0];
    expect(decoration.region.originalText).toBe(originalText);
    expect(decoration.dialState).toBe('quarantine');
    expect(decoration.message).toContain('Quarantined');

    // Ledger records quarantine event
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].type).toBe('paste_quarantine');

    // Region is unclaimed
    const regionId = decoration.region.id;
    expect(pq.getRegion(regionId)!.claimed).toBe(false);
    expect(pq.getUnclaimedRegions()).toHaveLength(1);

    // Step 2: Writer edits the text (trivial edit — mark persists)
    const trivialEdit = originalText.replace('worldwide', 'globally');
    const trivialClaimed = await pq.checkClaim(regionId, trivialEdit);
    expect(trivialClaimed).toBe(false);
    expect(pq.getRegion(regionId)!.claimed).toBe(false);
    // No additional ledger event for failed claim
    expect(append).toHaveBeenCalledTimes(1);

    // Step 3: Writer meaningfully rewrites in their own words
    const rewrittenText =
      'Swift progress in massive neural architectures has provoked substantial ' +
      'worries regarding scholarly honesty throughout higher education systems';
    const claimed = await pq.checkClaim(regionId, rewrittenText);
    expect(claimed).toBe(true);
    expect(pq.getRegion(regionId)!.claimed).toBe(true);
    expect(pq.getUnclaimedRegions()).toHaveLength(0);

    // Ledger records claim event
    expect(append).toHaveBeenCalledTimes(2);
    const claimEvent = append.mock.calls[1][0];
    expect(claimEvent.type).toBe('paste_claim');
    expect(claimEvent.payload.regionId).toBe(regionId);
    expect(typeof claimEvent.payload.overlap).toBe('number');
    expect(claimEvent.payload.overlap).toBeLessThan(CLAIM_OVERLAP_THRESHOLD);
  });
});
