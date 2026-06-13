import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureRecorder, FixtureReplayer } from '../../test/support/fixtures';

const FIXED_NOW = '2026-06-10T00:00:00.000Z';

// Stand-in for a CoachingProvider.coach() response (no concrete provider yet).
const COACH_RESPONSE = {
  observations: [
    { anchor: { start: 0, end: 12 }, kind: 'implicit_claim', reflection: 'r', question: 'why?' },
  ],
};
const JUDGE_RESPONSE = { refused: false, reason: 'no paste-ready prose' };

describe('record/replay fixture mechanism', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whetstone-fixtures-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a live response exactly once and snapshots it', async () => {
    const recorder = new FixtureRecorder({ provider: 'anthropic', now: () => FIXED_NOW });
    let liveCalls = 0;
    const live = async (req: { selectionText: string }) => {
      liveCalls += 1;
      expect(req.selectionText).toBe('hello');
      return COACH_RESPONSE;
    };

    const response = await recorder.record('coach', { selectionText: 'hello' }, live);

    expect(liveCalls).toBe(1);
    expect(response).toEqual(COACH_RESPONSE);
    const fixture = recorder.toFixture();
    expect(fixture.provider).toBe('anthropic');
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({ method: 'coach', recordedAt: FIXED_NOW });
  });

  it('omits the provider field when none is supplied', async () => {
    const recorder = new FixtureRecorder({ now: () => FIXED_NOW });
    await recorder.record('judge', JUDGE_RESPONSE, async () => JUDGE_RESPONSE);
    expect(recorder.toFixture().provider).toBeUndefined();
  });

  it('replays a recorded fixture deterministically without a network call', async () => {
    const recorder = new FixtureRecorder({ now: () => FIXED_NOW });
    let networkHits = 0;
    await recorder.record('coach', { selectionText: 'hello' }, async () => {
      networkHits += 1;
      return COACH_RESPONSE;
    });

    const file = join(dir, 'nested', 'coach.fixture.json');
    recorder.save(file);
    expect(existsSync(file)).toBe(true);

    // Fresh replayer from disk: no live function in sight, so no network is possible.
    const replayer = FixtureReplayer.fromFile(file);
    const first = replayer.replay('coach');
    const second = replayer.replay('coach');

    expect(first).toEqual(COACH_RESPONSE);
    expect(second).toEqual(first); // deterministic / repeatable
    expect(networkHits).toBe(1); // only the original record hit the "network"
  });

  it('builds a replayer directly from an in-memory fixture', () => {
    const replayer = FixtureReplayer.fromFixture({
      version: 1,
      calls: [{ method: 'judge', request: {}, response: JUDGE_RESPONSE, recordedAt: FIXED_NOW }],
    });
    expect(replayer.replay('judge')).toEqual(JUDGE_RESPONSE);
    expect(replayer.responsesFor('judge')).toHaveLength(1);
    expect(replayer.responsesFor('coach')).toHaveLength(0);
  });

  it('throws on an unrecorded method or out-of-range index', () => {
    const replayer = FixtureReplayer.fromFixture({
      version: 1,
      calls: [{ method: 'coach', request: {}, response: COACH_RESPONSE, recordedAt: FIXED_NOW }],
    });
    expect(() => replayer.replay('missing')).toThrow(/No recorded fixture/);
    expect(() => replayer.replay('coach', 5)).toThrow(/out of range/);
  });

  it('createReplayCall returns recorded responses in order then clamps at the last', async () => {
    const replayer = FixtureReplayer.fromFixture({
      version: 1,
      calls: [
        { method: 'coach', request: {}, response: { observations: [] }, recordedAt: FIXED_NOW },
        { method: 'coach', request: {}, response: COACH_RESPONSE, recordedAt: FIXED_NOW },
      ],
    });
    const call = replayer.createReplayCall<unknown, typeof COACH_RESPONSE>('coach');
    expect(await call({})).toEqual({ observations: [] });
    expect(await call({})).toEqual(COACH_RESPONSE);
    expect(await call({})).toEqual(COACH_RESPONSE); // clamps at last
  });

  it('createReplayCall rejects for an unrecorded method', async () => {
    const replayer = FixtureReplayer.fromFixture({ version: 1, calls: [] });
    const call = replayer.createReplayCall('coach');
    await expect(call(undefined)).rejects.toThrow(/No recorded fixture/);
  });
});
