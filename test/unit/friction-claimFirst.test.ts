/**
 * Unit tests for `src/friction/claimFirst.ts` — claim-first commitment gate
 * (instrument C, ADR-008, task 22).
 *
 * Tests:
 * - At "required", coaching command is blocked until a claim is provided
 * - At "off", coaching runs unchanged (no gate)
 * - The claim is passed as coaching context
 * - The claim is recorded to the ledger
 * - Edge cases: empty claim, cancelled prompt
 */

import { describe, it, expect, vi } from 'vitest';
import { ClaimFirstGate, CLAIM_PROMPT, CLAIM_PLACEHOLDER, CLAIM_TITLE } from '../../src/friction/claimFirst';
import type { ClaimPrompter } from '../../src/friction/claimFirst';
import { Dial } from '../../src/friction/dial';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-06-11T12:00:00.000Z';

function makeDial(claimFirstState: 'off' | 'required'): Dial {
  if (claimFirstState === 'off') {
    // Level 1 (Coach): claimFirst = 'off'
    return new Dial({ level: 1, floor: 0, overrides: {} });
  } else {
    // Level 2 (Engaged): claimFirst = 'required'
    return new Dial({ level: 2, floor: 0, overrides: {} });
  }
}

function makeLedger() {
  return { append: vi.fn(async () => undefined) };
}

function makeGate(claimFirstState: 'off' | 'required' = 'off') {
  const dial = makeDial(claimFirstState);
  const ledger = makeLedger();
  const gate = new ClaimFirstGate({ dial, ledger, now: () => FIXED_NOW });
  return { gate, dial, ledger };
}

function makePrompter(response: string | undefined): ClaimPrompter {
  return {
    showClaimInput: vi.fn(async () => response),
  };
}

// ---------------------------------------------------------------------------
// Pure data tests — constants
// ---------------------------------------------------------------------------

