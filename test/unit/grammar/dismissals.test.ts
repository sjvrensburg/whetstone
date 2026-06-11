/**
 * Unit tests for the persistent dismissal store (src/grammar/dismissals.ts).
 *
 * Verifies:
 * - Dismissed lint identities are stored and filtered out on the next lint pass.
 * - A dismissal survives a simulated reload (re-read from storage).
 * - Identity computation is stable and collision-free.
 * - The store handles empty, single, and multiple dismissals.
 * - Restore removes a dismissal.
 */

import { describe, it, expect } from 'vitest';
import {
  DismissalStore,
  computeDismissalKey,
  lintToIdentity,
  filterDismissed,
  type LintIdentity,
  type DismissalStorage,
} from '../../../src/grammar/dismissals';
import type { SerializedLint } from '../../../src/grammar/diagnostics';

// ---------------------------------------------------------------------------
// In-memory storage fake
// ---------------------------------------------------------------------------

/** A `DismissalStorage` backed by an in-memory Map. */
class InMemoryStorage implements DismissalStorage {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.get(key) as T) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  /** Expose internal data for test assertions. */
  snapshot(): ReadonlyMap<string, unknown> {
    return new Map(this.data);
  }
}

// ---------------------------------------------------------------------------
// Sample lints
// ---------------------------------------------------------------------------

const spellingLint: SerializedLint = {
  span: { start: 0, end: 6 },
  problemText: 'colour',
  lintKind: 'Spelling',
  lintKindPretty: 'Spelling',
  message: 'Did you mean "color"?',
  suggestionCount: 1,
};

const grammarLint: SerializedLint = {
  span: { start: 10, end: 14 },
  problemText: 'them',
  lintKind: 'Grammar',
  lintKindPretty: 'Grammar',
  message: 'Consider rewording for clarity.',
  suggestionCount: 0,
};

const anotherSpellingLint: SerializedLint = {
  span: { start: 20, end: 27 },
  problemText: 'analyse',
  lintKind: 'Spelling',
  lintKindPretty: 'Spelling',
  message: 'Did you mean "analyze"?',
  suggestionCount: 1,
};

// Same lintKind + problemText as spellingLint — same identity.
const sameWordDifferentPosition: SerializedLint = {
  span: { start: 100, end: 106 },
  problemText: 'colour',
  lintKind: 'Spelling',
  lintKindPretty: 'Spelling',
  message: 'Did you mean "color"?',
  suggestionCount: 1,
};

// ---------------------------------------------------------------------------
// computeDismissalKey
// ---------------------------------------------------------------------------

describe('computeDismissalKey', () => {
  it('produces a stable key for the same identity', () => {
    const id: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    expect(computeDismissalKey(id)).toBe(computeDismissalKey(id));
  });

  it('produces different keys for different identities', () => {
    const a: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const b: LintIdentity = { lintKind: 'Spelling', problemText: 'analyze' };
    expect(computeDismissalKey(a)).not.toBe(computeDismissalKey(b));
  });

  it('produces different keys for same word but different lint kind', () => {
    const a: LintIdentity = { lintKind: 'Spelling', problemText: 'colour' };
    const b: LintIdentity = { lintKind: 'Style', problemText: 'colour' };
    expect(computeDismissalKey(a)).not.toBe(computeDismissalKey(b));
  });

  it('does not collide for values that might naturally contain the separator', () => {
    // Null byte separator ensures no natural text collision.
    const a: LintIdentity = { lintKind: 'A', problemText: 'B\x0C' };
    const b: LintIdentity = { lintKind: 'A\x0B', problemText: 'C' };
    expect(computeDismissalKey(a)).not.toBe(computeDismissalKey(b));
  });
});

// ---------------------------------------------------------------------------
// lintToIdentity
// ---------------------------------------------------------------------------

describe('lintToIdentity', () => {
  it('extracts lintKind and problemText from a serialized lint', () => {
    const identity = lintToIdentity(spellingLint);
    expect(identity.lintKind).toBe('Spelling');
    expect(identity.problemText).toBe('colour');
  });

  it('ignores position (span) — same word = same identity', () => {
    const id1 = lintToIdentity(spellingLint);
    const id2 = lintToIdentity(sameWordDifferentPosition);
    expect(computeDismissalKey(id1)).toBe(computeDismissalKey(id2));
  });
});

// ---------------------------------------------------------------------------
// DismissalStore
// ---------------------------------------------------------------------------

