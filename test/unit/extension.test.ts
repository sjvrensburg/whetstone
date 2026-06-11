import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as extension from '../../src/extension';

// `vscode` is aliased to a stub (vitest.config.ts), so the host file imports
// cleanly here. This asserts the activation contract without launching a host;
// the real activation is covered by the integration suite.

describe('extension host module', () => {
  it('exports activate and deactivate', () => {
    expect(typeof extension.activate).toBe('function');
    expect(typeof extension.deactivate).toBe('function');
  });

  it('activate wires commands and views through context.subscriptions', () => {
    const pushed: { dispose(): unknown }[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whetstone-ext-test-'));

    const secretsMap = new Map<string, string>();
    const context = {
      subscriptions: {
        push: (...items: { dispose(): unknown }[]) => {
          pushed.push(...items);
          return pushed.length;
        },
      },
      globalStorageUri: { fsPath: path.join(tmpDir, 'globalStorage') },
      secrets: {
        get: (key: string) => Promise.resolve(secretsMap.get(key)),
        store: (key: string, value: string) => {
          secretsMap.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string) => {
          secretsMap.delete(key);
          return Promise.resolve();
        },
      },
    } as unknown as Parameters<typeof extension.activate>[0];

    try {
      expect(() => extension.activate(context)).not.toThrow();
      // 6 UI commands + 1 friction command + 2 sidebar views + 1 status bar + 1 config listener = 11 disposables.
      expect(pushed).toHaveLength(11);
    } finally {
      // Clean up temp dir.
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deactivate runs without throwing', () => {
    expect(() => extension.deactivate()).not.toThrow();
  });
});
