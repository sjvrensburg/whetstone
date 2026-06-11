/**
 * `ui/` — Presentation only (Component Overview boundary, ADR-007).
 *
 * TreeView providers, commands, and span reveal live here; no business logic.
 * Task 17 replaces the scaffold's empty providers with real coaching and ledger
 * views fed by the domain services, and wires the command handlers.
 */

export {
  CoachingTreeDataProvider,
  ObservationItem,
  ReflectionItem,
  EmptyCoachingItem,
  revealObservationSpan,
} from './coachingView';
export type { CoachingTreeElement, CoachingDocumentRef } from './coachingView';
export { LedgerTreeDataProvider, LedgerStatusItem } from './ledgerView';
export type { LedgerViewState } from './ledgerView';
export { createUICommands, UI_COMMAND_IDS } from './commands';
export type { UICommandDeps, CommandDescriptor } from './commands';

import * as vscode from 'vscode';
import type { ModuleContainer } from '../container';
import { CoachingTreeDataProvider } from './coachingView';
import { LedgerTreeDataProvider } from './ledgerView';
import type { LedgerViewState } from './ledgerView';

/** View ids contributed by `package.json` under the `whetstone` view container. */
export const VIEW_IDS = ['whetstone.coaching', 'whetstone.ledger'] as const;

/**
 * Register the sidebar views with real TreeDataProviders backed by the
 * domain services. The providers are stored in `container.ui` so the command
 * handlers can access them.
 *
 * Presentation only — no business logic.
 */
export function registerViews(context: vscode.ExtensionContext, container: ModuleContainer): void {
  const coachingView = new CoachingTreeDataProvider();
  const ledgerView = new LedgerTreeDataProvider(
    (container.ledger as LedgerViewState | undefined) ?? {
      isPaused: false,
      isDisabled: false,
      integrityStatus: { intact: true },
    },
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('whetstone.coaching', coachingView),
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('whetstone.ledger', ledgerView),
  );

  // Store providers in the container so command handlers can access them.
  container.ui = { coachingView, ledgerView };
}
