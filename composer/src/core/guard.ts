/**
 * The refusal guard — deterministic layers ported from V1 `src/guard/`
 * (ADR-003; ADR-009 ports "guard heuristics with the audit fixes").
 *
 * Layers, in order:
 *   1. Injection screening on the document input (untrusted channel).
 *   2. Schema validation (structural floor — done by the caller via
 *      `validateStructuredCoaching`).
 *   3. Deterministic semantic checks on the output: span-length caps,
 *      imperative-rewrite patterns, n-gram overlap with the writer's passage.
 *
 * On any failure the suspect text is never rendered. The V1 cloud-judge layer
 * (a second model call) is deferred — the deterministic layers are the v1
 * guarantee; the judge returns with the hosted tier.
 */

import {
  MAX_OBSERVATIONS,
  QUESTION_MAX_LENGTH,
  REFLECTION_MAX_LENGTH,
  type StructuredCoaching,
} from './coaching';
import { extractNgrams, ngramOverlap } from './ngram';

export type CheckResult = { ok: true } | { ok: false; reason: string };

export type GuardLayer = 'injection' | 'schema' | 'deterministic' | 'provider';

export type GuardResult = { ok: true } | { ok: false; layer: GuardLayer; reason: string };

// ---------------------------------------------------------------------------
// Untrusted-channel wrapping + injection screening
// ---------------------------------------------------------------------------

const CHANNEL_BEGIN = '<<<UNTRUSTED_DOCUMENT_BEGIN>>>';
const CHANNEL_END = '<<<UNTRUSTED_DOCUMENT_END>>>';

/** Wrap document text in a delimited, non-instruction channel. */
export function wrapUntrusted(documentText: string): string {
  return `${CHANNEL_BEGIN}\n${documentText}\n${CHANNEL_END}`;
}

/** Patterns that commonly indicate prompt-injection attempts in document text. */
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

/** Screen document text for prompt-injection patterns (input channel). */
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

// ---------------------------------------------------------------------------
// Deterministic output checks
// ---------------------------------------------------------------------------

/** Defense-in-depth re-check of the per-field length caps. */
export function checkSpanLengths(coaching: StructuredCoaching): CheckResult {
  if (coaching.observations.length > MAX_OBSERVATIONS) {
    return { ok: false, reason: `observations count exceeds ${MAX_OBSERVATIONS}` };
  }
  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;
    if (obs.reflection.length > REFLECTION_MAX_LENGTH) {
      return { ok: false, reason: `${at}.reflection exceeds ${REFLECTION_MAX_LENGTH} characters` };
    }
    if (obs.question.length > QUESTION_MAX_LENGTH) {
      return { ok: false, reason: `${at}.question exceeds ${QUESTION_MAX_LENGTH} characters` };
    }
  }
  return { ok: true };
}

/** Shapes that indicate a rewrite instruction rather than an observation. */
const REWRITE_PATTERNS: readonly RegExp[] = [
  /\bchange\s+.+\s+to\b/i,
  /\breplace\s+.+\s+with\b/i,
  /\btry\s+writing\b/i,
  /\byou\s+could\s+write\b/i,
  /\bwrite\s+this\s+as\b/i,
  /\brephrase\s+this\b/i,
  /\ba\s+better\s+version\s+would\s+be\b/i,
  /\bhere'?s\s+a\s+revision\b/i,
  /\bhere\s+is\s+a\s+rewrite\b/i,
  /\byou\s+should\s+write\b/i,
  /\bconsider\s+writing\b/i,
  /\binstead\s+(?:of|try)\s+this\b/i,
  /\bsuggested\s+rewrite\b/i,
  /\bimproved\s+version\b/i,
  /\btry\s+(?:this|the)\s+instead\b/i,
];

/** Reject any observation field matching an imperative-rewrite pattern. */
export function checkRewritePatterns(coaching: StructuredCoaching): CheckResult {
  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;
    for (const field of ['reflection', 'question'] as const) {
      for (const pattern of REWRITE_PATTERNS) {
        if (pattern.test(obs[field])) {
          return {
            ok: false,
            reason: `${at}.${field} matches rewrite pattern "${pattern.source}"`,
          };
        }
      }
    }
  }
  return { ok: true };
}

const GUARD_NGRAM_SIZE = 3;
const GUARD_OVERLAP_THRESHOLD = 0.5;