describe('Claim-first constants', () => {
  it('has a meaningful prompt', () => {
    expect(CLAIM_PROMPT.length).toBeGreaterThan(0);
  });

  it('has a placeholder with an example', () => {
    expect(CLAIM_PLACEHOLDER).toContain('e.g.');
  });

  it('has a title', () => {
    expect(CLAIM_TITLE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dial state: "off" — no gate, no prompt, no ledger event
// ---------------------------------------------------------------------------

describe('ClaimFirstGate — dial "off"', () => {
  it('returns ok:true with no claim', async () => {
    const { gate } = makeGate('off');
    const prompter = makePrompter('Some claim');

    const result = await gate.gate(prompter);

    expect(result).toEqual({ ok: true });
  });

  it('does not prompt the writer', async () => {
    const { gate } = makeGate('off');
    const prompter = makePrompter('Some claim');

    await gate.gate(prompter);

    expect(prompter.showClaimInput).not.toHaveBeenCalled();
  });

  it('does not record a ledger event', async () => {
    const { gate, ledger } = makeGate('off');
    const prompter = makePrompter('Some claim');

    await gate.gate(prompter);

    expect(ledger.append).not.toHaveBeenCalled();
  });

  it('coaching runs unchanged — gate returns ok immediately', async () => {
    const { gate } = makeGate('off');
    const result = await gate.gate(makePrompter(undefined));

    // Even with undefined prompter response, "off" returns ok
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim).toBeUndefined();
    }
  });

  it('exposes dialState as "off"', () => {
    const { gate } = makeGate('off');
    expect(gate.dialState).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Dial state: "required" — coaching blocked until claim provided
// ---------------------------------------------------------------------------

describe('ClaimFirstGate — dial "required"', () => {
  it('returns ok:true with the claim when the writer provides one', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter('I am arguing that the method needs justification.');

    const result = await gate.gate(prompter);

    expect(result).toEqual({ ok: true, claim: 'I am arguing that the method needs justification.' });
  });

  it('prompts the writer', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter('My point is X.');

    await gate.gate(prompter);

    expect(prompter.showClaimInput).toHaveBeenCalledOnce();
  });

  it('records a claim_captured ledger event', async () => {
    const { gate, ledger } = makeGate('required');
    const prompter = makePrompter('My argument is about X.');

    await gate.gate(prompter);

    expect(ledger.append).toHaveBeenCalledOnce();
    const call = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe('claim_captured');
    expect(call.ts).toBe(FIXED_NOW);
    expect(call.payload).toEqual({
      claimLength: 'My argument is about X.'.length,
      dialState: 'required',
    });
  });

  it('trims whitespace from the claim', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter('  My argument is about X.  ');

    const result = await gate.gate(prompter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim).toBe('My argument is about X.');
    }
  });

  it('exposes dialState as "required"', () => {
    const { gate } = makeGate('required');
    expect(gate.dialState).toBe('required');
  });
});

// ---------------------------------------------------------------------------
// "Required" — blocking cases
// ---------------------------------------------------------------------------

describe('ClaimFirstGate — "required" blocks coaching when claim missing', () => {
  it('blocks coaching when the user cancels (undefined)', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter(undefined);

    const result = await gate.gate(prompter);

    expect(result).toEqual({
      ok: false,
      reason: 'A claim is required before coaching. State your point in one sentence.',
    });
  });

  it('blocks coaching when the user provides an empty string', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter('');

    const result = await gate.gate(prompter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('required');
    }
  });

  it('blocks coaching when the user provides only whitespace', async () => {
    const { gate } = makeGate('required');
    const prompter = makePrompter('   ');

    const result = await gate.gate(prompter);

    expect(result.ok).toBe(false);
  });

  it('does not record a ledger event when blocked', async () => {
    const { gate, ledger } = makeGate('required');
    const prompter = makePrompter(undefined);

    await gate.gate(prompter);

    expect(ledger.append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dynamic dial changes
// ---------------------------------------------------------------------------

describe('ClaimFirstGate — dynamic dial changes', () => {
  it('responds to dial changes at runtime', async () => {
    const dial = makeDial('off');
    const ledger = makeLedger();
    const gate = new ClaimFirstGate({ dial, ledger, now: () => FIXED_NOW });

    // Initially "off" — no gate
    const resultOff = await gate.gate(makePrompter(undefined));
    expect(resultOff.ok).toBe(true);

    // Change to level 2 — claimFirst = 'required'
    dial.setLevel(2);

    const resultRequired = await gate.gate(makePrompter(undefined));
    expect(resultRequired.ok).toBe(false);
  });

  it('uses an override to force required even at level 1', async () => {
    const dial = makeDial('off'); // Level 1 — claimFirst = 'off'
    dial.setOverride('claimFirst', 'required');

    const ledger = makeLedger();
    const gate = new ClaimFirstGate({ dial, ledger, now: () => FIXED_NOW });

    const result = await gate.gate(makePrompter(undefined));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: required gate → enter claim → coaching proceeds with claim
// ---------------------------------------------------------------------------

describe('Claim-first integration — required gate', () => {
  it('end-to-end: gate → claim captured → coaching proceeds with claim in context', async () => {
    const { gate, ledger } = makeGate('required');
    const claimText = 'This passage establishes the theoretical framework.';
    const prompter = makePrompter(claimText);

    // Step 1: Run the gate
    const gateResult = await gate.gate(prompter);

    // Step 2: Gate passes with the claim
    expect(gateResult.ok).toBe(true);
    if (gateResult.ok) {
      expect(gateResult.claim).toBe(claimText);
    }

    // Step 3: Ledger event recorded
    expect(ledger.append).toHaveBeenCalledOnce();
    const ledgerCall = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ledgerCall.type).toBe('claim_captured');
    expect((ledgerCall.payload as { claimLength: number }).claimLength).toBe(claimText.length);

    // Step 4: The claim would be passed into the coaching turn as context
    // (the coaching command handler does this — tested in ui-commands tests)
    // Here we verify the gate returns the claim for the caller to use.
    if (gateResult.ok && gateResult.claim) {
      // Simulate what the coaching command does with the claim
      const coachingInput = {
        selectionText: 'Some selected text',
        anchorBase: 0,
        documentLanguage: 'markdown' as const,
        claim: gateResult.claim,
      };
      expect(coachingInput.claim).toBe(claimText);
    }
  });

  it('at "off", no gate → coaching proceeds without claim', async () => {
    const { gate } = makeGate('off');
    const prompter = makePrompter('ignored');

    const result = await gate.gate(prompter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim).toBeUndefined();
    }

    // Coaching input would NOT have a claim
    const coachingInput = {
      selectionText: 'Some selected text',
      anchorBase: 0,
      documentLanguage: 'markdown' as const,
      ...(result.ok && result.claim ? { claim: result.claim } : {}),
    };
    expect(coachingInput).not.toHaveProperty('claim');
  });
});

// ---------------------------------------------------------------------------
// Coaching context — claim reaches the coaching request builder
// ---------------------------------------------------------------------------

describe('Claim as coaching context', () => {
  it('claim from gate can be passed to buildCoachingRequest', async () => {
    const { buildCoachingRequest } = await import('../../src/coaching');
    const { gate } = makeGate('required');
    const claimText = 'The methodology section should justify sample size.';
    const result = await gate.gate(makePrompter(claimText));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const request = buildCoachingRequest({
      selectionText: 'Selected passage text.',
      anchorBase: 42,
      documentLanguage: 'markdown',
      claim: result.claim,
    });

    expect(request.claim).toBe(claimText);
    expect(request.selectionText).toBe('Selected passage text.');
  });

  it('buildCoachingRequest omits claim when not provided', async () => {
    const { buildCoachingRequest } = await import('../../src/coaching');

    const request = buildCoachingRequest({
      selectionText: 'Selected passage text.',
      anchorBase: 42,
      documentLanguage: 'markdown',
    });

    expect(request.claim).toBeUndefined();
  });
});
