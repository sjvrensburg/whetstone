/**
 * `telemetry/` — Opt-out, on-device-aggregated instrumentation (task 18,
 * TechSpec "Monitoring and Observability"; ADR-001 self-return north star;
 * ADR-004 redaction in all telemetry).
 *
 * Whetstone has no backend and no account, so telemetry never leaves the
 * device. This module is a **local sink**: callers emit structured events,
 * the sink aggregates them in memory, and nothing is transmitted. Every
 * payload passes through `redact()` (`./redact`) before it is stored, so
 * prose and keys can never appear in a telemetry event even if a caller
 * hands them in.
 *
 * Key metrics (TechSpec): self-return, activation, coaching helpfulness
 * (thumbs), ledger-on + report-generation, and the **voice-preservation
 * sample rate** (proportion of sampled responses with zero paste-ready
 * prose). Structured local events: coaching-turn outcomes (pass/reject +
 * guard layer), guard-judge verdicts, ledger integrity status, cloud-send
 * log.
 *
 * Opt-out is honored per event via the injected `readEnabled` seam (read from
 * the settings accessor, task 04); when disabled, `record*` are no-ops and no
 * aggregates change.
 */

export * from './redact';
import { redact } from './redact';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The guard layer that produced a screening outcome (ADR-003). */
export type GuardLayer = 'deterministic' | 'judge';

/** The machine-readable kinds of structured events the sink records. */
export type TelemetryEventKind =
  | 'coaching_turn'
  | 'guard_judge_verdict'
  | 'helpfulness'
  | 'activation'
  | 'self_return'
  | 'ledger_state'
  | 'report_generated'
  | 'cloud_send'
  | 'ledger_integrity'
  | 'voice_preservation_sample';

/**
 * One stored telemetry event. `payload` is metadata-only: it has already been
 * through `redact()`, so it contains neither prose nor keys.
 */
export interface TelemetryEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  /** The event kind. */
  kind: TelemetryEventKind;
  /** Metadata-only payload (prose/keys redacted). */
  payload: Record<string, unknown>;
}

/**
 * One sampled coaching response, for the voice-preservation metric.
 *
 * `leaked` is true when paste-ready prose reached the writer — a
 * voice-preservation breach. This single primitive unifies live use and the
 * release-gate corpus (task 19): a live coaching turn never leaks (the guard
 * suppresses suspect text by construction, so it records `leaked: false`);
 * the corpus sets `leaked: true` only when a leak fixture passes the guard.
 * The voice-preservation sample rate is therefore the ≥99% gate efficacy
 * when fed by the corpus, and reads "no prose leaked this period" (100%)
 * in normal live use.
 */
export interface VoicePreservationSample {
  /** True when paste-ready prose reached the writer. */
  leaked: boolean;
  /** The guard layer that produced the outcome, for diagnostics. */
  layer?: GuardLayer;
}

/** On-device aggregated metrics snapshot. */
export interface TelemetryMetrics {
  /** Coaching-turn outcomes by result and the guard layer that decided them. */
  coachingTurns: {
    pass: number;
    reject: number;
    byLayer: { deterministic: number; judge: number };
  };
  /** Guard-judge verdicts (independent of the overall turn outcome). */
  judgeVerdicts: { refused: number; passed: number };
  /** Coaching interactions (activation = at least one). */
  activationCount: number;
  /** Re-engagement signals (self-return north star). */
  selfReturnCount: number;
  /** In-product helpfulness thumbs. */
  helpfulness: { up: number; down: number };
  /** Whether the ledger is currently on (last reported state). */
  ledgerOn: boolean;
  /** Report/disclosure generation counts by kind. */
  reportsGenerated: { report: number; disclosure: number };
  /** Recorded cloud sends (provider egress). */
  cloudSendCount: number;
  /** Ledger integrity breaches observed. */
  integrityBreaches: number;
  /** Voice-preservation sampling. */
  voicePreservation: { samples: number; leaked: number; rate: number };
}

/**
 * Dependencies injected into `TelemetrySink` — kept structural so the module
 * stays headlessly unit-testable (the same DI pattern as `ConsentGate` /
 * `LedgerImpl`).
 */
export interface TelemetryDeps {
  /**
   * Whether opt-out telemetry collection is currently enabled. Re-read on
   * every event so toggling the setting takes effect immediately. Production
   * wires this to `() => getSettings().telemetryEnabled` (task 04).
   */
  readEnabled: () => boolean;
  /** Clock seam for deterministic timestamps in tests. Defaults to now. */
  now?: () => Date;
  /**
   * Maximum number of raw events retained in the on-device log (the most
   * recent are kept). Aggregates are unaffected by this cap. Defaults to 1000.
   */
  maxEvents?: number;
}

// ---------------------------------------------------------------------------
// Voice-preservation sample rate (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the voice-preservation sample rate: the proportion of sampled
 * responses with zero paste-ready prose (i.e. `leaked === false`).
 *
 * Returns `1` for an empty sample set (no breaches observed). This is the
 * pure computation the release gate (task 19) consumes; the sink exposes it
 * over its recorded samples via `voicePreservationSampleRate()`.
 */
