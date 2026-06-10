import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCli, CLI_NAME, type CliIO } from '../../src/dev/cli';

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe('runCli (dev-CLI scaffold)', () => {
  let cap: ReturnType<typeof captureIO>;

  beforeEach(() => {
    cap = captureIO();
  });

  it('exits cleanly with no args and reports the scaffold is ready', async () => {
    const code = await runCli([], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('scaffold ready');
    expect(cap.err).toHaveLength(0);
  });

  it('prints help for --help and exits 0', async () => {
    const code = await runCli(['--help'], cap.io);
    expect(code).toBe(0);
    const text = cap.out.join('\n');
    expect(text).toContain(CLI_NAME);
    expect(text).toContain('interactive');
    expect(text).toContain('record');
  });

  it('prints help for -h and exits 0', async () => {
    const code = await runCli(['-h'], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('Usage');
  });

  it('reports an unknown command on stderr and exits non-zero', async () => {
    const code = await runCli(['bogus'], cap.io);
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('unknown command');
  });

  it('has no VS Code host dependency (runs in plain Node)', () => {
    for (const file of ['src/dev/cli.ts', 'src/dev/main.ts']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/from ['"]vscode['"]/);
      expect(source).not.toMatch(/require\(['"]vscode['"]\)/);
    }
  });
});
