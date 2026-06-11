/**
 * Unit tests for `friction/pushCadence.ts` — proactive push coaching cadence
 * (instrument A, ADR-008, task 24).
 *
 * Covers:
 *   - Paragraph boundary detection (extractParagraphs, detectNewParagraph)
 *   - Dial gating (pull → no push; push → push fires)
 *   - Debounce behaviour (trivial edits do NOT trigger)
 *   - Consent gating (each push routes through ensureConsent, cloud_send)
 *   - Rate limiting (rapid successive pushes suppressed)
 *   - Dismiss and silence controls (document, session, dismiss)
 *   - Integration: full flow from feedChange → onIdle → coaching result
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PushCadence,
  extractParagraphs,
  detectNewParagraph,
  DEFAULT_PUSH_CONFIG,
} from '../../src/friction/pushCadence';
import type { PushCadenceDeps, PushCadenceConfig } from '../../src/friction/pushCadence';
import type { CoachingCadenceState } from '../../src/friction/presets';
import type { ConsentResult } from '../../src/consent';
import type { CoachingTurnDeps } from '../../src/coaching';
import type { Brief, StructuredCoaching } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Stubs / helpers
// ---------------------------------------------------------------------------

const NOW = '2026-06-11T12:00:00.000Z';
const TWO_PARAGRAPHS =
  'The first paragraph has enough content to be meaningful.\n\nThe second paragraph is also long enough to count as real content.';
const THREE_PARAGRAPHS =
  TWO_PARAGRAPHS +
  '\n\nThe third paragraph was just completed and meets the minimum threshold for push coaching.';

/** A valid StructuredCoaching fixture. */
const COACHING_FIXTURE: StructuredCoaching = {
  observations: [
    {
      anchor: { start: 0, end: 20 },
      kind: 'implicit_claim',
      reflection: 'The paragraph opens with a claim.',
      question: 'What evidence supports this claim?',
    },
  ],
};

/** Create a consent result. */
function consentResult(ok: boolean, reason?: string): ConsentResult {
  return ok
    ? { ok: true }
    : { ok: false, reason: reason ?? 'Consent declined.' };
}

/** Build a stub PushCadenceDeps with configurable behaviour. */
interface StubConfig {
  dialState?: CoachingCadenceState;
  consentOk?: boolean;
  brief?: Brief;
}