export function computeVoicePreservationRate(samples: VoicePreservationSample[]): number {
  if (samples.length === 0) {
    return 1;
  }
  const preserved = samples.filter((s) => !s.leaked).length;
  return preserved / samples.length;
}

// ---------------------------------------------------------------------------
// TelemetrySink
// ---------------------------------------------------------------------------

/** Default cap on the retained raw event log. */
const DEFAULT_MAX_EVENTS = 1000;

/**
 * The opt-out, on-device telemetry sink. All aggregation is in memory; the
 * sink performs **no network I/O** — there is no transport and nothing is
 * transmitted. Every recorded payload is redacted before storage.
 *
 * Usage:
 * ```ts
 * const sink = new TelemetrySink({ readEnabled: () => getSettings().telemetryEnabled });
 * sink.recordCoachingTurnOutcome({ outcome: 'pass' });
 * sink.recordHelpfulness({ helpful: true });
 * const metrics = sink.metrics();
 * const vpRate = sink.voicePreservationSampleRate();
 * ```
 */
export class TelemetrySink {
  private readonly readEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly maxEvents: number;
  private readonly events: TelemetryEvent[] = [];
  private readonly vpSamples: VoicePreservationSample[] = [];

  // Aggregates.
  private coachingPass = 0;
  private coachingReject = 0;
  private coachingByLayer: { deterministic: number; judge: number } = {
    deterministic: 0,
    judge: 0,
  };
  private judgeRefused = 0;
  private judgePassed = 0;
  private activationCount = 0;
  private selfReturnCount = 0;
  private thumbsUp = 0;
  private thumbsDown = 0;
  private ledgerOn = false;
  private reports = { report: 0, disclosure: 0 };
  private cloudSendCount = 0;
  private integrityBreaches = 0;

