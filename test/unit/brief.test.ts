/**
 * Unit tests for the brief capture module (task 14):
 * `BriefCapture.capture()` — multi-step QuickInput flow + persistence.
 * `BriefFileStore` — file-based `brief.json` persistence.
 * `BriefCapture.read()` — read access for coaching context.
 *
 * All UI interaction (QuickInput steps) is stubbed via `BriefPrompter`;
 * persistence is tested with both the file-based store (tmp dir) and an
 * in-memory stub. No network or VS Code calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BriefCapture,
  BriefFileStore,
  createBriefCapture,
} from '../../src/brief/index';
import type { BriefPrompter, BriefStore } from '../../src/brief/index';
import type { Brief } from '../../src/shared/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// In-memory BriefStore stub
// ---------------------------------------------------------------------------

/** In-memory store for fast unit tests (no filesystem). */
function memoryStore(initial?: Brief): BriefStore & {
  _saved: Brief[];
} {
  let stored: Brief | undefined = initial;
  const saved: Brief[] = [];
  return {
    _saved: saved,
    load: vi.fn(async () => {
      // Return a copy to prevent mutation cross-talk.
      return stored ? { ...stored } : undefined;
    }),
    save: vi.fn(async (brief: Brief) => {
      saved.push({ ...brief });
      stored = { ...brief };
    }),
  };
}

// ---------------------------------------------------------------------------
// Prompter stub
// ---------------------------------------------------------------------------

/**
 * Create a prompter stub that returns predetermined responses in order.
 * `undefined` simulates the user pressing Escape (cancel).
 */
function stubPrompter(
  responses: (string | undefined)[],
): BriefPrompter & { steps: Array<import('../../src/brief/index').BriefInputStep> } {
  const steps: Array<import('../../src/brief/index').BriefInputStep> = [];
  let idx = 0;
  return {
    steps,
    showInputStep: vi.fn(async (step) => {
      steps.push(step);
      return responses[idx++];
    }),
  };
}

// ---------------------------------------------------------------------------
// Temp directory helper (for BriefFileStore tests)
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'whetstone-brief-test-'));
}

// ---------------------------------------------------------------------------
// Tests — BriefCapture
// ---------------------------------------------------------------------------

