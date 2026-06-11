/**
 * The swappable cloud-inference seam (ADR-004). The only module that talks to
 * a cloud endpoint, reading the user's BYO key from SecretStorage and calling
 * the provider directly — no Whetstone backend, no account.
 *
 * `CoachingProvider` is the interface; `OpenAICompatibleProvider` (the ZAI/GLM
 * reference implementation) lives in `./openaiCompatible.ts`. Provider selection
 * is by settings; the registry in `./registry.ts` resolves config and creates
 * the concrete instance.
 */

import type { CoachingRequest, GuardVerdict, StructuredCoaching } from '../shared/types';

// ---------------------------------------------------------------------------
// Typed failure
// ---------------------------------------------------------------------------

/** Machine-readable error categories for a provider call failure. */
export type ProviderErrorKind =
  | 'timeout'
  | 'auth'
  | 'validation'
  | 'network'
  | 'blocked'
  | 'unknown';

/** A typed failure from a provider call — never fabricated output. */
export interface ProviderError {
  /** Machine-readable error category. */
  kind: ProviderErrorKind;
  /**
   * Human-readable message (safe for the UI; never contains the API key).
   * Kept short so it can be surfaced in the coaching panel.
   */
  message: string;
  /** The underlying error, if any (not surfaced to the user). */
  cause?: Error;
}

/** The outcome of a provider call: either a validated value or a typed error. */
export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

/**
 * Configuration for a concrete provider — base URL, model names, and the API
 * key. Read from settings (task 04) and SecretStorage by the registry; the
 * provider itself treats it as a frozen value.
 */
export interface ProviderConfig {
  /** The OpenAI-compatible Chat Completions base URL. */
  baseUrl: string;
  /** The model to use for coaching (forced structured output). */
  coachModel: string;
  /** The model to use for the guard judge (cheap model). */
  judgeModel: string;
  /**
   * The API key — read from SecretStorage (extension) or `Z_AI_API_KEY` env
   * var (local dev). Never logged or written to the ledger.
   */
  apiKey: string;
  /** Request timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
}

/** Per-provider default config (base URL and model names). */
export interface ProviderDefaults {
  baseUrl: string;
  coachModel: string;
  judgeModel: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * The swappable cloud-inference seam (ADR-004). The only module that talks to
 * a cloud endpoint. Provider selection is by settings; the reference V1
 * implementation is ZAI/GLM (OpenAI-compatible).
 */
export interface CoachingProvider {
  /** Provider identifier matching the settings/config value. */
  readonly id: string;

  /**
   * Produce a structured coaching response with forced JSON-schema output.
   * The response is validated against the coaching schema; a malformed or
   * blocked response yields a typed failure — never renderable prose.
   */
  coach(req: CoachingRequest): Promise<ProviderResult<StructuredCoaching>>;

  /**
   * Run the guard judge (cheap model) against a candidate coaching response.
   * Returns a verdict on whether the response contains paste-ready prose.
   */
  judge(candidate: StructuredCoaching): Promise<ProviderResult<GuardVerdict>>;
}