function makeDeps(stub: StubConfig = {}): PushCadenceDeps {
  const consentOk = stub.consentOk ?? true;

  return {
    dial: {
      instrumentState: vi.fn().mockReturnValue(stub.dialState ?? 'pull'),
    },
    consentGate: {
      ensureConsent: vi.fn().mockResolvedValue(consentResult(consentOk)),
    },
    buildCoachingDeps: vi.fn().mockResolvedValue({
      provider: {
        id: 'stub',
        coach: vi.fn().mockResolvedValue({ ok: true, value: COACHING_FIXTURE }),
      },
      guard: {
        screen: vi.fn().mockResolvedValue({ ok: true, coaching: COACHING_FIXTURE }),
      },
      ledger: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as CoachingTurnDeps),
    briefCapture: {
      read: vi.fn().mockResolvedValue(stub.brief ?? undefined),
    },
    ledger: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    now: vi.fn().mockReturnValue(NOW),
  };
}

/** Helper: extract push_coaching ledger events from mock calls. */
function pushEventsFromLedger(
  ledgerAppend: ReturnType<typeof vi.fn>,
): Array<{ ts: string; type: string; payload: unknown }> {
  return ledgerAppend.mock.calls
    .map((c: Array<unknown>) => c[0] as { ts: string; type: string; payload: unknown })
    .filter((e) => e.type === 'push_coaching');
}

/** Create a PushCadence with a small rate limit for testing. */
function makeCadence(
  deps?: PushCadenceDeps,
  config?: Partial<PushCadenceConfig>,
): PushCadence {
  return new PushCadence(
    deps ?? makeDeps({ dialState: 'push' }),
    { ...DEFAULT_PUSH_CONFIG, rateLimitMs: 1000, minParagraphChars: 30, ...config },
  );
}

// ---------------------------------------------------------------------------
// extractParagraphs
// ---------------------------------------------------------------------------

describe('extractParagraphs', () => {
  it('splits on double newlines', () => {
    const result = extractParagraphs('AAA\n\nBBB\n\nCCC');
    expect(result).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('filters empty paragraphs', () => {
    const result = extractParagraphs('AAA\n\n\n\nBBB');
    expect(result).toEqual(['AAA', 'BBB']);
  });

  it('trims whitespace', () => {
    const result = extractParagraphs('  AAA  \n\n  BBB  ');
    expect(result).toEqual(['AAA', 'BBB']);
  });

  it('returns empty for empty string', () => {
    expect(extractParagraphs('')).toEqual([]);
  });

  it('returns single paragraph with no double newline', () => {
    expect(extractParagraphs('Just one paragraph')).toEqual(['Just one paragraph']);
  });
});

// ---------------------------------------------------------------------------
// detectNewParagraph
// ---------------------------------------------------------------------------

describe('detectNewParagraph', () => {
  it('detects a new paragraph when count increases', () => {
    const result = detectNewParagraph(TWO_PARAGRAPHS, THREE_PARAGRAPHS, 30);
    expect(result).not.toBeNull();
    expect(result!.text).toContain('third paragraph');
    expect(result!.offset).toBeGreaterThanOrEqual(0);
  });

  it('returns null when paragraph count stays the same', () => {
    const result = detectNewParagraph(TWO_PARAGRAPHS, TWO_PARAGRAPHS, 30);
    expect(result).toBeNull();
  });

  it('returns null when paragraph count decreases', () => {
    const result = detectNewParagraph(THREE_PARAGRAPHS, TWO_PARAGRAPHS, 30);
    expect(result).toBeNull();
  });

  it('returns null when new paragraph is too short', () => {
    const short = TWO_PARAGRAPHS + '\n\nHi.';
    const result = detectNewParagraph(TWO_PARAGRAPHS, short, 30);
    expect(result).toBeNull();
  });

  it('returns null when both texts are empty', () => {
    expect(detectNewParagraph('', '', 30)).toBeNull();
  });

  it('detects first paragraph added to empty document', () => {
    const newText = 'This is the first paragraph with enough characters to qualify.';
    const result = detectNewParagraph('', newText, 30);
    expect(result).not.toBeNull();
    expect(result!.text).toBe(newText.trim());
  });
});

// ---------------------------------------------------------------------------
// PushCadence — dial gating
// ---------------------------------------------------------------------------

describe('PushCadence dial gating', () => {
  it('at "pull" (default), no push ever fires', async () => {
    const deps = makeDeps({ dialState: 'pull' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('pull');
    }
    expect(deps.consentGate.ensureConsent).not.toHaveBeenCalled();
  });

  it('at "push", coaching fires on settled boundary', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PushCadence — debounce (trivial edits do NOT trigger)
// ---------------------------------------------------------------------------

describe('PushCadence debounce', () => {
  it('trivial/in-progress edits do NOT trigger a push', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    // Same paragraph count — no boundary change
    const text1 = 'This is a paragraph with some content that is long enough.';
    const text2 = 'This is a paragraph with some content that is long enough and more.';
    cadence.feedChange(text1, 'markdown', 'file:///a.md');
    cadence.feedChange(text2, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('No new paragraph boundary');
    }
  });

  it('adding a too-short paragraph does NOT trigger', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    const long = 'A'.repeat(60);
    const short = 'Hi.';
    cadence.feedChange(long, 'markdown', 'file:///a.md');
    cadence.feedChange(long + '\n\n' + short, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
  });

  it('empty document change does NOT trigger', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange('', 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PushCadence — consent gating
// ---------------------------------------------------------------------------

describe('PushCadence consent gating', () => {
  it('each push routes through ensureConsent()', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    expect(deps.consentGate.ensureConsent).toHaveBeenCalledWith('coaching');
    expect(deps.consentGate.ensureConsent).toHaveBeenCalledTimes(1);
  });

  it('records cloud_send via consent gate (ledger event)', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    // The consent gate records cloud_send internally.
    // The push cadence also records a push_coaching event.
    const events = pushEventsFromLedger(deps.ledger.append as ReturnType<typeof vi.fn>);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      dialState: 'push',
      documentLanguage: 'markdown',
    });
  });

  it('declined consent blocks the push', async () => {
    const deps = makeDeps({ dialState: 'push', consentOk: false });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('Consent not granted');
    }
  });

  it('no cloud_send before consent is granted', async () => {
    const deps = makeDeps({ dialState: 'push', consentOk: false });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    await cadence.onIdle();
    // No push_coaching event recorded (consent failed)
    const events = pushEventsFromLedger(deps.ledger.append as ReturnType<typeof vi.fn>);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PushCadence — rate limiting
// ---------------------------------------------------------------------------

describe('PushCadence rate limiting', () => {
  it('rate limit suppresses rapid successive pushes', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps, { rateLimitMs: 60_000 }); // 1 minute

    // First push
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');
    const result1 = await cadence.onIdle();
    expect(result1.triggered).toBe(true);

    // Immediately add another paragraph — rate limited
    const fourP = THREE_PARAGRAPHS + '\n\nA fourth paragraph that is long enough to count normally.';
    cadence.feedChange(fourP, 'markdown', 'file:///a.md');
    const result2 = await cadence.onIdle();
    expect(result2.triggered).toBe(false);
    if (!result2.triggered) {
      expect(result2.reason).toContain('Rate limited');
    }
  });

  it('push fires after rate limit window passes', async () => {
    let nowMs = new Date(NOW).getTime();
    const deps = makeDeps({ dialState: 'push' });
    (deps.now as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Date(nowMs).toISOString(),
    );
    const cadence = makeCadence(deps, { rateLimitMs: 1000 });

    // First push
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');
    const result1 = await cadence.onIdle();
    expect(result1.triggered).toBe(true);

    // Advance time past rate limit
    nowMs += 2000;
    (deps.now as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Date(nowMs).toISOString(),
    );

    // Add another paragraph
    const fourP = THREE_PARAGRAPHS + '\n\nA fourth paragraph that is long enough to count normally.';
    cadence.feedChange(fourP, 'markdown', 'file:///a.md');
    const result2 = await cadence.onIdle();
    expect(result2.triggered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PushCadence — silence / dismiss controls
// ---------------------------------------------------------------------------

describe('PushCadence silence / dismiss', () => {
  it('dismiss stops the pending push', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.dismiss();

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('dismissed');
    }
  });

  it('feedChange resets dismissal', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.dismiss();

    // New change resets dismissal
    const fourP = THREE_PARAGRAPHS + '\n\nA fourth paragraph that is long enough to count normally.';
    cadence.feedChange(fourP, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
  });

  it('silenceDocument stops pushes for that document', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.silenceDocument('file:///a.md');
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('Document silenced');
    }
  });

  it('silenceDocument does NOT affect other documents', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.silenceDocument('file:///other.md');
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
  });

  it('silenceSession stops all pushes for the session', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.silenceSession();
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('Session silenced');
    }
  });

  it('isSilenced reflects combined session + document silence', () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    expect(cadence.isSilenced).toBe(false);

    cadence.silenceDocument('file:///a.md');
    cadence.feedChange('', 'markdown', 'file:///a.md');
    expect(cadence.isSilenced).toBe(true);

    cadence.feedChange('', 'markdown', 'file:///other.md');
    expect(cadence.isSilenced).toBe(false);

    cadence.silenceSession();
    expect(cadence.isSilenced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PushCadence — coaching failure
// ---------------------------------------------------------------------------

describe('PushCadence coaching failure', () => {
  it('coaching turn failure returns triggered:false', async () => {
    const deps = makeDeps({ dialState: 'push' });
    // Make the coaching turn fail by having the provider fail
    const coachingDeps = {
      provider: {
        id: 'stub',
        coach: vi.fn().mockResolvedValue({ ok: false, error: { message: 'Provider down.' } }),
      },
      guard: {
        screen: vi.fn(),
      },
      ledger: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    };
    (deps.buildCoachingDeps as ReturnType<typeof vi.fn>).mockResolvedValue(coachingDeps);

    const cadence = makeCadence(deps);
    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    if (!result.triggered) {
      expect(result.reason).toContain('Coaching failed');
    }
  });
});

// ---------------------------------------------------------------------------
// PushCadence — brief integration
// ---------------------------------------------------------------------------

describe('PushCadence brief integration', () => {
  it('includes brief in coaching input when available', async () => {
    const brief: Brief = {
      purposeClaim: 'Testing the claim.',
      updatedAt: NOW,
    };
    const deps = makeDeps({ dialState: 'push', brief });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.input.brief).toEqual(brief);
    }
  });
});

// ---------------------------------------------------------------------------
// PushCadence — document language
// ---------------------------------------------------------------------------

describe('PushCadence document language', () => {
  it('passes markdown language through to coaching', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'markdown', 'file:///a.md');
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///a.md');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.input.documentLanguage).toBe('markdown');
    }
  });

  it('passes latex language through to coaching', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    cadence.feedChange(TWO_PARAGRAPHS, 'latex', 'file:///a.tex');
    cadence.feedChange(THREE_PARAGRAPHS, 'latex', 'file:///a.tex');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.input.documentLanguage).toBe('latex');
    }
  });
});

// ---------------------------------------------------------------------------
// PushCadence — dial state getter
// ---------------------------------------------------------------------------

describe('PushCadence dial state', () => {
  it('exposes current dial state', () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);
    expect(cadence.dialState).toBe('push');
  });
});

