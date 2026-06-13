/**
 * Unit tests for the grammar code-action provider (src/grammar/codeActions.ts).
 *
 * Verifies:
 * - `createDismissAction` creates a quick-fix with the dismiss command.
 * - `createExplainRuleAction` creates a quick-fix with the explain-rule command.
 * - `handleDismissCommand` adds the identity to the store.
 * - `GrammarCodeActionProvider` provides dismiss + explain-rule actions for grammar diagnostics.
 * - No code path creates a prose rewrite action (no edit property).
 * - Only grammar-sourced diagnostics produce actions.
 */

import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  GrammarCodeActionProvider,
  createDismissAction,
  createExplainRuleAction,
  handleDismissCommand,
  DISMISS_COMMAND_ID,
  EXPLAIN_RULE_COMMAND_ID,
  type DismissCommandArgs,
  type ExplainRuleCommandArgs,
} from '../../../src/grammar/codeActions';
import {
  DismissalStore,
  type DismissalStorage,
  type LintIdentity,
} from '../../../src/grammar/dismissals';
import type { CancellationToken } from 'vscode';

// ---------------------------------------------------------------------------
// CodeActionContext helper — satisfies real @types/vscode
// ---------------------------------------------------------------------------

/** CodeActionTriggerKind.Invoked = 1 */
const INVOKED = 1;

function makeContext(diags: vscode.Diagnostic[]): vscode.CodeActionContext {
  return {
    diagnostics: diags,
    triggerKind: INVOKED,
    only: undefined,
  };
}

// ---------------------------------------------------------------------------
// In-memory storage fake
// ---------------------------------------------------------------------------

class InMemoryStorage implements DismissalStorage {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.data.get(key) as T) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Helpers — construct test objects compatible with real @types/vscode
// ---------------------------------------------------------------------------

/** Create a vscode-compatible Range. */
function range(sl: number, sc: number, el: number, ec: number): vscode.Range {
  return new vscode.Range(sl, sc, el, ec);
}

/** Create a vscode-compatible Diagnostic. */
function diag(r: vscode.Range, message: string, source?: string, code?: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(r, message);
  if (source) d.source = source;
  if (code) d.code = code;
  return d;
}

/** Create a URI for testing. */
function uri(path: string): vscode.Uri {
  return vscode.Uri.file(path);
}

/** A minimal TextDocument-like object for tests. */
interface TestDocument {
  uri: vscode.Uri;
  getText(r?: vscode.Range): string;
}

