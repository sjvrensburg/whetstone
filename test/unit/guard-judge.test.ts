/**
 * Unit tests for the cloud-judge layer of the refusal guard (task 11).
 *
 * All provider calls are stubbed — no network. Tests cover:
 *   - Judge flags a candidate → rejected with `layer: "judge"`
 *   - "Unsure" verdict defaults to refused
 *   - Judge error fails closed
 *   - Judge timeout fails closed
 *   - Clean candidate passes the judge
 *   - Majority-of-N rejects when a minority pass
 *   - Majority-of-N passes when a majority pass
 *   - Majority-of-N on tie → fails closed
 */

import { describe, it, expect, vi } from 'vitest';
import { singleJudge, majorityJudge, runJudgeLayer } from '../../src/guard/judge';
import type { CoachingProvider, ProviderResult } from '../../src/providers/types';
import type { DocumentContext, GuardVerdict, StructuredCoaching } from '../../src/shared/types';
import { RefusalGuard, createRefusalGuard } from '../../src/guard/index';

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

const cleanCoaching = coaching(
  obs(
    'The paragraph positions LLMs as a threat without examining mitigating factors.',
    'What if the argument addressed both threats and opportunities — where would the balance fall?',
  ),
);

const doc: DocumentContext = {
  selectionText:
    'The rapid advancement of large language models has raised significant concerns about academic integrity.',
  documentLanguage: 'markdown',
};

/** Create a stub CoachingProvider whose judge returns the given result. */
function stubJudgeProvider(judgeResult: ProviderResult<GuardVerdict>): CoachingProvider {
  return {
    id: 'test',
    coach: vi.fn(async () => ({ ok: true as const, value: cleanCoaching })),
    judge: vi.fn(async () => judgeResult),
  };
}

/** Create a provider whose judge call rejects (simulating error/throw). */
function throwingJudgeProvider(error: Error): CoachingProvider {
  return {
    id: 'test',
    coach: vi.fn(),
    judge: vi.fn(async () => { throw error; }),
  };
}

/** Create a provider whose judge call hangs (timeout scenario). */
function hangingJudgeProvider(): CoachingProvider {
  return {
    id: 'test',
    coach: vi.fn(),
    judge: vi.fn(async (): Promise<ProviderResult<GuardVerdict>> =>
      new Promise((_resolve, _reject) => { /* never resolves */ })),
  };
}

// ---------------------------------------------------------------------------
// singleJudge
// ---------------------------------------------------------------------------

