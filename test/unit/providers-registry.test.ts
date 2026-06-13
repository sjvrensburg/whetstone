/**
 * Unit tests for the provider registry (src/providers/registry.ts).
 *
 * Tests config resolution, API key fallback, and factory creation — all
 * offline with no network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { WhetstoneSettings } from '../../src/shared/config';
import { DEFAULT_SETTINGS } from '../../src/shared/config';
import {
  createProvider,
  resolveApiKey,
  resolveProviderConfig,
  PROVIDER_DEFAULTS,
  type ApiKeySource,
} from '../../src/providers/registry';
import type { ProviderConfig } from '../../src/providers/types';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ZAI_SETTINGS: WhetstoneSettings = {
  ...DEFAULT_SETTINGS,
  activeProvider: 'zai',
};

const ZAI_SETTINGS_WITH_OVERRIDES: WhetstoneSettings = {
  ...DEFAULT_SETTINGS,
  activeProvider: 'zai',
  models: {
    coaching: 'glm-5.1-custom',
    judge: 'glm-5-turbo-fast',
  },
};

const API_KEY = 'sk-test-zai-key';

// ---------------------------------------------------------------------------
// ApiKeySource mock
// ---------------------------------------------------------------------------

function mockKeySource(key: string | undefined): ApiKeySource {
  return { getApiKey: vi.fn().mockResolvedValue(key) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Provider registry', () => {
  const originalEnv = process.env.Z_AI_API_KEY;

  beforeEach(() => {
    delete process.env.Z_AI_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.Z_AI_API_KEY = originalEnv;
    } else {
      delete process.env.Z_AI_API_KEY;
    }
  });

  // -----------------------------------------------------------------------
  // PROVIDER_DEFAULTS
  // -----------------------------------------------------------------------

  describe('PROVIDER_DEFAULTS', () => {
    it('includes ZAI with the correct endpoint and models', () => {
      expect(PROVIDER_DEFAULTS.zai).toEqual({
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        coachModel: 'glm-5.1',
        judgeModel: 'glm-5-turbo',
      });
    });

    it('includes Anthropic as a historical entry', () => {
      expect(PROVIDER_DEFAULTS.anthropic).toBeDefined();
      expect(PROVIDER_DEFAULTS.anthropic.baseUrl).toContain('anthropic.com');
    });
  });

  // -----------------------------------------------------------------------
  // resolveProviderConfig
  // -----------------------------------------------------------------------

  describe('resolveProviderConfig', () => {
    it('returns ZAI defaults when no overrides are set', () => {
      const config = resolveProviderConfig(ZAI_SETTINGS, API_KEY);

      expect(config).toEqual({
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        coachModel: 'glm-5.1',
        judgeModel: 'glm-5-turbo',
        apiKey: API_KEY,
      } satisfies ProviderConfig);
    });

    it('applies model overrides from settings', () => {
      const config = resolveProviderConfig(ZAI_SETTINGS_WITH_OVERRIDES, API_KEY);

      expect(config.coachModel).toBe('glm-5.1-custom');
      expect(config.judgeModel).toBe('glm-5-turbo-fast');
    });

    it('uses provider defaults when model overrides are empty', () => {
      const settings: WhetstoneSettings = {
        ...DEFAULT_SETTINGS,
        activeProvider: 'zai',
        models: { coaching: undefined, judge: undefined },
      };
      const config = resolveProviderConfig(settings, API_KEY);

      expect(config.coachModel).toBe('glm-5.1');
      expect(config.judgeModel).toBe('glm-5-turbo');
    });

    it('throws for an unknown provider', () => {
      const settings = { ...DEFAULT_SETTINGS, activeProvider: 'nonexistent' as any };

      expect(() => resolveProviderConfig(settings, API_KEY)).toThrow('Unknown provider');
    });

    it('reads base URL and models from config, not hard-coded at the call site', () => {
      // Verify that the config comes from PROVIDER_DEFAULTS, not inline values
      const config = resolveProviderConfig(ZAI_SETTINGS, API_KEY);
      const defaults = PROVIDER_DEFAULTS.zai;

      expect(config.baseUrl).toBe(defaults.baseUrl);
      expect(config.coachModel).toBe(defaults.coachModel);
      expect(config.judgeModel).toBe(defaults.judgeModel);
    });
  });

  // -----------------------------------------------------------------------
  // resolveApiKey
  // -----------------------------------------------------------------------

  describe('resolveApiKey', () => {
    it('returns the key from SecretStorage when present', async () => {
      const source = mockKeySource('stored-key');
      const key = await resolveApiKey(source);
      expect(key).toBe('stored-key');
    });

    it('falls back to Z_AI_API_KEY env var when SecretStorage has no key', async () => {
      const source = mockKeySource(undefined);
      process.env.Z_AI_API_KEY = 'env-key';
      const key = await resolveApiKey(source);
      expect(key).toBe('env-key');
    });

    it('returns undefined when neither source has a key', async () => {
      const source = mockKeySource(undefined);
      const key = await resolveApiKey(source);
      expect(key).toBeUndefined();
    });

    it('prefers SecretStorage over env var', async () => {
      const source = mockKeySource('storage-key');
      process.env.Z_AI_API_KEY = 'env-key';
      const key = await resolveApiKey(source);
      expect(key).toBe('storage-key');
    });
  });

  // -----------------------------------------------------------------------
  // createProvider
  // -----------------------------------------------------------------------

  describe('createProvider', () => {
    it('creates an OpenAICompatibleProvider with the resolved config', () => {
      const provider = createProvider(ZAI_SETTINGS, API_KEY);

      expect(provider.id).toBe('zai');
      expect(provider).toBeDefined();
      // Provider has coach and judge methods
      expect(typeof provider.coach).toBe('function');
      expect(typeof provider.judge).toBe('function');
    });

    it('accepts an optional client for dependency injection', () => {
      const mockCreate = vi.fn();
      const mockClient = {
        chat: { completions: { create: mockCreate } },
      } as any;

      const provider = createProvider(ZAI_SETTINGS, API_KEY, mockClient);
      expect(provider.id).toBe('zai');
    });
  });
});
