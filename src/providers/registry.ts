/**
 * Provider registry: resolves settings + API key to a concrete CoachingProvider.
 * Per-provider defaults (base URL, model names) live here so the provider
 * implementation stays decoupled from config wiring.
 *
 * The API key comes from SecretStorage (extension) or the `Z_AI_API_KEY` env
 * var (local dev / headless CLI). The registry never logs the key.
 */

import OpenAI from 'openai';
import type { WhetstoneSettings } from '../shared/config';
import { OpenAICompatibleProvider } from './openaiCompatible';
import type { CoachingProvider, ProviderConfig, ProviderDefaults } from './types';

// ---------------------------------------------------------------------------
// Per-provider defaults
// ---------------------------------------------------------------------------

/** Provider defaults indexed by provider id (ADR-004 amendment: ZAI is the reference). */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  zai: {
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    coachModel: 'glm-5.1',
    judgeModel: 'glm-5-turbo',
  },
  anthropic: {
    // Historical defaults — Anthropic is not implemented in task 09; these
    // values exist so the config enum stays valid and a future provider can
    // pick them up. The guard prompts would need re-validation (ADR-004).
    baseUrl: 'https://api.anthropic.com/v1',
    coachModel: 'claude-opus-4-8',
    judgeModel: 'claude-haiku-4-5',
  },
};

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * The slice of `WhetstoneSecrets` the registry needs for key resolution.
 * Declared structurally so the registry doesn't couple to the full class.
 */
export interface ApiKeySource {
  getApiKey(): Promise<string | undefined>;
}

/**
 * Resolve the API key: try SecretStorage first, fall back to the `Z_AI_API_KEY`
 * environment variable (local dev / headless CLI).
 */
export async function resolveApiKey(source: ApiKeySource): Promise<string | undefined> {
  const fromStorage = await source.getApiKey();
  if (fromStorage) return fromStorage;
  return process.env.Z_AI_API_KEY;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective provider configuration from settings and an API key.
 * Applies per-provider defaults for base URL and model names, then overlays
 * any user-specified model overrides from settings.
 */
export function resolveProviderConfig(
  settings: WhetstoneSettings,
  apiKey: string,
): ProviderConfig {
  const defaults = PROVIDER_DEFAULTS[settings.activeProvider];
  if (!defaults) {
    throw new Error(`Unknown provider: "${settings.activeProvider}"`);
  }

  return {
    baseUrl: defaults.baseUrl,
    coachModel: settings.models.coaching ?? defaults.coachModel,
    judgeModel: settings.models.judge ?? defaults.judgeModel,
    apiKey,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `CoachingProvider` for the given settings and API key. Accepts an
 * optional `OpenAI` client for dependency injection (tests inject a stub).
 *
 * Currently all providers use the OpenAI-compatible wire format; a future
 * Anthropic-native provider would branch on `settings.activeProvider` here.
 */
export function createProvider(
  settings: WhetstoneSettings,
  apiKey: string,
  client?: OpenAI,
): CoachingProvider {
  const config = resolveProviderConfig(settings, apiKey);
  return new OpenAICompatibleProvider(settings.activeProvider, config, client);
}
