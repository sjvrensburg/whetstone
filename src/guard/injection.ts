/**
 * Untrusted-channel wrapping and injection-pattern screening for document
 * input (ADR-003).
 *
 * Document text is untrusted — it may contain prompt-injection attempts
 * ("ignore previous instructions", etc.). This module provides:
 *
 * 1. **Delimited wrapping**: a function that wraps document text in a
 *    clearly-delimited, non-instruction channel so downstream consumers
 *    (provider prompts, judge prompts) can distinguish user prose from
 *    instructions.
 *
 * 2. **Injection screening**: a function that detects common injection
 *    patterns in document input and returns a guard rejection if found.
 *    This prevents a crafted document from influencing the guard's or
 *    model's behavior.
 *
 * Both are pure functions with no external dependencies, individually
 * testable.
 */

import type { CheckResult } from './deterministic';

// ---------------------------------------------------------------------------
// Channel delimiters
// ---------------------------------------------------------------------------

/**
 * The sentinel markers that delimit the untrusted document channel. These are
 * chosen to be unlikely to appear in normal academic prose and clearly signal
 * "this is data, not instructions" to the model.
 */
const CHANNEL_BEGIN = '<<<UNTRUSTED_DOCUMENT_BEGIN>>>';
const CHANNEL_END = '<<<UNTRUSTED_DOCUMENT_END>>>';

/**
 * Wrap document text in a delimited, non-instruction channel. The wrapped
 * form makes it clear to the model that the enclosed text is the writer's own
 * prose — not instructions to follow.
 *
 * The wrapping is applied when building provider prompts (task 12), not by
 * the guard itself; this module exports it for use by the coaching pipeline.
 */
export function wrapUntrusted(documentText: string): string {
  return `${CHANNEL_BEGIN}\n${documentText}\n${CHANNEL_END}`;
}

// ---------------------------------------------------------------------------
// Injection-pattern screening
// ---------------------------------------------------------------------------

/**
 * Patterns that commonly indicate prompt-injection attempts embedded in
 * document text. These are checked against the raw document input before
 * the coaching turn is processed.
 *
 * The patterns are intentionally broad — false positives are acceptable
 * here because the document text is never rendered directly; it only feeds
 * the coaching model. The guard's job is to *screen*, not to perfectly
 * classify.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+instructions\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+instructions\b/i,
  /\bforget\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+instructions\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bsystem\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /\byou\s+are\s+now\b/i,
  /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  /\bact\s+as\s+(?:if\s+you\s+(?:are|were)|a)\b/i,
  /\boverride\s+(?:your|the)\s+(?:previous|original|initial)\s+(?:instructions?|directives?|prompt)\b/i,
  /\b(?:jailbreak|hack|exploit|bypass)\b/i,
  /\boutput\s+(?:the\s+)?following\s+(?:exactly|verbatim|as-is)\b/i,
  /\bprint\s+(?:the\s+)?following\b/i,
];

/**
 * Screen document text for prompt-injection patterns. Returns a failure if
 * any pattern matches, with the matched pattern identified in the reason.
 *
 * This is called by the `screen()` boundary before any deterministic checks
 * on the coaching output, because injection detection is about the *input*
 * channel, not the model's output.
 */
export function screenInjection(documentText: string): CheckResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(documentText)) {
      return {
        ok: false,
        reason: `document contains potential injection pattern: "${pattern.source}"`,
      };
    }
  }
  return { ok: true };
}
