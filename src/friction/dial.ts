/**
 * Friction-dial resolution API (ADR-008, task 20).
 *
 * The dial resolves an effective per-instrument configuration from:
 *   1. The current preset level (0–3)
 *   2. Per-instrument overrides (optional, raise individual instruments)
 *   3. The institutional floor (clamps the minimum — overrides may raise
 *      but must not lower below the floor)
 *
 * Changing the dial takes effect immediately without reload. Instruments
 * consult `instrumentState(name)` or `effectiveConfig()` at their discretion.
 */

import type { FrictionLevel, InstrumentName, InstrumentStateMap } from './presets';
import { PRESETS, stateOrdinal, isValidFrictionLevel, INSTRUMENT_NAMES } from './presets';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-instrument overrides. Only instruments with an explicit override
 *  are included; absent instruments fall through to the preset. */
export type InstrumentOverrides = Partial<InstrumentStateMap>;

/** The dial configuration — read from settings (task 04). */
export interface DialConfig {
  /** Current friction level (0–3). Defaults to 1 (Coach). */
  level: number;
  /** Institutional floor (0–3). Defaults to 0 (no floor). */
  floor: number;
  /** Per-instrument overrides. Absent instruments use the preset. */
  overrides: InstrumentOverrides;
}

/** The default dial configuration (level 1, no floor, no overrides). */
export const DEFAULT_DIAL_CONFIG: DialConfig = {
  level: 1,
  floor: 0,
  overrides: {},
};

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/**
 * Clamp a state to be at least as restrictive as the floor state.
 * If the proposed state's ordinal is below the floor's ordinal for that
 * instrument, returns the floor state; otherwise returns the proposed state.
 */
function clampToFloor(instrument: InstrumentName, proposed: string, floorState: string): string {
  const proposedOrdinal = stateOrdinal(instrument, proposed);
  const floorOrdinal = stateOrdinal(instrument, floorState);
  return proposedOrdinal >= floorOrdinal ? proposed : floorState;
}

/**
 * Resolve the effective configuration for a given dial config.
 *
 * Resolution order:
 *   1. Start with the preset for `level`.
 *   2. Apply any per-instrument overrides.
 *   3. Clamp each instrument against the floor: if the override would lower
 *      an instrument below the floor level's state, the floor wins.
 */
export function resolveEffectiveConfig(config: DialConfig): InstrumentStateMap {
  const level: FrictionLevel = isValidFrictionLevel(config.level) ? config.level : 1;
  const floor: FrictionLevel = isValidFrictionLevel(config.floor) ? config.floor : 0;
  const presetStates = PRESETS[level];
  const floorStates = PRESETS[floor];

  // 1. Start with preset states
  const effective = { ...presetStates };

  // 2. Apply per-instrument overrides
  for (const name of Object.keys(config.overrides) as InstrumentName[]) {
    const overrideValue = config.overrides[name];
    if (overrideValue !== undefined) {
      effective[name] = overrideValue as never;
    }
  }

  // 3. Clamp ALL instruments against the floor (not just overrides)
  for (const name of INSTRUMENT_NAMES) {
    effective[name] = clampToFloor(name, effective[name], floorStates[name]) as never;
  }

  return effective;
}

// ---------------------------------------------------------------------------
// Dial — the live, mutable resolution surface
// ---------------------------------------------------------------------------

/**
 * Observer callback — invoked whenever the effective config changes.
 * Receives the new effective config.
 */
export type DialObserver = (config: InstrumentStateMap) => void;

/**
 * The friction dial: holds the current configuration, resolves effective
 * per-instrument states, and notifies observers on change.
 *
 * Instruments call `instrumentState(name)` to get their effective state.
 * The control surface (task 20.4) calls `setLevel()` to change the dial.
 */
export class Dial {
  private _level: FrictionLevel;
  private _floor: FrictionLevel;
  private _overrides: InstrumentOverrides;
  private _effective: InstrumentStateMap;
  private readonly _observers: Set<DialObserver> = new Set();

