/**
 * Unit + integration tests for the coaching orchestration turn pipeline
 * (task 12): request build → provider.coach() → guard.screen() →
 * ledger.append(ai_consult) → result.
 *
 * All provider/guard/ledger dependencies are stubbed; no network or VS Code
 * calls. Tests verify the orchestrator's composition logic, not the
 * individual components (those are tested in their own files).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildCoachingRequest,
  buildDocumentContext,
  runCoachingTurn,
} from '../../src/coaching/index';
import type { CoachingTurnDeps, CoachingTurnInput } from '../../src/coaching/index';
import type { CoachingProvider, ProviderErrorKind } from '../../src/providers/types';
import type { RefusalGuard } from '../../src/guard/index';
import type { Ledger, StructuredCoaching, DocumentLanguage } from '../../src/shared/types';
import { TelemetrySink } from '../../src/telemetry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function obs(
  reflection: string,
  question: string,
  anchor: { start: number; end: number } = { start: 0, end: 10 },
  kind: 'implicit_claim' | 'intended_move' | 'logic_fork' = 'implicit_claim',
) {
  return { anchor, kind, reflection, question };
}

function coaching(...observations: ReturnType<typeof obs>[]): StructuredCoaching {
  return { observations };
}

const CLEAN_COACHING = coaching(
  obs(
    'The paragraph positions LLMs as a threat without examining mitigating factors.',
    'What if the argument addressed both threats and opportunities — where would the balance fall?',
  ),
);

const DEFAULT_INPUT: CoachingTurnInput = {
  selectionText:
    'The rapid advancement of large language models has raised significant concerns about academic integrity.',
  anchorBase: 42,
  documentLanguage: 'markdown' as DocumentLanguage,
};

/** Create a provider stub that returns the given coaching. */
function stubProvider(response: StructuredCoaching): CoachingProvider {
  return {
    id: 'test-provider',
    coach: vi.fn(async () => ({
      ok: true as const,
      value: response,
    })),
    judge: vi.fn(),
    explainRule: vi.fn(),
  };
}

/** Create a provider stub that returns a failure. */
function stubFailingProvider(error: {
  kind: ProviderErrorKind;
  message: string;
}): CoachingProvider {
  return {
    id: 'test-provider',
    coach: vi.fn(async () => ({
      ok: false as const,
      error: { kind: error.kind, message: error.message },
    })),
    judge: vi.fn(),
    explainRule: vi.fn(),
  };
}

/** Create a guard stub. */
function stubGuard(
  passes: boolean,
  reason = 'rejected',
  layer: 'deterministic' | 'judge' = 'deterministic',
) {
  return {
    screen: vi.fn(
      async (): Promise<{
        ok: boolean;
        coaching?: StructuredCoaching;
        reason?: string;
        layer?: string;
      }> => {
        if (passes) {
          return { ok: true, coaching: CLEAN_COACHING };
        }
        return { ok: false, reason, layer };
      },
    ),
  } as unknown as RefusalGuard;
}

/** Create a ledger stub that tracks append calls. */
function stubLedger() {
  const appends: Array<{ ts: string; type: string; payload: unknown }> = [];
  return {
    append: vi.fn(async (e: { ts: string; type: string; payload: unknown }) => {
      appends.push(e);
    }),
    _appends: appends,
    verify: vi.fn(async () => ({ intact: true })),
    report: vi.fn(),
    exportDisclosure: vi.fn(),
  } as unknown as Ledger & { _appends: Array<{ ts: string; type: string; payload: unknown }> };
}

/** Create default deps with all stubs. */
function stubDeps(overrides?: Partial<CoachingTurnDeps>): CoachingTurnDeps {
  return {
    provider: stubProvider(CLEAN_COACHING),
    guard: stubGuard(true),
    ledger: stubLedger(),
    ...overrides,
  };
}

// ===========================================================================
// Unit tests: request build
// ===========================================================================

describe('buildCoachingRequest', () => {
  it('builds a request from the turn input', () => {
    const req = buildCoachingRequest(DEFAULT_INPUT);
    expect(req.selectionText).toBe(DEFAULT_INPUT.selectionText);
    expect(req.anchorBase).toBe(42);
    expect(req.documentLanguage).toBe('markdown');
    expect(req.brief).toBeUndefined();
  });

  it('includes the brief when provided', () => {
    const brief = { purposeClaim: 'Test claim', updatedAt: '2026-01-01T00:00:00.000Z' };
    const req = buildCoachingRequest({ ...DEFAULT_INPUT, brief });
    expect(req.brief).toEqual(brief);
  });

  it('omits brief key when absent', () => {
    const req = buildCoachingRequest(DEFAULT_INPUT);
    expect('brief' in req).toBe(false);
  });
});

