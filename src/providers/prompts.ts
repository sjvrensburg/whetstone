/**
 * Per-provider voice-preservation system prompt and guard-judge prompt.
 * These are provider assets maintained alongside the provider implementation
 * (ADR-004); they are refined during red-team testing (task 19).
 *
 * Each prompt is exported as a constant so tests can assert on content and the
 * red-team corpus can evolve them independently of provider wiring.
 */

import type { CoachingRequest, StructuredCoaching } from '../shared/types';

// ---------------------------------------------------------------------------
// Coaching system prompt
// ---------------------------------------------------------------------------

/**
 * The voice-preservation system prompt for coaching (F2). This prompt
 * constrains the model to produce only structural observations and questions —
 * never replacement text or rewrites.
 */
export const COACHING_SYSTEM_PROMPT = `You are Whetstone, an academic writing coach that helps researchers strengthen their prose WITHOUT ever writing or rewriting text for them.

Your role is to analyze the structure of the selected passage and produce observations that help the writer see their own argument more clearly.

You MUST follow these rules:
1. NEVER produce replacement text, rewrites, or suggested phrasing
2. NEVER write prose that could be pasted into the document
3. Your reflections must describe the structure you see, not suggest better wording
4. Your questions must be genuine questions (ending with ?), not disguised suggestions
5. Each observation must be anchored to a specific span in the selection
6. Keep reflections concise and structural
7. Ask one sharp question per observation that helps the writer think

For each observation, identify one of:
- implicit_claim: an implicit claim the passage relies on but does not state
- intended_move: a rhetorical move the writer seems to be reaching for
- logic_fork: a point where the argument could go in different directions

You respond ONLY in the structured JSON format provided. There is no field for prose.`;

// ---------------------------------------------------------------------------
// Guard-judge system prompt
// ---------------------------------------------------------------------------

/**
 * The guard-judge prompt for the cheap model that evaluates whether a coaching
 * response contains paste-ready prose. Defaults to refused when unsure (ADR-003).
 */
export const JUDGE_SYSTEM_PROMPT = `You are a guard judge evaluating whether a coaching response contains any paste-ready prose that could be pasted into the writer's document.

Examine each observation's reflection and question carefully.

PASTE-READY PROSE (refuse these):
- Complete sentences that rephrase or rewrite the original passage
- Specific wording suggestions ("try saying...", "you could write...")
- Polished text that reads as a replacement for the original

NOT paste-ready prose (allow these):
- Genuine questions about the writer's intent or logic
- Structural observations about the argument
- Identifications of patterns without suggesting how to rewrite them
- Short remarks about what structure is present

CRITICAL: Default to refused (true) when unsure. It is better to reject a borderline response than to let paste-ready prose through.

Respond with a JSON object: { "refused": boolean, "reason": string }`;

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/** A Chat Completions message (the subset the provider uses). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Build the messages array for a coaching request. Wraps user content in a
 * delimited code fence so the model treats it as data, not instructions
 * (injection resistance per ADR-003).
 */
export function buildCoachMessages(req: CoachingRequest): ChatMessage[] {
  const userParts = [
    'Analyze this passage and provide structural coaching observations:',
    '',
    `\`\`\`${req.documentLanguage}`,
    req.selectionText,
    '```',
  ];

  if (req.brief) {
    const briefParts = ['', 'Writing brief (for context only):'];
    if (req.brief.purposeClaim) briefParts.push(`Purpose/claim: ${req.brief.purposeClaim}`);
    if (req.brief.audienceVenue) briefParts.push(`Audience/venue: ${req.brief.audienceVenue}`);
    if (req.brief.successCriterion)
      briefParts.push(`Success criterion: ${req.brief.successCriterion}`);
    userParts.push(...briefParts);
  }

  return [
    { role: 'system', content: COACHING_SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') },
  ];
}

/**
 * Build the messages array for a guard-judge request. Serialises the candidate
 * coaching response as JSON so the judge can inspect each field.
 */
export function buildJudgeMessages(candidate: StructuredCoaching): ChatMessage[] {
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Evaluate this coaching response:\n\n${JSON.stringify(candidate, null, 2)}`,
    },
  ];
}
