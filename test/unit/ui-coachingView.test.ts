/**
 * Unit tests for `src/ui/coachingView.ts` — CoachingTreeDataProvider
 * and revealObservationSpan.
 *
 * Tests the presentation layer in isolation: observations map to tree items,
 * reflections appear as children, reveal resolves anchors to editor ranges.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
  CoachingTreeDataProvider,
  ObservationItem,
  ReflectionItem,
  EmptyCoachingItem,
  revealObservationSpan,
  type CoachingDocumentRef,
} from '../../src/ui/coachingView';
import type { Observation, StructuredCoaching } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    anchor: { start: 0, end: 10 },
    kind: 'implicit_claim',
    reflection: 'This sentence buries the main claim.',
    question: 'What is the core argument you want the reader to take away?',
    ...overrides,
  };
}

function makeCoaching(observations: Observation[] = [makeObservation()]): StructuredCoaching {
  return { observations };
}

function makeDocRef(overrides: Partial<CoachingDocumentRef> = {}): CoachingDocumentRef {
  return {
    uri: vscode.Uri.file('/test/document.md'),
    anchorBase: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CoachingTreeDataProvider
// ---------------------------------------------------------------------------

describe('CoachingTreeDataProvider', () => {
  it('returns an empty placeholder when no coaching results exist', () => {
    const provider = new CoachingTreeDataProvider();
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyCoachingItem);
    expect(children[0].label).toBe('No coaching results yet');
  });

  it('maps observations to top-level items with question labels', () => {
    const provider = new CoachingTreeDataProvider();
    const obs1 = makeObservation({ question: 'Q1?', kind: 'implicit_claim' });
    const obs2 = makeObservation({ question: 'Q2?', kind: 'logic_fork' });
    provider.refresh(makeCoaching([obs1, obs2]), makeDocRef());

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(ObservationItem);
    expect(children[0].label).toBe('Q1?');
    expect(children[0].description).toBe('implicit claim');
    expect(children[1].label).toBe('Q2?');
    expect(children[1].description).toBe('logic fork');
  });

  it('expands observation to show reflection as child', () => {
    const provider = new CoachingTreeDataProvider();
    const obs = makeObservation({ reflection: 'Structure remark', question: 'Q?' });
    provider.refresh(makeCoaching([obs]), makeDocRef());

    const top = provider.getChildren();
    expect(top).toHaveLength(1);
    const obsItem = top[0] as ObservationItem;

    // Observation should be collapsible
    const treeItem = provider.getTreeItem(obsItem);
    expect(treeItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

    // Children should be the reflection
    const children = provider.getChildren(obsItem);
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ReflectionItem);
    expect(children[0].label).toBe('Structure remark');
  });

  it('sets tooltip on observation to the reflection text', () => {
    const provider = new CoachingTreeDataProvider();
    const obs = makeObservation({ reflection: 'Tooltip text', question: 'Q?' });
    provider.refresh(makeCoaching([obs]), makeDocRef());

    const item = provider.getChildren()[0] as ObservationItem;
    const treeItem = provider.getTreeItem(item);
    expect(treeItem.tooltip).toBe('Tooltip text');
  });

  it('sets contextValue on observation items for context menus', () => {
    const provider = new CoachingTreeDataProvider();
    provider.refresh(makeCoaching([makeObservation()]), makeDocRef());

    const item = provider.getChildren()[0] as ObservationItem;
    expect(item.contextValue).toBe('coachingObservation');
  });

  it('sets accessibility information on all items', () => {
    const provider = new CoachingTreeDataProvider();

    // Empty state
    let children = provider.getChildren();
    expect(children[0].accessibilityInformation?.label).toBeTruthy();
    expect(children[0].accessibilityInformation?.role).toBe('treeitem');

    // With observations
    const obs = makeObservation({ question: 'Q?', reflection: 'R' });
    provider.refresh(makeCoaching([obs]), makeDocRef());

    children = provider.getChildren();
    const obsItem = children[0] as ObservationItem;
    expect(obsItem.accessibilityInformation?.label).toContain('Q?');
    expect(obsItem.accessibilityInformation?.role).toBe('treeitem');

    const reflection = provider.getChildren(obsItem)[0] as ReflectionItem;
    expect(reflection.accessibilityInformation?.label).toContain('R');
  });

  it('returns no children for reflection items', () => {
    const provider = new CoachingTreeDataProvider();
    provider.refresh(makeCoaching([makeObservation()]), makeDocRef());

    const obsItem = provider.getChildren()[0] as ObservationItem;
    const reflection = provider.getChildren(obsItem)[0] as ReflectionItem;
    expect(provider.getChildren(reflection)).toHaveLength(0);
  });

  it('returns no children for empty items', () => {
    const provider = new CoachingTreeDataProvider();
    const empty = provider.getChildren()[0] as EmptyCoachingItem;
    expect(provider.getChildren(empty)).toHaveLength(0);
  });

  it('exposes the current coaching result', () => {
    const provider = new CoachingTreeDataProvider();
    expect(provider.coaching).toBeUndefined();

    const coaching = makeCoaching([makeObservation()]);
    provider.refresh(coaching, makeDocRef());
    expect(provider.coaching).toBe(coaching);
  });

  it('exposes the current document reference', () => {
    const provider = new CoachingTreeDataProvider();
    expect(provider.documentRef).toBeUndefined();

    const ref = makeDocRef({ anchorBase: 42 });
    provider.refresh(makeCoaching(), ref);
    expect(provider.documentRef?.anchorBase).toBe(42);
  });

  it('clear() resets coaching and document ref', () => {
    const provider = new CoachingTreeDataProvider();
    provider.refresh(makeCoaching(), makeDocRef());
    expect(provider.coaching).toBeDefined();
    expect(provider.documentRef).toBeDefined();

    provider.clear();
    expect(provider.coaching).toBeUndefined();
    expect(provider.documentRef).toBeUndefined();
    expect(provider.getChildren()[0]).toBeInstanceOf(EmptyCoachingItem);
  });

  it('stores the observation index on each item', () => {
    const provider = new CoachingTreeDataProvider();
    const obs = [makeObservation(), makeObservation(), makeObservation()];
    provider.refresh(makeCoaching(obs), makeDocRef());

    const items = provider.getChildren() as ObservationItem[];
    expect(items[0].index).toBe(0);
    expect(items[1].index).toBe(1);
    expect(items[2].index).toBe(2);
  });

  it('fires onDidChangeTreeData on refresh and clear', () => {
    const provider = new CoachingTreeDataProvider();
    const events: unknown[] = [];
    provider.onDidChangeTreeData((e) => events.push(e));

    provider.refresh(makeCoaching(), makeDocRef());
    expect(events).toHaveLength(1);

    provider.clear();
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// revealObservationSpan
// ---------------------------------------------------------------------------

describe('revealObservationSpan', () => {
  it('resolves anchor to absolute positions and sets selection', () => {
    // Long enough document for offset 100+15=115
    const text = 'A'.repeat(200);
    // @ts-expect-error — stub TextDocument constructor (vitest aliases vscode to stub)
    const doc = new vscode.TextDocument(text);
    let currentSelection = new vscode.Selection(0, 0, 0, 0);
    const editor = {
      document: doc,
      get selection() {
        return currentSelection;
      },
      set selection(s: vscode.Selection) {
        currentSelection = s;
      },
      selections: [] as vscode.Selection[],
      revealRange: () => undefined,
    } as unknown as vscode.TextEditor;

    const obs = makeObservation({ anchor: { start: 5, end: 15 } });
    const docRef = makeDocRef({ anchorBase: 100 });

    const result = revealObservationSpan(obs, docRef, editor);
    expect(result).toBe(true);
    // Verify selection was set (absolute offsets = 100+5=105, 100+15=115)
    expect(currentSelection.anchor.character).toBe(105);
    expect(currentSelection.active.character).toBe(115);
  });

  it('handles zero-based anchor offsets', () => {
    // @ts-expect-error — stub TextDocument constructor (vitest aliases vscode to stub)
    const doc = new vscode.TextDocument('Short text here.');
    let currentSelection = new vscode.Selection(0, 0, 0, 0);
    const editor = {
      document: doc,
      get selection() {
        return currentSelection;
      },
      set selection(s: vscode.Selection) {
        currentSelection = s;
      },
      selections: [] as vscode.Selection[],
      revealRange: () => undefined,
    } as unknown as vscode.TextEditor;

    const obs = makeObservation({ anchor: { start: 0, end: 5 } });
    const docRef = makeDocRef({ anchorBase: 0 });

    revealObservationSpan(obs, docRef, editor);
    expect(currentSelection.anchor.line).toBe(0);
    expect(currentSelection.anchor.character).toBe(0);
    expect(currentSelection.active.character).toBe(5);
  });
});