describe('buildDocumentContext', () => {
  it('builds a document context from the turn input', () => {
    const ctx = buildDocumentContext(DEFAULT_INPUT);
    expect(ctx.selectionText).toBe(DEFAULT_INPUT.selectionText);
    expect(ctx.documentLanguage).toBe('markdown');
  });
});

// ===========================================================================
// Unit tests: runCoachingTurn — passing turn
// ===========================================================================

describe('runCoachingTurn — passing turn', () => {
  it('appends exactly one ai_consult and returns anchored observations', async () => {
    const ledger = stubLedger();
    const deps = stubDeps({ ledger });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching.observations).toHaveLength(1);
      expect(result.coaching.observations[0].anchor).toEqual({ start: 0, end: 10 });
    }

    // Exactly one ledger append.
    expect(ledger.append).toHaveBeenCalledOnce();
    const appendArg = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(appendArg.type).toBe('ai_consult');
    expect(appendArg.payload).toEqual({
      providerId: 'test-provider',
      observationCount: 1,
      hadBrief: false,
      anchorBase: 42,
      documentLanguage: 'markdown',
    });
  });

  it('works with no brief — proceeds and produces observations', async () => {
    const deps = stubDeps();
    const result = await runCoachingTurn(deps, { ...DEFAULT_INPUT });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching.observations.length).toBeGreaterThan(0);
    }
  });

  it('passes brief through to the provider', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const deps = stubDeps({ provider });
    const brief = { purposeClaim: 'My paper claim', updatedAt: '2026-01-01T00:00:00.000Z' };

    await runCoachingTurn(deps, { ...DEFAULT_INPUT, brief });

    const coachCall = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(coachCall.brief).toEqual(brief);
  });

  it('records hadBrief=true in the ai_consult payload when brief is present', async () => {
    const ledger = stubLedger();
    const deps = stubDeps({ ledger });
    const brief = { purposeClaim: 'Test', updatedAt: '2026-01-01T00:00:00.000Z' };

    await runCoachingTurn(deps, { ...DEFAULT_INPUT, brief });

    const appendArg = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(appendArg.payload.hadBrief).toBe(true);
  });
});

// ===========================================================================
// Unit tests: runCoachingTurn — guard rejection
// ===========================================================================