describe('BriefCapture', () => {
  describe('capture()', () => {
    it('persists a full brief when all fields are filled', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter([
        'Argue for coaching-led writing',
        'JAIS reviewers',
        'Reviewers find the argument coherent',
      ]);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(true);
      if (!result.ok) return; // type narrowing

      expect(result.brief.purposeClaim).toBe('Argue for coaching-led writing');
      expect(result.brief.audienceVenue).toBe('JAIS reviewers');
      expect(result.brief.successCriterion).toBe('Reviewers find the argument coherent');
      expect(result.brief.updatedAt).toBeTruthy();
      expect(store._saved).toHaveLength(1);
    });

    it('persists an empty-but-valid brief when all fields are skipped', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      // Empty strings = user pressed Enter without typing.
      const prompter = stubPrompter(['', '', '']);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.brief.purposeClaim).toBeUndefined();
      expect(result.brief.audienceVenue).toBeUndefined();
      expect(result.brief.successCriterion).toBeUndefined();
      expect(result.brief.updatedAt).toBeTruthy();
      expect(store._saved).toHaveLength(1);
    });

    it('persists partial fields correctly', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['', 'JAIS reviewers', '']);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.brief.purposeClaim).toBeUndefined();
      expect(result.brief.audienceVenue).toBe('JAIS reviewers');
      expect(result.brief.successCriterion).toBeUndefined();
    });

    it('trims whitespace from input', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['  spaced purpose  ', '  ', '\t']);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.brief.purposeClaim).toBe('spaced purpose');
      // Whitespace-only strings are trimmed to empty → skipped.
      expect(result.brief.audienceVenue).toBeUndefined();
      expect(result.brief.successCriterion).toBeUndefined();
    });

    it('returns ok:false when user cancels on first step', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter([undefined]);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('Brief capture cancelled.');
      // Nothing should be persisted.
      expect(store._saved).toHaveLength(0);
    });

    it('returns ok:false when user cancels on middle step', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['filled', undefined, 'never reached']);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(false);
      expect(store._saved).toHaveLength(0);
    });

    it('returns ok:false when user cancels on last step', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['one', 'two', undefined]);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(false);
      expect(store._saved).toHaveLength(0);
    });

    it('pre-fills existing brief values when editing', async () => {
      const existing: Brief = {
        purposeClaim: 'old purpose',
        audienceVenue: 'old audience',
        successCriterion: 'old criterion',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      const store = memoryStore(existing);
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['new purpose', 'new audience', 'new criterion']);

      await capture.capture(prompter);

      // The prompter should have received the existing values as pre-fill.
      expect(prompter.steps[0].value).toBe('old purpose');
      expect(prompter.steps[1].value).toBe('old audience');
      expect(prompter.steps[2].value).toBe('old criterion');
    });

    it('pre-fills undefined for fields not in existing brief', async () => {
      const existing: Brief = {
        audienceVenue: 'only audience',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      const store = memoryStore(existing);
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['', '', '']);

      await capture.capture(prompter);

      expect(prompter.steps[0].value).toBeUndefined(); // purposeClaim was absent
      expect(prompter.steps[1].value).toBe('only audience');
      expect(prompter.steps[2].value).toBeUndefined(); // successCriterion was absent
    });

    it('updates updatedAt when the brief is edited', async () => {
      const existing: Brief = {
        purposeClaim: 'original',
        updatedAt: '2020-01-01T00:00:00.000Z',
      };
      const store = memoryStore(existing);
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['updated purpose', '', '']);

      const result = await capture.capture(prompter);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // updatedAt must be newer than the original.
      expect(result.brief.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('shows exactly 3 steps in the correct order', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);
      const prompter = stubPrompter(['a', 'b', 'c']);

      await capture.capture(prompter);

      expect(prompter.steps).toHaveLength(3);
      expect(prompter.steps[0].title).toContain('1/3');
      expect(prompter.steps[0].title).toContain('Purpose');
      expect(prompter.steps[1].title).toContain('2/3');
      expect(prompter.steps[1].title).toContain('Audience');
      expect(prompter.steps[2].title).toContain('3/3');
      expect(prompter.steps[2].title).toContain('Success');
    });
  });

  describe('read()', () => {
    it('returns undefined when no brief has been persisted', async () => {
      const store = memoryStore();
      const capture = new BriefCapture(store);

      const brief = await capture.read();

      expect(brief).toBeUndefined();
    });

    it('returns the persisted brief for coaching context', async () => {
      const existing: Brief = {
        purposeClaim: 'test purpose',
        updatedAt: '2025-06-11T12:00:00.000Z',
      };
      const store = memoryStore(existing);
      const capture = new BriefCapture(store);

      const brief = await capture.read();

      expect(brief).toEqual(existing);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — BriefFileStore
// ---------------------------------------------------------------------------

describe('BriefFileStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no brief.json exists', async () => {
    const store = new BriefFileStore(dir);
    const loaded = await store.load();
    expect(loaded).toBeUndefined();
  });

  it('persists and loads back a full brief identically', async () => {
    const store = new BriefFileStore(dir);
    const brief: Brief = {
      purposeClaim: 'Test claim',
      audienceVenue: 'Test audience',
      successCriterion: 'Test criterion',
      updatedAt: '2025-06-11T12:00:00.000Z',
    };

    await store.save(brief);
    const loaded = await store.load();

    expect(loaded).toEqual(brief);
  });

  it('persists and loads a partial brief identically', async () => {
    const store = new BriefFileStore(dir);
    const brief: Brief = {
      audienceVenue: 'Only audience set',
      updatedAt: '2025-06-11T12:00:00.000Z',
    };

    await store.save(brief);
    const loaded = await store.load();

    expect(loaded).toEqual(brief);
    expect(loaded!.purposeClaim).toBeUndefined();
    expect(loaded!.successCriterion).toBeUndefined();
  });

  it('overwrites an existing brief on save', async () => {
    const store = new BriefFileStore(dir);

    await store.save({ purposeClaim: 'first', updatedAt: '2025-01-01T00:00:00.000Z' });
    await store.save({ audienceVenue: 'second', updatedAt: '2025-06-11T00:00:00.000Z' });

    const loaded = await store.load();
    expect(loaded!.purposeClaim).toBeUndefined();
    expect(loaded!.audienceVenue).toBe('second');
  });

  it('returns undefined for a malformed brief.json', async () => {
    const store = new BriefFileStore(dir);
    // Write invalid JSON.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'brief.json'), '{not valid json', 'utf8');

    const loaded = await store.load();
    expect(loaded).toBeUndefined();
  });

  it('returns undefined for valid JSON missing updatedAt', async () => {
    const store = new BriefFileStore(dir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'brief.json'), JSON.stringify({ purposeClaim: 'no timestamp' }), 'utf8');

    const loaded = await store.load();
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when updatedAt is not a string', async () => {
    const store = new BriefFileStore(dir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'brief.json'), JSON.stringify({ updatedAt: 12345 }), 'utf8');

    const loaded = await store.load();
    expect(loaded).toBeUndefined();
  });

  it('returns undefined for extra non-string fields', async () => {
    const store = new BriefFileStore(dir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(dir, 'brief.json'),
      JSON.stringify({ purposeClaim: 42, updatedAt: '2025-06-11T00:00:00.000Z' }),
      'utf8',
    );

    const loaded = await store.load();
    expect(loaded).toBeUndefined();
  });

  it('creates the directory if it does not exist', async () => {
    const nestedDir = join(dir, 'sub', 'dir');
    const store = new BriefFileStore(nestedDir);
    const brief: Brief = { updatedAt: '2025-06-11T00:00:00.000Z' };

    await store.save(brief);
    const loaded = await store.load();
    expect(loaded).toEqual(brief);
  });

  it('exposes the resolved file path', () => {
    const store = new BriefFileStore(dir);
    expect(store.path).toBe(join(dir, 'brief.json'));
  });
});

