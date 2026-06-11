import { describe, it, expect } from 'vitest';
import {
  computeDisclosureText,
  TOOL_NAME,
  TOOL_DESCRIPTION,
  OVERSIGHT_DESCRIPTION,
} from '../../../src/ledger/disclosure';
import { SCOPING_NOTE } from '../../../src/ledger/report';
import type { LedgerEvent, LedgerEventType } from '../../../src/shared/types';
import { chainHash } from '../../../src/shared/crypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(
  seq: number,
  type: LedgerEventType,
  payload: unknown = {},
  prevHash: string = '',
): LedgerEvent {
  const entry = { seq, ts: `2026-06-11T10:00:0${seq}Z`, type, payload, prevHash };
  const hash = chainHash(entry);
  return { ...entry, hash };
}

function makeEventChain(specs: Array<{ type: LedgerEventType; payload?: unknown }>): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let prevHash = '';
  for (let i = 0; i < specs.length; i++) {
    const event = makeEvent(i, specs[i].type, specs[i].payload ?? {}, prevHash);
    events.push(event);
    prevHash = event.hash;
  }
  return events;
}

/** Coaching events with cloud_send metadata. */
function coachingEvents(count: number): Array<{ type: LedgerEventType; payload?: unknown }> {
  const specs: Array<{ type: LedgerEventType; payload?: unknown }> = [];
  for (let i = 0; i < count; i++) {
    specs.push({ type: 'ai_consult', payload: { observationCount: 3 } });
    specs.push({
      type: 'cloud_send',
      payload: {
        ts: `2026-06-11T10:0${i}:00Z`,
        provider: 'zai',
        model: 'glm-5.1',
        purpose: 'coaching',
        retention: '30 days',
      },
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Golden ICMJE three-element test
// ---------------------------------------------------------------------------

describe('computeDisclosureText — golden ICMJE three-element structure', () => {
  it('contains exactly the three ICMJE elements plus the scoping disclaimer', () => {
    const events = makeEventChain(coachingEvents(3));
    const disclosure = computeDisclosureText(events);

    // Element 1: Tool name
    expect(disclosure).toContain(TOOL_NAME);

    // Element 2: Per-use purpose (coaching sessions + provider)
    expect(disclosure).toContain('3 coaching sessions');
    expect(disclosure).toContain('zai');
    expect(disclosure).toContain('glm-5.1');
    expect(disclosure).toContain('coaching');

    // Element 3: Oversight extent
    expect(disclosure).toContain('reviewed all');
    expect(disclosure).toContain('editorial control');

    // Scoping disclaimer
    expect(disclosure).toContain(SCOPING_NOTE);

    // ICMJE reference
    expect(disclosure).toContain('ICMJE');
  });

  it('is a single coherent paragraph (or short paragraphs ending with the scoping note)', () => {
    const events = makeEventChain(coachingEvents(1));
    const disclosure = computeDisclosureText(events);

    // Should be a block of text ending with the scoping note.
    expect(disclosure.trim().length).toBeGreaterThan(0);
    expect(disclosure.endsWith(SCOPING_NOTE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-cloud (grammar-only) scenario
// ---------------------------------------------------------------------------

describe('computeDisclosureText — no cloud AI', () => {
  it('produces a non-declarable disclosure when no coaching occurred', () => {
    const events = makeEventChain([
      { type: 'suggestion_acted', payload: { observationIndex: 0 } },
      { type: 'suggestion_acted', payload: { observationIndex: 1 } },
    ]);

    const disclosure = computeDisclosureText(events);

    expect(disclosure).toContain(TOOL_NAME);
    expect(disclosure).toContain('No cloud-based AI assistance was used');
    expect(disclosure).toContain('grammar checking only');
    expect(disclosure).toContain(SCOPING_NOTE);
  });

  it('produces a non-declarable disclosure for an empty ledger', () => {
    const disclosure = computeDisclosureText([]);

    expect(disclosure).toContain(TOOL_NAME);
    expect(disclosure).toContain('No cloud-based AI assistance was used');
    expect(disclosure).toContain(SCOPING_NOTE);
  });
});

// ---------------------------------------------------------------------------
// Declarable cloud coaching
// ---------------------------------------------------------------------------

describe('computeDisclosureText — declarable cloud coaching', () => {
  it('declarable cloud coaching appears in the disclosure paragraph', () => {
    const events = makeEventChain([
      ...coachingEvents(2),
      { type: 'suggestion_acted', payload: {} },
    ]);

    const disclosure = computeDisclosureText(events);

    expect(disclosure).toContain('2 coaching sessions');
    expect(disclosure).toContain('Cloud-based AI assistance');
    expect(disclosure).toContain('zai');
  });

  it('deduplicates provider+model combinations', () => {
    const events = makeEventChain(coachingEvents(5));
    const disclosure = computeDisclosureText(events);

    // Only one provider+model pair — should appear once.
    const zaiMentions = disclosure.split('zai').length - 1;
    expect(zaiMentions).toBe(1);
  });

  it('handles multiple distinct providers', () => {
    const events = makeEventChain([
      {
        type: 'ai_consult',
        payload: {},
      },
      {
        type: 'cloud_send',
        payload: {
          ts: '2026-06-11T10:00:00Z',
          provider: 'zai',
          model: 'glm-5.1',
          purpose: 'coaching',
          retention: '30 days',
        },
      },
      {
        type: 'cloud_send',
        payload: {
          ts: '2026-06-11T11:00:00Z',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          purpose: 'judge',
          retention: 'not stored',
        },
      },
    ]);

    const disclosure = computeDisclosureText(events);

    expect(disclosure).toContain('zai');
    expect(disclosure).toContain('anthropic');
  });

  it('singular "session" for exactly one coaching session', () => {
    const events = makeEventChain(coachingEvents(1));
    const disclosure = computeDisclosureText(events);
    expect(disclosure).toContain('1 coaching session');
    expect(disclosure).not.toContain('1 coaching sessions');
  });
});

// ---------------------------------------------------------------------------
// No overclaim language
// ---------------------------------------------------------------------------

describe('computeDisclosureText — no overclaim language', () => {
  it('never contains "verified human" / "proof a human wrote" language', () => {
    const events = makeEventChain(coachingEvents(2));
    const disclosure = computeDisclosureText(events);

    const lower = disclosure.toLowerCase();
    expect(lower).not.toContain('verified human');
    expect(lower).not.toContain('proof a human wrote');
    expect(lower).not.toContain('proof of humanity');
    expect(lower).not.toContain('human wrote this');
  });

  it('the tool description explicitly says it does NOT generate prose', () => {
    expect(TOOL_DESCRIPTION).toContain('does not generate');
    expect(TOOL_DESCRIPTION).toContain('does not rewrite');
  });

  it('the oversight description asserts human editorial control', () => {
    expect(OVERSIGHT_DESCRIPTION).toContain('editorial control');
    expect(OVERSIGHT_DESCRIPTION).toContain('reviewed');
  });
});

// ---------------------------------------------------------------------------
// Malformed payloads
// ---------------------------------------------------------------------------

describe('computeDisclosureText — malformed payloads', () => {
  it('handles malformed cloud_send gracefully', () => {
    const events = makeEventChain([
      { type: 'ai_consult', payload: {} },
      { type: 'cloud_send', payload: null },
    ]);

    const disclosure = computeDisclosureText(events);
    // Should still produce a valid disclosure — "no cloud AI" or fallback.
    expect(disclosure).toContain(TOOL_NAME);
    expect(disclosure).toContain('1 coaching session');
    expect(disclosure).toContain('no cloud AI');
  });

  it('handles missing provider fields gracefully', () => {
    const events = makeEventChain([
      { type: 'ai_consult', payload: {} },
      { type: 'cloud_send', payload: { provider: 42 } }, // wrong type
    ]);

    const disclosure = computeDisclosureText(events);
    expect(disclosure).toContain(TOOL_NAME);
  });
});
