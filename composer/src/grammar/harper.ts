/**
 * Grammar engine — slice 7, ported approach from V1 `src/grammar/` (ADR-005).
 *
 * harper.js (WASM) linting behind a thin backend seam so tests use a fake (or
 * node-side `LocalLinter`) and the app uses `WorkerLinter` off the main
 * thread. Grammar is LOCAL ONLY — nothing leaves the device and nothing is
 * journaled (non-declarable assistance per ADR-002).
 *
 * The composer is plain prose, so the V1 LaTeX masking pipeline (and its
 * word-fusion bug) is deliberately not ported.
 */

import type { Diagnostic } from '@codemirror/lint';

/** A plain, serializable lint — decoupled from harper's WASM classes. */
export interface GrammarLint {
  from: number;
  to: number;
  message: string;
  kind: string;
}

export interface GrammarBackend {
  setup(): Promise<void>;
  lint(text: string): Promise<GrammarLint[]>;
}

/** The structural subset of a harper.js `Linter` the backend needs. */
export interface HarperLinterLike {
  setup(): Promise<void>;
  lint(
    text: string,
    options?: { language?: 'plaintext' | 'markdown' | 'typst' },
  ): Promise<
    {
      span(): { start: number; end: number };
      message(): string;
      lint_kind_pretty(): string;
    }[]
  >;
}

/** Wrap a harper.js linter (Local or Worker) as a `GrammarBackend`. */
export function harperBackend(linter: HarperLinterLike): GrammarBackend {
  return {
    setup: () => linter.setup(),
    async lint(text: string): Promise<GrammarLint[]> {
      const lints = await linter.lint(text, { language: 'plaintext' });
      return lints.map((lint) => {
        const span = lint.span();
        return {
          from: span.start,
          to: span.end,
          message: lint.message(),
          kind: lint.lint_kind_pretty(),
        };
      });
    },
  };
}

/**
 * Map grammar lints to CodeMirror diagnostics. Severity is always "info" —
 * grammar is a commodity assist, never a grade. Ranges are clamped to the
 * document so a stale lint can't crash the lint plugin.
 */
export function toDiagnostics(lints: readonly GrammarLint[], docLength: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const lint of lints) {
    const from = Math.max(0, Math.min(lint.from, docLength));
    const to = Math.max(from, Math.min(lint.to, docLength));
    if (to === from) continue;
    diagnostics.push({
      from,
      to,
      severity: 'info',
      source: `Harper · ${lint.kind}`,
      message: lint.message,
    });
  }
  return diagnostics;
}