// ---------------------------------------------------------------------------
// Tests — createBriefCapture factory
// ---------------------------------------------------------------------------

describe('createBriefCapture', () => {
  it('creates a BriefCapture with the given store', async () => {
    const store = memoryStore({ updatedAt: '2025-06-11T00:00:00.000Z' });
    const capture = createBriefCapture(store);

    const brief = await capture.read();
    expect(brief!.updatedAt).toBe('2025-06-11T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Integration — capture + file store round-trip
// ---------------------------------------------------------------------------

describe('capture + BriefFileStore round-trip', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures and persists a brief through the file store', async () => {
    const store = new BriefFileStore(dir);
    const capture = new BriefCapture(store);
    const prompter = stubPrompter([
      'My purpose',
      'My audience',
      'My criterion',
    ]);

    const result = await capture.capture(prompter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify the persisted brief loads back identically.
    const loaded = await store.load();
    expect(loaded).toEqual(result.brief);
  });

  it('re-capturing edits the existing brief', async () => {
    const store = new BriefFileStore(dir);
    const capture = new BriefCapture(store);

    // First capture.
    const prompter1 = stubPrompter(['original', 'audience', 'criterion']);
    const result1 = await capture.capture(prompter1);
    expect(result1.ok).toBe(true);
    const firstTs = (result1 as { ok: true; brief: Brief }).brief.updatedAt;

    // Wait briefly so updatedAt differs.
    await new Promise((r) => setTimeout(r, 10));

    // Second capture (edit).
    const prompter2 = stubPrompter(['updated purpose', '', '']);
    const result2 = await capture.capture(prompter2);

    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    const edited = result2.brief;
    expect(edited.purposeClaim).toBe('updated purpose');
    expect(edited.audienceVenue).toBeUndefined(); // cleared by empty input
    expect(edited.successCriterion).toBeUndefined(); // cleared by empty input
    expect(edited.updatedAt).not.toBe(firstTs);

    // Verify the store has the latest brief.
    const loaded = await store.load();
    expect(loaded!.purposeClaim).toBe('updated purpose');
  });
});
