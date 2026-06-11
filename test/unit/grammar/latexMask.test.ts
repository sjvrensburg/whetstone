/**
 * Unit tests for LaTeX masking (src/grammar/latexMask.ts).
 *
 * Verifies:
 * - LaTeX control sequences, math, and comments are masked out.
 * - Prose characters pass through unchanged.
 * - The source-offset map maps masked positions back to correct source indices.
 * - Edge cases: unclosed math, nested braces, escaped characters.
 */

import { describe, it, expect } from 'vitest';
import { maskLaTeX } from '../../../src/grammar/latexMask';

describe('latexMask', () => {
  // -------------------------------------------------------------------------
  // Prose passthrough
  // -------------------------------------------------------------------------

  it('passes plain prose through unchanged', () => {
    const source = 'Hello world, this is prose.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe(source);
    expect(result.sourceMap).toEqual(source.split('').map((_, i) => i));
  });

  it('preserves whitespace and newlines in prose', () => {
    const source = 'Line one\nLine two\n';
    const result = maskLaTeX(source);
    expect(result.masked).toBe(source);
  });

  // -------------------------------------------------------------------------
  // Inline math $...$
  // -------------------------------------------------------------------------

  it('masks inline math $...$', () => {
    const source = 'The value $x^2$ is positive.';
    const result = maskLaTeX(source);
    // The masked text should only contain the prose around the math.
    expect(result.masked).toBe('The value  is positive.');
    // The source map should skip the math region.
    expect(result.sourceMap).toEqual([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9, // "The value "
      // $x^2$ skipped (indices 10-14)
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      23,
      24,
      25,
      26,
      27, // " is positive."
    ]);
  });

  it('masks multiple inline math expressions', () => {
    const source = 'If $a$ and $b$ then $c$.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('If  and  then .');
  });

  // -------------------------------------------------------------------------
  // Display math $$...$$
  // -------------------------------------------------------------------------

  it('masks display math $$...$$', () => {
    const source = 'Before\n$$E = mc^2$$\nAfter';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('Before\n\nAfter');
  });

  it('distinguishes display math from inline math', () => {
    const source = '$$E=mc^2$$.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('.');
  });

  // -------------------------------------------------------------------------
  // Control sequences
  // -------------------------------------------------------------------------

  it('masks bare control sequences', () => {
    const source = 'Use \\textbf to bold.';
    const result = maskLaTeX(source);
    // \textbf (without braces) masks the command only, not trailing whitespace.
    expect(result.masked).toBe('Use  to bold.');
  });

  it('masks control sequences with brace arguments', () => {
    const source = 'This is \\textbf{important}.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('This is .');
  });

  it('masks control sequences with optional arguments', () => {
    const source = '\\cite[pp. 42]{smith2020} said so.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe(' said so.');
  });

  it('masks nested braces in control sequence arguments', () => {
    const source = '\\footnote{See \\textem{Chapter 1}} here.';
    const result = maskLaTeX(source);
    expect(result.masked).toBe(' here.');
  });

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  it('masks line comments', () => {
    const source = 'Prose % this is a comment\nMore prose';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('Prose \nMore prose');
  });

  it('does not mask escaped percent', () => {
    const source = '50\\% of the time';
    const result = maskLaTeX(source);
    // The \command sequence \\% gets masked (backslash + % isn't a valid
    // control sequence in our parser — but \% is handled by the control
    // sequence parser). Let's check what actually happens:
    // \% → \ followed by % (not a letter) → not masked as control sequence.
    // Then % is checked as comment → but we check for \% escape first.
    // Actually, let's verify: \% → tryControlSequence sees \ then % (not a letter)
    // → returns undefined. Then tryComment sees % at pos 2, but pos 1 is \
    // → escaped, returns undefined.
    // So \% stays in the output as two characters.
    // Hmm, but then \% at positions [1,2]: \ is just a character, % is checked.
    // The backslash at position 1 — tryControlSequence sees \ at pos 1, next char is % (not letter).
    // So \ at pos 1 stays as-is in the output. Then % at pos 2 — tryComment checks
    // if pos 1 is \ → yes, so it's escaped. Stays as-is.
    expect(result.masked).toBe('50\\% of the time');
  });

  // -------------------------------------------------------------------------
  // begin/end markers
  // -------------------------------------------------------------------------

  it('masks \\begin{environment} markers', () => {
    const source = '\\begin{equation}x + y\\end{equation}';
    const result = maskLaTeX(source);
    // \begin{equation} is masked, x + y stays, \end{equation} is masked
    expect(result.masked).toBe('x + y');
  });

  // -------------------------------------------------------------------------
  // Offset map correctness
  // -------------------------------------------------------------------------

  it('source map maps back to correct source positions', () => {
    const source = 'A $B$ C';
    //            0 1234 56
    // Masked:    "A  C"
    // SourceMap: [0, 1, 5, 6]
    const result = maskLaTeX(source);
    expect(result.masked).toBe('A  C');
    expect(result.sourceMap).toEqual([0, 1, 5, 6]);

    // Verify: masked[2] = ' ' corresponds to source[5] = ' '
    // masked[3] = 'C' corresponds to source[6] = 'C'
    expect(source[result.sourceMap[2]]).toBe(' ');
    expect(source[result.sourceMap[3]]).toBe('C');
  });

  it('a lint in masked text maps back to the correct source character', () => {
    // Source: "This \textbf{word} has $x$ errors."
    // \textbf{word} masked, $x$ masked
    // Masked: "This  has  errors."
    const source = 'This \\textbf{word} has $x$ errors.';
    const result = maskLaTeX(source);

    expect(result.masked).toBe('This  has  errors.');

    // "errors" starts at masked index 11, source index 27
    const errorStart = result.masked.indexOf('errors');
    expect(errorStart).toBe(11);
    expect(result.sourceMap[errorStart]).toBe(27);
    expect(source.slice(result.sourceMap[errorStart])).toBe('errors.');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles empty source', () => {
    const result = maskLaTeX('');
    expect(result.masked).toBe('');
    expect(result.sourceMap).toEqual([]);
  });

  it('handles unclosed inline math (masks to end)', () => {
    const source = 'Text $unclosed math';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('Text ');
  });

  it('handles unclosed display math (masks to end)', () => {
    const source = 'Text $$unclosed';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('Text ');
  });

  it('handles a document-like snippet', () => {
    const source = `\\documentclass{article}
\\begin{document}
The cat sat on the mat.
\\end{document}`;
    const result = maskLaTeX(source);
    expect(result.masked).toContain('The cat sat on the mat.');
    expect(result.masked).not.toContain('\\documentclass');
    expect(result.masked).not.toContain('\\begin');
    expect(result.masked).not.toContain('\\end');
  });

  it('handles consecutive control sequences', () => {
    const source = '\\textbf{A}\\textit{B}';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('');
  });

  // -------------------------------------------------------------------------
  // Word-boundary preservation (no fusion across masked regions)
  // -------------------------------------------------------------------------

  it('inserts a separator so a command between two words does not fuse them', () => {
    // Without a separator, `foo\emph{x}bar` masks to `foobar`, which the linter
    // would flag as a single bogus word.
    const source = 'foo\\emph{x}bar';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('foo bar');
    // The sentinel space maps to the start of the masked region (the `\`).
    const spaceIdx = result.masked.indexOf(' ');
    expect(source[result.sourceMap[spaceIdx]]).toBe('\\');
    // `bar` still maps back to its true source offset (foo=0..2, \emph{x}=3..10).
    const barIdx = result.masked.indexOf('bar');
    expect(result.sourceMap[barIdx]).toBe(11);
    expect(source.slice(result.sourceMap[barIdx])).toBe('bar');
  });

  it('inserts a separator so inline math between two words does not fuse them', () => {
    const source = 'a$x$b';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('a b');
  });

  it('does not insert a separator when the command is already space-delimited', () => {
    // The surrounding spaces are prose and already preserved — no extra space.
    const source = 'foo \\emph{x} bar';
    const result = maskLaTeX(source);
    expect(result.masked).toBe('foo  bar');
  });

  it('does not insert a separator next to punctuation', () => {
    const source = 'end\\emph{x}.';
    const result = maskLaTeX(source);
    // `.` is not a word character, so no fusion risk and no separator.
    expect(result.masked).toBe('end.');
  });

  it('keeps the source map monotonic when a separator is inserted', () => {
    const source = 'foo\\emph{x}bar';
    const result = maskLaTeX(source);
    for (let i = 1; i < result.sourceMap.length; i++) {
      expect(result.sourceMap[i]).toBeGreaterThan(result.sourceMap[i - 1]);
    }
  });
});
