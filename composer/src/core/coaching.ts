/**
 * Coaching schema & validator — ported from V1 `src/coaching/schema.ts` and
 * `src/shared/constants.ts` (ADR-003 structural floor).
 *
 * The schema's only fields are anchored coaching moves; `additionalProperties:
 * false` everywhere means there is no field a model could place replacement
 * prose into — ghostwriting is impossible at the structural level. Providers
 * force output against the wire schema; the validator independently enforces
 * the caps the wire schema cannot carry (length caps, interrogative rule),
 * so the floor holds regardless of provider behavior.
 */

// ---------------------------------------------------------------------------
// Taxonomy & caps
// ---------------------------------------------------------------------------

/** The only kinds of structural observation coaching may surface. */
export const OBSERVATION_KINDS = ['implicit_claim', 'intended_move', 'logic_fork'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const REFLECTION_MAX_LENGTH = 280;
export const QUESTION_MAX_LENGTH = 200;
export const MAX_OBSERVATIONS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Observation {
  /** Offsets into the coached selection. */
  anchor: { start: number; end: number };
  kind: ObservationKind;
  /** A short structural remark — never replacement prose. */
  reflection: string;
  /** One genuine, interrogative unblocking question. */
  question: string;
}

export interface StructuredCoaching {
  observations: Observation[];
}

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

/**
 * The forced-output JSON schema sent to providers. Kept to the subset every
 * structured-output implementation supports (no maxLength/maxItems/minimum —
 * the validator enforces those caps client-side as the deterministic layer).
 */
export const COACHING_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
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
              start: { type: 'integer' },
              end: { type: 'integer' },
            },
          },
          kind: { type: 'string', enum: [...OBSERVATION_KINDS] },
          reflection: { type: 'string' },
          question: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => k in obj);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True when `question` reads as a question: non-empty and ending in `?`. */
export function isInterrogative(question: string): boolean {
  const trimmed = question.trim();
  return trimmed.length > 1 && trimmed.endsWith('?');
}

function validateObservation(value: unknown, index: number): ValidationResult {
  const at = `observations[${index}]`;
  if (!isPlainObject(value)) {
    return { ok: false, reason: `${at} is not an object` };
  }
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
 * Validate an unknown value against the coaching schema, enforcing the
 * structural floor (no extra/prose fields), the move taxonomy, the length
 * caps, and the interrogative-question rule.
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
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function isStructuredCoaching(value: unknown): value is StructuredCoaching {
  return validateStructuredCoaching(value).ok;
}
