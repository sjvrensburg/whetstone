/**
 * Unit tests for the OpenAI-compatible provider (src/providers/openaiCompatible.ts)
 * and the provider prompts (src/providers/prompts.ts).
 *
 * All provider calls are stubbed — no network, no live API key. The mock
 * simulates the OpenAI SDK's chat.completions.create return shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';

import { COACHING_JSON_SCHEMA, isStructuredCoaching } from '../../src/coaching/schema';
import type { CoachingRequest, GuardVerdict, StructuredCoaching } from '../../src/shared/types';
import {
  buildCoachMessages,
  buildJudgeMessages,
  COACHING_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
} from '../../src/providers/prompts';
import { OpenAICompatibleProvider } from '../../src/providers/openaiCompatible';
import type { ProviderConfig, ProviderResult } from '../../src/providers/types';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'sk-test-zai-abcdef1234567890';

const TEST_CONFIG: ProviderConfig = {
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  coachModel: 'glm-5.1',
  judgeModel: 'glm-5-turbo',
  apiKey: TEST_API_KEY,
};

const VALID_COACHING: StructuredCoaching = {
  observations: [
    {
      anchor: { start: 0, end: 42 },
      kind: 'implicit_claim',
      reflection: 'The passage assumes causation without evidence.',
      question: 'What evidence supports the causal link you draw here?',
    },
    {
      anchor: { start: 43, end: 80 },
      kind: 'logic_fork',
      reflection: 'The argument could follow two distinct paths from this point.',
      question: 'Which direction of reasoning serves your central claim better?',
    },
  ],
};

const VALID_VERDICT: GuardVerdict = {
  refused: false,
  reason: 'All fields are structural observations and genuine questions.',
};

const COACHING_REQUEST: CoachingRequest = {
  selectionText: 'The data clearly shows that X causes Y. However, the mechanism remains unclear.',
  anchorBase: 0,
  documentLanguage: 'markdown',
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockCreate = ReturnType<typeof vi.fn>;

/** Create a mock OpenAI client that returns `mockCreate` as chat.completions.create. */
function mockClient(mockCreate: MockCreate): OpenAI {
  return {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  } as unknown as OpenAI;
}

/** A successful json_schema coaching response. */
function jsonSchemaCoachingResponse(coaching: StructuredCoaching = VALID_COACHING) {
  return {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(coaching) },
        finish_reason: 'stop',
      },
    ],
  };
}

/** A successful tool_call coaching response. */
function toolCallCoachingResponse(coaching: StructuredCoaching = VALID_COACHING) {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function' as const,
              function: {
                name: 'produce_coaching',
                arguments: JSON.stringify(coaching),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

/** A successful json_schema verdict response. */
function jsonSchemaVerdictResponse(verdict: GuardVerdict = VALID_VERDICT) {
  return {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(verdict) },
        finish_reason: 'stop',
      },
    ],
  };
}

