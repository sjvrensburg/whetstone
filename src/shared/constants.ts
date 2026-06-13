/**
 * Cross-module domain constants: the coaching move taxonomy and the per-field
 * length caps. These are the single source of truth that both the coaching
 * schema/validator (task 02) and the refusal guard's deterministic layer
 * (task 10) consume — neither redefines them (TechSpec "Data Models",
 * ADR-003 deterministic checks).
 */

/**
 * The coaching move taxonomy: the only kinds of structural observation
 * Whetstone may surface. Mirrors the PRD F1 moves — surface the implicit
 * claim, the intended move, and where the logic forks — and bounds the `kind`
 * field of every `Observation`. The schema's `enum` and the validator both
 * derive from this array, so the taxonomy lives in exactly one place.
 */
export const OBSERVATION_KINDS = ['implicit_claim', 'intended_move', 'logic_fork'] as const;

/** A single coaching move kind, derived from {@link OBSERVATION_KINDS}. */
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Maximum length (characters) of an observation's `reflection`. A reflection
 * is a short remark about structure, not prose; capping it is the first
 * deterministic defense against smuggling paste-ready text through this field
 * (ADR-003). The guard reuses this cap; the schema documents it.
 */
export const REFLECTION_MAX_LENGTH = 280;

/**
 * Maximum length (characters) of an observation's `question`. The single
 * unblocking question is interrogative and short; the cap bounds the field the
 * same way `reflection` is bounded.
 */
export const QUESTION_MAX_LENGTH = 200;

/**
 * Maximum number of observations in one coaching turn. The PRD calls for "a
 * small number" of anchored questions (F1); this bounds the array so a turn
 * cannot return a wall of text disguised as many short moves.
 */
export const MAX_OBSERVATIONS = 7;
