/**
 * `coaching/` — Coaching orchestration: request build + turn pipeline +
 * ledger emission (task 12).
 *
 * Composes the provider (task 09), the refusal guard (task 10+11), and the
 * ledger (task 07) into the full coaching turn flow described in the TechSpec
 * "Data Flow (coaching turn)":
 *
 *   request build → provider.coach() → guard.screen()
 *     → pass  → ledger.append(ai_consult) → return observations
 *     → fail  → retry with stricter reminder / suppress; never render suspect text
 *
 * The consent gate (task 17) is invoked by the UI command *before* this
 * orchestration runs, matching the data-flow diagram — not from inside it.
 */

export * from './schema';

import type { RefusalGuard } from '../guard';
import type { Ledger } from '../shared/types';
import type { Brief, CoachingRequest, DocumentContext, DocumentLanguage, StructuredCoaching } from '../shared/types';
import type { CoachingProvider } from '../providers/types';

// ---------------------------------------------------------------------------
// Turn-pipeline types
// ---------------------------------------------------------------------------

/** Dependencies the coaching turn pipeline needs (DI seam). */
export interface CoachingTurnDeps {
  /** The coaching provider to call for structured coaching. */
  provider: CoachingProvider;
  /** The refusal guard to screen coaching output (F2). */
  guard: RefusalGuard;
  /** The provenance ledger to record ai_consult events. */
  ledger: Ledger;
  /**
   * Maximum number of coach+screen attempts before giving up.
   * Default is 2 (one initial + one retry with stricter reminder).
   */
  maxAttempts?: number;
}

/** The input to a coaching turn — what the UI command provides. */
export interface CoachingTurnInput {
  /** The passage the writer asked to coach. */
  selectionText: string;
  /** Document offset of the selection's first character. */
  anchorBase: number;
  /** The source language of the document. */
  documentLanguage: DocumentLanguage;
  /** Optional writing brief (F5); coaching works fully without it. */
  brief?: Brief;
}

/** Machine-readable error categories for a failed coaching turn. */
export type TurnErrorKind = 'provider' | 'guard' | 'retry_exhausted';

/** A typed failure from the coaching turn pipeline. */
export interface TurnError {
  /** Machine-readable error category. */
  kind: TurnErrorKind;
  /** Human-readable message (safe for the UI). */
  message: string;
  /** The guard layer that rejected (only when kind is 'guard' or 'retry_exhausted'). */
  layer?: 'deterministic' | 'judge';
}

/** The outcome of a coaching turn. */
export type CoachingTurnResult =
  | { ok: true; coaching: StructuredCoaching }
  | { ok: false; error: TurnError };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The note appended to the brief on retry to make the system produce a
 * stricter response. Placed in the user message via the brief context so the
 * provider's message builder includes it without modifying shared types.
 */
const STRICT_RETRY_NOTE =
  '[SYSTEM NOTE: Your previous response was rejected because it may contain ' +
  'paste-ready prose. Provide ONLY structural observations and genuine questions. ' +
  'Do NOT suggest any specific wording, phrasing, or rewrites.]';

/** Default max attempts: one initial attempt + one retry. */
const DEFAULT_MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Request / context builders
// ---------------------------------------------------------------------------

/**
 * Build a `CoachingRequest` from the turn input (task 12.1). The request
 * carries the selection, anchor base, optional brief, and document language.
 */
export function buildCoachingRequest(input: CoachingTurnInput): CoachingRequest {
  return {
    selectionText: input.selectionText,
    anchorBase: input.anchorBase,
    documentLanguage: input.documentLanguage,
    ...(input.brief ? { brief: input.brief } : {}),
  };
}

/**
 * Build a `DocumentContext` from the turn input. The context is what the
 * refusal guard screens against — the writer's own passage for n-gram
 * overlap and injection screening.
 */
export function buildDocumentContext(input: CoachingTurnInput): DocumentContext {
  return {
    selectionText: input.selectionText,
    documentLanguage: input.documentLanguage,
  };
}

// ---------------------------------------------------------------------------
// Internal: retry-reminder injection
// ---------------------------------------------------------------------------

/**
 * Return a modified `CoachingRequest` with a stricter reminder injected into
 * the brief. On retry the model receives a stronger signal to avoid paste-ready
 * prose, satisfying the task-12 retry-with-stricter-reminder requirement.
 */
function addRetryReminder(req: CoachingRequest): CoachingRequest {
  const retryBrief: Brief = req.brief
    ? {
        ...req.brief,
        purposeClaim: req.brief.purposeClaim
          ? `${STRICT_RETRY_NOTE} ${req.brief.purposeClaim}`
          : STRICT_RETRY_NOTE,
      }
    : { purposeClaim: STRICT_RETRY_NOTE, updatedAt: new Date().toISOString() };

  return { ...req, brief: retryBrief };
}

// ---------------------------------------------------------------------------
// Internal: ai_consult payload
// ---------------------------------------------------------------------------

/**
 * Build the prose-free metadata payload for an `ai_consult` ledger event.
 * Records provider, model info, and observation metadata — never user prose.
 */
function buildAiConsultPayload(
  providerId: string,
  coaching: StructuredCoaching,
  input: CoachingTurnInput,
): Record<string, unknown> {
  return {
    providerId,
    observationCount: coaching.observations.length,
    hadBrief: !!input.brief,
    anchorBase: input.anchorBase,
    documentLanguage: input.documentLanguage,
  };
}

// ---------------------------------------------------------------------------
// Turn pipeline
// ---------------------------------------------------------------------------

/**
 * Run a full coaching turn (F1): build the request, call the provider,
 * screen through the refusal guard, and on pass append an `ai_consult`
 * ledger event and return anchored observations.
 *
 * On guard failure the pipeline retries with a stricter reminder (up to
 * `maxAttempts` total); suspect text is NEVER rendered (F2 invariant).
 * Provider errors/timeouts surface as a typed `TurnError` and render nothing.
 *
 * The consent gate (task 17) is invoked by the UI command before this
 * function runs — not from inside it.
 */
export async function runCoachingTurn(
  deps: CoachingTurnDeps,
  input: CoachingTurnInput,
): Promise<CoachingTurnResult> {
  const { provider, guard, ledger } = deps;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const doc = buildDocumentContext(input);
  let request = buildCoachingRequest(input);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // --- Call provider ---
    const coachResult = await provider.coach(request);
    if (!coachResult.ok) {
      return {
        ok: false,
        error: {
          kind: 'provider',
          message: coachResult.error.message,
        },
      };
    }

    const coaching = coachResult.value;

    // --- Screen through refusal guard ---
    const guardResult = await guard.screen(coaching, doc);
    if (guardResult.ok) {
      // --- Pass: append ai_consult ledger event (task 12.4) ---
      await ledger.append({
        ts: new Date().toISOString(),
        type: 'ai_consult',
        payload: buildAiConsultPayload(provider.id, coaching, input),
      });

      return { ok: true, coaching };
    }

    // --- Fail: inject stricter reminder for next attempt ---
    if (attempt < maxAttempts) {
      request = addRetryReminder(request);
      continue;
    }

    // --- All attempts exhausted: suppress, render nothing ---
    return {
      ok: false,
      error: {
        kind: 'retry_exhausted',
        message: guardResult.reason,
        layer: guardResult.layer,
      },
    };
  }

  // Unreachable, but satisfies the type checker.
  return {
    ok: false,
    error: { kind: 'retry_exhausted', message: 'All coaching attempts exhausted.' },
  };
}
