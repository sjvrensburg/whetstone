import * as vscode from 'vscode';
import type { ModuleContainer } from '../container';

/**
 * `ui/` — Presentation only (Component Overview boundary). TreeView providers,
 * commands, and span reveal live here; no business logic.
 *
 * For the scaffold this registers the two sidebar TreeViews (coaching + ledger,
 * per ADR-007's native-first decision) backed by an empty data provider, so the
 * view container is real and visible in the integration host. Task 17 replaces
 * the empty providers with the coaching/ledger views fed by the domain services.
 */

/** An empty TreeDataProvider placeholder: a real, registered provider with no items yet. */
class EmptyTreeDataProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }
}

/** View ids contributed by `package.json` under the `whetstone` view container. */
export const VIEW_IDS = ['whetstone.coaching', 'whetstone.ledger'] as const;

/** Register the sidebar views. Pure wiring over the container; no business logic. */
export function registerViews(context: vscode.ExtensionContext, _container: ModuleContainer): void {
  const provider = new EmptyTreeDataProvider();
  for (const viewId of VIEW_IDS) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(viewId, provider));
  }
}
