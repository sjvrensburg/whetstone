import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

// These tests exercise the real build/run configs end to end, so they spawn
// child processes and need a generous timeout.
describe('build + dev-CLI tooling (npm scripts)', () => {
  it('the build config produces the extension and CLI bundle artifacts', async () => {
    const result = await run(process.execPath, ['esbuild.js']);
    expect(result.code, result.stderr).toBe(0);

    const extensionBundle = resolve(ROOT, 'dist/extension.js');
    const cliBundle = resolve(ROOT, 'dist/dev/cli.js');
    expect(existsSync(extensionBundle)).toBe(true);
    expect(existsSync(cliBundle)).toBe(true);
    expect(statSync(extensionBundle).size).toBeGreaterThan(0);
    expect(statSync(cliBundle).size).toBeGreaterThan(0);
  }, 120_000);

  it('the dev CLI runs via its npm script and exits cleanly with no VS Code host', async () => {
    const result = await run('npm', ['run', '--silent', 'dev']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('scaffold ready');
  }, 120_000);
});
