/**
 * Unit tests for lint → diagnostic mapping (src/grammar/diagnostics.ts).
 *
 * Verifies:
 * - Lints are mapped to GrammarDiagnostic objects.
 * - Severity is always hint or info, never error or warning.
 * - Source-offset map translates positions correctly.
 * - Line/character positions are computed correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  lintsToDiagnostics,
  resolveSeverity,
  type SerializedLint,
} from '../../../src/grammar/diagnostics';

describe('resolveSeverity', () => {
  it('resolves "hint" to 2', () => {
    expect(resolveSeverity('hint')).toBe(2);
  });

  it('resolves "info" to 3', () => {
    expect(resolveSeverity('info')).toBe(3);
  });

  it('clamps "warning" to info (3) — never warning', () => {
    expect(resolveSeverity('warning')).toBe(3);
  });

  it('never returns error (0) or warning (1)', () => {
    for (const setting of ['hint', 'info', 'warning'] as const) {
      const severity = resolveSeverity(setting);
      expect(severity).toBeGreaterThanOrEqual(2); // not error (0) or warning (1)
      expect(severity).toBeLessThanOrEqual(3); // not error
    }
  });
});

describe('lintsToDiagnostics', () => {
  const sampleLint: SerializedLint = {
    span: { start: 0, end: 4 },
    problemText: 'Thsi',
    lintKind: 'Spelling',
    lintKindPretty: 'Spelling',
    message: 'Did you mean "This"?',
    suggestionCount: 1,
  };

  it('maps a lint to a GrammarDiagnostic', () => {
    const source = 'Thsi is a test.';
    const diags = lintsToDiagnostics([sampleLint], source, null, 3);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('Did you mean "This"?');
    expect(diags[0].severity).toBe(3); // info
    expect(diags[0].source).toBe('Harper');
    expect(diags[0].code).toBe('Spelling');
  });

  it('computes correct line and character positions', () => {
    const source = 'first line\nsecond line';
    const lint: SerializedLint = {
      span: { start: 11, end: 17 },
      problemText: 'second',
      lintKind: 'Spelling',
      lintKindPretty: 'Spelling',
      message: 'Issue',
      suggestionCount: 0,
    };
    const diags = lintsToDiagnostics([lint], source, null, 3);
    expect(diags[0].range.start).toEqual({ line: 1, character: 0 });
    expect(diags[0].range.end).toEqual({ line: 1, character: 6 });
  });

  it('always produces hint or info severity, never error or warning', () => {
    const diags = lintsToDiagnostics([sampleLint], 'Thsi is test', null, 3);
    for (const diag of diags) {
      expect(diag.severity).toBeGreaterThanOrEqual(2);
      expect(diag.severity).toBeLessThanOrEqual(3);
    }
  });

  it('translates positions through source map (LaTeX)', () => {
    // Source:  "A $B$ C"
    // Indices: 0123456
    // Masked:  "A  C"
    // Map:     [0, 1, 5, 6]
    // A lint at masked position 3-4 ("C") should map to source position 6-7.
    const sourceMap = [0, 1, 5, 6];
    const source = 'A $B$ C';
    const lint: SerializedLint = {
      span: { start: 3, end: 4 },
      problemText: 'C',
      lintKind: 'Grammar',
      lintKindPretty: 'Grammar',
      message: 'Issue with C',
      suggestionCount: 0,
    };
    const diags = lintsToDiagnostics([lint], source, sourceMap, 3);
    expect(diags[0].range.start).toEqual({ line: 0, character: 6 });
    expect(diags[0].range.end).toEqual({ line: 0, character: 7 });
  });

  it('handles empty lint array', () => {
    const diags = lintsToDiagnostics([], 'text', null, 2);
    expect(diags).toEqual([]);
  });

  it('clamps out-of-bounds spans to source length', () => {
    const source = 'short';
    const lint: SerializedLint = {
      span: { start: 0, end: 100 },
      problemText: 'short',
      lintKind: 'Style',
      lintKindPretty: 'Style',
      message: 'Too long?',
      suggestionCount: 0,
    };
    const diags = lintsToDiagnostics([lint], source, null, 2);
    // Clamped end to source.length (5).
    expect(diags[0].range.end.character).toBe(5);
  });

  it('handles multi-line source for position calculation', () => {
    const source = 'line1\nline2\nline3';
    const lint: SerializedLint = {
      span: { start: 12, end: 17 },
      problemText: 'line3',
      lintKind: 'Spelling',
      lintKindPretty: 'Spelling',
      message: 'Check',
      suggestionCount: 0,
    };
    const diags = lintsToDiagnostics([lint], source, null, 2);
    expect(diags[0].range.start).toEqual({ line: 2, character: 0 });
    expect(diags[0].range.end).toEqual({ line: 2, character: 5 });
  });

  it('maps multiple lints to separate diagnostics', () => {
    const lints: SerializedLint[] = [
      { ...sampleLint, span: { start: 0, end: 4 } },
      { ...sampleLint, span: { start: 5, end: 7 } },
    ];
    const diags = lintsToDiagnostics(lints, 'Thsi is test', null, 3);
    expect(diags).toHaveLength(2);
    expect(diags[0].range.start.character).toBe(0);
    expect(diags[1].range.start.character).toBe(5);
  });
});
