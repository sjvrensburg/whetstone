/**
 * The Service API seam (walking-skeleton spec §3, ADR-009 §3).
 *
 * The client NEVER writes the journal or stamps time directly — every record
 * mutation goes through a `WhetstoneService`. In v1 a `LocalService` assigns
 * `id`/`ts` locally; in v2 a remote server assigns `ts` on arrival (the
 * witness). The client code does not change — that is hypothesis H4.
 */

import type { Observation } from '../core/coaching';
import type { GuardLayer } from '../core/guard';
import type { ChatTurn } from '../core/prompts';

export type ProcessEventType =
  | 'session_start'
  | 'claim_set'
  | 'typing_burst'
  | 'paste_detected'
  | 'paste_quarantined'
  | 'paste_claimed'
  | 'paste_attributed'
  | 'region_revised'
  | 'coach_consult'
  | 'teach_back' // instrument D (slice 8)
  | 'push_coaching'; // instrument A (slice 9)

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

/** A coaching request — the ONLY path by which prose leaves the device. */
export interface CoachRequest {
  /** The selected passage to coach on (sent to the provider; never journaled). */
  selectionText: string;
  /** The writer's stated claim, included as context only. */
  claim?: string;
}

export type CoachResult =
  | { ok: true; observations: Observation[]; provider: string; model: string }
  | { ok: false; refused: true; layer: GuardLayer; reason: string };

/** One coach-chat turn. History is client-held and never journaled. */
export interface ChatRequest {
  /** The writer's message to the coach. */
  message: string;
  /** Prior turns of this conversation (session-only). */
  history: ChatTurn[];
  /** Draft excerpt for context (sent to the provider; never journaled). */
  contextText?: string;
  claim?: string;
}

export type ChatResult =
  | { ok: true; reply: string; provider: string; model: string }
  | { ok: false; refused: true; layer: GuardLayer; reason: string };

export interface WhetstoneService {
  startSession(docId: string): Promise<void>;
  appendEvent(e: ProcessEventInput): Promise<ProcessEvent>;
  getRecord(docId: string): Promise<ProcessEvent[]>;
  getPolicy(): Promise<FrictionPolicy>;
  exportDisclosure(docId: string): Promise<DisclosureDoc>;
  /**
   * Cloud-egress coaching (slice 5). Optional: absent when no provider is
   * configured — the composer works fully offline without it.
   */
  coach?(req: CoachRequest): Promise<CoachResult>;
  /**
   * Conversational coaching channel (chat). Same egress rules as coach():
   * consent-gated, guarded, journaled as metadata only.
   */
  coachChat?(req: ChatRequest): Promise<ChatResult>;
}
