/**
 * The Service API seam (walking-skeleton spec §3, ADR-009 §3).
 *
 * The client NEVER writes the journal or stamps time directly — every record
 * mutation goes through a `WhetstoneService`. In v1 a `LocalService` assigns
 * `id`/`ts` locally; in v2 a remote server assigns `ts` on arrival (the
 * witness). The client code does not change — that is hypothesis H4.
 */

export type ProcessEventType =
  | 'session_start'
  | 'claim_set'
  | 'typing_burst'
  | 'paste_detected'
  | 'paste_quarantined'
  | 'paste_claimed'
  | 'paste_attributed'
  | 'region_revised'
  | 'coach_consult'; // reserved, deferred

export interface ProcessEvent {
  /** Assigned by the Service. */
  id: string;
  /** ISO 8601 — assigned by the Service (v2: the SERVER stamps = the witness). */
  ts: string;
  type: ProcessEventType;
  /** Characters — METADATA ONLY, never the prose itself. */
  size?: number;
  location?: { from: number; to: number };
  meta?: Record<string, string | number | boolean>;
}

/** An event as submitted by the client — the Service assigns `id` and `ts`. */
export type ProcessEventInput = Omit<ProcessEvent, 'id' | 'ts'>;

export interface FrictionPolicy {
  /** Institutional minimum (v1: 0; set by org in v2). */
  floor: 0 | 1 | 2 | 3;
  /** Dial default. */
  preset: 0 | 1 | 2 | 3;
}

export interface DisclosureDoc {
  markdown: string;
  scopingNote: string;
}

export interface WhetstoneService {
  startSession(docId: string): Promise<void>;
  appendEvent(e: ProcessEventInput): Promise<ProcessEvent>;
  getRecord(docId: string): Promise<ProcessEvent[]>;
  getPolicy(): Promise<FrictionPolicy>;
  exportDisclosure(docId: string): Promise<DisclosureDoc>;
  // coach?(req): Promise<CoachResult>;   // deferred — next slice after the skeleton validates
}
