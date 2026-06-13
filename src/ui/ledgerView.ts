/**
 * `ui/ledgerView.ts` — Ledger status TreeView (ADR-007, task 17).
 *
 * Presentation only: shows the ledger state (active/paused/disabled), event
 * count, and integrity status as tree items. Pause/resume/disable commands
 * operate on the `LedgerImpl` through the injected seam; this view only reads.
 *
 * No business logic — a later webview swap would be a view-layer change only.
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// DI seam — the ledger surface the view reads from
// ---------------------------------------------------------------------------

/** The read-only ledger surface the view needs. */
export interface LedgerViewState {
  /** Whether the ledger is paused. */
  readonly isPaused: boolean;
  /** Whether the ledger is permanently disabled. */
  readonly isDisabled: boolean;
  /** The integrity status from the last verify. */
  readonly integrityStatus: { intact: boolean; brokenAt?: number };
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

/** A single row in the ledger status tree. */
export class LedgerStatusItem extends vscode.TreeItem {
  constructor(
    public readonly key: string,
    label: string,
    description: string,
    icon: vscode.ThemeIcon | undefined,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = key;
    if (icon) {
      this.iconPath = icon;
    }
    this.accessibilityInformation = {
      label: `${label}: ${description}`,
      role: 'treeitem',
    };
  }
}

// ---------------------------------------------------------------------------
// Data provider
// ---------------------------------------------------------------------------

/**
 * TreeDataProvider for the ledger sidebar view. Reads ledger state and
 * renders it as a flat list of status items.
 */
export class LedgerTreeDataProvider implements vscode.TreeDataProvider<LedgerStatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LedgerStatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private _state: LedgerViewState) {}

  /** Update the ledger state reference (e.g. after pause/resume). */
  setState(state: LedgerViewState): void {
    this._state = state;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Refresh the view (fire change event). */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: LedgerStatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(): LedgerStatusItem[] {
    if (this._state.isDisabled) {
      return [new LedgerStatusItem('state', 'State', 'Disabled', undefined)];
    }

    const stateLabel = this._state.isPaused ? 'Paused' : 'Active';
    const stateIcon = this._state.isPaused ? undefined : new vscode.ThemeIcon('check');

    const integrityDesc = this._state.integrityStatus.intact
      ? 'Intact ✓'
      : `Broken at event ${this._state.integrityStatus.brokenAt ?? 'unknown'}`;
    const integrityIcon = this._state.integrityStatus.intact
      ? new vscode.ThemeIcon('check')
      : new vscode.ThemeIcon('warning');

    return [
      new LedgerStatusItem('state', 'State', stateLabel, stateIcon),
      new LedgerStatusItem('integrity', 'Integrity', integrityDesc, integrityIcon),
    ];
  }
}
