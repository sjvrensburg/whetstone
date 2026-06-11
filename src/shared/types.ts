/**
 * Cross-module domain interfaces (TechSpec "Implementation Design → Core
 * Interfaces" and "Data Models"). `shared/` has no dependencies on other
 * modules; every other module imports these types from here.
 *
 * Provider- and guard-specific service interfaces (`CoachingProvider`,
 * `RefusalGuard`) live with their owning modules (tasks 09/10); this file
 * holds the data shapes those services exchange.
 */

import type { ObservationKind } from './constants';

// ---------------------------------------------------------------------------
// Coaching — the structured-output domain (ADR-003, ADR-004)
// ---------------------------------------------------------------------------

/**
 * A single anchored coaching move. The shape is the structural floor of the
 * refusal guard: the only fields are coaching moves, and there is no field a
 * model could place replacement prose into (ADR-003). The runtime shape is
 * enforced by the JSON schema and validator in `coaching/schema.ts`.
 */
export interface Observation {
  /** Character offsets into the coached selection that this move addresses. */
  anchor: { start: number; end: number };
  /** Which structural move this is — constrained to the shared taxonomy. */
  kind: ObservationKind;
  /** A short remark about the structure seen. Length-capped; never prose. */
  reflection: string;
  /** The single unblocking question. Must be interrogative. */
  question: string;
}

/**
 * The forced structured output of a coaching turn: a small set of anchored
 * observations and nothing else. The provider produces this against the JSON
 * schema (task 09); the guard validates it (task 10).
 */
export interface StructuredCoaching {
  observations: Observation[];
}

/** The documents Whetstone coaches in V1 (PRD: Markdown + LaTeX only). */
export type DocumentLanguage = 'markdown' | 'latex';

/**
 * A coaching request: the selected passage plus the context needed to build
 * the provider call and map anchors back to the document (TechSpec "Data
 * Models"). `brief` is included when one exists (F5).
 */
export interface CoachingRequest {
  /** The passage the writer asked to coach. */
  selectionText: string;
  /** Document offset of the selection's first character, so selection-relative
   * anchors can be resolved to absolute document positions. */
  anchorBase: number;
  /** Optional writing brief that makes coaching specific rather than generic. */
  brief?: Brief;
  /** The source language of the document the selection came from. */
  documentLanguage: DocumentLanguage;
  /** Optional writer's claim (instrument C, task 22). When present, the coach
   * uses it as context to respond to the writer's own stated point. */
  claim?: string;
}

/**
 * The context the refusal guard screens against. Carries the writer's own
 * passage so the deterministic layer can measure n-gram overlap (the heuristic
 * against "rephrase my sentence") and validate anchor spans (ADR-003).
 */
export interface DocumentContext {
  /** The writer's own passage that was coached — the overlap reference. */
  selectionText: string;
  /** The source language of the document, for language-aware screening. */
  documentLanguage: DocumentLanguage;
}

// ---------------------------------------------------------------------------
// Refusal guard verdicts (ADR-003)
// ---------------------------------------------------------------------------

/**
 * The outcome of `RefusalGuard.screen()`. On success the (validated) coaching
 * is carried through; on failure the offending layer and a reason are returned
 * and suspect text is never rendered.
 */
export type GuardResult =
  | { ok: true; coaching: StructuredCoaching }
  | { ok: false; reason: string; layer: 'deterministic' | 'judge' };

/** The verdict the cloud judge returns for a candidate coaching response. */
export interface GuardVerdict {
  refused: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Provenance ledger (ADR-006)
// ---------------------------------------------------------------------------

/** The event types recorded in the append-only ledger (ADR-006). */
export type LedgerEventType =
  | 'ai_consult'
  | 'suggestion_acted'
  | 'external_insert'
  | 'cloud_send'
  | 'ledger_paused'
  | 'ledger_resumed'
  | 'paste_quarantine'
  | 'paste_claim'
  | 'claim_captured'
  | 'teach_back';

/**
 * One entry in the append-only hash chain. `hash` is
 * `SHA-256(prevHash + canonicalize(entry-without-hash))`; `prevHash` is the
 * empty string for `seq` 0 (ADR-006). `payload` carries metadata only — prose
 * is excluded.
 */
export interface LedgerEvent {
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  type: LedgerEventType;
  /** Prose-free metadata; sensitive content is redacted to metadata only. */
  payload: unknown;
  /** Hash of the previous entry; `""` for the genesis entry. */
  prevHash: string;
  /** `SHA-256(prevHash + canonicalize(entry-without-hash))`. */
  hash: string;
}

/**
 * The provenance ledger service surface. `append` is the single chokepoint;
 * `verify`, `report`, and `exportDisclosure` are read-side computations that
 * stream over the file (ADR-006).
 */
export interface Ledger {
  append(e: Omit<LedgerEvent, 'seq' | 'prevHash' | 'hash'>): Promise<void>;
  verify(): Promise<{ intact: boolean; brokenAt?: number }>;
  report(): Promise<TransparencyReport>;
  exportDisclosure(): Promise<string>;
}

/** A recorded cloud send — provider, model, purpose, and retention disclosure. */
export interface CloudSendLogEntry {
  /** ISO 8601 timestamp of the send. */
  ts: string;
  provider: string;
  model: string;
  purpose: string;
  /** What the provider discloses about retention of the sent text. */
  retention: string;
}

/**
 * A recorded significant external-text insertion: size and location only,
 * never a claim about authorship (ADR-006: record, don't certify).
 */
export interface ExternalInsertLogEntry {
  /** ISO 8601 timestamp of the insertion. */
  ts: string;
  /** Size of the inserted text, in characters. */
  size: number;
  /** Where in the document the insertion occurred. */
  location: string;
}

/**
 * The read-side transparency report computed over the ledger (TechSpec "Data
 * Models", F6). Distinguishes declarable cloud coaching from non-declarable
 * local grammar, and carries scoping language framing it as evidence of
 * process, not proof of personhood.
 */
export interface TransparencyReport {
  /** Event counts keyed by type. */
  countsByType: Record<LedgerEventType, number>;
  /** Every cloud send, for the disclosure. */
  cloudSends: CloudSendLogEntry[];
  /** Hash-chain integrity status (mirrors `Ledger.verify`). */
  integrity: { intact: boolean; brokenAt?: number };
  /** Count of declarable events — cloud AI coaching consultations. */
  declarableCount: number;
  /** Count of non-declarable events — local grammar checks. */
  nonDeclarableCount: number;
  /** Significant external-text insertions, recorded not certified. */
  externalInserts: ExternalInsertLogEntry[];
  /** The honest scoping line attached to every exported artifact. */
  scopingNote: string;
}

// ---------------------------------------------------------------------------
// Writing brief (F5, TechSpec "Data Models")
// ---------------------------------------------------------------------------

/**
 * The optional ~3-field writing brief. All content fields are optional — the
 * writer can fill any subset or skip the brief entirely; coaching works
 * without it. `updatedAt` records when the brief was last persisted.
 */
export interface Brief {
  purposeClaim?: string;
  audienceVenue?: string;
  successCriterion?: string;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
}
