/**
 * Grammar code-action provider (ADR-005, Task 06).
 *
 * Provides a "Dismiss as false positive" quick-fix for grammar diagnostics.
 * When invoked, the action adds the lint's identity to the persistent
 * `DismissalStore` so the same lint does not reappear on re-lint or reload.
 *
 * Key guarantee: this provider exposes ONLY a dismiss action — never a prose
 * rewrite, autocorrect, or suggestion. This is asserted in unit tests.
 */

import * as vscode from 'vscode';
import type { DismissalStore } from './dismissals';
import { type LintIdentity } from './dismissals';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source identifier for grammar diagnostics (matches `diagnostics.ts`). */
const GRAMMAR_SOURCE = 'Harper';

/** The command ID for the dismiss action. */
export const DISMISS_COMMAND_ID = 'whetstone.grammar.dismissFalsePositive';

/** The quick-fix title shown to the writer. */
const DISMISS_TITLE = 'Dismiss as false positive';

// ---------------------------------------------------------------------------
// Dismiss command argument
// ---------------------------------------------------------------------------

/**
 * The argument passed to the dismiss command via `CodeAction.command.arguments`.
 * Contains the lint identity to dismiss and the document URI for re-linting.
 */
export interface DismissCommandArgs {
  /** The identity of the lint to dismiss. */
  readonly identity: LintIdentity;
  /** The URI of the document containing the lint (for diagnostic refresh). */
  readonly documentUri: vscode.Uri;
}

// ---------------------------------------------------------------------------
// Code action creation (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Create a dismiss quick-fix action for a grammar diagnostic.
 *
 * This is a pure factory — it creates the `CodeAction` object without
 * executing anything. The action's command is resolved when the user
 * clicks it.
 */
export function createDismissAction(
  diagnostic: vscode.Diagnostic,
  identity: LintIdentity,
  documentUri: vscode.Uri,
): vscode.CodeAction {
  const action = new vscode.CodeAction(DISMISS_TITLE, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.command = {
    title: DISMISS_TITLE,
    command: DISMISS_COMMAND_ID,
    arguments: [{ identity, documentUri } satisfies DismissCommandArgs],
  };
  // Explicitly no `action.edit` — dismiss never rewrites prose.
  return action;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * The function invoked when the writer selects "Dismiss as false positive".
 *
 * Adds the lint identity to the dismissal store and triggers a re-lint
 * so the dismissed diagnostic is removed immediately.
 *
 * @param store           The persistent dismissal store.
 * @param getDiagnostics  A function returning current diagnostics for the URI.
 * @param setDiagnostics  A function to set updated diagnostics for the URI.
 */
export async function handleDismissCommand(
  args: DismissCommandArgs,
  store: DismissalStore,
  onDismissed?: (documentUri: vscode.Uri) => void,
): Promise<void> {
  await store.dismiss(args.identity);
  onDismissed?.(args.documentUri);
}

// ---------------------------------------------------------------------------
// VS Code CodeActionProvider implementation
// ---------------------------------------------------------------------------

/**
 * Grammar code-action provider. Registered against Markdown and LaTeX
 * document selectors. Provides a "Dismiss as false positive" quick-fix
 * for each grammar diagnostic at the cursor position.
 */
export class GrammarCodeActionProvider implements vscode.CodeActionProvider {
  /**
   * @param _store  The dismissal store (available for future use by the
   *   provider; the actual dismiss logic runs in the command handler via
   *   `handleDismissCommand`).
   */
  constructor(_store: DismissalStore) {
    // The store is held for future use (e.g. checking dismissal status in
    // the provider, or for an "undo dismiss" action). The dismiss command
    // handler is the primary consumer today.
  }

  /**
   * Provide code actions for grammar diagnostics at the given range.
   *
   * @param document  The document.
   * @param range     The cursor/selection range.
   * @param context   The code-action context (contains diagnostics).
   * @param _token    Cancellation token.
   * @returns An array of dismiss actions, one per grammar diagnostic.
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    // Filter to grammar diagnostics that intersect the selection.
    const grammarDiags = context.diagnostics.filter(
      (d) => d.source === GRAMMAR_SOURCE && d.range.intersection(range) !== undefined,
    );

    if (grammarDiags.length === 0) {
      return [];
    }

    const actions: vscode.CodeAction[] = [];

    for (const diag of grammarDiags) {
      // Extract the lint identity from the diagnostic.
      // The `code` field is the lintKind and the message + flagged text
      // together identify the lint. Since we don't have `problemText` in
      // a `vscode.Diagnostic`, we use the diagnostic range to extract it
      // from the document.
      const problemText = document.getText(diag.range);
      const identity: LintIdentity = {
        lintKind: typeof diag.code === 'string' ? diag.code : String(diag.code ?? ''),
        problemText,
      };

      actions.push(createDismissAction(diag, identity, document.uri));
    }

    return actions;
  }
}

// ---------------------------------------------------------------------------
// Selection type (matches vscode.Selection)
// ---------------------------------------------------------------------------

/**
 * Minimal selection type that satisfies the provider signature.
 * `vscode.Selection` extends `vscode.Range`; the stub provides this.
 */
export type { Range as Selection } from 'vscode';
