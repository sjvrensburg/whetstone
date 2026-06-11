/**
 * Unit tests for `src/friction/teachBack.ts` — teach-back checkpoints
 * (instrument D, ADR-008, task 23).
 *
 * Tests:
 * - A section boundary triggers the checkpoint only when the dial enables it
 * - An empty/too-short/placeholder summary raises a disconnect signal (nudge, not block)
 * - A given summary records a "teach-back given" outcome; skipping records "skipped"
 * - The ledger payload contains no summary prose where flagged sensitive
 * - Writing is never blocked by the checkpoint (dismissible)
 * - Integration: finish a section → prompt appears → summary or skip → outcome logged
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TeachBackCheckpoint,
  isDisconnect,
  MIN_SUMMARY_LENGTH,
  SUMMARY_TITLE,
  SUMMARY_PROMPT,
  SUMMARY_PLACEHOLDER,
  DISCONNECT_NUDGE,
} from '../../src/friction/teachBack';
import type { SummaryPrompter } from '../../src/friction/teachBack';
import { Dial } from '../../src/friction/dial';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-06-11T12:00:00.000Z';

function makeDial(teachBackState: 'off' | 'per-section'): Dial {
  if (teachBackState === 'off') {
    // Level 1 (Coach): teachBack = 'off'
    return new Dial({ level: 1, floor: 0, overrides: {} });
  } else {
    // Level 2 (Engaged): teachBack = 'per-section'
    return new Dial({ level: 2, floor: 0, overrides: {} });
  }
}

function makeLedger() {
  return { append: vi.fn(async () => undefined) };
}

function makeCheckpoint(teachBackState: 'off' | 'per-section' = 'off') {
  const dial = makeDial(teachBackState);
  const ledger = makeLedger();
  const checkpoint = new TeachBackCheckpoint({ dial, ledger, now: () => FIXED_NOW });
  return { checkpoint, dial, ledger };
}

function makePrompter(response: string | undefined): SummaryPrompter {
  return {
    showSummaryInput: vi.fn(async (_sectionTitle: string) => response),
  };
}

// ---------------------------------------------------------------------------
// Pure data tests — constants
// ---------------------------------------------------------------------------

describe('Teach-back constants', () => {
  it('has a meaningful title', () => {
    expect(SUMMARY_TITLE.length).toBeGreaterThan(0);
  });

  it('has a prompt with supportive framing', () => {
    expect(SUMMARY_PROMPT).toContain('OK');
  });

  it('has a placeholder with an example', () => {
    expect(SUMMARY_PLACEHOLDER).toContain('e.g.');
  });

  it('has a disconnect nudge that is supportive, not punitive', () => {
    expect(DISCONNECT_NUDGE).toContain('signal');
    expect(DISCONNECT_NUDGE).not.toContain('fail');
    expect(DISCONNECT_NUDGE).not.toContain('error');
  });

  it('MIN_SUMMARY_LENGTH is reasonable', () => {
    expect(MIN_SUMMARY_LENGTH).toBeGreaterThan(0);
    expect(MIN_SUMMARY_LENGTH).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// isDisconnect — pure function tests
// ---------------------------------------------------------------------------

describe('isDisconnect', () => {
  it('returns true for empty string', () => {
    expect(isDisconnect('')).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    expect(isDisconnect('   ')).toBe(true);
  });

  it('returns true for strings shorter than MIN_SUMMARY_LENGTH', () => {
    expect(isDisconnect('short')).toBe(true);
  });

  it('returns true for placeholder "idk"', () => {
    expect(isDisconnect('idk')).toBe(true);
  });

  it('returns true for placeholder "I don\'t know"', () => {
    expect(isDisconnect("I don't know")).toBe(true);
  });

  it('returns true for placeholder "nothing"', () => {
    expect(isDisconnect('nothing')).toBe(true);
  });

  it('returns true for placeholder "n/a"', () => {
    expect(isDisconnect('n/a')).toBe(true);
  });

  it('returns true for placeholder "none"', () => {
    expect(isDisconnect('none')).toBe(true);
  });

  it('returns true for placeholder dots', () => {
    expect(isDisconnect('...')).toBe(true);
  });

  it('returns true for placeholder dashes', () => {
    expect(isDisconnect('---')).toBe(true);
  });

  it('returns true for "na"', () => {
    expect(isDisconnect('na')).toBe(true);
  });

  it('returns true for "nil"', () => {
    expect(isDisconnect('nil')).toBe(true);
  });

  it('returns false for a meaningful summary', () => {
    expect(isDisconnect('This section argues that sample size must be justified')).toBe(false);
  });

  it('returns false for a summary at exactly MIN_SUMMARY_LENGTH', () => {
    const exact = 'a'.repeat(MIN_SUMMARY_LENGTH);
    expect(isDisconnect(exact)).toBe(false);
  });

  it('returns false for a longer meaningful summary', () => {
    expect(isDisconnect('The theoretical framework establishes the foundation for the methodology.')).toBe(false);
  });

  it('is case-insensitive for placeholders', () => {
    expect(isDisconnect('IDK')).toBe(true);
    expect(isDisconnect('Nothing')).toBe(true);
    expect(isDisconnect('NONE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dial state: "off" — no checkpoint, no prompt, no ledger event
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — dial "off"', () => {
  it('returns triggered: false', async () => {
    const { checkpoint } = makeCheckpoint('off');
    const prompter = makePrompter('Some summary');

    const result = await checkpoint.checkpoint(prompter, 'Introduction');

    expect(result).toEqual({ triggered: false });
  });

  it('does not prompt the writer', async () => {
    const { checkpoint } = makeCheckpoint('off');
    const prompter = makePrompter('Some summary');

    await checkpoint.checkpoint(prompter, 'Introduction');

    expect(prompter.showSummaryInput).not.toHaveBeenCalled();
  });

  it('does not record a ledger event', async () => {
    const { checkpoint, ledger } = makeCheckpoint('off');
    const prompter = makePrompter('Some summary');

    await checkpoint.checkpoint(prompter, 'Introduction');

    expect(ledger.append).not.toHaveBeenCalled();
  });

  it('exposes dialState as "off"', () => {
    const { checkpoint } = makeCheckpoint('off');
    expect(checkpoint.dialState).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Dial state: "per-section" — checkpoint runs
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — dial "per-section"', () => {
  it('prompts the writer with the section title', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('A meaningful summary of the argument.');

    await checkpoint.checkpoint(prompter, 'Methodology');

    expect(prompter.showSummaryInput).toHaveBeenCalledOnce();
    expect(prompter.showSummaryInput).toHaveBeenCalledWith('Methodology');
  });

  it('returns triggered: true for a given summary', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const summary = 'This section argues that the sample size needs justification.';
    const prompter = makePrompter(summary);

    const result = await checkpoint.checkpoint(prompter, 'Methodology');

    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('given');
    expect(result.disconnect).toBe(false);
    expect(result.summary).toBe(summary);
    expect(result.sectionTitle).toBe('Methodology');
  });

  it('records a "teach_back" ledger event with outcome "given"', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const summary = 'The methodology section justifies the research approach.';
    const prompter = makePrompter(summary);

    await checkpoint.checkpoint(prompter, 'Methodology');

    expect(ledger.append).toHaveBeenCalledOnce();
    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe('teach_back');
    expect(call.ts).toBe(FIXED_NOW);
    expect(call.payload).toEqual({
      outcome: 'given',
      disconnect: false,
      sectionTitleLength: 'Methodology'.length,
      dialState: 'per-section',
    });
  });

  it('trims whitespace from the summary', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('  A meaningful summary here.  ');

    const result = await checkpoint.checkpoint(prompter, 'Intro');

    expect(result.outcome).toBe('given');
    expect(result.summary).toBe('A meaningful summary here.');
  });

  it('exposes dialState as "per-section"', () => {
    const { checkpoint } = makeCheckpoint('per-section');
    expect(checkpoint.dialState).toBe('per-section');
  });
});

// ---------------------------------------------------------------------------
// Dismissibility — skipping never blocks writing
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — dismissible (skipped)', () => {
  it('returns outcome "skipped" when the user dismisses (undefined)', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter(undefined);

    const result = await checkpoint.checkpoint(prompter, 'Introduction');

    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('skipped');
    expect(result.disconnect).toBe(false);
    expect(result.summary).toBeUndefined();
  });

  it('records a ledger event with outcome "skipped"', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const prompter = makePrompter(undefined);

    await checkpoint.checkpoint(prompter, 'Introduction');

    expect(ledger.append).toHaveBeenCalledOnce();
    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload).toMatchObject({ outcome: 'skipped', disconnect: false });
  });

  it('writing continues after skip — result does not block', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter(undefined);

    const result = await checkpoint.checkpoint(prompter, 'Discussion');

    // The result itself is the evidence: no `blocked` or `ok:false` field.
    // The caller can check `result.triggered` and `result.outcome` but
    // writing always continues.
    expect(result.outcome).toBe('skipped');
    // No "blocked" property exists on TeachBackResult
    expect('ok' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disconnect signal — empty/too-short/placeholder
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — disconnect signal', () => {
  it('detects disconnect for empty input (explicit empty string)', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('');

    const result = await checkpoint.checkpoint(prompter, 'Results');

    expect(result.outcome).toBe('disconnect-flagged');
    expect(result.disconnect).toBe(true);
  });

  it('detects disconnect for too-short input', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('short');

    const result = await checkpoint.checkpoint(prompter, 'Results');

    expect(result.outcome).toBe('disconnect-flagged');
    expect(result.disconnect).toBe(true);
  });

  it('detects disconnect for placeholder input', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('idk');

    const result = await checkpoint.checkpoint(prompter, 'Results');

    expect(result.outcome).toBe('disconnect-flagged');
    expect(result.disconnect).toBe(true);
    expect(result.summary).toBe('idk');
  });

  it('records a ledger event with outcome "disconnect-flagged"', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const prompter = makePrompter('');

    await checkpoint.checkpoint(prompter, 'Results');

    expect(ledger.append).toHaveBeenCalledOnce();
    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload).toMatchObject({
      outcome: 'disconnect-flagged',
      disconnect: true,
    });
  });

  it('disconnect is surfaced as a nudge, never a block', async () => {
    const { checkpoint } = makeCheckpoint('per-section');
    const prompter = makePrompter('idk');

    const result = await checkpoint.checkpoint(prompter, 'Results');

    // The result contains the disconnect signal but has no blocking field
    expect(result.disconnect).toBe(true);
    expect('ok' in result).toBe(false);
    // The nudge is a constant for the UI layer to display, not enforced here
    expect(DISCONNECT_NUDGE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Ledger payload — metadata only, never summary prose
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — ledger metadata only', () => {
  it('ledger payload does not contain the summary text', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const summary = 'This is a sensitive argument about proprietary methodology.';
    const prompter = makePrompter(summary);

    await checkpoint.checkpoint(prompter, 'Methodology');

    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = call.payload as Record<string, unknown>;

    // Payload must not contain the actual summary text
    expect(payload).not.toHaveProperty('summary');
    expect(payload).not.toHaveProperty('text');
    expect(payload).not.toHaveProperty('prose');
    // Only metadata
    expect(payload).toHaveProperty('outcome');
    expect(payload).toHaveProperty('disconnect');
    expect(payload).toHaveProperty('sectionTitleLength');
  });

  it('ledger payload for disconnect does not contain the placeholder text', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const prompter = makePrompter('idk');

    await checkpoint.checkpoint(prompter, 'Discussion');

    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = call.payload as Record<string, unknown>;

    expect(payload).not.toHaveProperty('summary');
    expect(payload).not.toHaveProperty('text');
  });
});

// ---------------------------------------------------------------------------
// Dynamic dial changes
// ---------------------------------------------------------------------------

describe('TeachBackCheckpoint — dynamic dial changes', () => {
  it('responds to dial changes at runtime', async () => {
    const dial = makeDial('off');
    const ledger = makeLedger();
    const checkpoint = new TeachBackCheckpoint({ dial, ledger, now: () => FIXED_NOW });

    // Initially "off" — no checkpoint
    const resultOff = await checkpoint.checkpoint(makePrompter('summary'), 'Intro');
    expect(resultOff.triggered).toBe(false);

    // Change to level 2 — teachBack = 'per-section'
    dial.setLevel(2);

    const resultOn = await checkpoint.checkpoint(makePrompter('A meaningful summary here.'), 'Method');
    expect(resultOn.triggered).toBe(true);
    expect(resultOn.outcome).toBe('given');
  });

  it('uses an override to force per-section even at level 1', async () => {
    const dial = makeDial('off'); // Level 1 — teachBack = 'off'
    dial.setOverride('teachBack', 'per-section');

    const ledger = makeLedger();
    const checkpoint = new TeachBackCheckpoint({ dial, ledger, now: () => FIXED_NOW });

    const result = await checkpoint.checkpoint(makePrompter('A meaningful summary here.'), 'Intro');
    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('given');
  });
});

// ---------------------------------------------------------------------------
// Integration: finish section → prompt → summary/skip → outcome logged
// ---------------------------------------------------------------------------

describe('Teach-back integration', () => {
  it('end-to-end: section → prompt → summary given → outcome logged, writing uninterrupted', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const summary = 'The introduction establishes the research gap and states the contribution.';
    const prompter = makePrompter(summary);

    // Step 1: Section boundary detected → run checkpoint
    const result = await checkpoint.checkpoint(prompter, 'Introduction');

    // Step 2: Writer provided a meaningful summary
    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('given');
    expect(result.summary).toBe(summary);
    expect(result.disconnect).toBe(false);

    // Step 3: Ledger event recorded with metadata only
    expect(ledger.append).toHaveBeenCalledOnce();
    const ledgerCall = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ledgerCall.type).toBe('teach_back');
    const payload = ledgerCall.payload as Record<string, unknown>;
    expect(payload.outcome).toBe('given');
    expect(payload.disconnect).toBe(false);
    // No prose in payload
    expect(payload).not.toHaveProperty('summary');

    // Step 4: Writing is uninterrupted — no blocking field
    expect('ok' in result).toBe(false);
  });

  it('end-to-end: section → prompt → skipped → outcome logged, writing uninterrupted', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const prompter = makePrompter(undefined);

    const result = await checkpoint.checkpoint(prompter, 'Introduction');

    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('skipped');
    expect(result.disconnect).toBe(false);

    expect(ledger.append).toHaveBeenCalledOnce();
    const payload = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.outcome).toBe('skipped');

    // Writing is uninterrupted
    expect('ok' in result).toBe(false);
  });

  it('end-to-end: section → prompt → disconnect → nudge surfaced, writing uninterrupted', async () => {
    const { checkpoint, ledger } = makeCheckpoint('per-section');
    const prompter = makePrompter('');

    const result = await checkpoint.checkpoint(prompter, 'Introduction');

    expect(result.triggered).toBe(true);
    expect(result.outcome).toBe('disconnect-flagged');
    expect(result.disconnect).toBe(true);

    expect(ledger.append).toHaveBeenCalledOnce();
    const payload = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.outcome).toBe('disconnect-flagged');
    expect(payload.disconnect).toBe(true);

    // Writing is uninterrupted — the disconnect is informational
    expect('ok' in result).toBe(false);
  });
});
