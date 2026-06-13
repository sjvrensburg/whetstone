import { describe, it, expect } from 'vitest';
import { createCommands, COMMAND_IDS } from '../../src/commands';
import { createContainer } from '../../src/container';

describe('createCommands (no-op command surface)', () => {
  it('builds a descriptor for every contributed command id', () => {
    const descriptors = createCommands(createContainer());
    expect(descriptors.map((d) => d.id)).toEqual([...COMMAND_IDS]);
  });

  it('registers handlers that are no-ops when container.ui is not set', () => {
    const descriptors = createCommands(createContainer());
    for (const descriptor of descriptors) {
      expect(typeof descriptor.handler).toBe('function');
      expect(descriptor.handler('arg')).toBeUndefined();
    }
  });

  it('exposes the canonical command ids from the UI module', () => {
    expect(COMMAND_IDS).toEqual([
      'whetstone.coachSelection',
      'whetstone.revealSpan',
      'whetstone.toggleLedger',
      'whetstone.openTransparencyReport',
      'whetstone.exportDisclosure',
      'whetstone.editBrief',
    ]);
  });
});
