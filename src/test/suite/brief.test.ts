/**
 * Integration tests for the brief capture module (task 14) — runs inside the
 * VS Code Extension Host via `@vscode/test-electron`.
 *
 * Uses `BriefFileStore` with real filesystem paths to verify capture + persist
 * + read works correctly in the actual VS Code environment. UI interaction is
 * stubbed (same pattern as consent-gate integration tests) because the test
 * harness cannot automate QuickInput user interaction.
 */

import * as assert from 'assert';
import { BriefCapture, BriefFileStore } from '../../brief/index';
import type { BriefPrompter } from '../../brief/index';
import type { Brief } from '../../shared/types';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a prompter stub that returns predetermined responses in order.
 * `undefined` simulates Escape (cancel).
 */
function stubPrompter(responses: (string | undefined)[]): BriefPrompter {
  let idx = 0;
  return {
    showInputStep: async () => responses[idx++],
  };
}

/** Create a unique temp directory for an integration test. */
function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `whetstone-brief-integ-${label}-`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Brief integration (Extension Host)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      if (existsSync(d)) {
        rmSync(d, { recursive: true, force: true });
      }
    }
    dirs.length = 0;
  });

  it('captures and persists a brief in the test host', async () => {
    const dir = makeTempDir('capture');
    dirs.push(dir);

    const store = new BriefFileStore(dir);
    const capture = new BriefCapture(store);

    // Verify no brief exists initially.
    const before = await capture.read();
    assert.strictEqual(before, undefined);

    // Capture a brief.
    const prompter = stubPrompter([
      'My research purpose',
      'Nature reviewers',
      'Acceptance after one revision',
    ]);
    const result = await capture.capture(prompter);

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;

    const brief = result.brief;
    assert.strictEqual(brief.purposeClaim, 'My research purpose');
    assert.strictEqual(brief.audienceVenue, 'Nature reviewers');
    assert.strictEqual(brief.successCriterion, 'Acceptance after one revision');
    assert.ok(brief.updatedAt);

    // Read back through the capture interface.
    const loaded = await capture.read();
    assert.deepStrictEqual(loaded, brief);
  });

  it('re-running the flow edits the existing brief', async () => {
    const dir = makeTempDir('edit');
    dirs.push(dir);

    const store = new BriefFileStore(dir);
    const capture = new BriefCapture(store);

    // First capture.
    const prompter1 = stubPrompter(['original purpose', 'original audience', 'original criterion']);
    const result1 = await capture.capture(prompter1);
    assert.strictEqual(result1.ok, true);
    const firstTs = (result1 as { ok: true; brief: Brief }).brief.updatedAt;

    // Small delay so updatedAt differs.
    await new Promise((r) => setTimeout(r, 15));

    // Re-capture (edit) — change purpose, skip others.
    const prompter2 = stubPrompter(['updated purpose', '', '']);
    const result2 = await capture.capture(prompter2);
    assert.strictEqual(result2.ok, true);

    const edited = (result2 as { ok: true; brief: Brief }).brief;
    assert.strictEqual(edited.purposeClaim, 'updated purpose');
    assert.strictEqual(edited.audienceVenue, undefined);
    assert.strictEqual(edited.successCriterion, undefined);
    assert.notStrictEqual(edited.updatedAt, firstTs);

    // Verify read returns the edited brief.
    const loaded = await capture.read();
    assert.deepStrictEqual(loaded, edited);
  });

  it('skipping all fields persists an empty-but-valid brief', async () => {
    const dir = makeTempDir('skip');
    dirs.push(dir);

    const store = new BriefFileStore(dir);
    const capture = new BriefCapture(store);
    const prompter = stubPrompter(['', '', '']);

    const result = await capture.capture(prompter);
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;

    const brief = result.brief;
    assert.strictEqual(brief.purposeClaim, undefined);
    assert.strictEqual(brief.audienceVenue, undefined);
    assert.strictEqual(brief.successCriterion, undefined);
    assert.ok(brief.updatedAt);

    // Verify persisted.
    const loaded = await capture.read();
    assert.deepStrictEqual(loaded, brief);
  });
});