describe('runCoachingTurn — guard rejection', () => {
  it('guard-rejected turn appends no ai_consult and returns nothing renderable', async () => {
    const ledger = stubLedger();
    const guard = stubGuard(false, 'n-gram overlap', 'deterministic');
    // Guard always rejects, so with maxAttempts=1 there's no retry.
    const deps = stubDeps({ ledger, guard, maxAttempts: 1 });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('retry_exhausted');
      expect(result.error.message).toContain('n-gram overlap');
      expect(result.error.layer).toBe('deterministic');
      // The result has no coaching field — nothing renderable.
      expect((result as { coaching?: unknown }).coaching).toBeUndefined();
    }

    // No ai_consult was recorded.
    expect(ledger.append).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Unit tests: runCoachingTurn — retry with stricter reminder
// ===========================================================================

describe('runCoachingTurn — retry with stricter reminder', () => {
  it('retries on guard failure and applies a stricter reminder on the second attempt', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const callCount = { value: 0 };
    const guard = {
      screen: vi.fn(async () => {
        callCount.value++;
        if (callCount.value === 1) {
          return { ok: false, reason: 'n-gram overlap', layer: 'deterministic' as const };
        }
        return { ok: true, coaching: CLEAN_COACHING };
      }),
    } as unknown as RefusalGuard;
    const ledger = stubLedger();
    const deps = stubDeps({ provider, guard, ledger });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    // The retry succeeds.
    expect(result.ok).toBe(true);

    // Provider was called twice.
    expect(provider.coach).toHaveBeenCalledTimes(2);

    // The second call has the stricter reminder in the brief.
    const secondCallArg = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCallArg.brief?.purposeClaim).toContain('previous response was rejected');

    // Exactly one ai_consult (from the successful retry).
    expect(ledger.append).toHaveBeenCalledOnce();
    expect((ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0].type).toBe('ai_consult');
  });

  it('retry with a brief that has no purposeClaim still injects the reminder', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const callCount = { value: 0 };
    const guard = {
      screen: vi.fn(async () => {
        callCount.value++;
        if (callCount.value === 1) {
          return { ok: false, reason: 'n-gram overlap', layer: 'deterministic' as const };
        }
        return { ok: true, coaching: CLEAN_COACHING };
      }),
    } as unknown as RefusalGuard;
    const ledger = stubLedger();
    const deps = stubDeps({ provider, guard, ledger });

    // Brief with audienceVenue but no purposeClaim — tests the else-branch.
    const brief = { audienceVenue: 'ICML', updatedAt: '2026-01-01T00:00:00.000Z' };
    await runCoachingTurn(deps, { ...DEFAULT_INPUT, brief });

    const secondCallArg = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[1][0];
    // The retry adds the strict reminder as purposeClaim (since original had none).
    expect(secondCallArg.brief?.purposeClaim).toContain('previous response was rejected');
    expect(secondCallArg.brief?.audienceVenue).toBe('ICML');
  });

  it('exhausts retries and returns retry_exhausted error', async () => {
    const guard = stubGuard(false, 'rewrite pattern', 'deterministic');
    const ledger = stubLedger();
    const deps = stubDeps({ guard, ledger, maxAttempts: 3 });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('retry_exhausted');
      expect(result.error.layer).toBe('deterministic');
    }

    // No ai_consult was recorded.
    expect(ledger.append).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Unit tests: runCoachingTurn — provider error
// ===========================================================================

describe('runCoachingTurn — provider error', () => {
  it('provider timeout renders nothing and surfaces an error', async () => {
    const provider = stubFailingProvider({
      kind: 'timeout',
      message: 'Request timed out. Please try again.',
    });
    const ledger = stubLedger();
    const deps = stubDeps({ provider, ledger });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
      expect(result.error.message).toContain('timed out');
    }

    // No ledger event.
    expect(ledger.append).not.toHaveBeenCalled();
  });

  it('provider auth error surfaces to the caller', async () => {
    const provider = stubFailingProvider({
      kind: 'auth',
      message: 'Authentication failed (status 401). Check your API key.',
    });
    const deps = stubDeps({ provider });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
      expect(result.error.message).toContain('Authentication');
    }
  });

  it('provider network error renders nothing', async () => {
    const provider = stubFailingProvider({
      kind: 'network',
      message: 'Could not connect to provider.',
    });
    const ledger = stubLedger();
    const deps = stubDeps({ provider, ledger });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
    }
    expect(ledger.append).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Unit tests: no brief
// ===========================================================================

describe('runCoachingTurn — no brief', () => {
  it('a turn with no brief proceeds and produces observations', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const deps = stubDeps({ provider });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching.observations.length).toBeGreaterThan(0);
    }

    // The request sent to provider has no brief.
    const coachCall = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(coachCall.brief).toBeUndefined();
  });
});

// ===========================================================================
// Integration tests: full stubbed turn
// ===========================================================================

describe('Integration: end-to-end stubbed coaching turn', () => {
  it('full pipeline: request build → schema validation → guard screen → ledger append → result', async () => {
    // Use a real-ish StructuredCoaching that passes the guard's deterministic
    // layer. The guard stub simulates a pass, but we still verify the flow.
    const provider = stubProvider(CLEAN_COACHING);
    const guard = stubGuard(true);
    const ledger = stubLedger();

    const result = await runCoachingTurn({ provider, guard, ledger }, DEFAULT_INPUT);

    // Result is ok.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    // Provider was called with a properly built request.
    expect(provider.coach).toHaveBeenCalledOnce();
    const coachReq = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(coachReq.selectionText).toBe(DEFAULT_INPUT.selectionText);
    expect(coachReq.anchorBase).toBe(42);
    expect(coachReq.documentLanguage).toBe('markdown');

    // Guard was called with the provider's output.
    expect(guard.screen).toHaveBeenCalledOnce();
    const [screenOut, screenDoc] = (guard.screen as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(screenOut).toEqual(CLEAN_COACHING);
    expect(screenDoc.selectionText).toBe(DEFAULT_INPUT.selectionText);

    // Ledger has exactly one ai_consult.
    expect(ledger.append).toHaveBeenCalledOnce();
    const appendArg = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(appendArg.type).toBe('ai_consult');
    expect(appendArg.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(appendArg.payload.observationCount).toBe(1);
  });

  it('failure path: guard reject → nothing rendered, no ai_consult', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const guard = stubGuard(false, 'rewrite pattern detected', 'deterministic');
    const ledger = stubLedger();

    const result = await runCoachingTurn(
      { provider, guard, ledger, maxAttempts: 1 },
      DEFAULT_INPUT,
    );

    // Result is failure.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');

    expect(result.error.kind).toBe('retry_exhausted');
    expect(result.error.layer).toBe('deterministic');

    // No ai_consult.
    expect(ledger.append).not.toHaveBeenCalled();

    // No coaching field — nothing renderable.
    expect((result as unknown as { coaching?: unknown }).coaching).toBeUndefined();
  });

  it('integration: retry on judge rejection then pass on second attempt', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const callCount = { value: 0 };
    const guard = {
      screen: vi.fn(async () => {
        callCount.value++;
        if (callCount.value === 1) {
          return { ok: false, reason: 'paste-ready prose detected', layer: 'judge' as const };
        }
        return { ok: true, coaching: CLEAN_COACHING };
      }),
    } as unknown as RefusalGuard;
    const ledger = stubLedger();

    const result = await runCoachingTurn({ provider, guard, ledger }, DEFAULT_INPUT);

    expect(result.ok).toBe(true);

    // Provider called twice (initial + retry).
    expect(provider.coach).toHaveBeenCalledTimes(2);

    // Guard called twice.
    expect(guard.screen).toHaveBeenCalledTimes(2);

    // Exactly one ai_consult (from the successful retry).
    expect(ledger.append).toHaveBeenCalledOnce();
    const appendArg = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(appendArg.type).toBe('ai_consult');
  });

  it('integration: brief is passed through the full pipeline', async () => {
    const provider = stubProvider(CLEAN_COACHING);
    const guard = stubGuard(true);
    const ledger = stubLedger();
    const brief = {
      purposeClaim: 'Investigate LLM impact on academic writing',
      audienceVenue: 'Journal of Academic Ethics',
      successCriterion: 'Publishable manuscript',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };

    await runCoachingTurn({ provider, guard, ledger }, { ...DEFAULT_INPUT, brief });

    const coachReq = (provider.coach as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(coachReq.brief).toEqual(brief);

    const appendArg = (ledger.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(appendArg.payload.hadBrief).toBe(true);
  });

  it('integration: provider failure on retry also surfaces error', async () => {
    // First: guard rejects. On retry: provider fails.
    const callCount = { value: 0 };
    const provider: CoachingProvider = {
      id: 'test-provider',
      coach: vi.fn(async () => {
        callCount.value++;
        if (callCount.value <= 1) {
          return { ok: true as const, value: CLEAN_COACHING };
        }
        return {
          ok: false as const,
          error: { kind: 'timeout' as const, message: 'Request timed out.' },
        };
      }),
      judge: vi.fn(),
      explainRule: vi.fn(),
    };
    const guard = {
      screen: vi.fn(async () => ({
        ok: false,
        reason: 'rejected',
        layer: 'deterministic' as const,
      })),
    } as unknown as RefusalGuard;
    const ledger = stubLedger();

    const result = await runCoachingTurn({ provider, guard, ledger }, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The retry's provider error is surfaced.
      expect(result.error.kind).toBe('provider');
      expect(result.error.message).toContain('timed out');
    }
    expect(ledger.append).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Task 18 — telemetry instrumentation of the turn pipeline
// ===========================================================================

describe('runCoachingTurn — telemetry instrumentation', () => {
  it('records a passing outcome and a voice-preservation sample on a clean turn', async () => {
    const telemetry = new TelemetrySink({ readEnabled: () => true });
    const deps = stubDeps({ telemetry });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(true);
    const m = telemetry.metrics();
    expect(m.coachingTurns.pass).toBe(1);
    expect(m.coachingTurns.reject).toBe(0);
    expect(m.voicePreservation.samples).toBe(1);
    expect(m.voicePreservation.rate).toBe(1); // no prose leaked
  });

  it('records the guard layer on a rejected turn', async () => {
    const telemetry = new TelemetrySink({ readEnabled: () => true });
    const deps = stubDeps({
      telemetry,
      guard: stubGuard(false, 'n-gram overlap too high', 'deterministic'),
    });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    const m = telemetry.metrics();
    expect(m.coachingTurns.reject).toBeGreaterThanOrEqual(1);
    expect(m.coachingTurns.byLayer.deterministic).toBeGreaterThanOrEqual(1);
    // Suppressed text never reached the writer → still preserved.
    expect(m.voicePreservation.rate).toBe(1);
  });

  it('does not record a coaching-turn outcome on a provider error', async () => {
    const telemetry = new TelemetrySink({ readEnabled: () => true });
    const deps = stubDeps({
      telemetry,
      provider: stubFailingProvider({ kind: 'timeout', message: 'timed out' }),
    });

    const result = await runCoachingTurn(deps, DEFAULT_INPUT);

    expect(result.ok).toBe(false);
    const m = telemetry.metrics();
    // No guard screen happened, so no coaching-turn outcome is recorded.
    expect(m.coachingTurns.pass).toBe(0);
    expect(m.coachingTurns.reject).toBe(0);
  });

  it('records nothing when telemetry is opt-out', async () => {
    const telemetry = new TelemetrySink({ readEnabled: () => false });
    const deps = stubDeps({ telemetry });

    await runCoachingTurn(deps, DEFAULT_INPUT);

    const m = telemetry.metrics();
    expect(m.coachingTurns.pass).toBe(0);
    expect(m.voicePreservation.samples).toBe(0);
    expect(telemetry.getEvents()).toHaveLength(0);
  });
});
