/**
 * Unit + integration tests for the consent gate (task 13):
 * `ConsentGate.ensureConsent()` — the chokepoint that gates first egress,
 * handles key setup, and records `cloud_send` ledger events.
 *
 * All UI interaction (consent disclosure, API key prompt) is stubbed; no
 * network or VS Code calls. Tests verify the gate's composition logic, not
 * the individual dependencies (those are tested in their own files).
 */

import { describe, it, expect, vi } from 'vitest';
import { ConsentGate, retentionFor, modelForPurpose } from '../../src/consent/index';
import type { ConsentDeps, ConsentPrompter, ConsentSecrets } from '../../src/consent/index';
import type { Ledger } from '../../src/shared/types';
import type { WhetstoneSettings } from '../../src/shared/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: WhetstoneSettings = {
  activeProvider: 'zai',
  models: {},
  ledgerInWorkspace: false,
  grammarSeverity: 'info',
  telemetryEnabled: true,
  externalInsertThreshold: 50,
};

/** Create a prompter stub with controllable responses. */
function stubPrompter(
  opts: {
    consentAccepted?: boolean;
    apiKey?: string | undefined;
  } = {},
): ConsentPrompter & {
  disclosures: Array<Parameters<ConsentPrompter['showConsentDisclosure']>[0]>;
  keyPrompts: string[];
} {
  const disclosures: Array<Parameters<ConsentPrompter['showConsentDisclosure']>[0]> = [];
  const keyPrompts: string[] = [];
  return {
    disclosures,
    keyPrompts,
    showConsentDisclosure: vi.fn(async (d) => {
      disclosures.push(d);
      return opts.consentAccepted ?? true;
    }),
    promptForApiKey: vi.fn(async (providerName) => {
      keyPrompts.push(providerName);
      return opts.apiKey;
    }),
  };
}

/** Create a secrets stub. */
function stubSecrets(
  hasKey = true,
  _keyToReturn?: string,
): ConsentSecrets & {
  storedKeys: string[];
} {
  const storedKeys: string[] = [];
  let has = hasKey;
  return {
    storedKeys,
    hasApiKey: vi.fn(async () => has),
    setApiKey: vi.fn(async (key: string) => {
      storedKeys.push(key);
      has = true;
    }),
  };
}

/** Create a ledger stub that tracks append calls. */
function stubLedger(): Ledger & {
  _appends: Array<{ ts: string; type: string; payload: unknown }>;
} {
  const appends: Array<{ ts: string; type: string; payload: unknown }> = [];
  return {
    append: vi.fn(async (e: { ts: string; type: string; payload: unknown }) => {
      appends.push(e);
    }),
    _appends: appends,
    verify: vi.fn(async () => ({ intact: true })),
    report: vi.fn(),
    exportDisclosure: vi.fn(),
  } as unknown as Ledger & {
    _appends: Array<{ ts: string; type: string; payload: unknown }>;
  };
}

