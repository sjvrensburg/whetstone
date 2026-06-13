import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BurstTracker } from '../src/editor/typingBurst';
import type { ProcessEventInput } from '../src/service/types';

describe('BurstTracker', () => {
  let events: ProcessEventInput[];

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
  });
  afterEach(() => vi.useRealTimers());

  const tracker = () => new BurstTracker((e) => events.push(e), 2000, 200);

  it('flushes a typing_burst after the idle window', () => {
    const t = tracker();
    t.record(5, 0, 5);
    t.record(3, 5, 8);
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(2000);
    expect(events).toEqual([{ type: 'typing_burst', size: 8, location: { from: 0, to: 8 } }]);
  });

  it('keeps extending the idle window while typing continues', () => {
    const t = tracker();
    t.record(1, 0, 1);
    vi.advanceTimersByTime(1500);
    t.record(1, 1, 2);
    vi.advanceTimersByTime(1500);
    expect(events).toHaveLength(0); // never 2s idle yet
    vi.advanceTimersByTime(500);
    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(2);
  });

  it('flushes immediately at the max-chars cap', () => {
    const t = tracker();
    t.record(150, 0, 150);
    t.record(60, 150, 210);
    expect(events).toHaveLength(1);
    expect(events[0].size).toBe(210);
  });

  it('manual flush emits the pending burst and resets; empty flush is a no-op', () => {
    const t = tracker();
    t.flush();
    expect(events).toHaveLength(0);

    t.record(4, 10, 14);
    t.flush();
    expect(events).toEqual([{ type: 'typing_burst', size: 4, location: { from: 10, to: 14 } }]);

    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(1); // nothing pending after reset
  });

  it('ignores non-positive sizes', () => {
    const t = tracker();
    t.record(0, 0, 0);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(0);
  });
});
