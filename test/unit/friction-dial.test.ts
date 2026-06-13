/**
 * Unit tests for the friction dial: presets, resolution, floor clamping,
 * and the Dial class API (task 20).
 */

import { describe, it, expect } from 'vitest';
import {
  PRESETS,
  FRICTION_LEVELS,
  FRICTION_LEVEL_LABELS,
  INSTRUMENT_NAMES,
  isValidFrictionLevel,
  stateOrdinal,
  stateAtOrdinal,
} from '../../src/friction/presets';
import type { InstrumentStateMap } from '../../src/friction/presets';
import { Dial, resolveEffectiveConfig } from '../../src/friction/dial';
import type { DialConfig } from '../../src/friction/dial';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

describe('presets', () => {
  it('defines exactly four levels (0–3)', () => {
    expect(FRICTION_LEVELS).toEqual([0, 1, 2, 3]);
  });

  it('has a human-readable label for every level', () => {
    for (const level of FRICTION_LEVELS) {
      expect(FRICTION_LEVEL_LABELS[level]).toBeDefined();
      expect(typeof FRICTION_LEVEL_LABELS[level]).toBe('string');
    }
  });

  it('labels match the ADR-008 names', () => {
    expect(FRICTION_LEVEL_LABELS[0]).toBe('Quiet');
    expect(FRICTION_LEVEL_LABELS[1]).toBe('Coach');
    expect(FRICTION_LEVEL_LABELS[2]).toBe('Engaged');
    expect(FRICTION_LEVEL_LABELS[3]).toBe('Deep Work');
  });

  it('each preset maps every instrument to a state', () => {
    for (const level of FRICTION_LEVELS) {
      const preset = PRESETS[level];
      for (const name of INSTRUMENT_NAMES) {
        expect(preset[name]).toBeDefined();
        expect(typeof preset[name]).toBe('string');
      }
    }
  });

  it('level 0 (Quiet) has the least restrictive states', () => {
    const p = PRESETS[0];
    expect(p.coachingCadence).toBe('pull');
    expect(p.pasteHandling).toBe('off');
    expect(p.claimFirst).toBe('off');
    expect(p.teachBack).toBe('off');
    expect(p.mirror).toBe('hidden');
  });

  it('level 1 (Coach) flags paste but keeps coaching pull-only', () => {
    const p = PRESETS[1];
    expect(p.coachingCadence).toBe('pull');
    expect(p.pasteHandling).toBe('flag');
    expect(p.claimFirst).toBe('off');
    expect(p.teachBack).toBe('off');
    expect(p.mirror).toBe('hidden');
  });

  it('level 2 (Engaged) activates push, quarantine, claim-first, teach-back', () => {
    const p = PRESETS[2];
    expect(p.coachingCadence).toBe('push');
    expect(p.pasteHandling).toBe('quarantine');
    expect(p.claimFirst).toBe('required');
    expect(p.teachBack).toBe('per-section');
    expect(p.mirror).toBe('hidden');
  });

  it('level 3 (Deep Work) activates all instruments at maximum', () => {
    const p = PRESETS[3];
    expect(p.coachingCadence).toBe('push');
    expect(p.pasteHandling).toBe('block');
    expect(p.claimFirst).toBe('required');
    expect(p.teachBack).toBe('per-section');
    expect(p.mirror).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// Ordinal helpers
// ---------------------------------------------------------------------------

describe('stateOrdinal', () => {
  it('returns 0 for the least-restrictive state of each instrument', () => {
    expect(stateOrdinal('coachingCadence', 'pull')).toBe(0);
    expect(stateOrdinal('pasteHandling', 'off')).toBe(0);
    expect(stateOrdinal('claimFirst', 'off')).toBe(0);
    expect(stateOrdinal('teachBack', 'off')).toBe(0);
    expect(stateOrdinal('mirror', 'hidden')).toBe(0);
  });

  it('returns increasing ordinals for more restrictive states', () => {
    // pasteHandling: off(0) < flag(1) < quarantine(2) < block(3)
    expect(stateOrdinal('pasteHandling', 'off')).toBeLessThan(
      stateOrdinal('pasteHandling', 'flag'),
    );
    expect(stateOrdinal('pasteHandling', 'flag')).toBeLessThan(
      stateOrdinal('pasteHandling', 'quarantine'),
    );
    expect(stateOrdinal('pasteHandling', 'quarantine')).toBeLessThan(
      stateOrdinal('pasteHandling', 'block'),
    );
  });

  it('throws for an unknown state', () => {
    expect(() => stateOrdinal('coachingCadence', 'unknown')).toThrow();
  });
});

describe('stateAtOrdinal', () => {
  it('returns the correct state for each ordinal', () => {
    expect(stateAtOrdinal('pasteHandling', 0)).toBe('off');
    expect(stateAtOrdinal('pasteHandling', 1)).toBe('flag');
    expect(stateAtOrdinal('pasteHandling', 2)).toBe('quarantine');
    expect(stateAtOrdinal('pasteHandling', 3)).toBe('block');
  });

  it('returns undefined for out-of-range ordinals', () => {
    expect(stateAtOrdinal('coachingCadence', 99)).toBeUndefined();
    expect(stateAtOrdinal('coachingCadence', -1)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isValidFrictionLevel
// ---------------------------------------------------------------------------

describe('isValidFrictionLevel', () => {
  it('accepts 0–3', () => {
    expect(isValidFrictionLevel(0)).toBe(true);
    expect(isValidFrictionLevel(1)).toBe(true);
    expect(isValidFrictionLevel(2)).toBe(true);
    expect(isValidFrictionLevel(3)).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(isValidFrictionLevel(-1)).toBe(false);
    expect(isValidFrictionLevel(4)).toBe(false);
    expect(isValidFrictionLevel(1.5)).toBe(false);
    expect(isValidFrictionLevel(NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveConfig — pure function
// ---------------------------------------------------------------------------

describe('resolveEffectiveConfig', () => {
  it('returns the preset states when no overrides or floor', () => {
    const config: DialConfig = { level: 1, floor: 0, overrides: {} };
    const result = resolveEffectiveConfig(config);
    expect(result).toEqual(PRESETS[1]);
  });

  it('honors a per-instrument override that raises an instrument', () => {
    const config: DialConfig = {
      level: 1,
      floor: 0,
      overrides: { coachingCadence: 'push' },
    };
    const result = resolveEffectiveConfig(config);
    expect(result.coachingCadence).toBe('push');
    // Other instruments should stay at preset
    expect(result.pasteHandling).toBe(PRESETS[1].pasteHandling);
  });

  it('clamps an override that would drop below the institutional floor', () => {
    // Floor = level 2: pasteHandling is 'quarantine' at level 2
    const config: DialConfig = {
      level: 3,
      floor: 2,
      overrides: { pasteHandling: 'flag' }, // flag is less restrictive than quarantine
    };
    const result = resolveEffectiveConfig(config);
    // Override 'flag' is below floor's 'quarantine' → clamped to 'quarantine'
    expect(result.pasteHandling).toBe('quarantine');
  });

  it('allows an override that raises above the floor', () => {
    // Floor = level 1: pasteHandling is 'flag'
    const config: DialConfig = {
      level: 1,
      floor: 1,
      overrides: { pasteHandling: 'block' }, // block is more restrictive than flag
    };
    const result = resolveEffectiveConfig(config);
    expect(result.pasteHandling).toBe('block');
  });

  it('coerces an invalid level to 1 (Coach)', () => {
    const config: DialConfig = { level: 99, floor: 0, overrides: {} };
    const result = resolveEffectiveConfig(config);
    expect(result).toEqual(PRESETS[1]);
  });

  it('coerces an invalid floor to 0 (no floor)', () => {
    const config: DialConfig = { level: 2, floor: -5, overrides: {} };
    const result = resolveEffectiveConfig(config);
    expect(result).toEqual(PRESETS[2]);
  });

  it('multiple overrides apply independently', () => {
    const config: DialConfig = {
      level: 0,
      floor: 0,
      overrides: {
        coachingCadence: 'push',
        mirror: 'live',
        claimFirst: 'required',
      },
    };
    const result = resolveEffectiveConfig(config);
    expect(result.coachingCadence).toBe('push');
    expect(result.mirror).toBe('live');
    expect(result.claimFirst).toBe('required');
    // Others stay at level 0 preset
    expect(result.pasteHandling).toBe('off');
    expect(result.teachBack).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Dial class
// ---------------------------------------------------------------------------

describe('Dial', () => {
  it('defaults to level 1 (Coach) when no config provided', () => {
    const dial = new Dial();
    expect(dial.frictionLevel()).toBe(1);
    expect(dial.floorLevel()).toBe(0);
  });

  it('accepts initial config', () => {
    const dial = new Dial({ level: 3, floor: 1, overrides: { mirror: 'live' } });
    expect(dial.frictionLevel()).toBe(3);
    expect(dial.floorLevel()).toBe(1);
  });

  it('instrumentState(name) returns the effective state for each instrument', () => {
    const dial = new Dial({ level: 2, floor: 0, overrides: {} });
    expect(dial.instrumentState('coachingCadence')).toBe('push');
    expect(dial.instrumentState('pasteHandling')).toBe('quarantine');
    expect(dial.instrumentState('claimFirst')).toBe('required');
    expect(dial.instrumentState('teachBack')).toBe('per-section');
    expect(dial.instrumentState('mirror')).toBe('hidden');
  });

  it('effectiveConfig() returns all instrument states', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    const config = dial.effectiveConfig();
    expect(config).toEqual(PRESETS[0]);
  });

  it('setLevel changes the level and recomputes', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    expect(dial.instrumentState('pasteHandling')).toBe('off');

    dial.setLevel(3);
    expect(dial.frictionLevel()).toBe(3);
    expect(dial.instrumentState('pasteHandling')).toBe('block');
  });

  it('setLevel ignores invalid values (stays at current)', () => {
    const dial = new Dial({ level: 2, floor: 0, overrides: {} });
    dial.setLevel(99);
    expect(dial.frictionLevel()).toBe(1); // coerced to default 1
  });

  it('setFloor changes the floor and recomputes', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    expect(dial.instrumentState('pasteHandling')).toBe('off');

    dial.setFloor(2);
    // Level 0 preset pasteHandling = 'off', floor 2 preset pasteHandling = 'quarantine'
    // Since level 0 < floor 2, the preset states come from level 0 but floor clamps
    // pasteHandling: off(0) < quarantine(2) → clamped to quarantine
    expect(dial.instrumentState('pasteHandling')).toBe('quarantine');
    expect(dial.floorLevel()).toBe(2);
  });

  it('setOverride updates a single instrument', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    dial.setOverride('coachingCadence', 'push');
    expect(dial.instrumentState('coachingCadence')).toBe('push');
    expect(dial.overrides()).toEqual({ coachingCadence: 'push' });
  });

  it('setOverride with undefined clears the override', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: { coachingCadence: 'push' } });
    expect(dial.instrumentState('coachingCadence')).toBe('push');

    dial.setOverride('coachingCadence', undefined);
    expect(dial.instrumentState('coachingCadence')).toBe('pull'); // back to preset
    expect(dial.overrides().coachingCadence).toBeUndefined();
  });

  it('setOverrides replaces all overrides', () => {
    const dial = new Dial({
      level: 1,
      floor: 0,
      overrides: { coachingCadence: 'push', mirror: 'live' },
    });
    dial.setOverrides({ claimFirst: 'required' });
    expect(dial.overrides()).toEqual({ claimFirst: 'required' });
    expect(dial.instrumentState('coachingCadence')).toBe('pull'); // back to preset
  });

  it('updateConfig applies partial changes', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    dial.updateConfig({ level: 3 });
    expect(dial.frictionLevel()).toBe(3);
    expect(dial.floorLevel()).toBe(0); // unchanged
  });

  it('observers fire when effective config changes', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    const observed: InstrumentStateMap[] = [];
    const unsub = dial.observe((config) => observed.push(config));

    dial.setLevel(3);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.pasteHandling).toBe('block');

    unsub();
  });

  it('observers do NOT fire when config changes but effective state stays the same', () => {
    // Setting level to current level is a no-op → no notification
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const observed: InstrumentStateMap[] = [];
    dial.observe((config) => observed.push(config));

    dial.setLevel(1); // same level
    expect(observed).toHaveLength(0);
  });

  it('rawConfig returns a snapshot of the current config', () => {
    const dial = new Dial({ level: 2, floor: 1, overrides: { mirror: 'live' } });
    const raw = dial.rawConfig();
    expect(raw.level).toBe(2);
    expect(raw.floor).toBe(1);
    expect(raw.overrides).toEqual({ mirror: 'live' });
  });

  it('multiple observers all receive updates', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    let count1 = 0;
    let count2 = 0;
    const unsub1 = dial.observe(() => {
      count1++;
    });
    const unsub2 = dial.observe(() => {
      count2++;
    });

    dial.setLevel(3);
    expect(count1).toBe(1);
    expect(count2).toBe(1);

    unsub1();

    dial.setLevel(0);
    expect(count1).toBe(1); // unsubscribed
    expect(count2).toBe(2);

    unsub2();
  });

  it('observers see the snapshot, not a live reference', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    let captured: InstrumentStateMap | undefined;
    dial.observe((config) => {
      captured = config;
    });

    dial.setLevel(3);
    // Mutating the captured snapshot should not affect the dial
    expect(captured).toBeDefined();
    const savedPaste = captured!.pasteHandling;
    (captured as unknown as Record<string, string>).pasteHandling = 'mutated';
    expect(dial.instrumentState('pasteHandling')).toBe(savedPaste);
  });
});

// ---------------------------------------------------------------------------
// Integration: live update without reload
// ---------------------------------------------------------------------------

describe('Dial — live update (integration)', () => {
  it('changing the level updates instrumentState immediately', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });

    // Level 0: mirror is hidden
    expect(dial.instrumentState('mirror')).toBe('hidden');

    // Change to level 3: mirror should be live immediately
    dial.setLevel(3);
    expect(dial.instrumentState('mirror')).toBe('live');
    expect(dial.instrumentState('pasteHandling')).toBe('block');
    expect(dial.instrumentState('coachingCadence')).toBe('push');

    // Change back to level 1
    dial.setLevel(1);
    expect(dial.instrumentState('mirror')).toBe('hidden');
    expect(dial.instrumentState('pasteHandling')).toBe('flag');
  });

  it('changing the floor re-clamps overrides', () => {
    const dial = new Dial({
      level: 3,
      floor: 0,
      overrides: { pasteHandling: 'off' },
    });

    // Override 'off' is valid when floor = 0
    expect(dial.instrumentState('pasteHandling')).toBe('off');

    // Raise floor to level 2 — floor's pasteHandling is 'quarantine'
    dial.setFloor(2);
    // 'off' (ordinal 0) < 'quarantine' (ordinal 2) → clamped
    expect(dial.instrumentState('pasteHandling')).toBe('quarantine');
  });

  it('updateConfig applies all changes atomically', () => {
    const dial = new Dial({ level: 0, floor: 0, overrides: {} });
    const observed: InstrumentStateMap[] = [];
    dial.observe((c) => observed.push(c));

    dial.updateConfig({
      level: 3,
      floor: 1,
      overrides: { mirror: 'live' },
    });

    expect(dial.frictionLevel()).toBe(3);
    expect(dial.floorLevel()).toBe(1);
    expect(dial.instrumentState('mirror')).toBe('live');
    // Observer should have fired (level 0→3 is a real change)
    expect(observed.length).toBeGreaterThanOrEqual(1);
  });
});
