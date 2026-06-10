import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  GRAMMAR_SEVERITIES,
  PROVIDER_IDS,
  getSettings,
  readSettings,
  type ConfigurationSource,
} from '../../src/shared/config';

/** A configuration source backed by an explicit map; unknown keys fall back to
 * the caller-supplied default, exactly as `WorkspaceConfiguration.get` does. */
function fakeConfig(values: Record<string, unknown>): ConfigurationSource {
  return {
    get<T>(key: string, defaultValue: T): T {
      return key in values ? (values[key] as T) : defaultValue;
    },
  };
}

/** A configuration source where nothing is set — every lookup gets its default. */
const unsetConfig: ConfigurationSource = {
  get: <T>(_key: string, defaultValue: T): T => defaultValue,
};

describe('readSettings — defaults when configuration is unset', () => {
  it('returns the documented defaults', () => {
    expect(readSettings(unsetConfig)).toEqual(DEFAULT_SETTINGS);
  });

  it('leaves both model overrides undefined by default', () => {
    const settings = readSettings(unsetConfig);
    expect(settings.models.coaching).toBeUndefined();
    expect(settings.models.judge).toBeUndefined();
  });
});

describe('readSettings — typed values from configuration', () => {
  it('maps every configured value to its typed field', () => {
    const settings = readSettings(
      fakeConfig({
        activeProvider: 'anthropic',
        'models.coaching': 'claude-opus-4-8',
        'models.judge': 'claude-haiku-4-5',
        'ledger.storeInWorkspace': true,
        'grammar.severity': 'warning',
        'telemetry.enabled': false,
      }),
    );
    expect(settings).toEqual({
      activeProvider: 'anthropic',
      models: { coaching: 'claude-opus-4-8', judge: 'claude-haiku-4-5' },
      ledgerInWorkspace: true,
      grammarSeverity: 'warning',
      telemetryEnabled: false,
    });
  });

  it('trims model overrides and treats blank values as "use provider default"', () => {
    const settings = readSettings(
      fakeConfig({ 'models.coaching': '  claude-opus-4-8  ', 'models.judge': '   ' }),
    );
    expect(settings.models.coaching).toBe('claude-opus-4-8');
    expect(settings.models.judge).toBeUndefined();
  });
});

describe('readSettings — coercion of out-of-range values', () => {
  it('coerces an unknown provider back to the default', () => {
    const settings = readSettings(fakeConfig({ activeProvider: 'pirate-llm' }));
    expect(settings.activeProvider).toBe(DEFAULT_SETTINGS.activeProvider);
    expect(PROVIDER_IDS).toContain(settings.activeProvider);
  });

  it('coerces an unknown grammar severity back to the default', () => {
    const settings = readSettings(fakeConfig({ 'grammar.severity': 'explosive' }));
    expect(settings.grammarSeverity).toBe(DEFAULT_SETTINGS.grammarSeverity);
    expect(GRAMMAR_SEVERITIES).toContain(settings.grammarSeverity);
  });

  it('accepts each documented severity', () => {
    for (const severity of GRAMMAR_SEVERITIES) {
      expect(readSettings(fakeConfig({ 'grammar.severity': severity })).grammarSeverity).toBe(
        severity,
      );
    }
  });
});

describe('getSettings — reads VS Code configuration', () => {
  it('returns the documented defaults against the stub (unset) configuration', () => {
    expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
