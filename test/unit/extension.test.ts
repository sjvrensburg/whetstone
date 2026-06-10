import { describe, it, expect } from 'vitest';
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
    const context = {
      subscriptions: {
        push: (...items: { dispose(): unknown }[]) => {
          pushed.push(...items);
          return pushed.length;
        },
      },
    } as unknown as Parameters<typeof extension.activate>[0];

    expect(() => extension.activate(context)).not.toThrow();
    // 3 no-op commands + 2 sidebar views registered as disposables.
    expect(pushed).toHaveLength(5);
  });

  it('deactivate runs without throwing', () => {
    expect(() => extension.deactivate()).not.toThrow();
  });
});
