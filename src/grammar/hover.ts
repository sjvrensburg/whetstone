/**
 * Grammar hover provider (ADR-005, Task 06).
 *
 * Shows a plain-language hover tooltip when the writer hovers over a grammar
 * diagnostic. The hover displays the lint's message, the category, and a brief
 * note that the marker comes from local grammar analysis.
 *
 * Design decisions:
 * - The core rendering logic (`formatHoverContent`) is a pure function so it
 *   can be unit-tested without VS Code.
 * - The provider wrapper is thin: it finds grammar diagnostics at the hover
 *   position and delegates to the pure function.
 * - Hovers are informational only — no rewrite or fix suggestions (those are
 *   the domain of the code-action provider, and "explain rule" is task 15).
 */

import * as vscode from 'vscode';
import type { GrammarDiagnostic } from './diagnostics';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source identifier for grammar diagnostics (matches `diagnostics.ts`). */
const GRAMMAR_SOURCE = 'Harper';

// ---------------------------------------------------------------------------
// Pure rendering logic (testable without VS Code)
// ---------------------------------------------------------------------------

/**
 * The data needed to render a grammar hover tooltip.
 * Extracted from `GrammarDiagnostic` so tests don't need VS Code types.
 */
export interface HoverData {
  /** The diagnostic message (e.g. "Did you mean 'This'?"). */
  readonly message: string;
  /** The lint category (e.g. "Spelling"). */
  readonly code: string;
}

/**
 * Format a grammar hover as a Markdown string.
 *
 * Returns the markdown content (without the surrounding code fence markers
 * that `vscode.MarkdownString` would add). This keeps the function pure
 * and testable; the provider wrapper wraps it in `MarkdownString`.
 *
 * Output format:
 * ```
 * **Category:** Spelling
 *
 * Did you mean "This"?
 *
 * ---
 * *Local grammar check (Harper)*
 * ```
 */
export function formatHoverContent(data: HoverData): string {
  const lines: string[] = [];
  lines.push(`**Category:** ${data.code}`);
  lines.push('');
  lines.push(data.message);
  lines.push('');
  lines.push('---');
  lines.push('*Local grammar check (Harper)*');
  return lines.join('\n');
}

/**
 * Extract `HoverData` from a `GrammarDiagnostic`.
 */
export function diagnosticToHoverData(diag: GrammarDiagnostic): HoverData {
  return {
    message: diag.message,
    code: diag.code,
  };
}

// ---------------------------------------------------------------------------
// VS Code HoverProvider implementation
// ---------------------------------------------------------------------------

/**
 * Grammar hover provider. Registered against Markdown and LaTeX document
 * selectors. Shows a hover for any diagnostic whose `source` matches
 * `GRAMMAR_SOURCE` at the hovered position.
 */
export class GrammarHoverProvider implements vscode.HoverProvider {
  /**
   * Provide hover information for grammar diagnostics at the given position.
   *
   * @param document   The document being hovered.
   * @param position   The hover position.
   * @param _token     Cancellation token (unused in V1).
   * @returns A `Hover` with the diagnostic message, or `undefined`.
   */
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | undefined {
    // The provider needs access to the diagnostic collection. In the real
    // extension, the diagnostics are set on a DiagnosticCollection by the
    // GrammarEngine consumer. The hover provider reads them through the
    // VS Code API's `languages.getDiagnostics()`.
    const diags = vscode.languages.getDiagnostics(document.uri);

    // Find grammar diagnostics that cover the hover position.
    const grammarDiags = diags.filter(
      (d) => d.source === GRAMMAR_SOURCE && d.range.contains(position),
    );

    if (grammarDiags.length === 0) {
      return undefined;
    }

    // Render all matching diagnostics into a single hover.
    const parts: string[] = [];
    for (const diag of grammarDiags) {
      const hoverData: HoverData = {
        message: diag.message,
        code: typeof diag.code === 'string' ? diag.code : String(diag.code ?? ''),
      };
      parts.push(formatHoverContent(hoverData));
    }

    const markdown = new vscode.MarkdownString(parts.join('\n\n---\n\n'));
    const range = grammarDiags[0].range;
    return new vscode.Hover([markdown], range);
  }
}
