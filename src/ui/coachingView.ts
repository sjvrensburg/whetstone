/**
 * `ui/coachingView.ts` — Coaching results TreeView (ADR-007, task 17).
 *
 * Presentation only: each observation maps to a top-level tree item showing
 * the question, expanding to the reflection as a child. The anchored span is
 * revealed in the editor when the user clicks the observation item.
 *
 * No business logic lives here — the view receives `StructuredCoaching` from
 * the command handler and renders it. A later webview swap would be a
 * view-layer change only.
 */

import * as vscode from 'vscode';
import type { Observation, StructuredCoaching } from '../shared/types';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

/**
 * Metadata stored with a coaching tree so the reveal-span command can
 * resolve an observation's anchor to an absolute document range.
 */
export interface CoachingDocumentRef {
  /** The URI of the document the coaching was run on. */
  uri: vscode.Uri;
  /** The base offset (start of the original selection) to add to each anchor. */
  anchorBase: number;
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

/** A top-level observation item: question label, reflection as child. */
export class ObservationItem extends vscode.TreeItem {
  constructor(
    public readonly observation: Observation,
    public readonly index: number,
  ) {
    super(observation.question, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = observation.kind.replace(/_/g, ' ');
    this.tooltip = observation.reflection;
    this.contextValue = 'coachingObservation';
    this.accessibilityInformation = {
      label: `Observation: ${observation.question}. ${observation.reflection}`,
      role: 'treeitem',
    };
  }
}

/** A child item showing the reflection text. */
export class ReflectionItem extends vscode.TreeItem {
  constructor(reflection: string) {
    super(reflection, vscode.TreeItemCollapsibleState.None);
    this.tooltip = reflection;
    this.accessibilityInformation = {
      label: `Reflection: ${reflection}`,
      role: 'treeitem',
    };
  }
}

/** Placeholder shown when no coaching results are available. */
export class EmptyCoachingItem extends vscode.TreeItem {
  constructor() {
    super('No coaching results yet', vscode.TreeItemCollapsibleState.None);
    this.description = 'Select text and run "Coach this selection"';
    this.accessibilityInformation = {
      label: 'No coaching results yet. Select text and run Coach this selection.',
      role: 'treeitem',
    };
  }
}

/** Union type for items in the coaching tree. */
export type CoachingTreeElement = ObservationItem | ReflectionItem | EmptyCoachingItem;

// ---------------------------------------------------------------------------
// Data provider
// ---------------------------------------------------------------------------

/**
 * TreeDataProvider for the coaching sidebar view. Holds the current coaching
 * result and renders observations as expandable items with reflection children.
 *
 * The reveal-span command reads the stored `documentRef` and observation index
 * to compute the absolute editor selection.
 */
export class CoachingTreeDataProvider implements vscode.TreeDataProvider<CoachingTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CoachingTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _coaching: StructuredCoaching | undefined;
  private _documentRef: CoachingDocumentRef | undefined;

  /** The current coaching result (if any). */
  get coaching(): StructuredCoaching | undefined {
    return this._coaching;
  }

  /** The document reference for anchor resolution. */
  get documentRef(): CoachingDocumentRef | undefined {
    return this._documentRef;
  }

  /**
   * Update the coaching result and refresh the tree.
   * @param coaching The new coaching result (observations).
   * @param docRef The document reference for anchor resolution.
   */
  refresh(coaching: StructuredCoaching, docRef: CoachingDocumentRef): void {
    this._coaching = coaching;
    this._documentRef = docRef;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Clear the coaching result and refresh. */
  clear(): void {
    this._coaching = undefined;
    this._documentRef = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: CoachingTreeElement): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CoachingTreeElement): CoachingTreeElement[] {
    // Top level: observations or empty placeholder
    if (!element) {
      if (!this._coaching || this._coaching.observations.length === 0) {
        return [new EmptyCoachingItem()];
      }
      return this._coaching.observations.map((obs, i) => new ObservationItem(obs, i));
    }

    // Child of observation: the reflection
    if (element instanceof ObservationItem) {
      return [new ReflectionItem(element.observation.reflection)];
    }

    // Reflection items and empty items have no children
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reveal span helper
// ---------------------------------------------------------------------------

/**
 * Resolve an observation's anchor to absolute document positions and reveal
 * the span in the editor. The anchor offsets are relative to the selection;
 * `anchorBase` converts them to absolute positions.
 *
 * @returns `true` if the span was revealed, `false` if no editor or no document ref.
 */
export function revealObservationSpan(
  observation: Observation,
  docRef: CoachingDocumentRef,
  editor: vscode.TextEditor,
): boolean {
  const startPos = editor.document.positionAt(docRef.anchorBase + observation.anchor.start);
  const endPos = editor.document.positionAt(docRef.anchorBase + observation.anchor.end);
  const selection = new vscode.Selection(startPos, endPos);
  editor.selection = selection;
  editor.revealRange(selection, /* InCenterIfOutsideViewport */ 2);
  return true;
}
