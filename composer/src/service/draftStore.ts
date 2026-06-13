/**
 * DraftStore — local-only persistence for document prose and titles.
 *
 * DELIBERATELY SEPARATE from `WhetstoneService`. That seam is the witness:
 * in v2 it points at a hosted server, and its core guarantee is "metadata
 * only — prose never leaves the device except through guarded coaching".
 * The writer's working draft (full prose + title) is a purely local
 * convenience, so it lives here, in its own IndexedDB database that the
 * witness upgrade never touches. Putting draft text on the Service interface
 * would ship prose to the server in v2 and break that guarantee.
 *
 * No account, no network, works offline.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** A document's metadata — everything the sidebar needs without loading prose. */
export interface DocMeta {
  id: string;
  title: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 — bumped on every content/title save. */
  updatedAt: string;
}

/** A document with its full prose. */
export interface DraftDoc extends DocMeta {
  content: string;
}

interface DraftDB extends DBSchema {
  drafts: {
    key: string; // doc id
    value: DraftDoc;
  };
}

const DB_NAME = 'whetstone-drafts';
const DB_VERSION = 1;

export const UNTITLED = 'Untitled document';

export class DraftStore {
  private db: Promise<IDBPDatabase<DraftDB>>;

  constructor(dbName: string = DB_NAME) {
    this.db = openDB<DraftDB>(dbName, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      },
    });
  }

  /** All documents, most-recently-edited first. */
  async list(): Promise<DocMeta[]> {
    const db = await this.db;
    const all = await db.getAll('drafts');
    return all
      .map(({ content: _c, ...meta }) => meta)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async get(id: string): Promise<DraftDoc | undefined> {
    const db = await this.db;
    return db.get('drafts', id);
  }

  /** Create a fresh document and return it. Id is content-independent. */
  async create(title: string = UNTITLED): Promise<DraftDoc> {
    const now = new Date().toISOString();
    const doc: DraftDoc = {
      id: `doc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      title: title.trim() || UNTITLED,
      content: '',
      createdAt: now,
      updatedAt: now,
    };
    const db = await this.db;
    await db.put('drafts', doc);
    return doc;
  }

  /** Persist prose for an existing document; bumps `updatedAt`. */
  async saveContent(id: string, content: string): Promise<void> {
    const db = await this.db;
    const existing = await db.get('drafts', id);
    if (!existing) return;
    await db.put('drafts', { ...existing, content, updatedAt: new Date().toISOString() });
  }

  /** Rename a document; bumps `updatedAt`. */
  async setTitle(id: string, title: string): Promise<void> {
    const db = await this.db;
    const existing = await db.get('drafts', id);
    if (!existing) return;
    await db.put('drafts', {
      ...existing,
      title: title.trim() || UNTITLED,
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.db;
    await db.delete('drafts', id);
  }
}