describe('DismissalStore', () => {
  it('starts with no dismissals when storage is empty', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    expect(store.size).toBe(0);
    expect(store.isDismissed(lintToIdentity(spellingLint))).toBe(false);
  });

  it('dismisses a lint identity', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity = lintToIdentity(spellingLint);
    await store.dismiss(identity);
    expect(store.size).toBe(1);
    expect(store.isDismissed(identity)).toBe(true);
  });

  it('accepts a SerializedLint directly in dismiss()', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    expect(store.isDismissed(spellingLint)).toBe(true);
  });

  it('accepts a SerializedLint directly in isDismissed()', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    expect(store.isDismissed(spellingLint)).toBe(true);
    expect(store.isDismissed(grammarLint)).toBe(false);
  });

  it('does not duplicate dismissals for the same identity', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    await store.dismiss(spellingLint);
    expect(store.size).toBe(1);
  });

  it('persists dismissals to storage', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);

    // Check storage was written.
    const snapshot = storage.snapshot();
    const stored = snapshot.get('whetstone.grammar.dismissals') as string[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(computeDismissalKey(lintToIdentity(spellingLint)));
  });

  it('survives a simulated reload (re-read from storage)', async () => {
    const storage = new InMemoryStorage();

    // First store: dismiss a lint.
    const store1 = new DismissalStore(storage);
    await store1.dismiss(spellingLint);
    await store1.dismiss(grammarLint);
    expect(store1.size).toBe(2);

    // Second store: reads from the same storage (simulates reload).
    const store2 = new DismissalStore(storage);
    expect(store2.size).toBe(2);
    expect(store2.isDismissed(spellingLint)).toBe(true);
    expect(store2.isDismissed(grammarLint)).toBe(true);
    expect(store2.isDismissed(anotherSpellingLint)).toBe(false);
  });

  it('handles multiple dismissals', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    await store.dismiss(grammarLint);
    await store.dismiss(anotherSpellingLint);
    expect(store.size).toBe(3);
    expect(store.isDismissed(spellingLint)).toBe(true);
    expect(store.isDismissed(grammarLint)).toBe(true);
    expect(store.isDismissed(anotherSpellingLint)).toBe(true);
  });

  it('restore removes a dismissal', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity = lintToIdentity(spellingLint);
    await store.dismiss(identity);
    expect(store.isDismissed(identity)).toBe(true);

    await store.restore(identity);
    expect(store.isDismissed(identity)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('restore is a no-op for non-dismissed identities', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const identity = lintToIdentity(spellingLint);
    await store.restore(identity); // no-op
    expect(store.size).toBe(0);
  });

  it('reload refreshes from storage', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);

    // Manually write an additional key to storage.
    const stored = storage.get<string[]>('whetstone.grammar.dismissals', []);
    stored.push(computeDismissalKey({ lintKind: 'Style', problemText: 'very unique' }));
    await storage.update('whetstone.grammar.dismissals', stored);

    // Reload should pick up the new key.
    await store.reload();
    expect(store.size).toBe(2);
    expect(store.isDismissed(spellingLint)).toBe(true);
    expect(store.isDismissed({ lintKind: 'Style', problemText: 'very unique' })).toBe(true);
  });

  it('dismissedKeys returns a snapshot', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    const keys = store.dismissedKeys;
    expect(keys.size).toBe(1);
    expect(keys.has(computeDismissalKey(lintToIdentity(spellingLint)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterDismissed
// ---------------------------------------------------------------------------

describe('filterDismissed', () => {
  it('returns all lints when nothing is dismissed', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const lints = [spellingLint, grammarLint, anotherSpellingLint];
    const filtered = filterDismissed(lints, store);
    expect(filtered).toHaveLength(3);
  });

  it('filters out dismissed lints', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);

    const lints = [spellingLint, grammarLint, anotherSpellingLint];
    const filtered = filterDismissed(lints, store);
    expect(filtered).toHaveLength(2);
    expect(filtered).not.toContain(spellingLint);
    expect(filtered).toContain(grammarLint);
    expect(filtered).toContain(anotherSpellingLint);
  });

  it('filters lints at different positions with the same identity', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);

    const lints = [spellingLint, sameWordDifferentPosition];
    const filtered = filterDismissed(lints, store);
    // Both "colour" lints should be filtered (same identity).
    expect(filtered).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    const filtered = filterDismissed([], store);
    expect(filtered).toEqual([]);
  });

  it('filters all when all are dismissed', async () => {
    const storage = new InMemoryStorage();
    const store = new DismissalStore(storage);
    await store.dismiss(spellingLint);
    await store.dismiss(grammarLint);
    const filtered = filterDismissed([spellingLint, grammarLint], store);
    expect(filtered).toHaveLength(0);
  });
});
