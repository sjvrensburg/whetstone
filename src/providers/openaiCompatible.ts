/**
 * OpenAI-compatible reference implementation of the CoachingProvider (ADR-004).
 * Default-configured for ZAI's endpoint with glm-5.1 (coach) / glm-5-turbo
 * (judge). Uses the `openai` npm SDK with a custom `baseURL` + `apiKey`.
 *
 * Forced structured output is enforced via two strategies (the hard requirement
 * from ADR-003/ADR-004):
 *
 * 1. **json_schema** (preferred): `response_format` with strict JSON schema.
 * 2. **tool_call** (fallback): single forced function call whose parameters
 *    ARE the schema — either path makes the schema the structural floor.
 *
 * Both strategies validate responses against the coaching schema before
 * returning; a malformed or blocked response yields a typed failure, never
 * renderable prose.
 */

import OpenAI from 'openai';
import { COACHING_JSON_SCHEMA, isStructuredCoaching } from '../coaching/schema';
import type { CoachingRequest, GuardVerdict, StructuredCoaching } from '../shared/types';
import {
  buildCoachMessages,
  buildExplainRuleMessages,
  buildJudgeMessages,
  type ChatMessage,
} from './prompts';
import type { CoachingProvider, ProviderConfig, ProviderError, ProviderResult } from './types';

// ---------------------------------------------------------------------------
// Guard-verdict JSON schema (used for judge structured output)
// ---------------------------------------------------------------------------

/** JSON Schema for the guard judge's GuardVerdict response. */
const GUARD_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['refused', 'reason'],
  properties: {
    refused: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Tool-call names
// ---------------------------------------------------------------------------

const COACHING_TOOL_NAME = 'produce_coaching';
const JUDGE_TOOL_NAME = 'produce_verdict';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Remove the API key from a string if it somehow appears there. Used as a
 * safety net — the key should never reach error messages in the first place.
 */
function sanitize(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.replaceAll(apiKey, '[REDACTED]');
}

/**
 * True when `error` carries an HTTP status code — covers `OpenAI.APIError` and
 * plain test doubles that set `error.status`.
 */
function hasStatus(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error &&
    typeof (error as unknown as Record<string, unknown>).status === 'number'
  );
}

/**
 * Map an unknown error from the OpenAI SDK to a typed ProviderError.
 * The API key is explicitly excluded from the error message.
 *
 * Uses duck-typing (`error.status`) so test doubles and SDK errors are
 * handled uniformly — the SDK-specific `instanceof` checks are kept as a
 * first pass for the richest error info but are not required.
 */
function mapError(error: unknown, apiKey: string): ProviderError {
  // SDK-specific connection errors (best-effort; tests may not have the exact class)
  if (typeof OpenAI !== 'undefined' && error instanceof OpenAI.APIConnectionTimeoutError) {
    return { kind: 'timeout', message: 'Request timed out. Please try again.', cause: error };
  }
  if (typeof OpenAI !== 'undefined' && error instanceof OpenAI.APIConnectionError) {
    return {
      kind: 'network',
      message: 'Could not connect to provider. Check your network.',
      cause: error,
    };
  }

  // Status-bearing errors — covers OpenAI.APIError and test doubles
  if (hasStatus(error)) {
    const status = error.status;
    const msg = sanitize(error.message ?? '', apiKey);

    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        message: `Authentication failed (status ${status}). Check your API key.`,
        cause: error,
      };
    }
    if (status === 429) {
      return { kind: 'network', message: 'Rate limited. Please try again later.', cause: error };
    }
    if (status === 400) {
      return {
        kind: 'unknown',
        message: `Bad request (status 400): ${msg}`,
        cause: error,
      };
    }
    // Content policy / blocked
    const errType = (error as unknown as Record<string, unknown>).type as string | undefined;
    if (status === 451 || errType === 'content_policy_violation') {
      return {
        kind: 'blocked',
        message: 'Request blocked by provider content policy.',
        cause: error,
      };
    }
    return {
      kind: 'unknown',
      message: `API error (status ${status}): ${msg}`,
      cause: error,
    };
  }

  if (error instanceof Error) {
    if (
      error.name === 'AbortError' ||
      error.message.toLowerCase().includes('timeout') ||
      error.message.toLowerCase().includes('timed out')
    ) {
      return { kind: 'timeout', message: 'Request timed out. Please try again.', cause: error };
    }
    return {
      kind: 'unknown',
      message: sanitize(error.message, apiKey),
      cause: error,
    };
  }

  return { kind: 'unknown', message: 'An unexpected error occurred.' };
}

