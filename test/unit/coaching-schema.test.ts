import { describe, it, expect } from 'vitest';
import {
  COACHING_JSON_SCHEMA,
  isInterrogative,
  isStructuredCoaching,
  validateStructuredCoaching,
} from '../../src/coaching/schema';
import {
  MAX_OBSERVATIONS,
  OBSERVATION_KINDS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
} from '../../src/shared/constants';
import type { StructuredCoaching } from '../../src/shared/types';

/** A structurally valid coaching response with one anchored observation. */
const validCoaching: StructuredCoaching = {
  observations: [
    {
      anchor: { start: 0, end: 24 },
      kind: 'implicit_claim',
      reflection: 'This sentence asserts a causal link without naming the mechanism.',
      question: 'What mechanism connects the cause to the effect here?',
    },
  ],
};

/** A typed view of the parts of the schema the structural assertions read. */
interface SchemaShape {
  additionalProperties: boolean;
  required: string[];
  properties: {
    observations: {
      type: string;
      maxItems: number;
      items: {
        additionalProperties: boolean;
        required: string[];
        properties: Record<
          string,
          { type?: string; enum?: string[]; maxLength?: number; additionalProperties?: boolean }
        >;
      };
    };
  };
}
const schema = COACHING_JSON_SCHEMA as unknown as SchemaShape;
const observationProps = schema.properties.observations.items.properties;

describe('COACHING_JSON_SCHEMA — the structural floor (ADR-003)', () => {
  it('has no field capable of holding replacement prose', () => {
    // additionalProperties: false everywhere is what makes ghostwriting
    // impossible at the API level.
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.observations.items.additionalProperties).toBe(false);
    expect(observationProps.anchor.additionalProperties).toBe(false);

    // An observation has exactly the four anchored coaching-move fields.
    expect(Object.keys(observationProps).sort()).toEqual([
      'anchor',
      'kind',
      'question',
      'reflection',
    ]);

    // None of the usual prose-bearing field names exists.
    const proseFields = [
      'prose',
      'rewrite',
      'rewritten',
      'text',
      'content',
      'suggestion',
      'draft',
      'replacement',
      'revision',
    ];
    for (const field of proseFields) {
      expect(field in observationProps).toBe(false);
    }
  });

  it('derives its taxonomy and caps from the shared constants (single source)', () => {
    expect(observationProps.kind.enum).toEqual([...OBSERVATION_KINDS]);
    expect(observationProps.reflection.maxLength).toBe(REFLECTION_MAX_LENGTH);
    expect(observationProps.question.maxLength).toBe(QUESTION_MAX_LENGTH);
    expect(schema.properties.observations.maxItems).toBe(MAX_OBSERVATIONS);
  });

  it('is consumable by a provider forced-output call shape (output_config.format)', () => {
    // Models the Anthropic forced-output shape task 09 will use with the real
    // SDK (`output_config: { format: { type: "json_schema", schema } }`).
    interface JsonSchemaFormat {
      type: 'json_schema';
      name?: string;
      schema: Record<string, unknown>;
    }
    interface ForcedOutputRequest {
      model: string;
      max_tokens: number;
      messages: { role: 'user'; content: string }[];
      output_config: { format: JsonSchemaFormat };
    }

    const request: ForcedOutputRequest = {
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Coach this passage.' }],
      output_config: {
        format: { type: 'json_schema', name: 'coaching', schema: COACHING_JSON_SCHEMA },
      },
    };

    expect(request.output_config.format.schema).toBe(COACHING_JSON_SCHEMA);
    expect(request.output_config.format.type).toBe('json_schema');
  });
});