  constructor(deps: TelemetryDeps) {
    this.readEnabled = deps.readEnabled;
    this.now = deps.now ?? (() => new Date());
    this.maxEvents = deps.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /**
   * Whether collection is currently enabled (honors opt-out live). Exposed for
   * callers that want to short-circuit expensive event construction.
   */
  get enabled(): boolean {
    return this.readEnabled();
  }

  // -----------------------------------------------------------------------
  // Internal: the single record chokepoint
  // -----------------------------------------------------------------------

  /**
   * Record a structured event. When opt-out is active this is a no-op and no
   * aggregate changes. Otherwise the payload is redacted, stamped, appended
   * to the on-device log (trimmed to `maxEvents`), and returned so callers
   * can also feed aggregates.
   *
   * Never performs network I/O and never throws on a malformed payload
   * (redaction is total).
   */
  private record(kind: TelemetryEventKind, payload: Record<string, unknown>): void {
    if (!this.readEnabled()) {
      return;
    }
    const event: TelemetryEvent = {
      ts: this.now().toISOString(),
      kind,
      payload: redact(payload) as Record<string, unknown>,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  // -----------------------------------------------------------------------
  // 18.2 — Coaching-turn outcomes, guard layers, judge verdicts
  // -----------------------------------------------------------------------

  /**
   * Record a coaching-turn outcome: whether the turn passed the guard or was
   * rejected, and (on rejection) the guard layer that decided it. Bumps the
   * coaching-turn aggregates.
   */
  recordCoachingTurnOutcome(input: { outcome: 'pass' | 'reject'; layer?: GuardLayer }): void {
    this.record('coaching_turn', {
      outcome: input.outcome,
      ...(input.layer !== undefined ? { layer: input.layer } : {}),
    });
    if (!this.readEnabled()) {
      return;
    }
    if (input.outcome === 'pass') {
      this.coachingPass++;
    } else {
      this.coachingReject++;
      if (input.layer) {
        this.coachingByLayer[input.layer]++;
      }
    }
  }

  /**
   * Record a guard-judge verdict (the cloud judge's own refused/passed call,
   * independent of the overall turn outcome). Bumps the judge-verdict
   * aggregates.
   */
  recordGuardJudgeVerdict(input: { refused: boolean }): void {
    this.record('guard_judge_verdict', { refused: input.refused });
    if (!this.readEnabled()) {
      return;
    }
    if (input.refused) {
      this.judgeRefused++;
    } else {
      this.judgePassed++;
    }
  }

  // -----------------------------------------------------------------------
  // 18.4 — Voice-preservation sampling
  // -----------------------------------------------------------------------

  /**
   * Record a voice-preservation sample. A live coaching turn records
   * `leaked: false` (the guard suppresses suspect text by construction); the
   * release-gate corpus records `leaked: true` when a leak slips through.
   */
  recordVoicePreservationSample(sample: VoicePreservationSample): void {
    this.record('voice_preservation_sample', {
      leaked: sample.leaked,
      ...(sample.layer !== undefined ? { layer: sample.layer } : {}),
    });
    if (!this.readEnabled()) {
      return;
    }
    this.vpSamples.push(sample);
    if (this.vpSamples.length > this.maxEvents) {
      this.vpSamples.shift();
    }
  }

  /**
   * The voice-preservation sample rate over recorded samples: the proportion
   * with zero paste-ready prose. Consumed by the release gate (task 19) and
   * available for on-device reporting.
   */
  voicePreservationSampleRate(): number {
    return computeVoicePreservationRate(this.vpSamples);
  }

  // -----------------------------------------------------------------------
  // 18.3 — Activation, helpfulness, ledger-on/report, self-return
  // -----------------------------------------------------------------------

  /** Record an activation (a coaching interaction). Activation = at least one. */
  recordActivation(): void {
    this.record('activation', {});
    if (this.readEnabled()) {
      this.activationCount++;
    }
  }

  /** Record a self-return (re-engagement) signal — the north-star metric. */
  recordSelfReturn(meta?: Record<string, unknown>): void {
    this.record('self_return', meta ?? {});
    if (this.readEnabled()) {
      this.selfReturnCount++;
    }
  }

  /** Record an in-product helpfulness thumb. */
  recordHelpfulness(input: { helpful: boolean }): void {
    this.record('helpfulness', { helpful: input.helpful });
    if (!this.readEnabled()) {
      return;
    }
    if (input.helpful) {
      this.thumbsUp++;
    } else {
      this.thumbsDown++;
    }
  }

  /** Record the ledger on/off state (the last reported state wins). */
  recordLedgerState(input: { on: boolean }): void {
    this.record('ledger_state', { on: input.on });
    if (this.readEnabled()) {
      this.ledgerOn = input.on;
    }
  }

  /** Record a transparency-report or disclosure generation event. */
  recordReportGenerated(input: { kind: 'report' | 'disclosure' }): void {
    this.record('report_generated', { kind: input.kind });
    if (!this.readEnabled()) {
      return;
    }
    if (input.kind === 'report') {
      this.reports.report++;
    } else {
      this.reports.disclosure++;
    }
  }

  /** Record a cloud send (provider egress) — metadata only, no prose/keys. */
  recordCloudSend(input: { provider: string; model: string; purpose: string }): void {
    this.record('cloud_send', {
      provider: input.provider,
      model: input.model,
      purpose: input.purpose,
    });
    if (this.readEnabled()) {
      this.cloudSendCount++;
    }
  }

  /** Record ledger integrity status; a non-intact chain bumps the breach count. */
  recordLedgerIntegrity(input: { intact: boolean; brokenAt?: number }): void {
    this.record('ledger_integrity', {
      intact: input.intact,
      ...(input.brokenAt !== undefined ? { brokenAt: input.brokenAt } : {}),
    });
    if (this.readEnabled() && !input.intact) {
      this.integrityBreaches++;
    }
  }

  // -----------------------------------------------------------------------
  // Read-side
  // -----------------------------------------------------------------------

  /** The redacted, on-device event log (most recent last). */
  getEvents(): readonly TelemetryEvent[] {
    return this.events;
  }

  /** A snapshot of all on-device aggregated metrics. */
  metrics(): TelemetryMetrics {
    return {
      coachingTurns: {
        pass: this.coachingPass,
        reject: this.coachingReject,
        byLayer: { ...this.coachingByLayer },
      },
      judgeVerdicts: { refused: this.judgeRefused, passed: this.judgePassed },
      activationCount: this.activationCount,
      selfReturnCount: this.selfReturnCount,
      helpfulness: { up: this.thumbsUp, down: this.thumbsDown },
      ledgerOn: this.ledgerOn,
      reportsGenerated: { ...this.reports },
      cloudSendCount: this.cloudSendCount,
      integrityBreaches: this.integrityBreaches,
      voicePreservation: {
        samples: this.vpSamples.length,
        leaked: this.vpSamples.filter((s) => s.leaked).length,
        rate: this.voicePreservationSampleRate(),
      },
    };
  }

  /** Clear all recorded events, samples, and aggregates (for testing). */
  reset(): void {
    this.events.length = 0;
    this.vpSamples.length = 0;
    this.coachingPass = 0;
    this.coachingReject = 0;
    this.coachingByLayer = { deterministic: 0, judge: 0 };
    this.judgeRefused = 0;
    this.judgePassed = 0;
    this.activationCount = 0;
    this.selfReturnCount = 0;
    this.thumbsUp = 0;
    this.thumbsDown = 0;
    this.ledgerOn = false;
    this.reports = { report: 0, disclosure: 0 };
    this.cloudSendCount = 0;
    this.integrityBreaches = 0;
  }
}

// ---------------------------------------------------------------------------
// Production wiring helper
// ---------------------------------------------------------------------------

/**
 * Create a `TelemetrySink` wired to the live opt-out setting. `readEnabled`
 * reads `getSettings().telemetryEnabled` on every event so toggling the
 * setting takes effect immediately (ADR-001: opt-out instrumentation).
 *
 * Kept structural: the caller injects `readSettings` (production passes
 * `getSettings` from `shared/config`), so this helper itself avoids importing
 * `vscode` and stays headlessly importable.
 */
export function createTelemetrySink(
  readSettings: () => { telemetryEnabled: boolean },
): TelemetrySink {
  return new TelemetrySink({ readEnabled: () => readSettings().telemetryEnabled });
}