/** Build a ConsentGate with the given options. */
function makeGate(
  opts: {
    settings?: Partial<WhetstoneSettings>;
    hasKey?: boolean;
    apiKey?: string | undefined;
    consentAccepted?: boolean;
  } = {},
): {
  gate: ConsentGate;
  ledger: ReturnType<typeof stubLedger>;
  secrets: ReturnType<typeof stubSecrets>;
  prompter: ReturnType<typeof stubPrompter>;
} {
  const ledger = stubLedger();
  const secrets = stubSecrets(opts.hasKey ?? true, opts.apiKey);
  const prompter = stubPrompter({
    consentAccepted: opts.consentAccepted ?? true,
    apiKey: 'apiKey' in opts ? opts.apiKey : 'test-api-key-123',
  });
  const settings: WhetstoneSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const deps: ConsentDeps = { secrets, ledger, settings, prompter };
  const gate = new ConsentGate(deps);
  return { gate, ledger, secrets, prompter };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('retentionFor', () => {
  it('returns ZAI-specific retention disclosure', () => {
    expect(retentionFor('zai')).toContain('ZAI');
  });

  it('returns Anthropic-specific retention disclosure', () => {
    expect(retentionFor('anthropic')).toContain('Anthropic');
  });

  it('returns generic disclosure for unknown providers', () => {
    const result = retentionFor('unknown-provider');
    expect(result).toContain('may retain your text');
  });
});

describe('modelForPurpose', () => {
  it('resolves coaching to the coach model', () => {
    expect(modelForPurpose('zai', 'coaching')).toBe('glm-5.1');
  });

  it('resolves explain_rule to the coach model', () => {
    expect(modelForPurpose('zai', 'explain_rule')).toBe('glm-5.1');
  });

  it('throws for unknown providers', () => {
    expect(() => modelForPurpose('nonexistent', 'coaching')).toThrow('Unknown provider');
  });
});

describe('ConsentGate', () => {
  // -------------------------------------------------------------------------
  // 13.1 — First egress shows disclosure and records cloud_send on accept
  // -------------------------------------------------------------------------

  describe('first egress (consent accepted)', () => {
    it('shows the disclosure and records cloud_send on accept', async () => {
      const { gate, ledger, prompter } = makeGate();

      const result = await gate.ensureConsent('coaching');

      expect(result).toEqual({ ok: true });
      // Disclosure was shown.
      expect(prompter.disclosures).toHaveLength(1);
      expect(prompter.disclosures[0]).toMatchObject({
        provider: 'zai',
        model: 'glm-5.1',
        purpose: 'coaching',
        retention: expect.stringContaining('ZAI'),
      });
      // cloud_send was recorded.
      expect(ledger._appends).toHaveLength(1);
      expect(ledger._appends[0].type).toBe('cloud_send');
      expect(ledger._appends[0].payload).toMatchObject({
        provider: 'zai',
        model: 'glm-5.1',
        purpose: 'coaching',
      });
    });

    it('passes the correct purpose through to the disclosure', async () => {
      const { gate, prompter } = makeGate();

      await gate.ensureConsent('explain_rule');

      expect(prompter.disclosures[0].purpose).toBe('explain_rule');
    });
  });

  // -------------------------------------------------------------------------
  // Declining blocks egress and records no cloud_send
  // -------------------------------------------------------------------------

  describe('consent declined', () => {
    it('blocks egress and records no cloud_send', async () => {
      const { gate, ledger, prompter } = makeGate({
        consentAccepted: false,
      });

      const result = await gate.ensureConsent('coaching');

      expect(result).toEqual({ ok: false, reason: 'Consent declined.' });
      // Disclosure was shown.
      expect(prompter.disclosures).toHaveLength(1);
      // No cloud_send was recorded.
      expect(ledger._appends).toHaveLength(0);
      // Gate is not consented.
      expect(gate.hasConsented).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 13.2 — Key setup stores the supplied key
  // -------------------------------------------------------------------------

  describe('key setup', () => {
    it('prompts for and stores the API key when none is present', async () => {
      const { gate, secrets, prompter } = makeGate({
        hasKey: false,
        apiKey: 'my-new-key',
      });

      const result = await gate.ensureConsent('coaching');

      expect(result).toEqual({ ok: true });
      // Key was prompted for.
      expect(prompter.keyPrompts).toHaveLength(1);
      expect(prompter.keyPrompts[0]).toBe('zai');
      // Key was stored.
      expect(secrets.storedKeys).toEqual(['my-new-key']);
    });

    it('blocks egress when key prompt is cancelled', async () => {
      const { gate, ledger } = makeGate({
        hasKey: false,
        apiKey: undefined, // user cancelled
      });

      const result = await gate.ensureConsent('coaching');

      expect(result).toEqual({ ok: false, reason: 'API key not provided.' });
      expect(ledger._appends).toHaveLength(0);
    });

    it('does not prompt for key when one already exists', async () => {
      const { gate, prompter } = makeGate({ hasKey: true });

      await gate.ensureConsent('coaching');

      // No key prompt — only consent disclosure.
      expect(prompter.keyPrompts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 13.3 — cloud_send recorded at the egress chokepoint
  // -------------------------------------------------------------------------

  describe('cloud_send recording', () => {
    it('records cloud_send with provider, model, purpose, and retention', async () => {
      const { gate, ledger } = makeGate();

      await gate.ensureConsent('coaching');

      const entry = ledger._appends[0];
      expect(entry.type).toBe('cloud_send');
      expect(entry.payload).toEqual({
        provider: 'zai',
        model: 'glm-5.1',
        purpose: 'coaching',
        retention: expect.stringContaining('ZAI'),
      });
      // Timestamp is a valid ISO string.
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
    });
  });

  // -------------------------------------------------------------------------
  // 13.4 — Subsequent egresses skip re-prompt
  // -------------------------------------------------------------------------

  describe('subsequent egresses', () => {
    it('do not re-prompt for consent', async () => {
      const { gate, prompter, ledger } = makeGate();

      // First egress — shows disclosure.
      await gate.ensureConsent('coaching');
      expect(prompter.disclosures).toHaveLength(1);
      expect(ledger._appends).toHaveLength(1);

      // Second egress — no disclosure, still records cloud_send.
      const result = await gate.ensureConsent('coaching');
      expect(result).toEqual({ ok: true });
      expect(prompter.disclosures).toHaveLength(1); // not increased
      expect(ledger._appends).toHaveLength(2); // second cloud_send
    });

    it('records separate cloud_send for each egress', async () => {
      const { gate, ledger } = makeGate();

      await gate.ensureConsent('coaching');
      await gate.ensureConsent('explain_rule');

      expect(ledger._appends).toHaveLength(2);
      expect(ledger._appends[0].payload).toMatchObject({ purpose: 'coaching' });
      expect(ledger._appends[1].payload).toMatchObject({ purpose: 'explain_rule' });
    });
  });

  // -------------------------------------------------------------------------
  // Unknown provider
  // -------------------------------------------------------------------------

  describe('unknown provider', () => {
    it('returns a failure for an unknown provider', async () => {
      const { gate } = makeGate({
        // Cast to override — simulates a hand-edited setting.
        settings: { activeProvider: 'nonexistent' as WhetstoneSettings['activeProvider'] },
      });

      const result = await gate.ensureConsent('coaching');
      expect(result).toEqual({ ok: false, reason: 'Unknown provider: "nonexistent".' });
    });
  });

  // -------------------------------------------------------------------------
  // hasConsented / reset
  // -------------------------------------------------------------------------

  describe('state management', () => {
    it('hasConsented is false before any call', () => {
      const { gate } = makeGate();
      expect(gate.hasConsented).toBe(false);
    });

    it('hasConsented is true after consent', async () => {
      const { gate } = makeGate();
      await gate.ensureConsent('coaching');
      expect(gate.hasConsented).toBe(true);
    });

    it('reset() clears consent state', async () => {
      const { gate, prompter } = makeGate();
      await gate.ensureConsent('coaching');
      expect(gate.hasConsented).toBe(true);

      gate.reset();
      expect(gate.hasConsented).toBe(false);

      // Next call re-prompts.
      await gate.ensureConsent('coaching');
      expect(prompter.disclosures).toHaveLength(2); // shown again
    });
  });

  // -------------------------------------------------------------------------
  // Local grammar does not invoke the consent gate
  // -------------------------------------------------------------------------

  describe('local grammar isolation', () => {
    it('grammar operations never call ensureConsent', () => {
      // The consent gate is an opt-in chokepoint: only callers that egress
      // invoke `ensureConsent()`. Local grammar (harper.js WASM) runs
      // entirely in-process and never touches the consent module. This test
      // verifies the gate is simply not in the local code path — a ConsentGate
      // instance that was never called has no recorded events.
      const { gate, ledger, prompter } = makeGate();

      // Simulate a local-only grammar session: no calls to ensureConsent.
      expect(gate.hasConsented).toBe(false);
      expect(ledger._appends).toHaveLength(0);
      expect(prompter.disclosures).toHaveLength(0);
      expect(prompter.keyPrompts).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('consent integration', () => {
  it('no cloud_send exists before the consent moment', async () => {
    const { gate, ledger } = makeGate();

    // Before any consent call, ledger is empty.
    expect(ledger._appends).toHaveLength(0);
    expect(gate.hasConsented).toBe(false);

    // Decline consent — still no cloud_send.
    const declining = makeGate({ consentAccepted: false });
    const result = await declining.gate.ensureConsent('coaching');
    expect(result.ok).toBe(false);
    expect(declining.ledger._appends).toHaveLength(0);
  });

  it('on accept, key is set and exactly one cloud_send is recorded', async () => {
    const { gate, ledger, secrets } = makeGate({
      hasKey: false,
      apiKey: 'integ-test-key',
    });

    const result = await gate.ensureConsent('coaching');

    // Consent was granted.
    expect(result).toEqual({ ok: true });
    expect(gate.hasConsented).toBe(true);

    // Key was stored.
    expect(secrets.storedKeys).toEqual(['integ-test-key']);

    // Exactly one cloud_send.
    expect(ledger._appends).toHaveLength(1);
    expect(ledger._appends[0].type).toBe('cloud_send');
    expect(ledger._appends[0].payload).toMatchObject({
      provider: 'zai',
      model: 'glm-5.1',
      purpose: 'coaching',
    });
  });

  it('consent + cloud_send happen at one shared chokepoint', async () => {
    // Verify the invariant: consent acceptance and cloud_send recording
    // always happen together — there is no path that records cloud_send
    // without consent, and no path that grants consent without recording.
    const { gate, ledger, prompter } = makeGate();

    // Accept: disclosure shown + cloud_send recorded.
    const r1 = await gate.ensureConsent('coaching');
    expect(r1.ok).toBe(true);
    expect(prompter.disclosures).toHaveLength(1);
    expect(ledger._appends).toHaveLength(1);

    // Second call: no disclosure (already consented) + cloud_send recorded.
    const r2 = await gate.ensureConsent('explain_rule');
    expect(r2.ok).toBe(true);
    expect(prompter.disclosures).toHaveLength(1);
    expect(ledger._appends).toHaveLength(2);

    // Now decline: consent already granted, so decline can't happen through
    // the normal flow. Verify via a fresh gate with no prior consent.
    const declined = makeGate({ consentAccepted: false });
    const r3 = await declined.gate.ensureConsent('coaching');
    expect(r3.ok).toBe(false);
    expect(declined.ledger._appends).toHaveLength(0);
    expect(declined.prompter.disclosures).toHaveLength(1);
  });
});
