/**
 * Persistent per-workspace lint dismissal store (ADR-005, Task 06).
 *
 * A "dismissal" records that the writer accepted a specific lint as a false
 * positive (e.g. an international-English construction that Harper flags as a
 * spelling error). Once dismissed, the same lint identity is filtered out of
 * future lint passes so the writer never sees it again in that workspace.
 *
 * The store persists through VS Code's `Memento`-compatible storage interface
 * (`workspaceState` for per-workscope scope). Unit tests inject an in-memory
 * fake; the real extension passes `context.workspaceState` at activation.
 *
 * Key design decisions:
 * - Lint identity is `lintKind + problemText` — same rule + same flagged word.
 *   This is resilient to minor message wording changes between harper versions.
 * - The dismissal set is stored as a JSON array of string keys under a single
 *   storage key, which is efficient for the expected small cardinality (dozens
 *   to low hundreds of dismissals per workspace).
 */

import type { SerializedLint } from './diagnostics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The stable identity of a dismissed lint. Two lints with the same identity
 * are considered the same false-positive candidate.
 */
export interface LintIdentity {
  /** The Harper lint category key (e.g. "Spelling"). */
  readonly lintKind: string;
  /** The specific flagged text (e.g. "colour"). */
  readonly problemText: string;
}

/**
 * A `Memento`-compatible storage interface. VS Code's `workspaceState` and
 * `globalState` satisfy this structurally; unit tests provide an in-memory map.
 */
export interface DismissalStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Storage key used in the Memento. */
const STORAGE_KEY = 'whetstone.grammar.dismissals';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Compute a stable string key for a lint identity.
 *
 * Uses a null-byte separator to avoid collisions between values that might
 * naturally contain the separator character. This is not a cryptographic hash;
 * it is a deterministic composite key for Set membership checks.
 */
export function computeDismissalKey(identity: LintIdentity): string {
  return `${identity.lintKind}\0${identity.problemText}`;
}

/**
 * Extract the lint identity from a `SerializedLint`.
 */
export function lintToIdentity(lint: SerializedLint): LintIdentity {
  return {
    lintKind: lint.lintKind,
    problemText: lint.problemText,
  };
}

// ---------------------------------------------------------------------------
// DismissalStore
// ---------------------------------------------------------------------------

/**
 * Persistent, per-workspace store of dismissed lint identities.
 *
 * Usage:
 * 1. Construct with a `DismissalStorage` (e.g. `context.workspaceState`).
 * 2. Call `isDismissed()` to check individual lints, or `filterDismissed()`
 *    to filter an array.
 * 3. Call `dismiss()` when the writer accepts a lint as a false positive.
 */
export class DismissalStore {
  private readonly dismissed: Set<string>;
  private readonly storage: DismissalStorage;
  private dirty = false;

  constructor(storage: DismissalStorage) {
    const stored = storage.get<string[]>(STORAGE_KEY, []);
    this.dismissed = new Set(stored);
    this.storage = storage;
  }

  /** Whether a lint with the given identity has been dismissed. */
  isDismissed(identity: LintIdentity): boolean;

  /** Whether a serialized lint has been dismissed. */
  isDismissed(lint: SerializedLint): boolean;

  isDismissed(lintOrIdentity: SerializedLint | LintIdentity): boolean {
    const identity =
      'span' in lintOrIdentity
        ? lintToIdentity(lintOrIdentity as SerializedLint)
        : (lintOrIdentity as LintIdentity);
    return this.dismissed.has(computeDismissalKey(identity));
  }

  /**
   * Dismiss a lint identity so it will be filtered from future lint passes.
   * Persists the updated set to storage.
   */
  async dismiss(identity: LintIdentity): Promise<void>;

  /**
   * Dismiss a serialized lint so it will be filtered from future lint passes.
   * Persists the updated set to storage.
   */
  async dismiss(lint: SerializedLint): Promise<void>;

  async dismiss(lintOrIdentity: SerializedLint | LintIdentity): Promise<void> {
    const identity =
      'span' in lintOrIdentity
        ? lintToIdentity(lintOrIdentity as SerializedLint)
        : (lintOrIdentity as LintIdentity);
    const key = computeDismissalKey(identity);
    if (!this.dismissed.has(key)) {
      this.dismissed.add(key);
      this.dirty = true;
      await this.persist();
    }
  }

  /**
   * Remove a dismissal (e.g. for an "undo dismiss" feature in a later task).
   * Persists the updated set to storage.
   */
  async restore(identity: LintIdentity): Promise<void> {
    const key = computeDismissalKey(identity);
    if (this.dismissed.has(key)) {
      this.dismissed.delete(key);
      this.dirty = true;
      await this.persist();
    }
  }

  /** The current number of dismissed lint identities. */
  get size(): number {
    return this.dismissed.size;
  }

  /** A snapshot of all dismissed keys (for diagnostics / testing). */
  get dismissedKeys(): ReadonlySet<string> {
    return new Set(this.dismissed);
  }

  /** Whether there are unsaved changes (for testing). */
  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Reload the dismissal set from storage.
   * Simulates what happens when the extension reactivates (e.g. reload window).
   */
  async reload(): Promise<void> {
    const stored = this.storage.get<string[]>(STORAGE_KEY, []);
    this.dismissed.clear();
    for (const key of stored) {
      this.dismissed.add(key);
    }
    this.dirty = false;
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, [...this.dismissed]);
    this.dirty = false;
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter dismissed lints out of a lint array.
 *
 * This is a pure function that uses the store's `isDismissed()` method to
 * remove any lints whose identity matches a previously-dismissed lint.
 */
export function filterDismissed(
  lints: readonly SerializedLint[],
  store: DismissalStore,
): SerializedLint[] {
  return lints.filter((lint) => !store.isDismissed(lint));
}
