import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DraftStore, UNTITLED } from '../src/service/draftStore';

function freshStore(): DraftStore {
  return new DraftStore(`drafts-${Math.random().toString(36).slice(2)}`);
}

/** Space writes past a millisecond so `updatedAt` ordering is unambiguous. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

describe('DraftStore — local document persistence', () => {
  let store: DraftStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('creates a document with an untitled default and empty content', async () => {
    const doc = await store.create();
    expect(doc.title).toBe(UNTITLED);
    expect(doc.content).toBe('');
    expect(doc.id).toMatch(/^doc-/);
    expect(Number.isNaN(Date.parse(doc.createdAt))).toBe(false);
  });

  it('persists prose and resurfaces it on get', async () => {
    const doc = await store.create('Essay');
    await store.saveContent(doc.id, 'My drafted prose.');
    const loaded = await store.get(doc.id);
    expect(loaded?.content).toBe('My drafted prose.');
    expect(loaded?.title).toBe('Essay');
  });

  it('renames a document, falling back to untitled on blank', async () => {
    const doc = await store.create('Old');
    await store.setTitle(doc.id, 'New title');
    expect((await store.get(doc.id))?.title).toBe('New title');
    await store.setTitle(doc.id, '   ');
    expect((await store.get(doc.id))?.title).toBe(UNTITLED);
  });

  it('lists documents most-recently-edited first', async () => {
    const a = await store.create('A');
    await tick();
    const b = await store.create('B');
    await tick();
    // Edit A after B so it should sort ahead.
    await store.saveContent(a.id, 'edit');
    const list = await store.list();
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
    // The list view omits prose.
    expect(list[0]).not.toHaveProperty('content');
  });

  it('deletes a document', async () => {
    const doc = await store.create();
    await store.delete(doc.id);
    expect(await store.get(doc.id)).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it('saveContent/setTitle on a missing id is a no-op, not a throw', async () => {
    await expect(store.saveContent('nope', 'x')).resolves.toBeUndefined();
    await expect(store.setTitle('nope', 'x')).resolves.toBeUndefined();
  });
});
