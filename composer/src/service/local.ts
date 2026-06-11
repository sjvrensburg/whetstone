/**
 * LocalService — the v1, in-process implementation of `WhetstoneService`
 * (walking-skeleton spec §3).
 *
 * Events are held in memory and persisted to IndexedDB keyed by `docId`.
 * The Service — never the client — assigns `id` and `ts`; that discipline is
 * the seam that makes the v2 hosted/witness swap a deployment change.
 *
 * No account, no network, works offline.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { renderDisclosure } from '../core/disclosure';
import type {
  DisclosureDoc,
  FrictionPolicy,
  ProcessEvent,
  ProcessEventInput,
  WhetstoneService,
} from './types';

interface WhetstoneDB extends DBSchema {
  events: {
    key: string; // event id
    value: ProcessEvent & { docId: string };
    indexes: { 'by-doc': string };
  };
}

const DB_NAME = 'whetstone-composer';
const DB_VERSION = 1;

export class LocalService implements WhetstoneService {
  private db: Promise<IDBPDatabase<WhetstoneDB>>;
  /** In-memory journal per doc — the IndexedDB rows are the persisted copy. */
  private journal = new Map<string, ProcessEvent[]>();
  private currentDocId: string | null = null;
  private seq = 0;

  constructor(dbName: string = DB_NAME) {
    this.db = openDB<WhetstoneDB>(dbName, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('events', { keyPath: 'id' });
        store.createIndex('by-doc', 'docId');
      },
    });
  }

  async startSession(docId: string): Promise<void> {
    this.currentDocId = docId;
    // Hydrate the in-memory journal from persistence so a reload resumes
    // the same record rather than forking it.
    const db = await this.db;
    const persisted = await db.getAllFromIndex('events', 'by-doc', docId);
    persisted.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
    this.journal.set(
      docId,
      persisted.map(({ docId: _d, ...event }) => event),
    );
    await this.appendEvent({ type: 'session_start' });
  }

  async appendEvent(e: ProcessEventInput): Promise<ProcessEvent> {
    const docId = this.currentDocId;
    if (!docId) {
      throw new Error('appendEvent before startSession — no active document');
    }

    // The Service assigns id + ts (spec §3). The sequence suffix keeps ids
    // unique and ordered even when two events share a millisecond.
    const event: ProcessEvent = {
      ...e,
      id: `${Date.now().toString(36)}-${(this.seq++).toString(36).padStart(4, '0')}`,
      ts: new Date().toISOString(),
    };

    const events = this.journal.get(docId) ?? [];
    events.push(event);
    this.journal.set(docId, events);

    const db = await this.db;
    await db.put('events', { ...event, docId });

    return event;
  }

  async getRecord(docId: string): Promise<ProcessEvent[]> {
    const cached = this.journal.get(docId);
    if (cached) return [...cached];
    const db = await this.db;
    const persisted = await db.getAllFromIndex('events', 'by-doc', docId);
    persisted.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
    return persisted.map(({ docId: _d, ...event }) => event);
  }

  async getPolicy(): Promise<FrictionPolicy> {
    return { floor: 0, preset: 1 };
  }

  async exportDisclosure(docId: string): Promise<DisclosureDoc> {
    const events = await this.getRecord(docId);
    return renderDisclosure(docId, events);
  }
}
