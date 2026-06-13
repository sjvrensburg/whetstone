import { describe, expect, it } from 'vitest';
import { harperBackend, toDiagnostics, type GrammarLint } from '../src/grammar/harper';

describe('toDiagnostics', () => {
  const lint = (overrides: Partial<GrammarLint> = {}): GrammarLint => ({
    from: 4,
    to: 8,
    message: 'Possible spelling mistake.',
    kind: 'Spelling',
    ...overrides,
  });

  it('maps lints to info-severity diagnostics', () => {
    const [d] = toDiagnostics([lint()], 100);
    expect(d).toMatchObject({
      from: 4,
      to: 8,
      severity: 'info',
      source: 'Harper · Spelling',
      message: 'Possible spelling mistake.',
    });
  });

  it('clamps out-of-range spans and drops empty ones', () => {
    const diagnostics = toDiagnostics(
      [lint({ from: 90, to: 200 }), lint({ from: 150, to: 160 })],
      100,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ from: 90, to: 100 });
  });
});

describe('harperBackend (real WASM, LocalLinter)', () => {
  it('lints a sentence with a real grammar error', async () => {
    const { LocalLinter } = await import('harper.js');
    const { binary } = await import('harper.js/binary');
    const backend = harperBackend(new LocalLinter({ binary }));
    await backend.setup();

    const lints = await backend.lint('She were going too the libary yesterday.');
    expect(lints.length).toBeGreaterThan(0);
    for (const l of lints) {
      expect(l.to).toBeGreaterThan(l.from);
      expect(l.message.length).toBeGreaterThan(0);
    }

    const clean = await backend.lint('She was going to the library yesterday.');
    expect(clean.length).toBeLessThan(lints.length);
  }, 60_000);
});
