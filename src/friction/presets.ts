/**
 * Friction-dial presets and per-instrument state model (ADR-008, task 20).
 *
 * The friction dial controls five instruments (A–E; F is Phase 3) across four
 * named presets. Each instrument has its own state enum with an implicit
 * ordering from least restrictive (lowest ordinal) to most restrictive
 * (highest ordinal). The institutional floor clamps using this ordering: an
 * override may raise an instrument but must not lower it below the floor
 * level's state for that instrument.
 *
 * Presets:
 *   0 — Quiet:      minimal friction, on-demand coaching only
 *   1 — Coach:      today's behaviour (default)
 *   2 — Engaged:    active friction, push coaching, paste quarantine
 *   3 — Deep Work:  maximum friction, all instruments at highest state
 */

// ---------------------------------------------------------------------------
// Instrument identifiers
// ---------------------------------------------------------------------------

/** The five dial-able instruments (ADR-008). F (record) is Phase 3. */
export const INSTRUMENT_NAMES = [
  'coachingCadence',
  'pasteHandling',
  'claimFirst',
  'teachBack',
  'mirror',
] as const;

export type InstrumentName = (typeof INSTRUMENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Per-instrument state enums
// ---------------------------------------------------------------------------

/** Instrument A — coaching cadence. */
export const COACHING_CADENCE_STATES = ['pull', 'push'] as const;
export type CoachingCadenceState = (typeof COACHING_CADENCE_STATES)[number];

/** Instrument B — paste handling. */
export const PASTE_HANDLING_STATES = ['off', 'flag', 'quarantine', 'block'] as const;
export type PasteHandlingState = (typeof PASTE_HANDLING_STATES)[number];

/** Instrument C — claim-first commitment gate. */
export const CLAIM_FIRST_STATES = ['off', 'required'] as const;
export type ClaimFirstState = (typeof CLAIM_FIRST_STATES)[number];

/** Instrument D — teach-back checkpoints. */
export const TEACH_BACK_STATES = ['off', 'per-section'] as const;
export type TeachBackState = (typeof TEACH_BACK_STATES)[number];

/** Instrument E — process self-mirror. */
export const MIRROR_STATES = ['hidden', 'live'] as const;
export type MirrorState = (typeof MIRROR_STATES)[number];

/** Union of all instrument state string literals. */
export type InstrumentState =
  | CoachingCadenceState
  | PasteHandlingState
  | ClaimFirstState
  | TeachBackState
  | MirrorState;

/** Map from instrument name to its state type. */
export interface InstrumentStateMap {
  coachingCadence: CoachingCadenceState;
  pasteHandling: PasteHandlingState;
  claimFirst: ClaimFirstState;
  teachBack: TeachBackState;
  mirror: MirrorState;
}

// ---------------------------------------------------------------------------
// Ordinal lookup — for floor clamping, "higher ordinal = more restrictive"
// ---------------------------------------------------------------------------

const ORDINALS: Record<string, readonly string[]> = {
  coachingCadence: COACHING_CADENCE_STATES,
  pasteHandling: PASTE_HANDLING_STATES,
  claimFirst: CLAIM_FIRST_STATES,
  teachBack: TEACH_BACK_STATES,
  mirror: MIRROR_STATES,
};

/**
 * Return the ordinal (0-based) of a state for a given instrument.
 * Higher ordinal = more restrictive. Used by the floor-clamp logic.
 */
export function stateOrdinal(instrument: InstrumentName, state: string): number {
  const order = ORDINALS[instrument];
  const idx = order.indexOf(state);
  if (idx < 0) {
    throw new Error(`Unknown state "${state}" for instrument "${instrument}"`);
  }
  return idx;
}

/**
 * Return the state at the given ordinal for an instrument.
 * Returns `undefined` if ordinal is out of range.
 */
export function stateAtOrdinal(instrument: InstrumentName, ordinal: number): string | undefined {
  const order = ORDINALS[instrument];
  return order[ordinal];
}

// ---------------------------------------------------------------------------
// Friction level type
// ---------------------------------------------------------------------------

/** The four friction-dial levels (ADR-008). */
export const FRICTION_LEVELS = [0, 1, 2, 3] as const;
export type FrictionLevel = (typeof FRICTION_LEVELS)[number];

/** Human-readable labels for the four presets. */
export const FRICTION_LEVEL_LABELS: Record<FrictionLevel, string> = {
  0: 'Quiet',
  1: 'Coach',
  2: 'Engaged',
  3: 'Deep Work',
} as const;

/** Check that a value is a valid friction level. */
export function isValidFrictionLevel(value: number): value is FrictionLevel {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

/**
 * Per-instrument state for each friction level (ADR-008).
 *
 * Level 0 (Quiet):     pull / off / off / off / hidden
 * Level 1 (Coach):     pull / flag / off / off / hidden
 * Level 2 (Engaged):   push / quarantine / required / per-section / hidden
 * Level 3 (Deep Work): push / block / required / per-section / live
 */
export const PRESETS: Record<FrictionLevel, InstrumentStateMap> = {
  0: {
    coachingCadence: 'pull',
    pasteHandling: 'off',
    claimFirst: 'off',
    teachBack: 'off',
    mirror: 'hidden',
  },
  1: {
    coachingCadence: 'pull',
    pasteHandling: 'flag',
    claimFirst: 'off',
    teachBack: 'off',
    mirror: 'hidden',
  },
  2: {
    coachingCadence: 'push',
    pasteHandling: 'quarantine',
    claimFirst: 'required',
    teachBack: 'per-section',
    mirror: 'hidden',
  },
  3: {
    coachingCadence: 'push',
    pasteHandling: 'block',
    claimFirst: 'required',
    teachBack: 'per-section',
    mirror: 'live',
  },
};
