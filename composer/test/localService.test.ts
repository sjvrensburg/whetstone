import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SCOPING_NOTE } from '../src/core/disclosure';
import { LocalService } from '../src/service/local';

let dbCounter = 0;
const freshDb = () => `test-db-${++dbCounter}`;

describe('LocalService', () => {
  it('rejects appendEvent before startSession', async () => {
    const svc = new LocalService(freshDb());
    await expect(svc.appendEvent({ type: 'typing_burst', size: 5 })).rejects.toThrow(
      /before startSession/,
    );
  });

  it('assigns id and ts to appended events (the Service stamps, not the client)', async () => {
    const svc = new LocalService(freshDb());
    await svc.startSession('doc-1');
    const event = await svc.appendEvent({ type: 'typing_burst', size: 42 });
    expect(event.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    expect(event.size).toBe(42);
  });

  it('records session_start and returns the journal in order', async () => {
    const svc = new LocalService(freshDb());
    await svc.startSession('doc-1');
    await svc.appendEvent({ type: 'claim_set', meta: { claim: 'X' } });
    await svc.appendEvent({ type: 'typing_burst', size: 10 });

    const record = await svc.getRecord('doc-1');
    expect(record.map((e) => e.type)).toEqual(['session_start', 'claim_set', 'typing_burst']);
    const ids = record.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('persists events to IndexedDB — a new instance over the same DB resumes the record', async () => {
    const dbName = freshDb();
    const first = new LocalService(dbName);
    await first.startSession('doc-1');
    await first.appendEvent({ type: 'claim_set', meta: { claim: 'persisted claim' } });
    await first.appendEvent({ type: 'typing_burst', size: 99 });

    const second = new LocalService(dbName);
    await second.startSession('doc-1');
    const record = await second.getRecord('doc-1');

    const types = record.map((e) => e.type);
    expect(types).toEqual([
      'session_start',
      'claim_set',
      'typing_burst',
      'session_start', // the resumed session's own start
    ]);
    expect(record[1].meta?.claim).toBe('persisted claim');
  });

  it('keeps documents separate', async () => {
    const svc = new LocalService(freshDb());
    await svc.startSession('doc-a');
    await svc.appendEvent({ type: 'typing_burst', size: 1 });
    await svc.startSession('doc-b');
    await svc.appendEvent({ type: 'typing_burst', size: 2 });

    const a = await svc.getRecord('doc-a');
    const b = await svc.getRecord('doc-b');
    expect(a.some((e) => e.size === 2)).toBe(false);
    expect(b.some((e) => e.size === 1)).toBe(false);
  });

  it('returns the v1 policy: floor 0, preset 1', async () => {
    await expect(new LocalService(freshDb()).getPolicy()).resolves.toEqual({
      floor: 0,
      preset: 1,
    });
  });

  it('exports a disclosure computed from the journal', async () => {
    const svc = new LocalService(freshDb());
    await svc.startSession('doc-1');
    await svc.appendEvent({ type: 'claim_set', size: 12, meta: { claim: 'A real claim.' } });
    await svc.appendEvent({ type: 'typing_burst', size: 250 });

    const doc = await svc.exportDisclosure('doc-1');
    expect(doc.markdown).toContain('A real claim.');
    expect(doc.markdown).toContain(SCOPING_NOTE);
  });
});
