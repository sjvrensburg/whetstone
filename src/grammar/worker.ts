/**
 * Linter backend for the grammar engine (ADR-005).
 *
 * Provides the `LinterBackend` interface and a `DirectLinterBackend` that
 * wraps harper.js `LocalLinter`. The interface abstraction allows:
 *
 * 1. Unit tests to inject a deterministic mock linter without WASM.
 * 2. Future migration to a Node.js `worker_threads` backend for truly
 *    off-thread linting (the current `LocalLinter.lint()` is async and
 *    already yields to the event loop, so the direct backend is safe for V1).
 *
 * This module serializes harper.js `Lint` objects into plain `SerializedLint`
 * values so they can cross boundaries without holding WASM references.
 *
 * Note: harper.js types are declared structurally here (not imported) because
 * the package uses `exports` in its package.json, which the project's
 * `moduleResolution: "node"` does not support. esbuild handles the imports
 * correctly at runtime; these structural types keep type-checking working.
 */

import type { SerializedLint } from './diagnostics';

// ---------------------------------------------------------------------------
// Structural types matching harper.js runtime objects
// ---------------------------------------------------------------------------

/** Matches the harper.js `Span` WASM class (start/end character indices). */
interface HarperSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Matches the harper.js `Lint` WASM class. Methods extract data from the
 * WASM object so it can be serialized before the object is freed.
 */
interface HarperLint {
  span(): HarperSpan;
  get_problem_text(): string;
  lint_kind(): string;
  lint_kind_pretty(): string;
  message(): string;
  suggestion_count(): number;
  suggestions(): unknown[];
  free(): void;
}

/** Matches the harper.js `LintOptions` interface. */
interface HarperLintOptions {
  language?: 'plaintext' | 'markdown' | 'typst';
  regex_mask?: string;
  forceAllHeadings?: boolean;
  dedup?: boolean;
}

/** Matches the harper.js `Linter` interface. */
interface HarperLinter {
  setup(): Promise<void>;
  lint(text: string, options?: HarperLintOptions): Promise<HarperLint[]>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Linter backend interface
// ---------------------------------------------------------------------------

/** Options for a single lint pass. */
export interface LintRequest {
  /** The text to lint (possibly masked). */
  readonly text: string;
  /** The language to lint as (affects Harper's parser). */
  readonly language: 'plaintext' | 'markdown';
}

/** The abstract linter backend the engine depends on. */
export interface LinterBackend {
  /** Perform a lint pass and return serialized results. */
  lint(req: LintRequest): Promise<readonly SerializedLint[]>;
  /** Perform any async setup (WASM compilation, etc.). */
  setup(): Promise<void>;
  /** Release resources held by the backend. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Convert a harper.js `Lint` object to a plain `SerializedLint`.
 * This must happen while the WASM `Lint` is still alive (before it's freed).
 */
export function serializeLint(lint: HarperLint): SerializedLint {
  const span = lint.span();
  return {
    span: { start: span.start, end: span.end },
    problemText: lint.get_problem_text(),
    lintKind: lint.lint_kind(),
    lintKindPretty: lint.lint_kind_pretty(),
    message: lint.message(),
    suggestionCount: lint.suggestion_count(),
  };
}

/**
 * Serialize all lints from a Harper lint pass.
 * Frees the WASM `Lint` objects after extraction to avoid leaking WASM memory.
 */
export function serializeLints(lints: HarperLint[]): SerializedLint[] {
  const result = lints.map(serializeLint);
  // Free the WASM lint objects now that we've extracted the data.
  for (const lint of lints) {
    lint.free();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Direct (in-process) backend using LocalLinter
// ---------------------------------------------------------------------------

/**
 * A linter backend that uses harper.js `LocalLinter` directly in the
 * extension host process. The `lint()` call is async and yields to the
 * event loop, so it does not block UI responsiveness for typical documents.
 *
 * Accepts a pre-constructed `Linter` instance so unit tests can substitute
 * a mock without touching this module.
 */
export class DirectLinterBackend implements LinterBackend {
  private readonly linter: HarperLinter;
  private ready = false;

  constructor(linter: HarperLinter) {
    this.linter = linter;
  }

  async setup(): Promise<void> {
    if (!this.ready) {
      await this.linter.setup();
      this.ready = true;
    }
  }

  async lint(req: LintRequest): Promise<readonly SerializedLint[]> {
    if (!this.ready) {
      await this.setup();
    }
    const options: HarperLintOptions = {
      language: req.language,
    };
    const lints = await this.linter.lint(req.text, options);
    return serializeLints(lints);
  }

  async dispose(): Promise<void> {
    if (this.ready) {
      await this.linter.dispose();
      this.ready = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — creates a DirectLinterBackend with the real harper.js binary.
// Used at extension activation; unit tests bypass this and inject mocks.
// ---------------------------------------------------------------------------

/**
 * Native dynamic `import()` that bypasses TypeScript's CJS transformation.
 *
 * TypeScript with `module: "commonjs"` converts `import('...')` to
 * `Promise.resolve().then(() => require('...'))`. This fails for packages
 * (like harper.js) that only declare `import` conditions in their package
 * `exports` — `require()` can't resolve them. The `new Function` indirection
 * prevents tsc from rewriting the call, preserving the native `import()`
 * which Node.js supports even from CJS contexts (Node ≥ 12).
 */
const nativeImport = new Function(
  'modulePath',
  'return import(modulePath)',
) as (path: string) => Promise<Record<string, unknown>>;

/**
 * Create a `DirectLinterBackend` using the real harper.js WASM binary.
 *
 * Uses native dynamic `import()` so it works in both esbuild-bundled
 * (extension host) and tsc-compiled CJS (integration tests) contexts.
 */
export async function createDirectBackend(): Promise<DirectLinterBackend> {
  const harper = await nativeImport('harper.js');
  const binaryModule = await nativeImport('harper.js/binary');
  const LocalLinter = harper.LocalLinter as new (init: { binary: unknown }) => HarperLinter;
  const linter = new LocalLinter({ binary: binaryModule.binary });
  return new DirectLinterBackend(linter);
}