describe('validateStructuredCoaching / isStructuredCoaching', () => {
  it('accepts a valid StructuredCoaching with anchored observations', () => {
    expect(validateStructuredCoaching(validCoaching)).toEqual({ ok: true });
    expect(isStructuredCoaching(validCoaching)).toBe(true);
  });

  it('accepts an empty observation list', () => {
    expect(isStructuredCoaching({ observations: [] })).toBe(true);
  });

  it('rejects an extra/prose-bearing field on an observation', () => {
    const leak = {
      observations: [
        {
          ...validCoaching.observations[0],
          rewrite: 'Here is a cleaner version you can paste in.',
        },
      ],
    };
    const result = validateStructuredCoaching(leak);
    expect(result.ok).toBe(false);
    expect(isStructuredCoaching(leak)).toBe(false);
  });

  it('rejects an extra field at the top level', () => {
    const leak = { observations: [], prose: 'paste-ready text' };
    expect(isStructuredCoaching(leak)).toBe(false);
  });

  it('rejects a question that is not interrogative', () => {
    const bad = {
      observations: [{ ...validCoaching.observations[0], question: 'Rewrite the sentence.' }],
    };
    const result = validateStructuredCoaching(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/interrogative/);
    }
  });

  it('rejects a reflection longer than the length cap', () => {
    const bad = {
      observations: [
        { ...validCoaching.observations[0], reflection: 'a'.repeat(REFLECTION_MAX_LENGTH + 1) },
      ],
    };
    expect(isStructuredCoaching(bad)).toBe(false);
  });

  it('rejects a question longer than the length cap', () => {
    const longQuestion = `${'a'.repeat(QUESTION_MAX_LENGTH)}?`;
    const bad = {
      observations: [{ ...validCoaching.observations[0], question: longQuestion }],
    };
    expect(isStructuredCoaching(bad)).toBe(false);
  });

  it('rejects a kind outside the move taxonomy', () => {
    const bad = {
      observations: [{ ...validCoaching.observations[0], kind: 'rewrite_request' }],
    };
    const result = validateStructuredCoaching(bad);
    expect(result.ok).toBe(false);
    expect(isStructuredCoaching(bad)).toBe(false);
  });

  it('rejects more observations than the cap allows', () => {
    const tooMany = {
      observations: Array.from(
        { length: MAX_OBSERVATIONS + 1 },
        () => validCoaching.observations[0],
      ),
    };
    expect(isStructuredCoaching(tooMany)).toBe(false);
  });

  it('rejects non-object and non-array shapes', () => {
    expect(isStructuredCoaching(null)).toBe(false);
    expect(isStructuredCoaching(42)).toBe(false);
    expect(isStructuredCoaching([])).toBe(false);
    expect(isStructuredCoaching({})).toBe(false);
    expect(isStructuredCoaching({ observations: 'nope' })).toBe(false);
  });

  it('rejects a non-object observation', () => {
    expect(isStructuredCoaching({ observations: [null] })).toBe(false);
    expect(isStructuredCoaching({ observations: [42] })).toBe(false);
  });

  it('rejects a malformed anchor', () => {
    const base = validCoaching.observations[0];
    expect(isStructuredCoaching({ observations: [{ ...base, anchor: { start: 0 } }] })).toBe(false);
    expect(
      isStructuredCoaching({ observations: [{ ...base, anchor: { start: 0, end: 1.5 } }] }),
    ).toBe(false);
    expect(
      isStructuredCoaching({ observations: [{ ...base, anchor: { start: -1, end: 2 } }] }),
    ).toBe(false);
    expect(isStructuredCoaching({ observations: [{ ...base, anchor: 'span 0-5' }] })).toBe(false);
  });

  it('rejects non-string reflection or question', () => {
    const base = validCoaching.observations[0];
    expect(isStructuredCoaching({ observations: [{ ...base, reflection: 5 }] })).toBe(false);
    expect(isStructuredCoaching({ observations: [{ ...base, question: 5 }] })).toBe(false);
  });
});

describe('isInterrogative', () => {
  it('accepts a trimmed question ending in "?"', () => {
    expect(isInterrogative('What is the claim?')).toBe(true);
    expect(isInterrogative('  Why?  ')).toBe(true);
  });

  it('rejects statements, empty input, and a bare "?"', () => {
    expect(isInterrogative('Rewrite this.')).toBe(false);
    expect(isInterrogative('')).toBe(false);
    expect(isInterrogative('   ')).toBe(false);
    expect(isInterrogative('?')).toBe(false);
  });
});
