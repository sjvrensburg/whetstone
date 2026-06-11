/**
 * Unit + integration tests for the telemetry sink (task 18) —
 * `src/telemetry/index.ts`.
 *
 * Covers the task's required cases:
 *  - opt-out disables all collection
 *  - a coaching-turn outcome records pass/reject plus the guard layer
 *  - the voice-preservation sample rate computes correctly from samples
 *  - aggregation stays on-device (no network call)
 *  - redaction strips prose/keys from any stored event
 * plus an integration scenario (coaching turn + helpfulness thumb update the
 * local aggregates without emitting prose or keys).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TelemetrySink,
  computeVoicePreservationRate,
  createTelemetrySink,
  REDACTED_PROSE,
  REDACTED_KEY,
} from '../../../src/telemetry/index';
import type { VoicePreservationSample } from '../../../src/telemetry/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A string of exactly `n` characters. */
function chars(n: number): string {
  return 'a'.repeat(n);
}

/** A sink with a controllable enabled flag and a fixed clock. */
function makeSink(
  enabled = true,
  now = new Date('2026-06-11T00:00:00Z'),
): {
  sink: TelemetrySink;
  setEnabled: (v: boolean) => void;
} {
  let on = enabled;
  return {
    sink: new TelemetrySink({ readEnabled: () => on, now: () => now }),
    setEnabled: (v: boolean) => {
      on = v;
    },
  };
}

// ---------------------------------------------------------------------------
// computeVoicePreservationRate (pure)
// ---------------------------------------------------------------------------

