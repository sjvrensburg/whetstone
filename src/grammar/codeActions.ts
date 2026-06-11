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

/** The command ID for the explain-rule action. */
export const EXPLAIN_RULE_COMMAND_ID = 'whetstone.grammar.explainRule';

/** The quick-fix title for the explain-rule action. */
const EXPLAIN_RULE_TITLE = 'Explain this rule in my own words';

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

/**
 * The argument passed to the explain-rule command. Contains the offending
 * sentence and the lint metadata needed to request a rule explanation.
 */
export interface ExplainRuleCommandArgs {
  /** The sentence containing the grammar issue. */
  readonly sentence: string;
  /** The URI of the document (for context). */
  readonly documentUri: vscode.Uri;
  /** The lint metadata. */
  readonly lintKind: string;
  /** Human-readable lint category. */
  readonly lintKindPretty: string;
  /** The diagnostic message from Harper. */
  readonly message: string;
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

/**
 * Create an "Explain this rule" code action for a grammar diagnostic.
 *
 * This is a pure factory — it creates the `CodeAction` object without
 * executing anything. The action's command is resolved when the user
 * clicks it. The action never carries an edit (explanation is read-only).
 */
export function createExplainRuleAction(
  diagnostic: vscode.Diagnostic,
  sentence: string,
  lintKind: string,
  lintKindPretty: string,
  message: string,
  documentUri: vscode.Uri,
): vscode.CodeAction {
  const action = new vscode.CodeAction(EXPLAIN_RULE_TITLE, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.command = {
    title: EXPLAIN_RULE_TITLE,
    command: EXPLAIN_RULE_COMMAND_ID,
    arguments: [
      {
        sentence,
        documentUri,
        lintKind,
        lintKindPretty,
        message,
      } satisfies ExplainRuleCommandArgs,
    ],
  };
  // Explicitly no `action.edit` — explanation is read-only, never applied.
  return action;
}

// ---------------------------------------------------------------------------
// Sentence extraction
// ---------------------------------------------------------------------------

/**
 * Convert a (line, character) position to a character offset in the text.
 * Both line and character are 0-based. Mirrors `vscode.TextDocument.offsetAt`
 * so tests don't need the full VS Code document API.
 */
function positionToOffset(
  text: string,
  pos: { readonly line: number; readonly character: number },
): number {
  let offset = 0;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === pos.line) {
      return offset + Math.min(pos.character, text.length - offset);
    }
    if (text[i] === '\n') {
      line++;
      offset = i + 1;
    }
  }
  // Position past the end — return text length.
  return text.length;
}

/**
 * Extract the sentence containing the diagnostic from the document.
 *
 * Expands from the diagnostic range to the nearest sentence boundaries
 * (period, exclamation, question mark, or line boundary) so the rule
 * explanation has full-sentence context rather than just the flagged fragment.
 *
 * Accepts a `TextDocument`-shaped object with `getText()` returning the full
 * document text, plus a `Diagnostic` with a `range`. Works with both the real
 * VS Code API and test stubs that may not implement `offsetAt`.
 */
function extractSentence(
  document: { getText(): string },
  diagnostic: Pick<vscode.Diagnostic, 'range'>,
): string {
  const fullText = document.getText();
  const startOffset = positionToOffset(fullText, diagnostic.range.start);
  const endOffset = positionToOffset(fullText, diagnostic.range.end);

  // Expand backward to find the sentence start.
  let sentenceStart = startOffset;
  for (let i = startOffset - 1; i >= 0; i--) {
    const ch = fullText[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      sentenceStart = i + 1;
      break;
    }
    if (i === 0) {
      sentenceStart = 0;
    }
  }

  // Expand forward to find the sentence end.
  let sentenceEnd = endOffset;
  for (let i = endOffset; i < fullText.length; i++) {
    const ch = fullText[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      sentenceEnd = i + 1;
      break;
    }
    if (i === fullText.length - 1) {
      sentenceEnd = fullText.length;
    }
  }

  return fullText.slice(sentenceStart, sentenceEnd).trim();
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

      // "Explain this rule" action (task 15) — extracts the sentence around
      // the diagnostic to provide context for the rule explanation.
      const sentence = extractSentence(document, diag);
      const lintKind = typeof diag.code === 'string' ? diag.code : String(diag.code ?? '');
      const lintKindPretty = diag.source ?? 'Grammar';
      const message = diag.message;

      actions.push(
        createExplainRuleAction(diag, sentence, lintKind, lintKindPretty, message, document.uri),
      );
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
