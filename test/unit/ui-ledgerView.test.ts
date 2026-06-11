/**
 * Unit tests for `src/ui/ledgerView.ts` — LedgerTreeDataProvider.
 *
 * Tests the presentation layer: state, integrity, and event count
 * are rendered as tree items reflecting the ledger state.
 */

import { describe, it, expect } from 'vitest';
import { LedgerTreeDataProvider, type LedgerViewState } from '../../src/ui/ledgerView';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<LedgerViewState> = {}): LedgerViewState {
  return {
    isPaused: false,
    isDisabled: false,
    integrityStatus: { intact: true },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// LedgerTreeDataProvider
// ---------------------------------------------------------------------------

describe('LedgerTreeDataProvider', () => {
  it('shows "Active" state when ledger is recording', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    const children = provider.getChildren();

    const stateItem = children.find((c) => c.contextValue === 'state')!;
    expect(stateItem).toBeDefined();
    expect(stateItem.description).toBe('Active');
  });

  it('shows "Paused" state when ledger is paused', () => {
    const provider = new LedgerTreeDataProvider(makeState({ isPaused: true }));
    const children = provider.getChildren();

    const stateItem = children.find((c) => c.contextValue === 'state')!;
    expect(stateItem.description).toBe('Paused');
  });

  it('shows "Disabled" state when ledger is disabled', () => {
    const provider = new LedgerTreeDataProvider(makeState({ isDisabled: true }));
    const children = provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0].description).toBe('Disabled');
  });

  it('shows "Intact ✓" when integrity is intact', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    const children = provider.getChildren();

    const integrityItem = children.find((c) => c.contextValue === 'integrity')!;
    expect(integrityItem.description).toBe('Intact ✓');
  });

  it('shows broken-at event when integrity is compromised', () => {
    const provider = new LedgerTreeDataProvider(
      makeState({ integrityStatus: { intact: false, brokenAt: 42 } }),
    );
    const children = provider.getChildren();

    const integrityItem = children.find((c) => c.contextValue === 'integrity')!;
    expect(integrityItem.description).toBe('Broken at event 42');
  });

  it('sets accessibility information on all items', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    const children = provider.getChildren();

    for (const item of children) {
      expect(item.accessibilityInformation?.label).toBeTruthy();
      expect(item.accessibilityInformation?.role).toBe('treeitem');
    }
  });

  it('returns correct tree items from getTreeItem', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    const children = provider.getChildren();

    for (const child of children) {
      const treeItem = provider.getTreeItem(child);
      expect(treeItem).toBe(child);
    }
  });

  it('setState updates the view state', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    let children = provider.getChildren();
    expect(children.find((c) => c.contextValue === 'state')!.description).toBe('Active');

    provider.setState(makeState({ isPaused: true }));
    children = provider.getChildren();
    expect(children.find((c) => c.contextValue === 'state')!.description).toBe('Paused');
  });

  it('refresh fires onDidChangeTreeData', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    const events: unknown[] = [];
    provider.onDidChangeTreeData((e) => events.push(e));

    provider.refresh();
    expect(events).toHaveLength(1);
  });

  it('shows exactly 2 items when active (state + integrity)', () => {
    const provider = new LedgerTreeDataProvider(makeState());
    expect(provider.getChildren()).toHaveLength(2);
  });

  it('shows exactly 1 item when disabled (state only)', () => {
    const provider = new LedgerTreeDataProvider(makeState({ isDisabled: true }));
    expect(provider.getChildren()).toHaveLength(1);
  });
});
