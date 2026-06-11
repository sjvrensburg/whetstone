/**
 * Maps Harper lints to VS Code `Diagnostic` objects (ADR-005).
 *
 * This module is pure and side-effect-free — it depends only on the lint
 * data shape (not the harper.js class) so it is trivially unit-testable.
 *
 * Key guarantees:
 * - Severity is **always** `hint` or `info`, never `error` or `warning`
 *   (the F4 quietness invariant, configurable via `grammarSeverity`).
 * - If a source-offset map is provided, lint positions are translated from
 *   the masked text back to the original source.
 */

// ---------------------------------------------------------------------------
// VS Code Diagnostic types (structural — no runtime dependency on `vscode`)
// ---------------------------------------------------------------------------

/**
 * The subset of `vscode.DiagnosticSeverity` the grammar engine uses.
 * Deliberately limited to hint/info to enforce the quietness invariant.
 */
export type GrammarDiagnosticSeverity = 2 | 3; // hint=2, info=3

/**
 * A position in a document (0-based line and character).
 * Mirrors `vscode.Position` for use without importing `vscode`.
 */
export interface DocumentPosition {
  readonly line: number;
  readonly character: number;
}

/**
 * A range in a document (inclusive start, exclusive end).
 * Mirrors `vscode.Range` for use without importing `vscode`.
 */
export interface DocumentRange {
  readonly start: DocumentPosition;
  readonly end: DocumentPosition;
}

/**
 * A diagnostic produced by the grammar engine.
 * Mirrors `vscode.Diagnostic` for use without importing `vscode`.
 * The `range` uses source positions (not masked positions).
 */
export interface GrammarDiagnostic {
  /** The source range the diagnostic covers. */
  readonly range: DocumentRange;
  /** The diagnostic message (from Harper). */
  readonly message: string;
  /** Always `hint` (2) or `info` (3). */
  readonly severity: GrammarDiagnosticSeverity;
  /** The Harper lint category (e.g. "Spelling", "Capitalization"). */
  readonly source: string;
  /** The specific lint kind key from Harper. */
  readonly code: string;
}

// ---------------------------------------------------------------------------
// Serialized lint shape (harper.js-independent)
// ---------------------------------------------------------------------------

/**
 * A lint extracted from a Harper `Lint` object into a plain, serializable
 * form that can cross worker boundaries and be used in tests without WASM.
 */
export interface SerializedLint {
  /** Character span: inclusive start, exclusive end. */
  readonly span: { readonly start: number; readonly end: number };
  /** The problematic text. */
  readonly problemText: string;
  /** The lint category key (e.g. "Spelling"). */
  readonly lintKind: string;
  /** Human-readable category name (e.g. "Spelling"). */
  readonly lintKindPretty: string;
  /** The diagnostic message. */
  readonly message: string;
  /** Number of suggestions available. */
  readonly suggestionCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 0-based character offset into a (line, character) position.
 * Lines and characters are both 0-based.
 */
function offsetToPosition(text: string, offset: number): DocumentPosition {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: offset - lastNewline - 1 };
}

/**
 * Map a lint span from masked-text coordinates to source coordinates
 * using the source-offset map produced by LaTeX masking.
 *
 * The source map is an array where `sourceMap[maskedPos] = sourcePos`.
 * When a lint spans a gap in the source map (i.e. adjacent positions in
 * the masked text correspond to non-adjacent positions in the source —
 * because a LaTeX region was removed between them), we clamp the span
 * to the last contiguous source position to avoid the diagnostic
 * incorrectly covering the removed LaTeX region.
 */
function mapSpan(
  maskedSpan: { readonly start: number; readonly end: number },
  sourceMap: ReadonlyArray<number>,
  sourceLength: number,
): { start: number; end: number } {
  if (maskedSpan.start >= sourceMap.length) {
    return { start: sourceLength, end: sourceLength };
  }

  const mappedStart = sourceMap[maskedSpan.start];

  // Walk from start to end, finding the last contiguous source position.
  // Stop when the source position jumps (indicating a masked gap).
  let lastContiguousIdx = maskedSpan.start;
  for (let i = maskedSpan.start + 1; i < maskedSpan.end && i < sourceMap.length; i++) {
    // Check that this source position is immediately after the previous one.
    if (sourceMap[i] === sourceMap[i - 1] + 1) {
      lastContiguousIdx = i;
    } else {
      // Gap detected — stop here.
      break;
    }
  }

  const mappedEnd = sourceMap[lastContiguousIdx] + 1;
  return { start: mappedStart, end: mappedEnd };
}

/**
 * Resolve the diagnostic severity from the user's `grammarSeverity` setting.
 * Enforces the quietness invariant: only `hint` and `info` are produced,
 * never `error` or `warning`.
 */
export function resolveSeverity(setting: 'hint' | 'info' | 'warning'): GrammarDiagnosticSeverity {
  // The setting can be 'warning' but we clamp to 'info' — the F4 quietness
  // guarantee means grammar diagnostics never reach warning/error severity.
  if (setting === 'hint') {
    return 2; // vscode.DiagnosticSeverity.Hint
  }
  return 3; // vscode.DiagnosticSeverity.Information
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert serialized Harper lints to grammar diagnostics.
 *
 * @param lints        The lints from a Harper lint pass (serialized form).
 * @param sourceText   The **original** source text (for line calculation).
 * @param sourceMap    The offset map from LaTeX masking, or `null` for
 *                     Markdown (where positions are already source-aligned).
 * @param severity     The resolved diagnostic severity (hint or info).
 * @returns An array of `GrammarDiagnostic` objects with correct source ranges.
 */
export function lintsToDiagnostics(
  lints: readonly SerializedLint[],
  sourceText: string,
  sourceMap: ReadonlyArray<number> | null,
  severity: GrammarDiagnosticSeverity,
): GrammarDiagnostic[] {
  const sourceLength = sourceText.length;

  return lints.map((lint): GrammarDiagnostic => {
    // If we have a source map (LaTeX), translate the span back to source coords.
    // If not (Markdown), the lint span is already in source coordinates.
    const span = sourceMap ? mapSpan(lint.span, sourceMap, sourceLength) : lint.span;

    // Clamp to source bounds.
    const clampedStart = Math.max(0, Math.min(span.start, sourceLength));
    const clampedEnd = Math.max(clampedStart, Math.min(span.end, sourceLength));

    return {
      range: {
        start: offsetToPosition(sourceText, clampedStart),
        end: offsetToPosition(sourceText, clampedEnd),
      },
      message: lint.message,
      severity,
      source: 'Harper',
      code: lint.lintKind,
    };
  });
}