/**
 * True when the error indicates that `response_format: json_schema` is not
 * supported by the endpoint — the signal to fall back to tool_call.
 * Uses duck-typing so test doubles work without the exact SDK error class.
 */
function isUnsupportedSchemaError(error: unknown): boolean {
  if (!hasStatus(error)) return false;
  if (error.status !== 400) return false;
  const msg = (error.message ?? '').toLowerCase();
  return (
    msg.includes('response_format') ||
    msg.includes('json_schema') ||
    msg.includes('unsupported') ||
    msg.includes('not supported')
  );
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * The parts of a `ChatCompletionMessage` this module reads. Kept structural so
 * tests can create plain objects without pulling in the full SDK type tree.
 */
interface CompletionMessage {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Extract and parse JSON from a completion message, depending on the structured
 * output strategy used.
 */
function extractJson(
  message: CompletionMessage | undefined,
  strategy: 'json_schema' | 'tool_call',
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!message) {
    return { ok: false, reason: 'No message in response' };
  }

  if (strategy === 'tool_call') {
    const toolCall = message.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      return { ok: false, reason: 'No tool call in response' };
    }
    try {
      return { ok: true, value: JSON.parse(toolCall.function.arguments) };
    } catch {
      return { ok: false, reason: 'Tool call arguments are not valid JSON' };
    }
  }

  // json_schema strategy — content is a JSON string
  const content = message.content;
  if (!content) {
    return { ok: false, reason: 'Empty response content' };
  }
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, reason: 'Response content is not valid JSON' };
  }
}

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

function isGuardVerdict(value: unknown): value is GuardVerdict {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).refused === 'boolean' &&
    typeof (value as Record<string, unknown>).reason === 'string'
  );
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible `CoachingProvider`, default-configured for ZAI/GLM.
 *
 * The constructor accepts an optional `OpenAI` client for dependency injection
 * (tests inject a stubbed client; production lets the provider create its own).
 */
