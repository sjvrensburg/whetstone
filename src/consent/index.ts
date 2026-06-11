/**
 * `consent/` — Just-in-time cloud consent gate + key setup (task 13, PRD F7).
 *
 * At the first moment text would leave the device, the gate:
 *   1. Discloses what text is sent, to which provider, and the retention policy.
 *   2. Sets the API key in SecretStorage if none is present.
 *   3. Records a `cloud_send` ledger event (provider, model, purpose, retention).
 *
 * Subsequent egresses within the same session skip the consent prompt but still
 * record `cloud_send`. Local grammar never triggers this gate — only callers
 * that egress (the UI coaching command, the explain-rule action) invoke
 * `ensureConsent()`.
 *
 * The gate is a class (`ConsentGate`) so session-scoped consent state is
 * encapsulated. UI interaction is injected via `ConsentPrompter` so the module
 * stays headlessly unit-testable (the same DI pattern used by LedgerImpl,
 * CoachingTurnDeps, etc.).
 *
 * Consent and `cloud_send` recording happen at one shared chokepoint
 * (ADR-004 implementation notes), satisfying both F7 consent and F3
 * provenance.
 */

import { PROVIDER_DEFAULTS } from '../providers/registry';
import type { Ledger } from '../shared/types';
import type { WhetstoneSettings } from '../shared/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why text is being sent to the cloud. */
export type ConsentPurpose = 'coaching' | 'explain_rule';

/** What the consent disclosure shows to the user. */
export interface ConsentDisclosure {
  /** The provider the text will be sent to. */
  provider: string;
  /** The model that will process the text. */
  model: string;
  /** Why text is being sent. */
  purpose: ConsentPurpose;
  /** What the provider discloses about retention of the sent text. */
  retention: string;
}

/**
 * UI interaction seam — the consent module doesn't import `vscode` directly.
 * The caller injects the actual prompt mechanism (QuickInput in production,
 * a stub in tests).
 */
export interface ConsentPrompter {
  /** Show the consent disclosure. Return true for accept, false for decline. */
  showConsentDisclosure(disclosure: ConsentDisclosure): Promise<boolean>;
  /** Prompt the user for an API key. Return the key or undefined on cancel. */
  promptForApiKey(providerName: string): Promise<string | undefined>;
}

/** The secrets seam the consent gate needs. */
export interface ConsentSecrets {
  /** Whether an API key has been set (the "no key set" signal). */
  hasApiKey(): Promise<boolean>;
  /** Store the API key. */
  setApiKey(key: string): Promise<void>;
}

/** Dependencies injected into `ConsentGate` — kept structural for testability. */
export interface ConsentDeps {
  secrets: ConsentSecrets;
  ledger: Ledger;
  settings: WhetstoneSettings;
  prompter: ConsentPrompter;
}

/** The outcome of the consent gate. */
export type ConsentResult = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Per-provider retention disclosures
// ---------------------------------------------------------------------------

/**
 * Retention disclosure per provider (ADR-004: each cloud send must state
 * whether the provider retains the text). These strings appear in the consent
 * prompt and in the `cloud_send` ledger payload.
 */
const RETENTION_DISCLOSURES: Record<string, string> = {
  zai: "ZAI may log your text for abuse monitoring. Refer to ZAI's terms of service for details.",
  anthropic:
    "Anthropic states it does not use API inputs for training. Refer to Anthropic's usage policy for details.",
};

/**
 * Return the retention disclosure for a provider. Unknown providers get a
 * generic statement.
 */
export function retentionFor(provider: string): string {
  return (
    RETENTION_DISCLOSURES[provider] ??
    'This provider may retain your text. Refer to its terms of service for details.'
  );
}

/**
 * Resolve the model name for a given purpose from provider defaults.
 * Coaching and explain-rule both use the coach model (the primary inference
 * model); the guard judge is an internal call that doesn't need its own
 * consent disclosure.
 */
export function modelForPurpose(provider: string, _purpose: ConsentPurpose): string {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(`Unknown provider: "${provider}".`);
  }
  // Both coaching and explain_rule use the primary coaching model.
  // The guard judge is an internal implementation detail.
  return defaults.coachModel;
}

// ---------------------------------------------------------------------------
// ConsentGate
// ---------------------------------------------------------------------------

/**
 * Session-scoped consent gate (F7). On the first egress it presents the
 * consent disclosure and handles key setup; on subsequent egresses it only
 * records `cloud_send`. Local grammar never calls this gate.
 */
export class ConsentGate {
  private consented = false;

  constructor(private readonly deps: ConsentDeps) {}

  /** Whether consent has been granted in this session. */
  get hasConsented(): boolean {
    return this.consented;
  }

  /** Reset consent state (for testing or when the provider changes). */
  reset(): void {
    this.consented = false;
  }

  /**
   * Ensure consent has been granted before egressing text to a cloud provider.
   *
   * On the first call (per session):
   *   1. Prompt for API key if none is stored (SecretStorage).
   *   2. Show the consent disclosure (what / where / retention).
   *   3. On accept, record `cloud_send` and mark consented.
   *   4. On decline, block egress — no `cloud_send` is recorded.
   *
   * Subsequent calls skip the prompt but still record `cloud_send`.
   *
   * @param purpose — why text is being sent ('coaching' or 'explain_rule').
   * @returns `{ ok: true }` on consent, `{ ok: false, reason }` on decline.
   */
  async ensureConsent(purpose: ConsentPurpose): Promise<ConsentResult> {
    const { secrets, ledger, settings, prompter } = this.deps;
    const provider = settings.activeProvider;

    // Resolve provider metadata — fail early for unknown providers.
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!defaults) {
      return { ok: false, reason: `Unknown provider: "${provider}".` };
    }

    const model = modelForPurpose(provider, purpose);
    const retention = retentionFor(provider);

    // --- First-egress: key setup + consent prompt ---
    if (!this.consented) {
      // Key setup: prompt if none is stored.
      const hasKey = await secrets.hasApiKey();
      if (!hasKey) {
        const key = await prompter.promptForApiKey(provider);
        if (!key) {
          return { ok: false, reason: 'API key not provided.' };
        }
        await secrets.setApiKey(key);
      }

      // Consent disclosure.
      const disclosure: ConsentDisclosure = { provider, model, purpose, retention };
      const accepted = await prompter.showConsentDisclosure(disclosure);
      if (!accepted) {
        return { ok: false, reason: 'Consent declined.' };
      }

      this.consented = true;
    }

    // --- Record cloud_send (every egress) ---
    await ledger.append({
      ts: new Date().toISOString(),
      type: 'cloud_send',
      payload: { provider, model, purpose, retention },
    });

    return { ok: true };
  }
}
