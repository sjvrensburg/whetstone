/**
 * Typed accessor for Whetstone's VS Code settings (Component Overview:
 * `shared/` owns config access). Every consumer reads settings through here so
 * the defaults live in exactly one place and the rest of the codebase deals in
 * a typed `WhetstoneSettings` value rather than raw configuration lookups.
 *
 * The settings surface mirrors `package.json#contributes.configuration`: the
 * active provider (ADR-004), optional per-purpose model overrides, the opt-in
 * in-workspace ledger location (ADR-006), the grammar diagnostic severity /
 * quietness (PRD F4), and the opt-out telemetry flag (ADR-001).
 *
 * This module holds no secrets — the provider API key and the device signing
 * key live in SecretStorage (`./secrets`), never in configuration.
 */

import * as vscode from 'vscode';

/** The configuration section all Whetstone settings live under. */
export const CONFIG_SECTION = 'whetstone';

/**
 * The provider ids the active-provider setting accepts (ADR-004). ZAI is the
 * validated reference (amendment 2026-06-11); Anthropic is retained for future
 * activation once it passes the red-team gate. The list grows alongside
 * `package.json`'s enum.
 */
export const PROVIDER_IDS = ['zai', 'anthropic'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Grammar diagnostic severities, quietest-first (PRD F4: tuned to "hint/info",
 * never an alarming "error"). This setting is the configurable quietness dial
 * so coaching/grammar never feels like alarm.
 */
export const GRAMMAR_SEVERITIES = ['hint', 'info', 'warning'] as const;
export type GrammarSeverity = (typeof GRAMMAR_SEVERITIES)[number];

/**
 * Optional per-purpose model overrides; an absent field means "use the
 * provider's default model" (ADR-004: opus for coaching, haiku for the judge).
 */
export interface ModelOverrides {
  /** Override for the coaching model; `undefined` keeps the provider default. */
  coaching?: string;
  /** Override for the guard-judge model; `undefined` keeps the provider default. */
  judge?: string;
}

/** The fully-resolved, typed Whetstone settings. */
export interface WhetstoneSettings {
  /** The active cloud provider used for coaching inference. */
  activeProvider: ProviderId;
  /** Optional per-purpose model overrides. */
  models: ModelOverrides;
  /** Opt-in: store the ledger inside the workspace instead of global storage. */
  ledgerInWorkspace: boolean;
  /** Severity (quietness) of local grammar diagnostics. */
  grammarSeverity: GrammarSeverity;
  /** Whether opt-out telemetry collection is enabled. */
  telemetryEnabled: boolean;
  /**
   * Minimum characters in a single insert to be classified as paste-shaped
   * (ADR-006: record, don't certify). Changes below this threshold are
   * considered incremental typing and are not recorded.
   */
  externalInsertThreshold: number;
  /**
   * Friction-dial level (0–3). Controls the intensity of the friction
   * instruments (ADR-008). 0 = Quiet, 1 = Coach (default), 2 = Engaged,
   * 3 = Deep Work.
   */
  frictionLevel: number;
  /**
   * Institutional floor (0–3). A writer cannot drop the dial below this
   * level; overrides cannot lower an instrument below its floor-state
   * (ADR-008).
   */
  frictionFloor: number;
  /**
   * Per-instrument overrides. Keys are instrument names; values are the
   * requested state for that instrument. Only instruments with an explicit
   * override are included.
   */
  frictionOverrides: Record<string, string>;
}

/** The documented defaults, applied whenever a setting is unset. */
export const DEFAULT_SETTINGS: WhetstoneSettings = {
  activeProvider: 'zai',
  models: {},
  ledgerInWorkspace: false,
  grammarSeverity: 'info',
  telemetryEnabled: true,
  externalInsertThreshold: 50,
  frictionLevel: 1,
  frictionFloor: 0,
  frictionOverrides: {},
};

/**
 * The slice of `vscode.WorkspaceConfiguration` this module needs. Declaring it
 * structurally keeps `readSettings` pure and unit-testable with a plain fake,
 * while the live `WorkspaceConfiguration` still satisfies it at the call site.
 */
export interface ConfigurationSource {
  get<T>(section: string, defaultValue: T): T;
}

function coerceProvider(value: string): ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : DEFAULT_SETTINGS.activeProvider;
}

function coerceSeverity(value: string): GrammarSeverity {
  return (GRAMMAR_SEVERITIES as readonly string[]).includes(value)
    ? (value as GrammarSeverity)
    : DEFAULT_SETTINGS.grammarSeverity;
}

/** An empty or whitespace-only override means "use the provider default". */
function normalizeModel(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Coerce the external-insert threshold to a positive integer, falling back
 * to the default for NaN, negative, or zero values (hand-edited settings).
 */
function coerceThreshold(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_SETTINGS.externalInsertThreshold;
}

/**
 * Coerce a friction level (0–3). Invalid values fall back to the provided
 * default (level 1 for the dial itself, 0 for the floor).
 */
function coerceFrictionLevel(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : fallback;
}

/**
 * Map a configuration source onto the typed settings, applying the documented
 * defaults and coercing any out-of-range value back to its default (settings
 * can be hand-edited in `settings.json` beyond the contributed enum).
 */
export function readSettings(config: ConfigurationSource): WhetstoneSettings {
  return {
    activeProvider: coerceProvider(config.get('activeProvider', DEFAULT_SETTINGS.activeProvider)),
    models: {
      coaching: normalizeModel(config.get('models.coaching', '')),
      judge: normalizeModel(config.get('models.judge', '')),
    },
    ledgerInWorkspace: config.get('ledger.storeInWorkspace', DEFAULT_SETTINGS.ledgerInWorkspace),
    grammarSeverity: coerceSeverity(
      config.get('grammar.severity', DEFAULT_SETTINGS.grammarSeverity),
    ),
    telemetryEnabled: config.get('telemetry.enabled', DEFAULT_SETTINGS.telemetryEnabled),
    externalInsertThreshold: coerceThreshold(
      config.get('ledger.externalInsertThreshold', DEFAULT_SETTINGS.externalInsertThreshold),
    ),
    frictionLevel: coerceFrictionLevel(
      config.get('friction.level', DEFAULT_SETTINGS.frictionLevel),
      DEFAULT_SETTINGS.frictionLevel,
    ),
    frictionFloor: coerceFrictionLevel(
      config.get('friction.floor', DEFAULT_SETTINGS.frictionFloor),
      DEFAULT_SETTINGS.frictionFloor,
    ),
    frictionOverrides: config.get('friction.overrides', DEFAULT_SETTINGS.frictionOverrides),
  };
}

/** Read the live Whetstone settings from VS Code configuration. */
export function getSettings(): WhetstoneSettings {
  return readSettings(vscode.workspace.getConfiguration(CONFIG_SECTION));
}
