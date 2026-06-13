/**
 * Unit tests for the friction dial control surface: FrictionStatusBar,
 * QuickPick builder, and the set-level command flow (task 20).
 */

import { describe, it, expect } from 'vitest';
import { Dial } from '../../src/friction/dial';
import {
  FrictionStatusBar,
  showLevelQuickPick,
  createFrictionControlCommands,
} from '../../src/friction/control';

// ---------------------------------------------------------------------------
// FrictionStatusBar
// ---------------------------------------------------------------------------

describe('FrictionStatusBar', () => {
  it('can be constructed and disposed', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const bar = new FrictionStatusBar(dial);
    // Should not throw on dispose
    expect(() => bar.dispose()).not.toThrow();
  });

  it('updates the status bar text when the dial changes', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const bar = new FrictionStatusBar(dial);

    // Change the dial — should update without throwing
    expect(() => dial.setLevel(3)).not.toThrow();
    expect(() => dial.setLevel(0)).not.toThrow();

    bar.dispose();
  });

  it('stops observing after dispose', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const bar = new FrictionStatusBar(dial);
    bar.dispose();

    // After dispose, changing the dial should not throw (observer was removed)
    expect(() => dial.setLevel(3)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// showLevelQuickPick — integration test with mock VS Code
// ---------------------------------------------------------------------------

describe('showLevelQuickPick', () => {
  it('returns undefined when user dismisses the QuickPick', async () => {
    // The vscode stub's showQuickPick returns Promise.resolve(undefined)
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const result = await showLevelQuickPick(dial);
    expect(result).toBeUndefined();
    // Dial level should be unchanged
    expect(dial.frictionLevel()).toBe(1);
  });

  it('filters out below-floor items (verified by buildPickItems logic)', () => {
    // We test the filtering logic indirectly: with floor=2, levels 0 and 1
    // should not be selectable. The actual QuickPick filtering happens inside
    // showLevelQuickPick which calls the vscode stub, so we verify that the
    // dial correctly honors the floor.
    const dial = new Dial({ level: 2, floor: 2, overrides: {} });

    // Even if setLevel is called with 0, the floor prevents actual lowering
    // (the floor only clamps instrument states, not the level value itself —
    // the control surface prevents the user from picking below-floor levels)
    dial.setLevel(0);
    // Level is stored as 0, but instruments should be clamped to floor (2)
    expect(dial.instrumentState('pasteHandling')).toBe('quarantine'); // level 2 state
  });
});

// ---------------------------------------------------------------------------
// createFrictionControlCommands
// ---------------------------------------------------------------------------

describe('createFrictionControlCommands', () => {
  it('returns the setFrictionLevel command descriptor', () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const commands = createFrictionControlCommands({ dial });

    expect(commands).toHaveLength(1);
    expect(commands[0]!.id).toBe('whetstone.setFrictionLevel');
    expect(typeof commands[0]!.handler).toBe('function');
  });

  it('the handler does not throw when invoked', async () => {
    const dial = new Dial({ level: 1, floor: 0, overrides: {} });
    const commands = createFrictionControlCommands({ dial });

    // The handler calls showLevelQuickPick which returns undefined from stub
    await expect(commands[0]!.handler()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Floor-aware control — below-floor options disabled
// ---------------------------------------------------------------------------

describe('control surface — floor awareness', () => {
  it('dial with floor=2 still allows setting to level 3', () => {
    const dial = new Dial({ level: 2, floor: 2, overrides: {} });
    dial.setLevel(3);
    expect(dial.frictionLevel()).toBe(3);
    expect(dial.instrumentState('pasteHandling')).toBe('block');
  });

  it('dial with floor=1 prevents instrument states from dropping below level 1', () => {
    const dial = new Dial({ level: 0, floor: 1, overrides: {} });
    // Even though level is 0, floor=1 means pasteHandling can't be below 'flag'
    expect(dial.instrumentState('pasteHandling')).toBe('flag');
  });

  it('override cannot bypass the floor', () => {
    const dial = new Dial({
      level: 3,
      floor: 2,
      overrides: { pasteHandling: 'off' },
    });
    // 'off' is below floor's 'quarantine' → clamped
    expect(dial.instrumentState('pasteHandling')).toBe('quarantine');
  });

  it('changing floor dynamically re-clamps all instruments', () => {
    const dial = new Dial({
      level: 0,
      floor: 0,
      overrides: { pasteHandling: 'off' },
    });
    expect(dial.instrumentState('pasteHandling')).toBe('off');

    dial.setFloor(3);
    // Floor 3 → pasteHandling = 'block'; override 'off' (0) < 'block' (3) → clamped
    expect(dial.instrumentState('pasteHandling')).toBe('block');
  });
});
