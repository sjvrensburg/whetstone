/**
 * Generic provider-call record/replay fixture mechanism.
 *
 * Defined generically against the `CoachingProvider` call shape (an async
 * `(request) => Promise<response>` keyed by a method name such as `coach` or
 * `judge`) — there is no concrete provider yet. Two halves:
 *
 *  - `FixtureRecorder` wraps a live call, captures `(method, request, response)`
 *    to a fixture file (the `record` path used by task 19's live/record mode).
 *  - `FixtureReplayer` returns recorded responses deterministically with no
 *    network call, so unit tests (tasks 09, 11) and the red-team gate (task 19)
 *    run offline and free.
 *
 * This is test-support code (it touches the filesystem); it is not part of the
 * shipped extension bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A single recorded provider call. Prose-free metadata only is the caller's concern. */
export interface RecordedCall {
  /** The provider method, e.g. `"coach"` or `"judge"`. */
  method: string;
  /** The request passed to the live call. */
  request: unknown;
  /** The response the live call returned. */
  response: unknown;
  /** ISO 8601 timestamp of when the response was recorded. */
  recordedAt: string;
}

/** The on-disk fixture format. */
export interface ProviderFixture {
  version: 1;
  /** Optional provider id (e.g. `"anthropic"`) for human traceability. */
  provider?: string;
  calls: RecordedCall[];
}

/** The generic provider call shape: a single-argument async function. */
export type ProviderCall<Req, Res> = (request: Req) => Promise<Res>;

export interface RecorderOptions {
  provider?: string;
  /** Clock injection so recordings are reproducible in tests. */
  now?: () => string;
}

/**
 * Records live provider responses into a replayable fixture. Each `record` call
 * invokes the live function exactly once and appends the result.
 */
export class FixtureRecorder {
  private readonly calls: RecordedCall[] = [];
  private readonly now: () => string;
  private readonly provider?: string;

  constructor(options: RecorderOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.provider = options.provider;
  }

  /** Invoke `live` once, snapshot the response, and return it unchanged. */
  async record<Req, Res>(method: string, request: Req, live: ProviderCall<Req, Res>): Promise<Res> {
    const response = await live(request);
    this.calls.push({ method, request, response, recordedAt: this.now() });
    return response;
  }

  /** The accumulated fixture, ready to replay or persist. */
  toFixture(): ProviderFixture {
    const fixture: ProviderFixture = { version: 1, calls: [...this.calls] };
    if (this.provider !== undefined) {
      fixture.provider = this.provider;
    }
    return fixture;
  }

  /** Persist the fixture to disk, creating parent directories as needed. */
  save(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(this.toFixture(), null, 2)}\n`, 'utf8');
  }
}

/**
 * Replays recorded provider responses deterministically — no network, no live
 * call. Responses for a given method are returned in recorded order; once the
 * recorded responses are exhausted the last one repeats, so a method stubbed
 * from a single recording answers every invocation identically.
 */
export class FixtureReplayer {
  private readonly byMethod = new Map<string, RecordedCall[]>();
  private readonly cursors = new Map<string, number>();

  constructor(fixture: ProviderFixture) {
    for (const call of fixture.calls) {
      const existing = this.byMethod.get(call.method) ?? [];
      existing.push(call);
      this.byMethod.set(call.method, existing);
    }
  }

  static fromFixture(fixture: ProviderFixture): FixtureReplayer {
    return new FixtureReplayer(fixture);
  }

  static fromFile(filePath: string): FixtureReplayer {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ProviderFixture;
    return new FixtureReplayer(parsed);
  }

  /** All recorded calls for a method (empty array if none). */
  responsesFor(method: string): RecordedCall[] {
    return this.byMethod.get(method) ?? [];
  }

  /**
   * The recorded response for `method` at `index` (default the first). Pure and
   * repeatable: the same `(method, index)` always yields the same value.
   */
  replay<Res>(method: string, index = 0): Res {
    const calls = this.byMethod.get(method);
    if (!calls || calls.length === 0) {
      throw new Error(`No recorded fixture for method "${method}"`);
    }
    if (index < 0 || index >= calls.length) {
      throw new Error(
        `Fixture index ${index} out of range for method "${method}" (${calls.length} recorded)`,
      );
    }
    return calls[index].response as Res;
  }

  /**
   * A drop-in replacement for a live provider method: an async function that
   * returns the next recorded response in order, clamping at the last. This is
   * how tasks 09/11 stub `coach`/`judge` offline.
   */
  createReplayCall<Req, Res>(method: string): ProviderCall<Req, Res> {
    return () => {
      const calls = this.byMethod.get(method);
      if (!calls || calls.length === 0) {
        return Promise.reject(new Error(`No recorded fixture for method "${method}"`));
      }
      const cursor = this.cursors.get(method) ?? 0;
      const next = Math.min(cursor, calls.length - 1);
      this.cursors.set(method, cursor + 1);
      return Promise.resolve(calls[next].response as Res);
    };
  }
}
