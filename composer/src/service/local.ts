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
import { isStructuredCoaching, validateStructuredCoaching } from '../core/coaching';
import { renderDisclosure } from '../core/disclosure';
import { runDeterministicChecks, screenInjection } from '../core/guard';
import { buildCoachMessages } from '../core/prompts';
import type { CoachProvider } from './provider';
import type {
  CoachRequest,
  CoachResult,
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

  /** Set when the student has configured a provider; coaching is optional. */
  private provider: CoachProvider | null = null;

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

  setProvider(provider: CoachProvider | null): void {
    this.provider = provider;
  }

  /**
   * Cloud-egress coaching (slice 5). The pipeline, in order:
   *
   *   1. Injection screen on the selection (input channel) — refuses BEFORE
   *      any egress.
   *   2. Provider call (the student's own key; the only prose egress).
   *   3. Schema validation (structural floor) + deterministic guard checks
   *      on the output — a failing response is never returned to the UI.
   *
   * Every consult — successful or refused — is journaled as a metadata-only
   * `coach_consult` event (selection size, provider, model, outcome). The
   * journal never carries the prose or the coaching text.
   */
  async coach(req: CoachRequest): Promise<CoachResult> {
    const provider = this.provider;
    if (!provider) {
      return { ok: false, refused: true, layer: 'provider', reason: 'no provider configured' };
    }

    const journal = async (outcome: Record<string, string | number | boolean>) => {
      await this.appendEvent({
        type: 'coach_consult',
        size: req.selectionText.length,
        meta: { provider: provider.name, model: provider.model, ...outcome },
      });
    };

    const injection = screenInjection(req.selectionText);
    if (!injection.ok) {
      await journal({ refused: true, layer: 'injection' });
      return { ok: false, refused: true, layer: 'injection', reason: injection.reason };
    }

    let raw: unknown;
    try {
      raw = await provider.complete(buildCoachMessages(req.selectionText, req.claim));
    } catch (error) {
      await journal({ refused: true, layer: 'provider' });
      return {
        ok: false,
        refused: true,
        layer: 'provider',
        reason: error instanceof Error ? error.message : 'provider call failed',
      };
    }

    const valid = validateStructuredCoaching(raw);
    if (!valid.ok || !isStructuredCoaching(raw)) {
      await journal({ refused: true, layer: 'schema' });
      return {
        ok: false,
        refused: true,
        layer: 'schema',
        reason: valid.ok ? 'schema validation failed' : valid.reason,
      };
    }

    const det = runDeterministicChecks(raw, req.selectionText);
    if (!det.ok) {
      await journal({ refused: true, layer: 'deterministic' });
      return { ok: false, refused: true, layer: 'deterministic', reason: det.reason };
    }

    await journal({ refused: false, observations: raw.observations.length });
    return { ok: true, observations: raw.observations, provider: provider.name, model: provider.model };
  }
}