export class OpenAICompatibleProvider implements CoachingProvider {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(
    readonly id: string,
    private readonly config: ProviderConfig,
    client?: OpenAI,
  ) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        timeout: this.timeoutMs,
      });
  }

  // -----------------------------------------------------------------------
  // coach()
  // -----------------------------------------------------------------------

  async coach(req: CoachingRequest): Promise<ProviderResult<StructuredCoaching>> {
    const messages = buildCoachMessages(req);

    try {
      // Strategy 1: json_schema structured output (preferred)
      const response = (await this.client.chat.completions.create({
        model: this.config.coachModel,
        messages,
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: 'coaching_response',
            strict: true,
            schema: COACHING_JSON_SCHEMA as Record<string, unknown>,
          },
        },
      })) as { choices: Array<{ message: CompletionMessage }> };

      return this.validateCoaching(response.choices[0]?.message, 'json_schema');
    } catch (error) {
      // If json_schema is unsupported, fall back to tool_call
      if (isUnsupportedSchemaError(error)) {
        return this.coachWithToolCall(messages);
      }
      return fail(mapError(error, this.config.apiKey));
    }
  }

  private async coachWithToolCall(
    messages: ChatMessage[],
  ): Promise<ProviderResult<StructuredCoaching>> {
    try {
      const response = (await this.client.chat.completions.create({
        model: this.config.coachModel,
        messages,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: COACHING_TOOL_NAME,
              strict: true,
              parameters: COACHING_JSON_SCHEMA as Record<string, unknown>,
            },
          },
        ],
        tool_choice: {
          type: 'function' as const,
          function: { name: COACHING_TOOL_NAME },
        },
      })) as { choices: Array<{ message: CompletionMessage }> };

      return this.validateCoaching(response.choices[0]?.message, 'tool_call');
    } catch (error) {
      return fail(mapError(error, this.config.apiKey));
    }
  }

  private validateCoaching(
    message: CompletionMessage | undefined,
    strategy: 'json_schema' | 'tool_call',
  ): ProviderResult<StructuredCoaching> {
    const extracted = extractJson(message, strategy);
    if (!extracted.ok) {
      return fail<StructuredCoaching>({ kind: 'validation', message: extracted.reason });
    }

    if (!isStructuredCoaching(extracted.value)) {
      return fail<StructuredCoaching>({
        kind: 'validation',
        message: 'Response does not match the coaching schema. No prose returned.',
      });
    }

    return { ok: true, value: extracted.value };
  }

  // -----------------------------------------------------------------------
  // judge()
  // -----------------------------------------------------------------------

  async judge(candidate: StructuredCoaching): Promise<ProviderResult<GuardVerdict>> {
    const messages = buildJudgeMessages(candidate);

    try {
      const response = (await this.client.chat.completions.create({
        model: this.config.judgeModel,
        messages,
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: 'guard_verdict',
            strict: true,
            schema: GUARD_VERDICT_SCHEMA,
          },
        },
      })) as { choices: Array<{ message: CompletionMessage }> };

      return this.validateVerdict(response.choices[0]?.message, 'json_schema');
    } catch (error) {
      if (isUnsupportedSchemaError(error)) {
        return this.judgeWithToolCall(messages);
      }
      return fail(mapError(error, this.config.apiKey));
    }
  }

  private async judgeWithToolCall(messages: ChatMessage[]): Promise<ProviderResult<GuardVerdict>> {
    try {
      const response = (await this.client.chat.completions.create({
        model: this.config.judgeModel,
        messages,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: JUDGE_TOOL_NAME,
              strict: true,
              parameters: GUARD_VERDICT_SCHEMA,
            },
          },
        ],
        tool_choice: {
          type: 'function' as const,
          function: { name: JUDGE_TOOL_NAME },
        },
      })) as { choices: Array<{ message: CompletionMessage }> };

      return this.validateVerdict(response.choices[0]?.message, 'tool_call');
    } catch (error) {
      return fail(mapError(error, this.config.apiKey));
    }
  }

  private validateVerdict(
    message: CompletionMessage | undefined,
    strategy: 'json_schema' | 'tool_call',
  ): ProviderResult<GuardVerdict> {
    const extracted = extractJson(message, strategy);
    if (!extracted.ok) {
      return fail<GuardVerdict>({ kind: 'validation', message: extracted.reason });
    }

    if (!isGuardVerdict(extracted.value)) {
      return fail<GuardVerdict>({
        kind: 'validation',
        message: 'Judge response does not match the GuardVerdict schema.',
      });
    }

    return { ok: true, value: extracted.value };
  }

  // -----------------------------------------------------------------------
  // explainRule()
  // -----------------------------------------------------------------------

  async explainRule(
    sentence: string,
    lintMeta: { lintKind: string; lintKindPretty: string; message: string },
  ): Promise<ProviderResult<string>> {
    const messages = buildExplainRuleMessages(sentence, lintMeta);

    try {
      const response = (await this.client.chat.completions.create({
        model: this.config.coachModel,
        messages,
        // Plain text response — no structured output for explanations.
      })) as { choices: Array<{ message: CompletionMessage }> };

      const content = response.choices[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        return fail<string>({
          kind: 'validation',
          message: 'Empty explanation returned by provider.',
        });
      }

      return { ok: true, value: content.trim() };
    } catch (error) {
      return fail<string>(mapError(error, this.config.apiKey));
    }
  }
}

/** Shorthand for a typed failure. */
function fail<T>(error: ProviderError): ProviderResult<T> {
  return { ok: false, error };
}
