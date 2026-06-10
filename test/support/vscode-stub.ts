/**
 * Minimal `vscode` stub for headless unit tests. The real `vscode` module only
 * exists inside the Extension Host, so vitest aliases imports of it to this file
 * (see vitest.config.ts). Only the runtime members the host file actually calls
 * are provided; full API surface is exercised by the integration harness.
 */

export interface Disposable {
  dispose(): void;
}

function makeDisposable(): Disposable {
  return { dispose: () => undefined };
}

export const commands = {
  registerCommand(_id: string, _handler: (...args: unknown[]) => unknown): Disposable {
    return makeDisposable();
  },
};

export const window = {
  registerTreeDataProvider(_viewId: string, _provider: unknown): Disposable {
    return makeDisposable();
  },
};

/** Minimal `WorkspaceConfiguration`: always returns the caller's default, which
 * models an unset configuration (the live API is exercised by integration). */
export interface WorkspaceConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

export const workspace = {
  getConfiguration(_section?: string): WorkspaceConfiguration {
    return {
      get<T>(_key: string, defaultValue: T): T {
        return defaultValue;
      },
    };
  },
};

export class TreeItem {}
