import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LedgerStore, resolveLedgerDir } from '../../../src/ledger/store';

describe('LedgerStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whetstone-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('appendLine / readLines', () => {
    it('appends and reads back lines', () => {
      const store = new LedgerStore(dir);
      store.appendLine('{"seq":0}');
      store.appendLine('{"seq":1}');

      const lines = store.readLines();
      expect(lines).toEqual(['{"seq":0}', '{"seq":1}']);
    });

    it('returns an empty array when the file does not exist', () => {
      const store = new LedgerStore(dir);
      expect(store.readLines()).toEqual([]);
    });

    it('creates the directory on construction', () => {
      const nested = join(dir, 'a', 'b', 'c');
      const store = new LedgerStore(nested);
      store.appendLine('test');
      expect(existsSync(join(nested, 'ledger.jsonl'))).toBe(true);
    });

    it('persists across multiple writes (append-only)', () => {
      const store1 = new LedgerStore(dir);
      store1.appendLine('first');

      const store2 = new LedgerStore(dir);
      store2.appendLine('second');

      const lines = store2.readLines();
      expect(lines).toEqual(['first', 'second']);
    });
  });

  describe('appendCheckpointLine / readCheckpointLines', () => {
    it('appends and reads back checkpoint lines', () => {
      const store = new LedgerStore(dir);
      store.appendCheckpointLine('{"seq":9}');
      store.appendCheckpointLine('{"seq":19}');

      const lines = store.readCheckpointLines();
      expect(lines).toEqual(['{"seq":9}', '{"seq":19}']);
    });

    it('returns an empty array when the file does not exist', () => {
      const store = new LedgerStore(dir);
      expect(store.readCheckpointLines()).toEqual([]);
    });
  });

  describe('directory property', () => {
    it('exposes the resolved directory path', () => {
      const store = new LedgerStore(dir);
      expect(store.directory).toBe(dir);
    });
  });
});

describe('resolveLedgerDir', () => {
  it('uses global storage with workspace hash by default', () => {
    const result = resolveLedgerDir({
      globalStoragePath: '/global/storage',
      workspaceFolders: [{ uri: { fsPath: '/home/user/project' } }],
      ledgerInWorkspace: false,
    });

    expect(result).toMatch(/^\/global\/storage\/ledger\/[0-9a-f]{16}$/);
  });

  it('uses .whetstone/ledger inside workspace when ledgerInWorkspace is true', () => {
    const result = resolveLedgerDir({
      globalStoragePath: '/global/storage',
      workspaceFolders: [{ uri: { fsPath: '/home/user/project' } }],
      ledgerInWorkspace: true,
    });

    expect(result).toBe('/home/user/project/.whetstone/ledger');
  });

  it('falls back to global/default when no workspace is open', () => {
    const result = resolveLedgerDir({
      globalStoragePath: '/global/storage',
      workspaceFolders: undefined,
      ledgerInWorkspace: false,
    });

    expect(result).toBe('/global/storage/ledger/default');
  });

  it('falls back to global/default when ledgerInWorkspace is true but no workspace', () => {
    const result = resolveLedgerDir({
      globalStoragePath: '/global/storage',
      workspaceFolders: undefined,
      ledgerInWorkspace: true,
    });

    expect(result).toBe('/global/storage/ledger/default');
  });

  it('produces different directories for different workspaces', () => {
    const a = resolveLedgerDir({
      globalStoragePath: '/global',
      workspaceFolders: [{ uri: { fsPath: '/project-a' } }],
      ledgerInWorkspace: false,
    });
    const b = resolveLedgerDir({
      globalStoragePath: '/global',
      workspaceFolders: [{ uri: { fsPath: '/project-b' } }],
      ledgerInWorkspace: false,
    });

    expect(a).not.toBe(b);
  });
});