describe('computeVoicePreservationRate', () => {
  it('returns 1 for an empty sample set', () => {
    expect(computeVoicePreservationRate([])).toBe(1);
  });

  it('returns 1 when no samples leaked', () => {
    const samples: VoicePreservationSample[] = [
      { leaked: false },
      { leaked: false, layer: 'deterministic' },
    ];
    expect(computeVoicePreservationRate(samples)).toBe(1);
  });

  it('returns 0 when every sample leaked', () => {
    const samples: VoicePreservationSample[] = [{ leaked: true }, { leaked: true }];
    expect(computeVoicePreservationRate(samples)).toBe(0);
  });

  it('computes the preserved fraction for a mix', () => {
    // 3 preserved, 1 leaked → 0.75.
    const samples: VoicePreservationSample[] = [
      { leaked: false },
      { leaked: false },
      { leaked: true },
      { leaked: false },
    ];
    expect(computeVoicePreservationRate(samples)).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

describe('TelemetrySink — opt-out', () => {
  it('the enabled getter reflects the readEnabled seam', () => {
    const { sink, setEnabled } = makeSink(true);
    expect(sink.enabled).toBe(true);
    setEnabled(false);
    expect(sink.enabled).toBe(false);
  });

  it('records nothing when opt-out is active', () => {
    const { sink } = makeSink(false);
    sink.recordCoachingTurnOutcome({ outcome: 'pass' });
    sink.recordHelpfulness({ helpful: true });
    sink.recordActivation();
    sink.recordVoicePreservationSample({ leaked: false });

    const m = sink.metrics();
    expect(m.coachingTurns.pass).toBe(0);
    expect(m.helpfulness.up).toBe(0);
    expect(m.activationCount).toBe(0);
    expect(m.voicePreservation.samples).toBe(0);
    expect(sink.getEvents()).toHaveLength(0);
  });

  it('starts collecting again the moment opt-out is turned back on', () => {
    const { sink, setEnabled } = makeSink(false);
    sink.recordActivation(); // dropped
    setEnabled(true);
    sink.recordActivation(); // kept
    expect(sink.metrics().activationCount).toBe(1);
    expect(sink.getEvents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Coaching-turn outcomes (pass/reject + guard layer)
// ---------------------------------------------------------------------------

describe('TelemetrySink — coaching-turn outcomes', () => {
  it('records a pass without a layer', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'pass' });
    const m = sink.metrics();
    expect(m.coachingTurns.pass).toBe(1);
    expect(m.coachingTurns.reject).toBe(0);
    expect(m.coachingTurns.byLayer).toEqual({ deterministic: 0, judge: 0 });
  });

  it('records a reject plus the deterministic guard layer', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'reject', layer: 'deterministic' });
    const m = sink.metrics();
    expect(m.coachingTurns.reject).toBe(1);
    expect(m.coachingTurns.byLayer.deterministic).toBe(1);
    expect(m.coachingTurns.byLayer.judge).toBe(0);
  });

  it('records a reject plus the judge guard layer', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'reject', layer: 'judge' });
    const m = sink.metrics();
    expect(m.coachingTurns.reject).toBe(1);
    expect(m.coachingTurns.byLayer.judge).toBe(1);
  });

  it('records an event carrying the outcome and layer', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'reject', layer: 'judge' });
    const event = sink.getEvents()[0];
    expect(event.kind).toBe('coaching_turn');
    expect(event.payload).toEqual({ outcome: 'reject', layer: 'judge' });
    expect(event.ts).toBe('2026-06-11T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Guard-judge verdicts
// ---------------------------------------------------------------------------

describe('TelemetrySink — guard-judge verdicts', () => {
  it('counts refused and passed verdicts separately', () => {
    const { sink } = makeSink();
    sink.recordGuardJudgeVerdict({ refused: true });
    sink.recordGuardJudgeVerdict({ refused: true });
    sink.recordGuardJudgeVerdict({ refused: false });
    const m = sink.metrics();
    expect(m.judgeVerdicts).toEqual({ refused: 2, passed: 1 });
  });
});

// ---------------------------------------------------------------------------
// Voice-preservation sampling
// ---------------------------------------------------------------------------

describe('TelemetrySink — voice-preservation sample rate', () => {
  it('computes from recorded samples', () => {
    const { sink } = makeSink();
    sink.recordVoicePreservationSample({ leaked: false });
    sink.recordVoicePreservationSample({ leaked: false, layer: 'deterministic' });
    sink.recordVoicePreservationSample({ leaked: true, layer: 'judge' });
    const m = sink.metrics();
    expect(m.voicePreservation.samples).toBe(3);
    expect(m.voicePreservation.leaked).toBe(1);
    expect(m.voicePreservation.rate).toBeCloseTo(2 / 3, 10);
    expect(sink.voicePreservationSampleRate()).toBeCloseTo(2 / 3, 10);
  });

  it('live coaching turns (all leaked=false) read as fully preserved', () => {
    const { sink } = makeSink();
    for (let i = 0; i < 10; i++) {
      sink.recordVoicePreservationSample({ leaked: false });
    }
    expect(sink.voicePreservationSampleRate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Activation / helpfulness / ledger / report / cloud / integrity / self-return
// ---------------------------------------------------------------------------

describe('TelemetrySink — product metrics', () => {
  it('counts activations', () => {
    const { sink } = makeSink();
    sink.recordActivation();
    sink.recordActivation();
    expect(sink.metrics().activationCount).toBe(2);
  });

  it('counts self-return signals', () => {
    const { sink } = makeSink();
    sink.recordSelfReturn({ daysSinceFirstUse: 28 });
    expect(sink.metrics().selfReturnCount).toBe(1);
  });

  it('counts helpfulness thumbs up and down', () => {
    const { sink } = makeSink();
    sink.recordHelpfulness({ helpful: true });
    sink.recordHelpfulness({ helpful: true });
    sink.recordHelpfulness({ helpful: false });
    expect(sink.metrics().helpfulness).toEqual({ up: 2, down: 1 });
  });

  it('tracks the last-reported ledger on/off state', () => {
    const { sink } = makeSink();
    sink.recordLedgerState({ on: true });
    expect(sink.metrics().ledgerOn).toBe(true);
    sink.recordLedgerState({ on: false });
    expect(sink.metrics().ledgerOn).toBe(false);
  });

  it('counts report and disclosure generations separately', () => {
    const { sink } = makeSink();
    sink.recordReportGenerated({ kind: 'report' });
    sink.recordReportGenerated({ kind: 'report' });
    sink.recordReportGenerated({ kind: 'disclosure' });
    expect(sink.metrics().reportsGenerated).toEqual({ report: 2, disclosure: 1 });
  });

  it('counts cloud sends and ledger-integrity breaches', () => {
    const { sink } = makeSink();
    sink.recordCloudSend({ provider: 'zai', model: 'glm-5.1', purpose: 'coaching' });
    sink.recordLedgerIntegrity({ intact: true });
    sink.recordLedgerIntegrity({ intact: false, brokenAt: 7 });
    const m = sink.metrics();
    expect(m.cloudSendCount).toBe(1);
    expect(m.integrityBreaches).toBe(1);
  });

  it('does not count an intact ledger as a breach', () => {
    const { sink } = makeSink();
    sink.recordLedgerIntegrity({ intact: true });
    sink.recordLedgerIntegrity({ intact: true });
    expect(sink.metrics().integrityBreaches).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// On-device aggregation (no network)
// ---------------------------------------------------------------------------

describe('TelemetrySink — on-device aggregation', () => {
  it('never calls fetch (or any network) while recording', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { sink } = makeSink();
    for (let i = 0; i < 50; i++) {
      sink.recordCoachingTurnOutcome({ outcome: 'pass' });
      sink.recordHelpfulness({ helpful: true });
      sink.recordCloudSend({ provider: 'zai', model: 'glm-5.1', purpose: 'coaching' });
    }
    sink.metrics();

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('aggregates are available locally after recording', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'pass' });
    sink.recordActivation();
    const m = sink.metrics();
    expect(m.coachingTurns.pass).toBe(1);
    expect(m.activationCount).toBe(1);
    expect(sink.getEvents()).toHaveLength(2);
  });

  it('trims the raw event log to maxEvents but leaves aggregates intact', () => {
    const now = new Date('2026-06-11T00:00:00Z');
    const sink = new TelemetrySink({ readEnabled: () => true, now: () => now, maxEvents: 3 });
    for (let i = 0; i < 5; i++) {
      sink.recordActivation();
    }
    expect(sink.getEvents()).toHaveLength(3); // trimmed
    expect(sink.metrics().activationCount).toBe(5); // aggregate unaffected
  });
});

// ---------------------------------------------------------------------------
// Redaction at the record chokepoint
// ---------------------------------------------------------------------------

describe('TelemetrySink — redaction at the chokepoint', () => {
  it('strips prose and keys from a payload passed to recordSelfReturn', () => {
    const { sink } = makeSink();
    sink.recordSelfReturn({
      note: chars(300),
      apiKey: 'sk-test-1234567890',
      daysSinceFirstUse: 28,
    });
    const payload = sink.getEvents()[0].payload;
    expect(payload.note).toBe(REDACTED_PROSE);
    expect(payload.apiKey).toBe(REDACTED_KEY);
    expect(payload.daysSinceFirstUse).toBe(28);
  });

  it('no stored event contains an unredacted long string or key-shaped value', () => {
    const { sink } = makeSink();
    sink.recordCloudSend({
      provider: 'zai',
      // A prose-length "retention" string a careless caller might pass.
      model: chars(400),
      purpose: 'coaching',
    });
    sink.recordSelfReturn({ smuggledKey: 'sk-ant-abcdefghij' });
    for (const event of sink.getEvents()) {
      assertNoProseOrKeys(event.payload);
    }
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('TelemetrySink.reset', () => {
  it('clears all events, samples, and aggregates', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'pass' });
    sink.recordActivation();
    sink.recordVoicePreservationSample({ leaked: false });
    sink.reset();
    const m = sink.metrics();
    expect(m.coachingTurns.pass).toBe(0);
    expect(m.activationCount).toBe(0);
    expect(m.voicePreservation.samples).toBe(0);
    expect(sink.getEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createTelemetrySink helper
// ---------------------------------------------------------------------------

describe('createTelemetrySink', () => {
  it('wires readEnabled to the telemetryEnabled setting', () => {
    const sink = createTelemetrySink(() => ({ telemetryEnabled: true }));
    expect(sink.enabled).toBe(true);
    sink.recordActivation();
    expect(sink.metrics().activationCount).toBe(1);

    const off = createTelemetrySink(() => ({ telemetryEnabled: false }));
    off.recordActivation();
    expect(off.metrics().activationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: coaching turn + helpfulness thumb (no prose/keys emitted)
// ---------------------------------------------------------------------------

describe('integration — coaching turn + helpfulness thumb', () => {
  it('updates the local aggregates without emitting prose or keys', () => {
    const { sink } = makeSink();

    // Simulate one coaching turn: a guard-passed attempt then a thumb up.
    sink.recordCoachingTurnOutcome({ outcome: 'pass' });
    sink.recordVoicePreservationSample({ leaked: false });
    sink.recordHelpfulness({ helpful: true });

    const m = sink.metrics();
    expect(m.coachingTurns.pass).toBe(1);
    expect(m.voicePreservation.rate).toBe(1);
    expect(m.helpfulness.up).toBe(1);

    // Nothing stored carries prose or keys.
    for (const event of sink.getEvents()) {
      assertNoProseOrKeys(event.payload);
    }
  });

  it('a rejected coaching turn records the guard layer and stays prose-free', () => {
    const { sink } = makeSink();
    sink.recordCoachingTurnOutcome({ outcome: 'reject', layer: 'judge' });
    sink.recordVoicePreservationSample({ leaked: false, layer: 'judge' });
    sink.recordHelpfulness({ helpful: false });

    const m = sink.metrics();
    expect(m.coachingTurns.reject).toBe(1);
    expect(m.coachingTurns.byLayer.judge).toBe(1);
    expect(m.helpfulness.down).toBe(1);

    for (const event of sink.getEvents()) {
      assertNoProseOrKeys(event.payload);
    }
  });
});

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Walk a payload and fail if any value is an unredacted long string (prose),
 * a key-shaped string, or one of the known redaction markers left un-stripped
 * adjacent to raw prose. Redaction markers themselves are allowed (they are
 * the proof prose was caught); raw prose/key values are not.
 */
function assertNoProseOrKeys(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoProseOrKeys(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A field named like a secret must already be a redaction marker.
      if (/key|secret|token|password|credential/i.test(k)) {
        expect(v).toBe(REDACTED_KEY);
      }
      assertNoProseOrKeys(v, `${path}.${k}`);
    }
    return;
  }
  if (typeof value === 'string') {
    // No raw prose (long strings) and no bare key-shaped values survive.
    expect(value.length, `prose at ${path}`).toBeLessThanOrEqual(280);
    // Reject key-shaped raw values (known prefixes or opaque tokens).
    expect(/^(sk-|Bearer\s|gl-|xai-|AKIA|sk_ant_)/i.test(value), `key prefix at ${path}`).toBe(
      false,
    );
  }
}
