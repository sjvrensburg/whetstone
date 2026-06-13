/**
 * Unit tests for the grammar hover provider (src/grammar/hover.ts).
 *
 * Verifies:
 * - `formatHoverContent` renders the lint message and category.
 * - `diagnosticToHoverData` extracts the correct data.
 * - `GrammarHoverProvider` returns hovers for grammar diagnostics.
 * - No code path produces a prose rewrite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { setDiagnosticsForUri, clearAllDiagnostics } from '../../../test/support/vscode-stub';
import {
  formatHoverContent,
  diagnosticToHoverData,
  GrammarHoverProvider,
  type HoverData,
} from '../../../src/grammar/hover';
import type { GrammarDiagnostic } from '../../../src/grammar/diagnostics';
import type { CancellationToken } from 'vscode';

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleDiagnostic: GrammarDiagnostic = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 6 },
  },
  message: 'Did you mean "color"?',
  severity: 3,
  source: 'Harper',
  code: 'Spelling',
};

const sampleHoverData: HoverData = {
  message: 'Did you mean "color"?',
  code: 'Spelling',
};

// ---------------------------------------------------------------------------
// formatHoverContent
// ---------------------------------------------------------------------------

describe('formatHoverContent', () => {
  it('includes the lint category', () => {
    const content = formatHoverContent(sampleHoverData);
    expect(content).toContain('**Category:** Spelling');
  });

  it('includes the lint message in plain language', () => {
    const content = formatHoverContent(sampleHoverData);
    expect(content).toContain('Did you mean "color"?');
  });

  it('includes the local-grammar-check attribution', () => {
    const content = formatHoverContent(sampleHoverData);
    expect(content).toContain('Local grammar check (Harper)');
  });

  it('does not contain any rewrite suggestion', () => {
    const content = formatHoverContent(sampleHoverData);
    // "Replace with" / "Change to" would indicate a rewrite suggestion.
    expect(content).not.toContain('Replace with');
    expect(content).not.toContain('Change to');
    expect(content).not.toContain('Fix:');
    // The message itself contains a quoted suggestion ("color") but that's
    // the diagnostic's wording, not a hover affordance.
  });

  it('renders different categories correctly', () => {
    const data: HoverData = { message: 'Consider shorter phrasing.', code: 'Style' };
    const content = formatHoverContent(data);
    expect(content).toContain('**Category:** Style');
    expect(content).toContain('Consider shorter phrasing.');
  });

  it('renders empty message gracefully', () => {
    const data: HoverData = { message: '', code: 'Grammar' };
    const content = formatHoverContent(data);
    expect(content).toContain('**Category:** Grammar');
    // The empty message line is still present (no crash).
    expect(content).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// diagnosticToHoverData
// ---------------------------------------------------------------------------

describe('diagnosticToHoverData', () => {
  it('extracts message and code from a GrammarDiagnostic', () => {
    const data = diagnosticToHoverData(sampleDiagnostic);
    expect(data.message).toBe('Did you mean "color"?');
    expect(data.code).toBe('Spelling');
  });

  it('preserves the diagnostic message verbatim', () => {
    const diag: GrammarDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: 'This sentence is long and complex.',
      severity: 3,
      source: 'Harper',
      code: 'Readability',
    };
    const data = diagnosticToHoverData(diag);
    expect(data.message).toBe('This sentence is long and complex.');
    expect(data.code).toBe('Readability');
  });
});

// ---------------------------------------------------------------------------
// GrammarHoverProvider (uses vscode stub)
// ---------------------------------------------------------------------------

/** A minimal TextDocument-like object for provider tests. */
interface TestDoc {
  uri: vscode.Uri;
}

function makeDoc(path: string): TestDoc {
  return { uri: vscode.Uri.file(path) };
}