/** A successful tool_call verdict response. */
function toolCallVerdictResponse(verdict: GuardVerdict = VALID_VERDICT) {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_456',
              type: 'function' as const,
              function: {
                name: 'produce_verdict',
                arguments: JSON.stringify(verdict),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

/** An API error simulating unsupported json_schema response_format. */
class UnsupportedSchemaError extends Error {
  status = 400;
  override message = 'Unsupported response_format: json_schema is not supported by this endpoint.';
  constructor() {
    super('Unsupported response_format: json_schema is not supported by this endpoint.');
  }
}

/** A generic API error with a status code. */
function apiErrorWithStatus(status: number, message: string) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

function makeProvider(mockCreate: MockCreate): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider('zai', TEST_CONFIG, mockClient(mockCreate));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider', () => {
  let mockCreate: MockCreate;

  beforeEach(() => {
    mockCreate = vi.fn();
  });

  // -----------------------------------------------------------------------
  // coach() — json_schema strategy
  // -----------------------------------------------------------------------

  describe('coach() — json_schema strategy', () => {
    it('requests forced schema output and returns a validated StructuredCoaching', async () => {
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse());

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(true);
      if (!result.ok) return; // type narrowing
      expect(result.value).toEqual(VALID_COACHING);

      // Verify the request used json_schema structured output
      expect(mockCreate).toHaveBeenCalledOnce();
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe('glm-5.1');
      expect(call.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'coaching_response',
          strict: true,
          schema: COACHING_JSON_SCHEMA,
        },
      });
    });

    it('uses the config base URL and models, not hard-coded values', async () => {
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse());

      const customConfig: ProviderConfig = {
        baseUrl: 'https://custom.api.example.com/v1',
        coachModel: 'custom-model-v2',
        judgeModel: 'custom-judge-v1',
        apiKey: 'test-key',
      };
      const provider = new OpenAICompatibleProvider('custom', customConfig, mockClient(mockCreate));
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(true);
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe('custom-model-v2');
    });
  });

  // -----------------------------------------------------------------------
  // coach() — tool_call fallback
  // -----------------------------------------------------------------------

  describe('coach() — tool_call fallback', () => {
    it('falls back to tool_call when json_schema is unsupported', async () => {
      // First call (json_schema) throws unsupported error
      // Second call (tool_call) succeeds
      mockCreate
        .mockRejectedValueOnce(new UnsupportedSchemaError())
        .mockResolvedValueOnce(toolCallCoachingResponse());

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(VALID_COACHING);

      // Second call used tool_call strategy
      expect(mockCreate).toHaveBeenCalledTimes(2);
      const toolCall = mockCreate.mock.calls[1][0];
      expect(toolCall.tools).toBeDefined();
      expect(toolCall.tools[0].function.name).toBe('produce_coaching');
      expect(toolCall.tool_choice).toEqual({
        type: 'function',
        function: { name: 'produce_coaching' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // coach() — validation failures
  // -----------------------------------------------------------------------

  describe('coach() — validation failures', () => {
    it('rejects a response missing required schema fields and returns no prose', async () => {
      const malformed = { observations: [{ anchor: { start: 0, end: 10 } }] }; // missing kind, reflection, question
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse(malformed as any));

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
      expect(result.error.message).toContain('schema');
      // No prose value is accessible
    });

    it('rejects a response with extra fields (no prose field)', async () => {
      const withExtra = {
        observations: [
          {
            anchor: { start: 0, end: 42 },
            kind: 'implicit_claim',
            reflection: 'Structural observation.',
            question: 'Why does this matter?',
            // Extra field — should be rejected by strict validation
            rewrite: 'You should say it differently because...',
          },
        ],
      };
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse(withExtra as any));

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
    });

    it('rejects a response with empty/null content', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      });

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
    });

    it('rejects a response with non-JSON content', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'This is plain text, not JSON.' }, finish_reason: 'stop' },
        ],
      });

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
    });
  });

  // -----------------------------------------------------------------------
  // judge()
  // -----------------------------------------------------------------------

  describe('judge()', () => {
    it('returns a GuardVerdict from the judge model', async () => {
      mockCreate.mockResolvedValue(jsonSchemaVerdictResponse());

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(VALID_VERDICT);

      // Verify judge model is used
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe('glm-5-turbo');
    });

    it('falls back to tool_call when json_schema is unsupported', async () => {
      mockCreate
        .mockRejectedValueOnce(new UnsupportedSchemaError())
        .mockResolvedValueOnce(toolCallVerdictResponse());

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(VALID_VERDICT);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      const toolCall = mockCreate.mock.calls[1][0];
      expect(toolCall.tools).toBeDefined();
      expect(toolCall.tools[0].function.name).toBe('produce_verdict');
    });

    it('rejects a malformed judge response', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ refused: 'not-a-bool' }) },
            finish_reason: 'stop',
          },
        ],
      });

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling — timeout
  // -----------------------------------------------------------------------

  describe('error handling — timeout', () => {
    it('maps a timeout error to a typed error, never fabricated output', async () => {
      const timeoutErr = new Error('Request timed out after 30000ms');
      timeoutErr.name = 'AbortError';
      mockCreate.mockRejectedValue(timeoutErr);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('timeout');
      expect(result.error.message).toContain('timed out');
      // No fabricated output
    });

    it('maps a timeout error for judge() too', async () => {
      const timeoutErr = new Error('Connection timed out');
      mockCreate.mockRejectedValue(timeoutErr);

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('timeout');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling — auth
  // -----------------------------------------------------------------------

  describe('error handling — auth', () => {
    it('maps a 401 error to an auth error', async () => {
      const err = apiErrorWithStatus(401, 'Unauthorized');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('auth');
    });

    it('maps a 403 error to an auth error', async () => {
      const err = apiErrorWithStatus(403, 'Forbidden');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('auth');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling — rate limit, blocked, generic
  // -----------------------------------------------------------------------

  describe('error handling — rate limit / blocked / generic status', () => {
    it('maps a 429 rate-limit error to a network error', async () => {
      const err = apiErrorWithStatus(429, 'Too many requests');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('network');
      expect(result.error.message).toContain('Rate limited');
    });

    it('maps a 400 bad-request error to unknown', async () => {
      const err = apiErrorWithStatus(400, 'Invalid request body');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown');
      expect(result.error.message).toContain('Bad request');
    });

    it('maps a 451 error (content policy) to blocked', async () => {
      const err = apiErrorWithStatus(451, 'Content blocked');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('blocked');
      expect(result.error.message).toContain('content policy');
    });

    it('maps an error with type=content_policy_violation to blocked', async () => {
      const err = new Error('Policy violation') as Error & { status: number; type: string };
      err.status = 200; // any status not 400/401/403/429
      err.type = 'content_policy_violation';
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('blocked');
    });

    it('maps an unrecognised status code to unknown', async () => {
      const err = apiErrorWithStatus(500, 'Internal server error');
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown');
      expect(result.error.message).toContain('status 500');
    });

    it('maps a non-Error thrown value to unknown', async () => {
      mockCreate.mockRejectedValue('string error');

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown');
      expect(result.error.message).toBe('An unexpected error occurred.');
    });
  });

  // -----------------------------------------------------------------------
  // isUnsupportedSchemaError — keyword branches
  // -----------------------------------------------------------------------

  describe('json_schema fallback — alternative trigger keywords', () => {
    it.each([
      ['json_schema', 'json_schema is not supported'],
      ['not supported', 'Feature not supported by endpoint'],
    ])('falls back on keyword "%s"', async (_keyword, msg) => {
      const err = new Error(msg) as Error & { status: number };
      err.status = 400;
      mockCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(toolCallCoachingResponse());

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('does NOT fall back for a non-400 error', async () => {
      const err = new Error('response_format unsupported') as Error & { status: number };
      err.status = 500; // not 400
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown'); // not a schema fallback
    });

    it('does NOT fall back for a 400 without schema keywords', async () => {
      const err = new Error('Invalid request parameter') as Error & { status: number };
      err.status = 400;
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // tool_call — extraction edge cases
  // -----------------------------------------------------------------------

  describe('tool_call extraction edge cases', () => {
    it('rejects a tool_call response with no tool_calls', async () => {
      const err = new Error('json_schema not supported') as Error & { status: number };
      err.status = 400;
      // Fallback response has no tool_calls
      mockCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [] },
              finish_reason: 'stop',
            },
          ],
        });

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
      expect(result.error.message).toContain('No tool call');
    });

    it('rejects a tool_call response with invalid JSON arguments', async () => {
      const err = new Error('json_schema not supported') as Error & { status: number };
      err.status = 400;
      mockCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad',
                    type: 'function' as const,
                    function: { name: 'produce_coaching', arguments: 'not-json' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
      expect(result.error.message).toContain('not valid JSON');
    });

    it('judge falls back to tool_call and rejects invalid JSON arguments', async () => {
      const err = new Error('json_schema unsupported') as Error & { status: number };
      err.status = 400;
      mockCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad_judge',
                    type: 'function' as const,
                    function: { name: 'produce_verdict', arguments: '{bad json' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('validation');
    });
  });

  // -----------------------------------------------------------------------
  // API key safety — never logged / never in error messages
  // -----------------------------------------------------------------------

  describe('API key safety', () => {
    it('never includes the API key in error messages', async () => {
      // Simulate an error whose raw message contains the key
      const err = new Error(`Invalid API key: ${TEST_API_KEY}`);
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).not.toContain(TEST_API_KEY);
      expect(result.error.message).toContain('[REDACTED]');
    });

    it('never includes the API key in judge error messages', async () => {
      const err = new Error(`Bad key ${TEST_API_KEY} provided`);
      mockCreate.mockRejectedValue(err);

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).not.toContain(TEST_API_KEY);
    });
  });

  // -----------------------------------------------------------------------
  // Integration — round-trip with stubbed provider
  // -----------------------------------------------------------------------

  describe('integration — round-trip', () => {
    it('a coaching request round-trips request → validated output', async () => {
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse());

      const provider = makeProvider(mockCreate);
      const result: ProviderResult<StructuredCoaching> = await provider.coach(COACHING_REQUEST);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The output is a valid StructuredCoaching
      expect(isStructuredCoaching(result.value)).toBe(true);
      expect(result.value.observations).toHaveLength(2);

      // Verify the request was built correctly
      const call = mockCreate.mock.calls[0][0];
      expect(call.messages).toHaveLength(2);
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[0].content).toBe(COACHING_SYSTEM_PROMPT);
      expect(call.messages[1].role).toBe('user');
      expect(call.messages[1].content).toContain(COACHING_REQUEST.selectionText);
    });

    it('a coaching request with brief round-trips correctly', async () => {
      mockCreate.mockResolvedValue(jsonSchemaCoachingResponse());

      const reqWithBrief: CoachingRequest = {
        ...COACHING_REQUEST,
        brief: {
          purposeClaim: 'To demonstrate X causes Y',
          audienceVenue: 'Nature Methods',
          successCriterion: 'Reviewer acceptance',
          updatedAt: '2026-06-11T12:00:00Z',
        },
      };

      const provider = makeProvider(mockCreate);
      const result = await provider.coach(reqWithBrief);

      expect(result.ok).toBe(true);

      const call = mockCreate.mock.calls[0][0];
      const userContent = call.messages[1].content;
      expect(userContent).toContain('Writing brief');
      expect(userContent).toContain('Nature Methods');
    });

    it('judge round-trip for a refused response', async () => {
      const refusedVerdict: GuardVerdict = {
        refused: true,
        reason: 'Question contains suggested phrasing: "try writing..."',
      };
      mockCreate.mockResolvedValue(jsonSchemaVerdictResponse(refusedVerdict));

      const provider = makeProvider(mockCreate);
      const result = await provider.judge(VALID_COACHING);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.refused).toBe(true);
      expect(result.value.reason).toContain('try writing');
    });
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('Provider prompts', () => {
  describe('buildCoachMessages', () => {
    it('builds system + user messages with the passage in a code fence', () => {
      const messages = buildCoachMessages(COACHING_REQUEST);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe(COACHING_SYSTEM_PROMPT);
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('```markdown');
      expect(messages[1].content).toContain(COACHING_REQUEST.selectionText);
    });

    it('includes brief fields when present', () => {
      const req: CoachingRequest = {
        ...COACHING_REQUEST,
        brief: {
          purposeClaim: 'Test claim',
          audienceVenue: 'Test venue',
          updatedAt: '2026-06-11T00:00:00Z',
        },
      };

      const messages = buildCoachMessages(req);
      const userContent = messages[1].content;
      expect(userContent).toContain('Writing brief');
      expect(userContent).toContain('Test claim');
      expect(userContent).toContain('Test venue');
    });

    it('omits brief section when no brief is provided', () => {
      const messages = buildCoachMessages(COACHING_REQUEST);
      expect(messages[1].content).not.toContain('Writing brief');
    });
  });

  describe('buildJudgeMessages', () => {
    it('builds system + user messages with serialised candidate', () => {
      const messages = buildJudgeMessages(VALID_COACHING);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe(JUDGE_SYSTEM_PROMPT);
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('coaching response');
      // The candidate JSON is included
      expect(messages[1].content).toContain('implicit_claim');
    });
  });

  describe('prompt content', () => {
    it('coaching prompt emphasises never writing for the user', () => {
      expect(COACHING_SYSTEM_PROMPT).toContain('NEVER produce replacement text');
      expect(COACHING_SYSTEM_PROMPT).toContain('NEVER write prose');
      expect(COACHING_SYSTEM_PROMPT).toContain('no field for prose');
    });

    it('judge prompt defaults to refused when unsure', () => {
      expect(JUDGE_SYSTEM_PROMPT).toContain('Default to refused');
      expect(JUDGE_SYSTEM_PROMPT).toContain('unsure');
    });
  });
});