  constructor(config: DialConfig = DEFAULT_DIAL_CONFIG) {
    this._level = isValidFrictionLevel(config.level) ? config.level : 1;
    this._floor = isValidFrictionLevel(config.floor) ? config.floor : 0;
    this._overrides = { ...config.overrides };
    this._effective = this._resolve();
  }

  /** The current friction level. */
  frictionLevel(): FrictionLevel {
    return this._level;
  }

  /** The institutional floor level. */
  floorLevel(): FrictionLevel {
    return this._floor;
  }

  /** The current per-instrument overrides. */
  overrides(): InstrumentOverrides {
    return { ...this._overrides };
  }

  /** The full effective configuration (resolved: preset + overrides + floor). */
  effectiveConfig(): InstrumentStateMap {
    return { ...this._effective };
  }

  /** The effective state for a single instrument. */
  instrumentState<N extends InstrumentName>(name: N): InstrumentStateMap[N] {
    return this._effective[name];
  }

  /** Set the friction level. Clamps to [0, 3]. Triggers observers if changed. */
  setLevel(level: number): void {
    const clamped: FrictionLevel = isValidFrictionLevel(level) ? level : 1;
    if (clamped === this._level) return;
    this._level = clamped;
    this._recompute();
  }

  /** Set the institutional floor. Clamps to [0, 3]. Triggers observers if changed. */
  setFloor(floor: number): void {
    const clamped: FrictionLevel = isValidFrictionLevel(floor) ? floor : 0;
    if (clamped === this._floor) return;
    this._floor = clamped;
    this._recompute();
  }

  /** Set per-instrument overrides. Replaces all overrides. Triggers observers. */
  setOverrides(overrides: InstrumentOverrides): void {
    this._overrides = { ...overrides };
    this._recompute();
  }

  /**
   * Update a single instrument override. Triggers observers if changed.
   * To clear an override, set it to `undefined`.
   */
  setOverride<N extends InstrumentName>(name: N, state: InstrumentStateMap[N] | undefined): void {
    if (state === undefined) {
      delete this._overrides[name];
    } else {
      (this._overrides as Record<string, string>)[name] = state;
    }
    this._recompute();
  }

  /** Update the full dial configuration at once. Triggers observers. */
  updateConfig(config: Partial<DialConfig>): void {
    if (config.level !== undefined) {
      const clamped: FrictionLevel = isValidFrictionLevel(config.level) ? config.level : 1;
      this._level = clamped;
    }
    if (config.floor !== undefined) {
      const clamped: FrictionLevel = isValidFrictionLevel(config.floor) ? config.floor : 0;
      this._floor = clamped;
    }
    if (config.overrides !== undefined) {
      this._overrides = { ...config.overrides };
    }
    this._recompute();
  }

  /** Register an observer that fires when the effective config changes. */
  observe(observer: DialObserver): () => void {
    this._observers.add(observer);
    return () => {
      this._observers.delete(observer);
    };
  }

  /** The current raw config (level, floor, overrides). */
  rawConfig(): DialConfig {
    return {
      level: this._level,
      floor: this._floor,
      overrides: { ...this._overrides },
    };
  }

  // --- Private ---

  private _resolve(): InstrumentStateMap {
    const presetStates = PRESETS[this._level];
    const floorStates = PRESETS[this._floor];

    // 1. Start with preset states
    const effective = { ...presetStates };

    // 2. Apply per-instrument overrides
    for (const name of Object.keys(this._overrides) as InstrumentName[]) {
      const overrideValue = this._overrides[name];
      if (overrideValue !== undefined) {
        effective[name] = overrideValue as never;
      }
    }

    // 3. Clamp ALL instruments against the floor
    for (const name of INSTRUMENT_NAMES) {
      effective[name] = clampToFloor(name, effective[name], floorStates[name]) as never;
    }

    return effective;
  }

  private _recompute(): void {
    const previous = this._effective;
    this._effective = this._resolve();

    // Only notify if something actually changed
    for (const name of Object.keys(previous) as InstrumentName[]) {
      if (previous[name] !== this._effective[name]) {
        this._notify();
        return;
      }
    }
  }

  private _notify(): void {
    const snapshot = { ...this._effective };
    for (const observer of this._observers) {
      observer(snapshot);
    }
  }
}
