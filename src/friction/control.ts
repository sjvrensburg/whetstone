/**
 * Friction-dial control surface (ADR-008, task 20).
 *
 * Provides a VS Code status-bar item showing the current friction level and
 * a command + QuickPick to change it. Below-floor options are disabled in the
 * QuickPick. Changing the level takes effect immediately without reload.
 */

import * as vscode from 'vscode';
import type { Dial } from './dial';
import type { FrictionLevel } from './presets';
import { FRICTION_LEVEL_LABELS } from './presets';
import { CONFIG_SECTION } from '../shared/config';

// ---------------------------------------------------------------------------
// Status-bar item
// ---------------------------------------------------------------------------

const STATUS_BAR_PRIORITY = 50;

/**
 * Create and manage the friction-dial status-bar item.
 * Shows the current level label (e.g. "⚙ Coach") and updates reactively.
 */
export class FrictionStatusBar {
  private readonly _item: vscode.StatusBarItem;
  private readonly _dial: Dial;
  private readonly _disposeObserver: () => void;

  constructor(dial: Dial) {
    this._dial = dial;

    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this._item.command = 'whetstone.setFrictionLevel';
    this._item.tooltip = 'Click to change friction level';

    this._disposeObserver = dial.observe(() => this._refresh());
    this._refresh();
    this._item.show();
  }

  private _refresh(): void {
    const level = this._dial.frictionLevel();
    const label = FRICTION_LEVEL_LABELS[level];
    this._item.text = `⚙ ${label}`;
    this._item.tooltip = `Friction level: ${label} (${level}) — click to change`;
  }

  dispose(): void {
    this._disposeObserver();
    this._item.dispose();
  }
}

// ---------------------------------------------------------------------------
// QuickPick — set level command
// ---------------------------------------------------------------------------

interface LevelPickItem extends vscode.QuickPickItem {
  readonly level: FrictionLevel;
}

/**
 * Build the QuickPick items for the friction-level selector.
 * Items below the institutional floor are marked as disabled.
 */
function buildPickItems(dial: Dial): LevelPickItem[] {
  const floor = dial.floorLevel();
  const current = dial.frictionLevel();

  const items: LevelPickItem[] = [];
  for (let i = 3; i >= 0; i--) {
    const level = i as FrictionLevel;
    const label = `${level} ${FRICTION_LEVEL_LABELS[level]}`;
    const isCurrent = level === current;
    const isBelowFloor = level < floor;

    items.push({
      label: isCurrent ? `$(check) ${label}` : label,
      description: isCurrent ? 'Current' : undefined,
      level,
      // VS Code QuickPick supports `disabled` for items that cannot be picked
      ...(isBelowFloor ? { picked: false, detail: 'Below institutional floor' } : {}),
    });
  }
  return items;
}

/**
 * Show the friction-level QuickPick and apply the selection.
 * Returns the selected level, or `undefined` if dismissed.
 */
export async function showLevelQuickPick(dial: Dial): Promise<FrictionLevel | undefined> {
  const items = buildPickItems(dial);
  const floor = dial.floorLevel();

  // Filter out below-floor items entirely (QuickPick doesn't have a native
  // "disabled" that prevents selection, so we simply omit them).
  const selectable = items.filter((item) => item.level >= floor);

  const picked = await vscode.window.showQuickPick(selectable, {
    title: 'Set Friction Level',
    placeHolder: 'Choose a friction level…',
  });

  if (picked === undefined) return undefined;

  dial.setLevel(picked.level);

  // Persist to VS Code settings so the choice survives restarts
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('friction.level', picked.level, vscode.ConfigurationTarget.Global);

  return picked.level;
}

// ---------------------------------------------------------------------------
// Command descriptor
// ---------------------------------------------------------------------------

export interface FrictionControlDeps {
  readonly dial: Dial;
}

/**
 * Create the command descriptor for the set-friction-level command.
 * The handler shows the QuickPick and applies the selection.
 */
export function createFrictionControlCommands(
  deps: FrictionControlDeps,
): Array<{ id: string; handler: (...args: unknown[]) => unknown }> {
  return [
    {
      id: 'whetstone.setFrictionLevel',
      handler: () => showLevelQuickPick(deps.dial),
    },
  ];
}
