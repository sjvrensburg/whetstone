import 'fake-indexeddb/auto';
/**
 * H4 (walking-skeleton spec §10): the Service API cleanly separates client
 * from record/policy — a (mock) RemoteService behind the same interface
 * requires no client change. The "client routine" below is written once
 * against `WhetstoneService` and runs unchanged against both implementations.
 */
import { describe, expect, it } from 'vitest';
import { renderDisclosure, SCOPING_NOTE } from '../src/core/disclosure';
import { LocalService } from '../src/service/local';
import type {
  DisclosureDoc,
  FrictionPolicy,
  ProcessEvent,
  ProcessEventInput,
  WhetstoneService,
} from '../src/service/types';

/**
 * A stand-in for the v2 hosted service: the "server" assigns `id` and `ts`
 * on arrival (the witness). Implements the same interface; no client change.
 */
class MockRemoteService implements WhetstoneService {
  private store = new Map<string, ProcessEvent[]>();
  private current: string | null = null;
  private serverClock = Date.parse('2026-06-11T12:00:00Z');
  private seq = 0;

  async startSession(docId: string): Promise<void> {
    this.current = docId;
    if (!this.store.has(docId)) this.store.set(docId, []);
    await this.appendEvent({ type: 'session_start' });
  }

  async appendEvent(e: ProcessEventInput): Promise<ProcessEvent> {
    if (!this.current) throw new Error('appendEvent before startSession');
    // The SERVER stamps on arrival — that is the witness upgrade.
    const event: ProcessEvent = {
      ...e,
      id: `srv-${this.seq++}`,
      ts: new Date((this.serverClock += 1000)).toISOString(),
    };
    this.store.get(this.current)!.push(event);
    return event;
  }

  async getRecord(docId: string): Promise<ProcessEvent[]> {
    return [...(this.store.get(docId) ?? [])];
  }

  async getPolicy(): Promise<FrictionPolicy> {
    return { floor: 1, preset: 2 }; // an institutional floor — a v2 concern
  }

  async exportDisclosure(docId: string): Promise<DisclosureDoc> {
    return renderDisclosure(docId, await this.getRecord(docId));
  }
}

/**
 * The client routine: exactly what the composer does in a session, written
 * once against the interface. If this compiles and behaves identically for
 * both implementations, the seam holds.
 */
async function clientSession(service: WhetstoneService, docId: string) {
  await service.startSession(docId);
  await service.appendEvent({ type: 'claim_set', size: 20, meta: { claim: 'My one-line thesis.' } });
  await service.appendEvent({ type: 'typing_burst', size: 120, location: { from: 0, to: 120 } });
  await service.appendEvent({
    type: 'paste_quarantined',
    size: 80,
    location: { from: 120, to: 200 },
    meta: { regionId: 'r1' },
  });
  await service.appendEvent({ type: 'paste_claimed', size: 60, meta: { regionId: 'r1' } });

  const policy = await service.getPolicy();
  const record = await service.getRecord(docId);
  const disclosure = await service.exportDisclosure(docId);
  return { policy, record, disclosure };
}

describe('H4 — Service seam substitutability', () => {
  const implementations: [string, () => WhetstoneService][] = [
    ['LocalService', () => new LocalService(`seam-${Math.random().toString(36).slice(2)}`)],
    ['MockRemoteService', () => new MockRemoteService()],
  ];

  for (const [name, make] of implementations) {
    it(`runs the unchanged client routine against ${name}`, async () => {
      const { policy, record, disclosure } = await clientSession(make(), 'essay-1');

      expect(record.map((e) => e.type)).toEqual([
        'session_start',
        'claim_set',
        'typing_burst',
        'paste_quarantined',
        'paste_claimed',
      ]);
      // The Service — never the client — stamped every event.
      for (const e of record) {
        expect(e.id).toBeTruthy();
        expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      }
      expect([0, 1, 2, 3]).toContain(policy.floor);
      expect(disclosure.markdown).toContain('My one-line thesis.');
      expect(disclosure.markdown).toContain('Pastes rewritten until owned: 1');
      expect(disclosure.scopingNote).toBe(SCOPING_NOTE);
    });
  }

  it('both implementations produce an identical disclosure for the same stream', async () => {
    const [local, remote] = await Promise.all(
      implementations.map(([, make]) => clientSession(make(), 'essay-1')),
    );
    // Timestamps differ (different clocks); the disclosure content modulo the
    // session line must be identical.
    const stripSession = (md: string) =>
      md
        .split('\n')
        .filter((line) => !line.startsWith('Session:'))
        .join('\n');
    expect(stripSession(local.disclosure.markdown)).toBe(
      stripSession(remote.disclosure.markdown),
    );
  });
});