// ---------------------------------------------------------------------------
// Integration: full flow from feedChange → onIdle → coaching result
// ---------------------------------------------------------------------------

describe('PushCadence integration: settled paragraph triggers one push', () => {
  it('finish a paragraph → after idle, one push appears; no coaching before consent', async () => {
    const deps = makeDeps({ dialState: 'push' });
    const cadence = makeCadence(deps);

    // Writer starts with one paragraph
    cadence.feedChange(
      'The first paragraph has enough content to be meaningful.',
      'markdown',
      'file:///essay.md',
    );

    // Idle fires — no new paragraph boundary yet
    let result = await cadence.onIdle();
    expect(result.triggered).toBe(false);
    expect(deps.consentGate.ensureConsent).not.toHaveBeenCalled();

    // Writer adds a second paragraph (finishes it)
    cadence.feedChange(THREE_PARAGRAPHS, 'markdown', 'file:///essay.md');

    // Idle fires — push should trigger
    result = await cadence.onIdle();
    expect(result.triggered).toBe(true);

    // Consent was called exactly once
    expect(deps.consentGate.ensureConsent).toHaveBeenCalledTimes(1);

    // push_coaching event recorded
    const events = pushEventsFromLedger(deps.ledger.append as ReturnType<typeof vi.fn>);
    expect(events).toHaveLength(1);

    // Result contains coaching with observations
    if (result.triggered) {
      expect(result.coaching.observations).toHaveLength(1);
      expect(result.coaching.observations[0].kind).toBe('implicit_claim');
      expect(result.anchorBase).toBeGreaterThanOrEqual(0);
    }
  });

  it('full end-to-end with brief and latex', async () => {
    const brief: Brief = {
      purposeClaim: 'Argue for method justification.',
      audienceVenue: 'Journal of Methods',
      successCriterion: 'Reviewer accepts sample-size rationale',
      updatedAt: NOW,
    };
    const deps = makeDeps({ dialState: 'push', brief });
    const cadence = makeCadence(deps);

    const para1 = 'First paragraph with enough content for the test to pass.';
    const para2 = 'Second paragraph also has sufficient content to be meaningful.';
    const text1 = para1;
    const text2 = para1 + '\n\n' + para2;

    cadence.feedChange(text1, 'latex', 'file:///paper.tex');
    cadence.feedChange(text2, 'latex', 'file:///paper.tex');

    const result = await cadence.onIdle();
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(result.input.documentLanguage).toBe('latex');
      expect(result.input.brief).toEqual(brief);
      expect(result.coaching).toBeDefined();
    }
  });
});
