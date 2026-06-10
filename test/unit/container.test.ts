import { describe, it, expect } from 'vitest';
import { createContainer, MODULE_SLOTS } from '../../src/container';

describe('createContainer (dependency-wiring seam)', () => {
  it('returns a container with exactly the expected module slots', () => {
    const container = createContainer();
    expect(Object.keys(container).sort()).toEqual([...MODULE_SLOTS].sort());
  });

  it('exposes every Component Overview module as a slot', () => {
    const container = createContainer();
    for (const name of MODULE_SLOTS) {
      expect(name in container).toBe(true);
      // Slots are empty in the scaffold; owning tasks populate them.
      expect(container[name]).toBeUndefined();
    }
  });

  it('accepts a host context through the seam without using it yet', () => {
    const pushed: unknown[] = [];
    const fakeContext = {
      subscriptions: { push: (...items: { dispose(): unknown }[]) => pushed.push(...items) },
    };
    const container = createContainer(fakeContext);
    expect(Object.keys(container)).toHaveLength(MODULE_SLOTS.length);
    // The scaffold does not register anything via context yet.
    expect(pushed).toHaveLength(0);
  });

  it('includes all ten domain modules from the Component Overview', () => {
    expect(MODULE_SLOTS).toEqual([
      'shared',
      'providers',
      'coaching',
      'guard',
      'grammar',
      'ledger',
      'brief',
      'consent',
      'ui',
      'telemetry',
    ]);
  });
});
