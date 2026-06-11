/**
 * Atomic append-only JSONL persistence for the provenance ledger, plus
 * storage-location resolution (ADR-006).
 *
 * The default location is the extension's global-storage directory namespaced
 * by a hash of the first workspace folder — so the ledger is per-project but
 * not accidentally git-committed. An opt-in setting (`ledgerInWorkspace`)
 * stores it inside the workspace at `.whetstone/ledger/` instead.
 *
 * Every write goes through `appendLine()` / `appendCheckpoint()`, which
 * open → write → fsync → close to survive crashes mid-write.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const LEDGER_FILE = 'ledger.jsonl';
const CHECKPOINTS_FILE = 'checkpoints.jsonl';

// ---------------------------------------------------------------------------
// Storage-location resolution
// ---------------------------------------------------------------------------

/** The dependencies `resolveLedgerDir` needs from the extension host. */
export interface StorageLocationDeps {
  /** `context.globalStorageUri.fsPath` — the extension's per-machine data dir. */
  globalStoragePath: string;
  /** `vscode.workspace.workspaceFolders` — may be `undefined` (no folder open). */
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  /** The `ledgerInWorkspace` setting from `WhetstoneSettings`. */
  ledgerInWorkspace: boolean;
}

/**
 * Resolve the directory that will hold `ledger.jsonl` and `checkpoints.jsonl`.
 *
 * - **Default** (`ledgerInWorkspace === false`): extension global storage
 *   namespaced by a truncated SHA-256 of the first workspace folder path,
 *   so each project gets its own ledger without polluting the workspace.
 * - **Opt-in** (`ledgerInWorkspace === true`): `.whetstone/ledger/` inside
 *   the workspace root.
 * - **No workspace**: falls back to a `default` namespace in global storage.
 */
export function resolveLedgerDir(deps: StorageLocationDeps): string {
  if (deps.ledgerInWorkspace && deps.workspaceFolders && deps.workspaceFolders.length > 0) {
    return join(deps.workspaceFolders[0].uri.fsPath, '.whetstone', 'ledger');
  }

  const namespace =
    deps.workspaceFolders && deps.workspaceFolders.length > 0
      ? createHash('sha256').update(deps.workspaceFolders[0].uri.fsPath).digest('hex').slice(0, 16)
      : 'default';

  return join(deps.globalStoragePath, 'ledger', namespace);
}

// ---------------------------------------------------------------------------
// Append-only JSONL store
// ---------------------------------------------------------------------------

/**
 * Manages the two JSONL files (`ledger.jsonl` and `checkpoints.jsonl`) in a
 * given directory. Creates the directory on construction. All writes are
 * atomic (open → write → fsync → close).
 */
export class LedgerStore {
  private readonly ledgerPath: string;
  private readonly checkpointsPath: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.ledgerPath = join(dir, LEDGER_FILE);
    this.checkpointsPath = join(dir, CHECKPOINTS_FILE);
  }

  /** The resolved directory path (for testing / diagnostics). */
  get directory(): string {
    return this.dir;
  }

  /**
   * Atomically append a line to `ledger.jsonl`.
   * Uses open → write → fsync → close to survive crashes mid-write.
   */
  appendLine(line: string): void {
    const fd = openSync(this.ledgerPath, 'a');
    try {
      writeFileSync(fd, line + '\n', 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Read all non-empty lines from `ledger.jsonl`. Returns `[]` if absent. */
  readLines(): string[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }
    const content = readFileSync(this.ledgerPath, 'utf8');
    if (content.trim().length === 0) {
      return [];
    }
    return content.split('\n').filter((line) => line.length > 0);
  }

  /**
   * Atomically append a checkpoint line to `checkpoints.jsonl`.
   * Same fsync guarantee as `appendLine`.
   */
  appendCheckpointLine(line: string): void {
    const fd = openSync(this.checkpointsPath, 'a');
    try {
      writeFileSync(fd, line + '\n', 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Read all non-empty checkpoint lines. Returns `[]` if absent. */
  readCheckpointLines(): string[] {
    if (!existsSync(this.checkpointsPath)) {
      return [];
    }
    const content = readFileSync(this.checkpointsPath, 'utf8');
    if (content.trim().length === 0) {
      return [];
    }
    return content.split('\n').filter((line) => line.length > 0);
  }
}