describe('singleJudge', () => {
  it('rejects a candidate the judge flags (refused: true)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: true, reason: 'contains paste-ready prose' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('paste-ready prose');
    }
  });

  it('defaults to refused on "unsure" verdict (refused: true with unsure reason)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: true, reason: 'unsure — defaulting to refused' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('unsure');
    }
  });

  it('defaults to refused when verdict reason is empty', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: true, reason: '' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('passes a clean candidate (refused: false)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching).toBe(cleanCoaching);
    }
  });

  it('fails closed on provider error (auth)', async () => {
    const provider = stubJudgeProvider({
      ok: false,
      error: { kind: 'auth', message: 'invalid API key' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('judge error');
      expect(result.reason).toContain('invalid API key');
    }
  });

  it('fails closed on provider error (timeout)', async () => {
    const provider = stubJudgeProvider({
      ok: false,
      error: { kind: 'timeout', message: 'request timed out' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('judge error');
    }
  });

  it('fails closed on provider error (network)', async () => {
    const provider = stubJudgeProvider({
      ok: false,
      error: { kind: 'network', message: 'connection refused' },
    });

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('fails closed when judge throws an exception', async () => {
    const provider = throwingJudgeProvider(new Error('unexpected failure'));

    const result = await singleJudge(provider, cleanCoaching);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('judge call failed');
      expect(result.reason).toContain('unexpected failure');
    }
  });

  it('fails closed on timeout (with timeoutMs)', async () => {
    // Provider that never resolves; we set a very short timeout.
    const provider = hangingJudgeProvider();

    const result = await singleJudge(provider, cleanCoaching, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('judge timed out');
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// majorityJudge
// ---------------------------------------------------------------------------

describe('majorityJudge', () => {
  it('rejects when a majority of judges refuse (2 of 3)', async () => {
    let callIndex = 0;
    const provider: CoachingProvider = {
      id: 'test',
      coach: vi.fn(),
      judge: vi.fn(async () => {
        callIndex++;
        if (callIndex === 2) {
          return { ok: true as const, value: { refused: false, reason: '' } };
        }
        return { ok: true as const, value: { refused: true, reason: 'paste-ready prose detected' } };
      }),
    };

    const result = await majorityJudge(provider, cleanCoaching, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('passes when a majority of judges pass (2 of 3)', async () => {
    let callIndex = 0;
    const provider: CoachingProvider = {
      id: 'test',
      coach: vi.fn(),
      judge: vi.fn(async () => {
        callIndex++;
        if (callIndex === 3) {
          return { ok: true as const, value: { refused: true, reason: 'borderline' } };
        }
        return { ok: true as const, value: { refused: false, reason: '' } };
      }),
    };

    const result = await majorityJudge(provider, cleanCoaching, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching).toBe(cleanCoaching);
    }
  });

  it('fails closed on a tie (1 of 2 refusing)', async () => {
    let callIndex = 0;
    const provider: CoachingProvider = {
      id: 'test',
      coach: vi.fn(),
      judge: vi.fn(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { ok: true as const, value: { refused: false, reason: '' } };
        }
        return { ok: true as const, value: { refused: true, reason: 'suspicious' } };
      }),
    };

    const result = await majorityJudge(provider, cleanCoaching, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('rejects when all judges refuse (unanimous)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: true, reason: 'prose detected' },
    });

    const result = await majorityJudge(provider, cleanCoaching, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('passes when all judges pass (unanimous)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });

    const result = await majorityJudge(provider, cleanCoaching, 3);
    expect(result.ok).toBe(true);
  });

  it('fails closed when some judge calls error', async () => {
    let callIndex = 0;
    const provider: CoachingProvider = {
      id: 'test',
      coach: vi.fn(),
      judge: vi.fn(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { ok: true as const, value: { refused: false, reason: '' } };
        }
        return { ok: false as const, error: { kind: 'network' as const, message: 'connection lost' } };
      }),
    };

    const result = await majorityJudge(provider, cleanCoaching, 3);
    // 1 pass, 2 errors → errors count as refusal → 2 refuse > 1 pass
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });
});

// ---------------------------------------------------------------------------
// runJudgeLayer (top-level entry)
// ---------------------------------------------------------------------------

describe('runJudgeLayer', () => {
  it('delegates to singleJudge when rounds is 1 (default)', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });

    const result = await runJudgeLayer(provider, cleanCoaching);
    expect(result.ok).toBe(true);
    expect(provider.judge).toHaveBeenCalledOnce();
  });

  it('delegates to majorityJudge when rounds > 1', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });

    const result = await runJudgeLayer(provider, cleanCoaching, { rounds: 3 });
    expect(result.ok).toBe(true);
    expect(provider.judge).toHaveBeenCalledTimes(3);
  });

  it('passes timeout to singleJudge', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });

    const result = await runJudgeLayer(provider, cleanCoaching, { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RefusalGuard with judge (integration through screen())
// ---------------------------------------------------------------------------

describe('RefusalGuard.screen() with judge', () => {
  it('returns ok:true when no provider is configured (backward compat)', async () => {
    const guard = new RefusalGuard();
    const result = await guard.screen(cleanCoaching, doc);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when provider judge passes', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });
    const guard = new RefusalGuard({ provider });
    const result = await guard.screen(cleanCoaching, doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.coaching).toBe(cleanCoaching);
    }
  });

  it('returns ok:false layer "judge" when judge refuses', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: true, reason: 'paste-ready prose found' },
    });
    const guard = new RefusalGuard({ provider });
    const result = await guard.screen(cleanCoaching, doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
      expect(result.reason).toContain('paste-ready');
    }
  });

  it('returns ok:false layer "deterministic" before reaching judge', async () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });
    const guard = new RefusalGuard({ provider });
    // This has a rewrite pattern → deterministic layer should catch it
    const badCoaching = coaching(
      obs('Change the first sentence to "A better opening."', 'Does this help?'),
    );
    const result = await guard.screen(badCoaching, doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('deterministic');
      expect(result.reason).toContain('rewrite pattern');
    }
    // Judge should NOT have been called
    expect(provider.judge).not.toHaveBeenCalled();
  });

  it('fails closed when judge errors (provider failure)', async () => {
    const provider = stubJudgeProvider({
      ok: false,
      error: { kind: 'auth', message: 'API key invalid' },
    });
    const guard = new RefusalGuard({ provider });
    const result = await guard.screen(cleanCoaching, doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.layer).toBe('judge');
    }
  });

  it('passes with majority-of-3 judge config', async () => {
    let callIndex = 0;
    const provider: CoachingProvider = {
      id: 'test',
      coach: vi.fn(),
      judge: vi.fn(async () => {
        callIndex++;
        if (callIndex === 2) {
          return { ok: true as const, value: { refused: true, reason: 'borderline' } };
        }
        return { ok: true as const, value: { refused: false, reason: '' } };
      }),
    };

    const guard = new RefusalGuard({
      provider,
      judgeOptions: { rounds: 3 },
    });
    const result = await guard.screen(cleanCoaching, doc);
    expect(result.ok).toBe(true);
    expect(provider.judge).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// createRefusalGuard factory with deps
// ---------------------------------------------------------------------------

describe('createRefusalGuard with deps', () => {
  it('creates guard without deps (backward compat)', () => {
    const g = createRefusalGuard();
    expect(g).toBeInstanceOf(RefusalGuard);
  });

  it('creates guard with provider', () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });
    const g = createRefusalGuard({ provider });
    expect(g).toBeInstanceOf(RefusalGuard);
  });

  it('creates guard with provider and judge options', () => {
    const provider = stubJudgeProvider({
      ok: true,
      value: { refused: false, reason: '' },
    });
    const g = createRefusalGuard({
      provider,
      judgeOptions: { rounds: 3, timeoutMs: 5000 },
    });
    expect(g).toBeInstanceOf(RefusalGuard);
  });
});
