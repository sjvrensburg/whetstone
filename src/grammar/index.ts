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
 * Public surface (task 06):
 * - `DismissalStore` — persistent per-workspace lint dismissal store
 * - `GrammarHoverProvider` — hover over grammar diagnostics
 * - `GrammarCodeActionProvider` — "dismiss as false positive" quick-fix
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

export { DismissalStore, computeDismissalKey, lintToIdentity, filterDismissed } from './dismissals';
export type { LintIdentity, DismissalStorage } from './dismissals';

export { GrammarHoverProvider, formatHoverContent, diagnosticToHoverData } from './hover';
export type { HoverData } from './hover';

export {
  GrammarCodeActionProvider,
  createDismissAction,
  createExplainRuleAction,
  handleDismissCommand,
  DISMISS_COMMAND_ID,
  EXPLAIN_RULE_COMMAND_ID,
} from './codeActions';
export type { DismissCommandArgs, ExplainRuleCommandArgs } from './codeActions';

export { explainRule, containsRewrite } from './explainRule';
export type {
  ExplainRuleInput,
  ExplainRuleResult,
  ExplainRuleError,
  ExplainRuleErrorKind,
  ExplainRuleDeps,
} from './explainRule';

export { DirectLinterBackend, serializeLint, serializeLints } from './worker';
export type { LinterBackend, LintRequest } from './worker';