function testDoc(text: string, path = '/test/doc.md'): TestDocument {
  const lines = text.split('\n');
  return {
    uri: uri(path),
    getText(r?: vscode.Range): string {
      if (!r) return text;
      if (r.start.line === r.end.line) {
        return lines[r.start.line]?.slice(r.start.character, r.end.character) ?? '';
      }
      const parts = [lines[r.start.line]?.slice(r.start.character) ?? ''];
      for (let i = r.start.line + 1; i < r.end.line; i++) {
        parts.push(lines[i] ?? '');
      }
      parts.push(lines[r.end.line]?.slice(0, r.end.character) ?? '');
      return parts.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// createDismissAction
// ---------------------------------------------------------------------------

describe('createDismissAction', () => {
  it('creates an action with the dismiss title', () => {
    const d = diag(range(0, 0, 0, 6), 'Did you mean "color"?');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const action = createDismissAction(d, identity, uri('/test/doc.md'));
    expect(action.title).toBe('Dismiss as false positive');
  });

  it('sets the QuickFix kind', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'test' };
    const action = createDismissAction(d, identity, uri('/test/doc.md'));
    expect(action.kind).toBe(vscode.CodeActionKind.QuickFix);
  });

  it('includes the dismiss command', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'test' };
    const action = createDismissAction(d, identity, uri('/test/doc.md'));
    expect(action.command).toBeDefined();
    expect(action.command!.command).toBe(DISMISS_COMMAND_ID);
  });

  it('passes the identity and URI in command arguments', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const u = uri('/test/doc.md');
    const action = createDismissAction(d, identity, u);
    const args = action.command!.arguments![0] as DismissCommandArgs;
    expect(args.identity).toEqual(identity);
    expect(args.documentUri).toBe(u);
  });

  it('attaches the diagnostic to the action', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'test' };
    const action = createDismissAction(d, identity, uri('/test/doc.md'));
    expect(action.diagnostics).toEqual([d]);
  });

  it('NEVER sets an edit (no prose rewrite)', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'test' };
    const action = createDismissAction(d, identity, uri('/test/doc.md'));
    // The action must never carry a WorkspaceEdit — dismiss only.
    expect(action.edit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createExplainRuleAction
// ---------------------------------------------------------------------------

describe('createExplainRuleAction', () => {
  it('creates an action with the explain-rule title', () => {
    const d = diag(range(0, 0, 0, 6), 'Did you mean "color"?');
    const action = createExplainRuleAction(
      d,
      'colour is nice',
      'Spelling',
      'Spelling',
      'Did you mean "color"?',
      uri('/test/doc.md'),
    );
    expect(action.title).toBe('Explain this rule in my own words');
  });

  it('sets the QuickFix kind', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const action = createExplainRuleAction(
      d,
      'test sentence',
      'Spelling',
      'Spelling',
      'Test',
      uri('/test/doc.md'),
    );
    expect(action.kind).toBe(vscode.CodeActionKind.QuickFix);
  });

  it('includes the explain-rule command', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const action = createExplainRuleAction(
      d,
      'test',
      'Spelling',
      'Spelling',
      'Test',
      uri('/test/doc.md'),
    );
    expect(action.command).toBeDefined();
    expect(action.command!.command).toBe(EXPLAIN_RULE_COMMAND_ID);
  });

  it('passes lint metadata and URI in command arguments', () => {
    const d = diag(range(0, 0, 0, 6), 'Did you mean "color"?');
    const u = uri('/test/doc.md');
    const action = createExplainRuleAction(
      d,
      'colour is nice',
      'Spelling',
      'Spelling',
      'Did you mean "color"?',
      u,
    );
    const args = action.command!.arguments![0] as ExplainRuleCommandArgs;
    expect(args.sentence).toBe('colour is nice');
    expect(args.lintKind).toBe('Spelling');
    expect(args.lintKindPretty).toBe('Spelling');
    expect(args.message).toBe('Did you mean "color"?');
    expect(args.documentUri).toBe(u);
  });

  it('attaches the diagnostic to the action', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const action = createExplainRuleAction(
      d,
      'test',
      'Spelling',
      'Spelling',
      'Test',
      uri('/test/doc.md'),
    );
    expect(action.diagnostics).toEqual([d]);
  });

  it('NEVER sets an edit (explanation is read-only)', () => {
    const d = diag(range(0, 0, 0, 6), 'Test');
    const action = createExplainRuleAction(
      d,
      'test',
      'Spelling',
      'Spelling',
      'Test',
      uri('/test/doc.md'),
    );
    // The action must never carry a WorkspaceEdit — explanation is read-only.
    expect(action.edit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleDismissCommand
// ---------------------------------------------------------------------------

describe('handleDismissCommand', () => {
  it('adds the identity to the store', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const u = uri('/test/doc.md');

    await handleDismissCommand({ identity, documentUri: u }, store);
    expect(store.isDismissed(identity)).toBe(true);
  });

  it('calls the onDismissed callback', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const u = uri('/test/doc.md');
    const onDismissed = vi.fn();

    await handleDismissCommand({ identity, documentUri: u }, store, onDismissed);
    expect(onDismissed).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledWith(u);
  });

  it('works without the onDismissed callback', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const u = uri('/test/doc.md');

    await expect(
      handleDismissCommand({ identity, documentUri: u }, store),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GrammarCodeActionProvider
// ---------------------------------------------------------------------------

describe('GrammarCodeActionProvider', () => {
  it('provides dismiss + explain-rule actions for grammar diagnostics', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('colour is nice') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 6);
    const d = diag(r, 'Did you mean "color"?', 'Harper', 'Spelling');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    // One grammar diagnostic → 2 actions: dismiss + explain-rule.
    expect(actions).toHaveLength(2);
    const titles = actions.map((a) => a.title);
    expect(titles).toContain('Dismiss as false positive');
    expect(titles).toContain('Explain this rule in my own words');
  });

  it('does not provide actions for non-grammar diagnostics', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('some text') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 4);
    const d = diag(r, 'Some other lint', 'TypeScript', 'TS2304');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    expect(actions).toHaveLength(0);
  });

  it('does not provide actions for diagnostics outside the selection', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('some colour here') as unknown as vscode.TextDocument;
    const diagRange = range(0, 5, 0, 11);
    const selectionRange = range(0, 0, 0, 4); // doesn't overlap

    const d = diag(diagRange, 'Did you mean "color"?', 'Harper', 'Spelling');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, selectionRange, context, token);
    expect(actions).toHaveLength(0);
  });

  it('provides actions for multiple grammar diagnostics (2 diags → 4 actions)', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('colour analyse') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 15);

    const d1 = diag(range(0, 0, 0, 6), 'Colour?', 'Harper', 'Spelling');
    const d2 = diag(range(0, 7, 0, 14), 'Analyse?', 'Harper', 'Spelling');

    const context = makeContext([d1, d2]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    // 2 diagnostics × 2 actions each = 4 total.
    expect(actions).toHaveLength(4);
    // All actions should have no edits.
    for (const action of actions) {
      expect(action.edit).toBeUndefined();
    }
  });

  it('extracts problemText from the document at the diagnostic range', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('colour is nice') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 6);

    const d = diag(r, 'Did you mean "color"?', 'Harper', 'Spelling');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    // Find the dismiss action and check its problemText.
    const dismissAction = actions.find((a) => a.command?.command === DISMISS_COMMAND_ID);
    expect(dismissAction).toBeDefined();

    const args = dismissAction!.command!.arguments![0] as DismissCommandArgs;
    expect(args.identity.problemText).toBe('colour');
    expect(args.identity.lintKind).toBe('Spelling');
  });

  it('extracts sentence context for the explain-rule action', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('colour is nice') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 6);

    const d = diag(r, 'Did you mean "color"?', 'Harper', 'Spelling');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    const explainAction = actions.find((a) => a.command?.command === EXPLAIN_RULE_COMMAND_ID);
    expect(explainAction).toBeDefined();

    const args = explainAction!.command!.arguments![0] as ExplainRuleCommandArgs;
    // The sentence extraction should capture the full text (no sentence boundary).
    expect(args.sentence).toContain('colour');
    expect(args.lintKind).toBe('Spelling');
    expect(args.message).toBe('Did you mean "color"?');
  });

  it('never produces any action with an edit property', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('colour') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 6);

    const d = diag(r, 'Issue', 'Harper', 'Spelling');
    const context = makeContext([d]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    for (const action of actions) {
      // Critical: every action must NEVER carry a prose rewrite.
      expect(action.edit).toBeUndefined();
      // Every action must have a command (dismiss or explain-rule).
      expect(action.command).toBeDefined();
      expect([DISMISS_COMMAND_ID, EXPLAIN_RULE_COMMAND_ID]).toContain(action.command!.command);
    }
  });

  it('returns empty for empty diagnostic context', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const provider = new GrammarCodeActionProvider(store);

    const doc = testDoc('clean text') as unknown as vscode.TextDocument;
    const r = range(0, 0, 0, 5);
    const context = makeContext([]);
    const token = { isCancellationRequested: false } as CancellationToken;

    const actions = provider.provideCodeActions(doc, r, context, token);
    expect(actions).toEqual([]);
  });
});
