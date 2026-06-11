/**
 * GrammarEngine facade (ADR-005, Task 05).
 *
 * Orchestrates LaTeX masking → harper.js linting → diagnostics mapping with
 * debounce so rapid edits are coalesced into a single lint pass.
 *
 * The engine is injected into the extension's dependency container and
 * consumed by the diagnostic collection, hover provider, and code actions
 * (tasks 06, 15).
 *
 * Design decisions:
 * - Debounce is configurable (default 300ms, matching the ADR-005 "visible
 *   range + dirty region" priority guidance for V1).
 * - The `LinterBackend` is injected so unit tests provide a deterministic
 *   mock and the real backend is only created at extension activation.
 * - Markdown files are linted natively (Harper handles markdown parsing).
 * - LaTeX files go through the masking pipeline first.
 */

import type { DocumentLanguage } from '../shared/types';
import type { GrammarDiagnostic } from './diagnostics';
import { lintsToDiagnostics, resolveSeverity } from './diagnostics';
import type { LinterBackend } from './worker';
import { maskLaTeX } from './latexMask';

// ---------------------------------------------------------------------------
// Debounce utility
// ---------------------------------------------------------------------------

/**
 * A cancelable debounce wrapper. Calling `call()` schedules the function
 * to run after `delayMs`; subsequent calls reset the timer. Calling
 * `cancel()` prevents the scheduled run.
 */
export class Debounce<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly fn: () => Promise<T>;
  private readonly delayMs: number;
  private pending: Promise<T> | undefined;
  private resolve?: (value: T) => void;

  constructor(fn: () => Promise<T>, delayMs: number) {
    this.fn = fn;
    this.delayMs = delayMs;
  }

  /**
   * Schedule (or reschedule) the debounced call. Returns a promise that
   * resolves with the result of the next executed call.
   */
  call(): Promise<T> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    if (!this.pending) {
      this.pending = new Promise<T>((resolve) => {
        this.resolve = resolve;
      });
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.execute();
    }, this.delayMs);
    return this.pending;
  }

  /** Cancel any pending scheduled call. */
  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Resolve the pending promise with an empty result so callers don't hang.
    if (this.pending && this.resolve) {
      this.resolve([] as unknown as T);
      this.pending = undefined;
      this.resolve = undefined;
    }
  }

  /** Whether a call is currently scheduled (for testing debounce behavior). */
  get isScheduled(): boolean {
    return this.timer !== undefined;
  }

  private async execute(): Promise<void> {
    const current = this.pending;
    const resolve = this.resolve;
    this.pending = undefined;
    this.resolve = undefined;
    if (current && resolve) {
      const result = await this.fn();
      resolve(result);
    }
  }
}

// ---------------------------------------------------------------------------
// Engine public types
// ---------------------------------------------------------------------------

/** A lint result: the diagnostics and the masked text metadata. */
export interface LintResult {
  /** Grammar diagnostics ready for VS Code's DiagnosticCollection. */
  readonly diagnostics: readonly GrammarDiagnostic[];
}

// ---------------------------------------------------------------------------
// GrammarEngine
// ---------------------------------------------------------------------------

/** Default debounce delay in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * The grammar engine facade. Encapsulates masking, linting, and diagnostics
 * mapping behind a single async interface.
 *
 * Usage:
 * 1. Construct with a `LinterBackend` (real or mock).
 * 2. Call `lintDocument()` to produce diagnostics for a document.
 * 3. Call `dispose()` when the extension deactivates.
 */
export class GrammarEngine {
  private readonly backend: LinterBackend;
  private readonly severitySetting: 'hint' | 'info' | 'warning';
  private readonly debounceMs: number;
  private debounce: Debounce<LintResult>;

  /**
   * @param backend    The linter backend (real harper.js or mock for tests).
   * @param severity   The grammar diagnostic severity setting.
   * @param debounceMs Debounce delay in ms (default 300).
   */
  constructor(
    backend: LinterBackend,
    severity: 'hint' | 'info' | 'warning' = 'info',
    debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {
    this.backend = backend;
    this.severitySetting = severity;
    this.debounceMs = debounceMs;
    this.debounce = new Debounce<LintResult>(() => Promise.resolve(emptyResult), debounceMs);
  }

  /** Initialize the backend (WASM compilation, etc.). */
  async setup(): Promise<void> {
    await this.backend.setup();
  }

  /**
   * Lint a document and produce diagnostics. This is the primary API.
   *
   * For Markdown: linted natively by Harper.
   * For LaTeX: masked first, then linted as plaintext, positions mapped back.
   *
   * @param text     The full document text.
   * @param language The document language ('markdown' or 'latex').
   * @returns A `LintResult` with diagnostics.
   */
  async lintDocument(
    text: string,
    language: DocumentLanguage,
  ): Promise<LintResult> {
    if (language === 'latex') {
      return this.lintLatex(text);
    }
    return this.lintMarkdown(text);
  }

  /**
   * Schedule a debounced lint. Rapid successive calls coalesce into one.
   * Returns a promise that resolves with the result of the eventual lint pass.
   */
  scheduleLint(
    text: string,
    language: DocumentLanguage,
  ): Promise<LintResult> {
    this.debounce.cancel();
    this.debounce = new Debounce<LintResult>(
      () => this.lintDocument(text, language),
      this.debounceMs,
    );
    return this.debounce.call();
  }

  /** Cancel any pending debounced lint. */
  cancelPending(): void {
    this.debounce.cancel();
  }

  /** Release backend resources. */
  async dispose(): Promise<void> {
    this.debounce.cancel();
    await this.backend.dispose();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async lintMarkdown(text: string): Promise<LintResult> {
    const lints = await this.backend.lint({ text, language: 'markdown' });
    const severity = resolveSeverity(this.severitySetting);
    const diagnostics = lintsToDiagnostics(lints, text, null, severity);
    return { diagnostics };
  }

  private async lintLatex(text: string): Promise<LintResult> {
    const maskResult = maskLaTeX(text);
    const lints = await this.backend.lint({
      text: maskResult.masked,
      language: 'plaintext',
    });
    const severity = resolveSeverity(this.severitySetting);
    const diagnostics = lintsToDiagnostics(lints, text, maskResult.sourceMap, severity);
    return { diagnostics };
  }
}

const emptyResult: LintResult = { diagnostics: [] };

// ---------------------------------------------------------------------------
// Factory — for extension activation
// ---------------------------------------------------------------------------

/**
 * Create a fully-initialized `GrammarEngine` with the real harper.js backend.
 * Called during extension activation; unit tests construct engines with mock
 * backends directly.
 */
export async function createGrammarEngine(
  severity: 'hint' | 'info' | 'warning' = 'info',
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): Promise<GrammarEngine> {
  const { createDirectBackend } = await import('./worker');
  const backend = await createDirectBackend();
  return new GrammarEngine(backend, severity, debounceMs);
}
