/**
 * Unit tests for the GrammarEngine facade (src/grammar/engine.ts).
 *
 * Uses a mock `LinterBackend` so the tests are deterministic, fast,
 * and require no WASM or network.
 *
 * Verifies:
 * - Markdown and LaTeX documents produce diagnostics.
 * - Debounce coalesces rapid calls.
 * - The engine delegates to the backend correctly.
 * - LaTeX masking is applied for 'latex' language.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrammarEngine, Debounce, type LintResult } from '../../../src/grammar/engine';
import type { LinterBackend, LintRequest } from '../../../src/grammar/worker';
import type { SerializedLint } from '../../../src/grammar/diagnostics';

// ---------------------------------------------------------------------------
// Mock linter backend
// ---------------------------------------------------------------------------

/** A linter backend that returns predetermined lints for testing. */
class MockLinterBackend implements LinterBackend {
  private readonly lints: SerializedLint[];
  public readonly requests: LintRequest[] = [];
  public setupCalled = false;
  public disposeCalled = false;

  constructor(lints: SerializedLint[] = []) {
    this.lints = lints;
  }

  async setup(): Promise<void> {
    this.setupCalled = true;
  }

  async lint(req: LintRequest): Promise<readonly SerializedLint[]> {
    this.requests.push(req);
    return this.lints;
  }

  async dispose(): Promise<void> {
    this.disposeCalled = true;
  }
}

/** A sample lint for testing. */
const sampleLint: SerializedLint = {
  span: { start: 0, end: 4 },
  problemText: 'Thsi',
  lintKind: 'Spelling',
  lintKindPretty: 'Spelling',
  message: 'Did you mean "This"?',
  suggestionCount: 1,
};

// ---------------------------------------------------------------------------
// GrammarEngine tests
// ---------------------------------------------------------------------------

describe('GrammarEngine', () => {
  let backend: MockLinterBackend;
  let engine: GrammarEngine;

  beforeEach(() => {
    backend = new MockLinterBackend([sampleLint]);
    engine = new GrammarEngine(backend, 'info');
  });

  afterEach(async () => {
    await engine.dispose();
  });

  it('calls setup on the backend', async () => {
    await engine.setup();
    expect(backend.setupCalled).toBe(true);
  });

  it('produces diagnostics for a Markdown document', async () => {
    const result = await engine.lintDocument('Thsi is a test.', 'markdown');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toBe('Did you mean "This"?');
    expect(result.diagnostics[0].severity).toBe(3); // info
    expect(result.diagnostics[0].source).toBe('Harper');
  });

  it('passes text to backend with language=markdown for Markdown', async () => {
    await engine.lintDocument('Some text', 'markdown');
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0].language).toBe('markdown');
    expect(backend.requests[0].text).toBe('Some text');
  });

  it('masks LaTeX before linting', async () => {
    await engine.lintDocument('Text \\textbf{bold} more', 'latex');
    expect(backend.requests).toHaveLength(1);
    // The masked text should have the control sequence removed.
    expect(backend.requests[0].text).toBe('Text  more');
    expect(backend.requests[0].language).toBe('plaintext');
  });

  it('maps LaTeX lints back to source positions', async () => {
    // Source: "Text \textbf{bold} more text"
    // \textbf{bold} masked → masked: "Text  more text"
    // sourceMap: [0,1,2,3,4, 18,19,20,21, 22,23,24,25,26]
    // "more" at masked 5-8 → source 18-21
    const backend2 = new MockLinterBackend([
      {
        span: { start: 5, end: 9 },
        problemText: 'more',
        lintKind: 'Spelling',
        lintKindPretty: 'Spelling',
        message: 'Check "more"',
        suggestionCount: 0,
      },
    ]);
    const engine2 = new GrammarEngine(backend2, 'info');

    const source = 'Text \\textbf{bold} more text';
    const result = await engine2.lintDocument(source, 'latex');
    // Masked: "Text  more text"
    // SourceMap: [0,1,2,3,4, 18,19,20,21, 22,23,24,25,26]
    // Lint at masked 5-9 → source 18-22
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].range.start.character).toBe(18);
    expect(result.diagnostics[0].range.end.character).toBe(22);
    await engine2.dispose();
  });

  it('respects severity setting', async () => {
    const hintEngine = new GrammarEngine(backend, 'hint');
    const result = await hintEngine.lintDocument('Text', 'markdown');
    expect(result.diagnostics[0].severity).toBe(2); // hint
    await hintEngine.dispose();
  });

  it('never produces error severity', async () => {
    const warningEngine = new GrammarEngine(backend, 'warning');
    const result = await warningEngine.lintDocument('Text', 'markdown');
    // "warning" is clamped to info (3).
    expect(result.diagnostics[0].severity).toBe(3);
    await warningEngine.dispose();
  });

  it('returns empty diagnostics when backend returns no lints', async () => {
    const emptyBackend = new MockLinterBackend([]);
    const emptyEngine = new GrammarEngine(emptyBackend, 'info');
    const result = await emptyEngine.lintDocument('Clean text', 'markdown');
    expect(result.diagnostics).toHaveLength(0);
    await emptyEngine.dispose();
  });

  it('disposes the backend', async () => {
    await engine.dispose();
    expect(backend.disposeCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Debounce tests
// ---------------------------------------------------------------------------

describe('Debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid calls into a single execution', async () => {
    let callCount = 0;
    const debounced = new Debounce(async () => {
      callCount++;
      return { diagnostics: [] };
    }, 100);

    // Fire three rapid calls.
    debounced.call();
    debounced.call();
    debounced.call();

    // Before the timer fires, the function hasn't been called yet.
    expect(callCount).toBe(0);

    // Advance past the debounce window.
    await vi.advanceTimersByTimeAsync(150);

    // Only one execution happened.
    expect(callCount).toBe(1);
  });

  it('returns the result through the promise', async () => {
    const debounced = new Debounce<LintResult>(
      async () => ({ diagnostics: [] }),
      50,
    );

    const promise = debounced.call();
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.diagnostics).toEqual([]);
  });

  it('cancels the pending call', () => {
    let callCount = 0;
    const debounced = new Debounce(async () => {
      callCount++;
      return { diagnostics: [] };
    }, 100);

    debounced.call();
    expect(debounced.isScheduled).toBe(true);

    debounced.cancel();
    expect(debounced.isScheduled).toBe(false);

    // Advance time — the function should not have been called.
    vi.advanceTimersByTime(200);
    expect(callCount).toBe(0);
  });

  it('reports isScheduled correctly', () => {
    const debounced = new Debounce(async () => ({ diagnostics: [] }), 50);

    expect(debounced.isScheduled).toBe(false);
    debounced.call();
    expect(debounced.isScheduled).toBe(true);
    vi.advanceTimersByTime(100);
    expect(debounced.isScheduled).toBe(false);
  });
});
