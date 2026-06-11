/**
 * LaTeX masking / preprocessing for the grammar engine (ADR-005).
 *
 * Hides LaTeX control sequences, math environments, and comments from the
 * linter so only prose reaches Harper. Produces a source-offset map so
 * character positions in the masked text can be translated back to the
 * original source positions — diagnostics land on the correct characters.
 *
 * The module is pure and side-effect-free so it is trivially unit-testable
 * without harper.js or VS Code.
 */

/** The result of masking a LaTeX source. */
export interface MaskResult {
  /** The masked text — only prose characters remain. */
  readonly masked: string;
  /**
   * Maps each character position in `masked` to the corresponding
   * character position in the original source. `sourceMap[maskedPos]`
   * yields the source offset.
   */
  readonly sourceMap: ReadonlyArray<number>;
}

/** A contiguous region of the source that should be hidden. */
interface MaskedRegion {
  /** Inclusive start index in the source. */
  readonly start: number;
  /** Exclusive end index in the source. */
  readonly end: number;
}

// ---------------------------------------------------------------------------
// Region detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect a display-math region (`$$...$$`) starting at `pos`.
 * Returns the region or `undefined` if `pos` doesn't start one.
 */
function tryDisplayMath(source: string, pos: number): MaskedRegion | undefined {
  if (pos + 1 >= source.length || source[pos] !== '$' || source[pos + 1] !== '$') {
    return undefined;
  }
  // Scan for closing $$ (not escaped).
  let i = pos + 2;
  while (i < source.length) {
    if (source[i] === '$' && i + 1 < source.length && source[i + 1] === '$') {
      // Check that the $ before this $$ is not a backslash-escape.
      if (i > 0 && source[i - 1] === '\\') {
        i += 2;
        continue;
      }
      return { start: pos, end: i + 2 };
    }
    i++;
  }
  // Unclosed display math — mask to end of source.
  return { start: pos, end: source.length };
}

/**
 * Detect an inline-math region (`$...$`) starting at `pos`.
 * Returns the region or `undefined` if `pos` doesn't start one.
 * Must be called **after** display-math check so `$$` is consumed first.
 */
function tryInlineMath(source: string, pos: number): MaskedRegion | undefined {
  if (source[pos] !== '$') {
    return undefined;
  }
  // Escaped \$ — not math.
  if (pos > 0 && source[pos - 1] === '\\') {
    return undefined;
  }
  // Scan for closing $.
  let i = pos + 1;
  while (i < source.length) {
    if (source[i] === '$') {
      // Don't match $$ (that's display math).
      if (i + 1 < source.length && source[i + 1] === '$') {
        i += 2;
        continue;
      }
      return { start: pos, end: i + 1 };
    }
    i++;
  }
  // Unclosed inline math — mask to end of source.
  return { start: pos, end: source.length };
}

/**
 * Detect a LaTeX comment (`%...`) starting at `pos`.
 * Masks from `%` to end of line (or end of source).
 */
function tryComment(source: string, pos: number): MaskedRegion | undefined {
  if (source[pos] !== '%') {
    return undefined;
  }
  // Escaped \% — not a comment.
  if (pos > 0 && source[pos - 1] === '\\') {
    return undefined;
  }
  let i = pos + 1;
  while (i < source.length && source[i] !== '\n') {
    i++;
  }
  // Include the newline so we don't join lines.
  return { start: pos, end: i };
}

/**
 * Detect a LaTeX control sequence (`\command`) starting at `pos`.
 * A control sequence is `\` followed by one or more ASCII letters.
 * If followed by `[` (optional argument) and/or `{...}` (mandatory argument),
 * those are consumed as well.
 */
function tryControlSequence(source: string, pos: number): MaskedRegion | undefined {
  if (source[pos] !== '\\') {
    return undefined;
  }
  // Check the next character is a letter (or @ for @-commands).
  if (pos + 1 >= source.length) {
    return undefined;
  }
  const next = source[pos + 1];
  if (!isAsciiLetter(next) && next !== '@') {
    return undefined;
  }

  let i = pos + 1;
  // Consume the command name (letters + @).
  while (i < source.length && (isAsciiLetter(source[i]) || source[i] === '@')) {
    i++;
  }
  // Consume optional argument in brackets [...].
  // Do NOT consume trailing whitespace — it belongs to the prose, not the command.
  if (i < source.length && source[i] === '[') {
    i = skipBalanced(source, i, '[', ']');
  }
  // Consume mandatory argument in braces {...} (handles nesting).
  if (i < source.length && source[i] === '{') {
    i = skipBalanced(source, i, '{', '}');
  }
  return { start: pos, end: i };
}

/** Detect a `\begin{env}` or `\end{env}` marker. */
function tryBeginEnd(source: string, pos: number): MaskedRegion | undefined {
  const beginMarker = '\\begin';
  const endMarker = '\\end';
  if (source.startsWith(beginMarker, pos)) {
    const after = pos + beginMarker.length;
    const region = consumeBraceGroup(source, after);
    if (region) {
      return { start: pos, end: region.end };
    }
  }
  if (source.startsWith(endMarker, pos)) {
    const after = pos + endMarker.length;
    const region = consumeBraceGroup(source, after);
    if (region) {
      return { start: pos, end: region.end };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * Skip a balanced group starting at `pos` where `source[pos] === open`.
 * Returns the index after the closing `close` character.
 * Handles nested groups.
 */
function skipBalanced(source: string, pos: number, open: string, close: string): number {
  if (pos >= source.length || source[pos] !== open) {
    return pos;
  }
  let depth = 1;
  let i = pos + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '\\') {
      i += 2; // skip escaped character
      continue;
    }
    if (source[i] === open) {
      depth++;
    } else if (source[i] === close) {
      depth--;
    }
    i++;
  }
  return i;
}

/**
 * Consume a brace group `{...}` starting at or after `pos`.
 * Skips leading whitespace before the opening brace.
 */
function consumeBraceGroup(source: string, pos: number): MaskedRegion | undefined {
  let i = pos;
  while (i < source.length && source[i] === ' ') {
    i++;
  }
  if (i >= source.length || source[i] !== '{') {
    return undefined;
  }
  const end = skipBalanced(source, i, '{', '}');
  return { start: pos, end };
}

// ---------------------------------------------------------------------------
// Main masking function
// ---------------------------------------------------------------------------

/**
 * Mask LaTeX control sequences, math, and comments in `source`, producing a
 * prose-only string and a source-offset map. The map translates character
 * positions in the masked string back to positions in the original source so
 * that diagnostics land on the correct characters.
 *
 * Masking priority (first match wins at each position):
 * 1. Display math `$$...$$`
 * 2. Inline math `$...$`
 * 3. Comments `%...`
 * 4. `\begin{env}` / `\end{env}` markers
 * 5. Control sequences `\command[...]{...}`
 *
 * Everything else (prose, whitespace, newlines) passes through unchanged.
 */
export function maskLaTeX(source: string): MaskResult {
  const maskedChars: string[] = [];
  const sourceMap: number[] = [];
  let i = 0;

  while (i < source.length) {
    // Try each masking pattern in priority order.
    const region =
      tryDisplayMath(source, i) ??
      tryInlineMath(source, i) ??
      tryComment(source, i) ??
      tryBeginEnd(source, i) ??
      tryControlSequence(source, i);

    if (region) {
      // Skip the masked region entirely.
      i = region.end;
      continue;
    }

    // Prose character — keep it and record the mapping.
    maskedChars.push(source[i]);
    sourceMap.push(i);
    i++;
  }

  return { masked: maskedChars.join(''), sourceMap };
}
