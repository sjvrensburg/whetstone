/**
 * Pluggable coach providers (ADR-004: the provider seam, moved behind the
 * Service API per ADR-009). v1 is local-first: the student's OWN key, held in
 * the browser; the only egress is the coaching call itself.
 *
 * Both implementations force structured output against the coaching wire
 * schema; the Service re-validates and guards regardless (the provider is
 * not trusted to enforce the floor).
 */

import Anthropic from '@anthropic-ai/sdk';
import { COACHING_JSON_SCHEMA } from '../core/coaching';
import type { ChatMessage } from '../core/prompts';

export interface CoachProvider {
  /** Provider identifier journaled in coach_consult events. */
  readonly name: string;
  /** Model identifier journaled in coach_consult events. */
  readonly model: string;
  /**
   * Run one structured coaching completion. Returns the provider's parsed
   * JSON output (NOT yet validated — the Service validates and guards it).
   */
  complete(messages: ChatMessage[]): Promise<unknown>;
  /**
   * Run one free-text completion (the coach chat). Returns the raw reply
   * text (NOT yet screened — the Service guards it).
   */
  completeText(messages: ChatMessage[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude) — official SDK, direct from the browser
// ---------------------------------------------------------------------------

export class AnthropicCoachProvider implements CoachProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    readonly model: string = 'claude-opus-4-8',
  ) {}

  async complete(messages: ChatMessage[]): Promise<unknown> {
    const client = new Anthropic({
      apiKey: this.apiKey,
      // Local-first by design: the student's own key, from their own browser.
      dangerouslyAllowBrowser: true,
    });

    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.filter((m) => m.role === 'user');

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system,
      messages: user.map((m) => ({ role: 'user' as const, content: m.content })),
      output_config: {
        format: { type: 'json_schema', schema: COACHING_JSON_SCHEMA },
      },
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error(`provider returned no text block (stop_reason: ${response.stop_reason})`);
    }
    return JSON.parse(text.text);
  }

  async completeText(messages: ChatMessage[]): Promise<string> {
    const client = new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true });

    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const turns = messages.filter((m) => m.role !== 'system');

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system,
      messages: turns.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error(`provider returned no text block (stop_reason: ${response.stop_reason})`);
    }
    return text.text;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (default-configured for Z.ai / GLM)
// ---------------------------------------------------------------------------

export const ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_DEFAULT_MODEL = 'glm-5.1';

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  name?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class OpenAICompatibleCoachProvider implements CoachProvider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? ZAI_BASE_URL).replace(/\/$/, '');
    this.model = options.model ?? ZAI_DEFAULT_MODEL;
    this.name = options.name ?? 'zai';
    // Wrap rather than reference: a bare `fetch` called via `this.fetchFn(...)`
    // loses its `window` receiver in browsers — "Illegal invocation".
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
  }

  async complete(messages: ChatMessage[]): Promise<unknown> {
    // Forced tool call: the function parameters ARE the coaching schema.
    // Chosen over `response_format: json_schema` because some OpenAI-compatible
    // servers (Z.ai's coding endpoint among them) silently ignore json_schema —
    // the V1 audit's "tool_call fallback" is the reliable structural floor here.
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: 'produce_coaching',
              description: 'Produce the structured coaching observations for the analyzed passage.',
              parameters: COACHING_JSON_SCHEMA,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'produce_coaching' } },
      }),
    });

    if (!response.ok) {
      // Never include the key; the body may echo request headers on some proxies.
      throw new Error(`provider request failed with status ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };

    const message = body.choices?.[0]?.message;
    const args = message?.tool_calls?.[0]?.function?.arguments;
    if (typeof args === 'string' && args.length > 0) {
      return JSON.parse(args);
    }

    // Some servers answer in content despite a forced tool_choice.
    if (typeof message?.content === 'string' && message.content.length > 0) {
      return JSON.parse(extractJsonObject(message.content));
    }

    throw new Error('provider returned neither a tool call nor message content');
  }

  async completeText(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });

    if (!response.ok) {
      throw new Error(`provider request failed with status ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('provider returned no message content');
    }
    return content.trim();
  }
}

/**
 * Some OpenAI-compatible servers wrap JSON in markdown fences despite
 * json_schema mode. Extract the outermost JSON object defensively.
 */
export function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('provider response contains no JSON object');
  }
  return trimmed.slice(start, end + 1);
}
