/**
 * Unit tests for the linter backend / worker module (src/grammar/worker.ts).
 *
 * Verifies the DirectLinterBackend construction, serialization, and the
 * factory function. Uses mock objects where harper.js WASM is needed.
 */

import { describe, it, expect } from 'vitest';
import { serializeLint, DirectLinterBackend } from '../../../src/grammar/worker';

// ---------------------------------------------------------------------------
// serializeLint tests (using a mock Lint object)
// ---------------------------------------------------------------------------

describe('serializeLint', () => {
  it('extracts data from a Lint-like object', () => {
    const mockLint = {
      span: () => ({ start: 5, end: 10 }),
      get_problem_text: () => 'teh',
      lint_kind: () => 'Spelling',
      lint_kind_pretty: () => 'Spelling',
      message: () => 'Did you mean "the"?',
      suggestion_count: () => 1,
      suggestions: () => [],
      free: () => {},
    };

    const result = serializeLint(mockLint as any);
    expect(result).toEqual({
      span: { start: 5, end: 10 },
      problemText: 'teh',
      lintKind: 'Spelling',
      lintKindPretty: 'Spelling',
      message: 'Did you mean "the"?',
      suggestionCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// DirectLinterBackend tests (using a mock Linter)
// ---------------------------------------------------------------------------

describe('DirectLinterBackend', () => {
  it('calls setup on the underlying linter', async () => {
    let setupCalled = false;
    const mockLinter = {
      setup: async () => {
        setupCalled = true;
      },
      lint: async () => [],
      dispose: async () => {},
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.setup();
    expect(setupCalled).toBe(true);
    await backend.dispose();
  });

  it('serializes lints from the underlying linter', async () => {
    const mockLint = {
      span: () => ({ start: 0, end: 3 }),
      get_problem_text: () => 'teh',
      lint_kind: () => 'Spelling',
      lint_kind_pretty: () => 'Spelling',
      message: () => 'Did you mean "the"?',
      suggestion_count: () => 1,
      suggestions: () => [],
      free: () => {},
    };
    const mockLinter = {
      setup: async () => {},
      lint: async () => [mockLint],
      dispose: async () => {},
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.setup();

    const lints = await backend.lint({ text: 'teh cat', language: 'plaintext' });
    expect(lints).toHaveLength(1);
    expect(lints[0].problemText).toBe('teh');
    expect(lints[0].message).toBe('Did you mean "the"?');
    await backend.dispose();
  });

  it('auto-setup on first lint if setup not called', async () => {
    let setupCalled = false;
    const mockLinter = {
      setup: async () => {
        setupCalled = true;
      },
      lint: async () => [],
      dispose: async () => {},
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.lint({ text: 'text', language: 'plaintext' });
    expect(setupCalled).toBe(true);
    await backend.dispose();
  });

  it('passes lint options correctly', async () => {
    const received: any[] = [];
    const mockLinter = {
      setup: async () => {},
      lint: async (_text: string, options: any) => {
        received.push({ _text, options });
        return [];
      },
      dispose: async () => {},
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.lint({ text: '# Hello', language: 'markdown' });
    expect(received[0]._text).toBe('# Hello');
    expect(received[0].options.language).toBe('markdown');
    await backend.dispose();
  });

  it('calls dispose on the underlying linter', async () => {
    let disposeCalled = false;
    const mockLinter = {
      setup: async () => {},
      lint: async () => [],
      dispose: async () => {
        disposeCalled = true;
      },
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.setup();
    await backend.dispose();
    expect(disposeCalled).toBe(true);
  });

  it('frees WASM lint objects after serialization', async () => {
    let freed = 0;
    const mockLint = {
      span: () => ({ start: 0, end: 3 }),
      get_problem_text: () => 'teh',
      lint_kind: () => 'Spelling',
      lint_kind_pretty: () => 'Spelling',
      message: () => 'Error',
      suggestion_count: () => 0,
      suggestions: () => [],
      free: () => {
        freed++;
      },
    };
    const mockLinter = {
      setup: async () => {},
      lint: async () => [mockLint, mockLint],
      dispose: async () => {},
    };
    const backend = new DirectLinterBackend(mockLinter as any);
    await backend.lint({ text: 'teh', language: 'plaintext' });
    expect(freed).toBe(2);
    await backend.dispose();
  });
});