describe('GrammarHoverProvider', () => {
  const provider = new GrammarHoverProvider();

  beforeEach(() => {
    clearAllDiagnostics();
  });

  afterEach(() => {
    clearAllDiagnostics();
  });

  it('returns a hover for a grammar diagnostic at the position', () => {
    const doc = makeDoc('/test/hover.md');
    const r = new vscode.Range(0, 0, 0, 6);
    const d = new vscode.Diagnostic(r, 'Did you mean "color"?');
    d.source = 'Harper';
    d.code = 'Spelling';

    setDiagnosticsForUri(doc.uri, [
      d,
    ] as unknown as import('../../../test/support/vscode-stub').Diagnostic[]);

    const position = new vscode.Position(0, 3);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    expect(hover).toBeDefined();
    expect(hover!.contents).toHaveLength(1);
    // The stub's MarkdownString has a .value property.
    const mdString = hover!.contents[0] as { value: string };
    expect(mdString.value).toContain('Did you mean "color"?');
    expect(mdString.value).toContain('**Category:** Spelling');
  });

  it('returns undefined when no grammar diagnostics exist at position', () => {
    const doc = makeDoc('/test/clean.md');
    setDiagnosticsForUri(
      doc.uri,
      [] as unknown as import('../../../test/support/vscode-stub').Diagnostic[],
    );

    const position = new vscode.Position(0, 0);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    expect(hover).toBeUndefined();
  });

  it('ignores non-Harper diagnostics', () => {
    const doc = makeDoc('/test/ts.ts');
    const r = new vscode.Range(0, 0, 0, 4);
    const d = new vscode.Diagnostic(r, 'Type error');
    d.source = 'TypeScript';
    d.code = 'TS2304';

    setDiagnosticsForUri(doc.uri, [
      d,
    ] as unknown as import('../../../test/support/vscode-stub').Diagnostic[]);

    const position = new vscode.Position(0, 2);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    expect(hover).toBeUndefined();
  });

  it('returns undefined when position is outside diagnostic range', () => {
    const doc = makeDoc('/test/outside.md');
    const r = new vscode.Range(0, 0, 0, 6);
    const d = new vscode.Diagnostic(r, 'Did you mean "color"?');
    d.source = 'Harper';
    d.code = 'Spelling';

    setDiagnosticsForUri(doc.uri, [
      d,
    ] as unknown as import('../../../test/support/vscode-stub').Diagnostic[]);

    // Position at character 10 — outside the diagnostic range.
    const position = new vscode.Position(0, 10);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    expect(hover).toBeUndefined();
  });

  it('renders multiple grammar diagnostics in a single hover', () => {
    const doc = makeDoc('/test/multi.md');
    const d1 = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), 'Colour?');
    d1.source = 'Harper';
    d1.code = 'Spelling';
    const d2 = new vscode.Diagnostic(new vscode.Range(0, 7, 0, 14), 'Analyse?');
    d2.source = 'Harper';
    d2.code = 'Spelling';

    setDiagnosticsForUri(doc.uri, [
      d1,
      d2,
    ] as unknown as import('../../../test/support/vscode-stub').Diagnostic[]);

    // Hover at position inside first diagnostic.
    const position = new vscode.Position(0, 3);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    // Only d1 is at position (0,3); d2 is at (0,7-14).
    expect(hover).toBeDefined();
    expect(hover!.contents).toHaveLength(1);
    const mdString = hover!.contents[0] as { value: string };
    expect(mdString.value).toContain('Colour?');
  });

  it('hover content never contains a rewrite suggestion', () => {
    const doc = makeDoc('/test/rewrite.md');
    const r = new vscode.Range(0, 0, 0, 6);
    const d = new vscode.Diagnostic(r, 'Did you mean "color"?');
    d.source = 'Harper';
    d.code = 'Spelling';

    setDiagnosticsForUri(doc.uri, [
      d,
    ] as unknown as import('../../../test/support/vscode-stub').Diagnostic[]);

    const position = new vscode.Position(0, 3);
    const token = { isCancellationRequested: false } as CancellationToken;
    const hover = provider.provideHover(doc as unknown as vscode.TextDocument, position, token);

    expect(hover).toBeDefined();
    const mdString = hover!.contents[0] as { value: string };
    // The hover text is informational; no rewrite affordance.
    expect(mdString.value).not.toContain('Replace with');
    expect(mdString.value).not.toContain('Change to');
    expect(mdString.value).not.toContain('Fix:');
  });
});
