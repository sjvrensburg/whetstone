/**
 * The forced structured-output JSON Schema for a coaching turn, plus the
 * runtime validator for `StructuredCoaching`.
 *
 * This schema is the structural floor of the refusal guard (ADR-003): its only
 * fields are anchored coaching moves, and `additionalProperties: false`
 * everywhere means there is no field a model could place replacement prose
 * into — the worst failure mode (ghostwriting) is impossible at the API level.
 * Providers force output against this exact object (task 09) and the guard
 * validates against it (task 10); it is the single source of truth, so it is
 * never duplicated.
 *
 * Note on constraints: Anthropic structured outputs do not enforce `minimum`
 * or `maxLength` server-side — the SDK strips them before sending and
 * re-validates client-side. They are kept here so the schema is self-
 * documenting and sourced from the shared constants, and {@link
 * validateStructuredCoaching} enforces them independently as the deterministic
 * layer (so caps hold regardless of provider behavior).
 */

import {
  MAX_OBSERVATIONS,
  OBSERVATION_KINDS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
} from '../shared/constants';
import type { StructuredCoaching } from '../shared/types';

/** A permissive JSON Schema object type — enough to type the schema literal
 * and hand it to a provider's forced-output call (`output_config.format`). */
export type JsonSchema = {
  type: string;
  [keyword: string]: unknown;
};

/**
 * The coaching forced-output schema. Exactly: an `observations` array of
 * objects each carrying `anchor` (start/end offsets), a `kind` from the move
 * taxonomy, a `reflection`, and a `question` — and no other field.
 */
export const COACHING_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
      maxItems: MAX_OBSERVATIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['anchor', 'kind', 'reflection', 'question'],
        properties: {
          anchor: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
            },
          },
          kind: { type: 'string', enum: [...OBSERVATION_KINDS] },
          reflection: { type: 'string', maxLength: REFLECTION_MAX_LENGTH },
          question: { type: 'string', maxLength: QUESTION_MAX_LENGTH },
        },
      },
    },
  },
};

/** The outcome of validating an unknown value against the coaching schema. */
export type ValidationResult = { ok: true } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `obj`'s own keys are exactly `keys` (no missing, no extra). */
function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => k in obj);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True when `question` reads as a question: non-empty and ending in `?`. The
 * cloud judge (task 11) handles deeper intent; this is the cheap deterministic
 * gate the guard reuses.
 */
export function isInterrogative(question: string): boolean {
  const trimmed = question.trim();
  return trimmed.length > 1 && trimmed.endsWith('?');
}

function validateObservation(value: unknown, index: number): ValidationResult {
  const at = `observations[${index}]`;
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${at} is not an object` };
  }
  // additionalProperties: false — any field beyond the four coaching moves
  // (including a prose-bearing one) is rejected here.
  if (!hasExactKeys(value, ['anchor', 'kind', 'reflection', 'question'])) {
    return { ok: false, reason: `${at} must have exactly anchor, kind, reflection, question` };
  }

  const { anchor, kind, reflection, question } = value;

  if (!isPlainObject(anchor) || !hasExactKeys(anchor, ['start', 'end'])) {
    return { ok: false, reason: `${at}.anchor must have exactly start and end` };
  }
  if (!isNonNegativeInteger(anchor.start) || !isNonNegativeInteger(anchor.end)) {
    return { ok: false, reason: `${at}.anchor offsets must be non-negative integers` };
  }

  if (typeof kind !== 'string' || !(OBSERVATION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `${at}.kind must be one of ${OBSERVATION_KINDS.join(', ')}` };
  }

  if (typeof reflection !== 'string') {
    return { ok: false, reason: `${at}.reflection must be a string` };
  }
  if (reflection.length > REFLECTION_MAX_LENGTH) {
    return { ok: false, reason: `${at}.reflection exceeds ${REFLECTION_MAX_LENGTH} characters` };
  }

  if (typeof question !== 'string') {
    return { ok: false, reason: `${at}.question must be a string` };
  }
  if (question.length > QUESTION_MAX_LENGTH) {
    return { ok: false, reason: `${at}.question exceeds ${QUESTION_MAX_LENGTH} characters` };
  }
  if (!isInterrogative(question)) {
    return { ok: false, reason: `${at}.question must be interrogative` };
  }

  return { ok: true };
}

/**
 * Validate an unknown value against {@link COACHING_JSON_SCHEMA}, enforcing the
 * structural floor (no extra/prose fields), the move taxonomy, and the length
 * caps — plus the interrogative-question rule the JSON Schema can't express.
 * Returns a reason on failure so the guard can surface it.
 */
export function validateStructuredCoaching(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'value is not an object' };
  }
  if (!hasExactKeys(value, ['observations'])) {
    return { ok: false, reason: 'top-level object must have exactly observations' };
  }
  const { observations } = value;
  if (!Array.isArray(observations)) {
    return { ok: false, reason: 'observations must be an array' };
  }
  if (observations.length > MAX_OBSERVATIONS) {
    return { ok: false, reason: `observations exceeds ${MAX_OBSERVATIONS} entries` };
  }
  for (let i = 0; i < observations.length; i++) {
    const result = validateObservation(observations[i], i);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

/** Type guard: narrows an unknown value to {@link StructuredCoaching}. */
export function isStructuredCoaching(value: unknown): value is StructuredCoaching {
  return validateStructuredCoaching(value).ok;
}
