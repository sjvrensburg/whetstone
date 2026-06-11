/**
 * `grammar/` — harper.js (WASM) linting, LaTeX masking, lint->diagnostic
 * mapping (Component Overview, ADR-005).
 *
 * Public surface (task 05):
 * - `GrammarEngine` — facade that coordinates masking → linting → diagnostics
 * - `maskLaTeX` — LaTeX masking with source-offset map
 * - `lintsToDiagnostics` — Harper lints → VS Code hint/info diagnostics
 * - `DirectLinterBackend` / `LinterBackend` — linter abstraction
 *
 * Consumed by task 06 (hover, dismiss), task 15 (explain-this-rule).
 */

export { GrammarEngine, createGrammarEngine, Debounce } from './engine';
export type { LintResult } from './engine';

export { maskLaTeX } from './latexMask';
export type { MaskResult } from './latexMask';

export { lintsToDiagnostics, resolveSeverity } from './diagnostics';
export type {
  GrammarDiagnostic,
  GrammarDiagnosticSeverity,
  SerializedLint,
  DocumentPosition,
  DocumentRange,
} from './diagnostics';

export { DirectLinterBackend, serializeLint, serializeLints } from './worker';
export type { LinterBackend, LintRequest } from './worker';