/**
 * Reject observation fields with high n-gram containment in the writer's
 * passage — a paraphrase of the writer's own words handed back as coaching is
 * the "rephrase" failure mode. Direction here is candidate-in-source: what
 * fraction of the FIELD's trigrams appear in the selection. (This differs
 * deliberately from claim-to-own, which measures original-survives-in-current;
 * each direction answers its own question.)
 */
export function checkNgramOverlap(
  coaching: StructuredCoaching,
  selectionText: string,
  n: number = GUARD_NGRAM_SIZE,
  threshold: number = GUARD_OVERLAP_THRESHOLD,
): CheckResult {
  const sourceNgrams = extractNgrams(selectionText, n);

  for (let i = 0; i < coaching.observations.length; i++) {
    const obs = coaching.observations[i];
    const at = `observations[${i}]`;
    for (const field of ['reflection', 'question'] as const) {
      const text = obs[field];
      const words = text.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
      if (words.length < n) continue;

      const overlap = ngramOverlap(extractNgrams(text, n), sourceNgrams);
      if (overlap >= threshold) {
        return {
          ok: false,
          reason: `${at}.${field} has ${(overlap * 100).toFixed(0)}% n-gram overlap with the selection (threshold ${threshold * 100}%)`,
        };
      }
    }
  }
  return { ok: true };
}

/** All deterministic output checks, first failure wins. */
export function runDeterministicChecks(
  coaching: StructuredCoaching,
  selectionText: string,
): CheckResult {
  const span = checkSpanLengths(coaching);
  if (!span.ok) return span;
  const rewrite = checkRewritePatterns(coaching);
  if (!rewrite.ok) return rewrite;
  return checkNgramOverlap(coaching, selectionText);
}

// ---------------------------------------------------------------------------
// Chat-reply screening (free text — no structural schema to lean on)
// ---------------------------------------------------------------------------

/**
 * Chat replies are coaching-sized, not essay-sized. A reply long enough to
 * BE the essay is the failure mode this cap exists for.
 */
export const CHAT_REPLY_MAX_LENGTH = 900;

const TEXT_REWRITE_PATTERNS: readonly RegExp[] = [
  ...REWRITE_PATTERNS,
  /\bhere'?s\s+(?:a|the|your|one)\s+(?:draft|paragraph|version|opening|intro|sentence)\b/i,
  /\bhere\s+is\s+(?:a|the|your|one)\s+(?:draft|paragraph|version|opening|intro|sentence)\b/i,
  /\byou\s+(?:could|can|might)\s+(?:say|phrase|word)\s+it\b/i,
  /\bhow\s+about\s*[:"]/i,
  /\bsomething\s+like\s*[:"]/i,
];

/**
 * Screen a free-text chat reply. Without the structural schema (which makes
 * ghostwriting impossible for coaching turns), chat leans on the system
 * prompt plus these deterministic heuristics: length cap, rewrite/dictation
 * shapes, n-gram overlap with the draft, and the forbidden-label vocabulary.
 * A residual risk remains by construction — the cap keeps it small.
 */
export function screenChatReply(reply: string, contextText: string): CheckResult {
  if (reply.trim().length === 0) {
    return { ok: false, reason: 'empty reply' };
  }
  if (reply.length > CHAT_REPLY_MAX_LENGTH) {
    return {
      ok: false,
      reason: `reply exceeds ${CHAT_REPLY_MAX_LENGTH} characters — too long to be coaching`,
    };
  }

  for (const pattern of TEXT_REWRITE_PATTERNS) {
    if (pattern.test(reply)) {
      return { ok: false, reason: `reply matches rewrite pattern "${pattern.source}"` };
    }
  }

  if (contextText.trim().length > 0) {
    const words = reply.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
    if (words.length >= GUARD_NGRAM_SIZE) {
      const overlap = ngramOverlap(
        extractNgrams(reply, GUARD_NGRAM_SIZE),
        extractNgrams(contextText, GUARD_NGRAM_SIZE),
      );
      if (overlap >= GUARD_OVERLAP_THRESHOLD) {
        return {
          ok: false,
          reason: `reply has ${(overlap * 100).toFixed(0)}% n-gram overlap with the draft (threshold ${GUARD_OVERLAP_THRESHOLD * 100}%)`,
        };
      }
    }
  }

  return { ok: true };
}
