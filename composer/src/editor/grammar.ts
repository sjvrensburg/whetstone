/**
 * CodeMirror wiring for the grammar engine (slice 7). `@codemirror/lint`
 * provides the debounce (its `delay`) and the underline/tooltip UI; the
 * backend does the work off the main thread (WorkerLinter).
 */

import { linter } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { toDiagnostics, type GrammarBackend } from '../grammar/harper';

export const GRAMMAR_LINT_DELAY_MS = 600;

export function grammarExtension(backend: GrammarBackend): Extension {
  return linter(
    async (view) => {
      const text = view.state.doc.toString();
      if (text.trim().length === 0) return [];
      const lints = await backend.lint(text);
      return toDiagnostics(lints, view.state.doc.length);
    },
    { delay: GRAMMAR_LINT_DELAY_MS },
  );
}
