/**
 * Transparency report computation — a read-side function over the ledger
 * (ADR-006, F6). Streams over parsed `LedgerEvent`s to produce a
 * `TransparencyReport` with counts by type, cloud-send log, external-insert
 * log, integrity status, and the declarable-vs-non-declarable split.
 *
 * Pure function; no I/O, no side effects, no `vscode` import.
 */

import type {
  CloudSendLogEntry,
  ExternalInsertLogEntry,
  LedgerEvent,
  LedgerEventType,
  TransparencyReport,
} from '../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The honest scoping line attached to every exported artifact — ADR-001,
 * ADR-006, PRD: "evidence of process, not proof of personhood."
 */
export const SCOPING_NOTE =
  'This report is evidence of process for transparency and self-accountability — ' +
  'not proof that a human wrote the text.';

/**
 * Event types that involve cloud AI and must be declared in the ICMJE
 * disclosure. `ai_consult` is a cloud coaching session; `cloud_send` records
 * that text left the device for AI processing. Both are declarable because
 * they involve external AI services (ADR-002: paste-ready disclosure with
 * declarable-vs-non-declarable split).
 */
export const DECLARABLE_TYPES: ReadonlySet<LedgerEventType> = new Set(['ai_consult', 'cloud_send']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialize a zeroed counts-by-type record for all known event types. */
function zeroedCounts(): Record<LedgerEventType, number> {
  return {
    ai_consult: 0,
    suggestion_acted: 0,
    external_insert: 0,
    cloud_send: 0,
    ledger_paused: 0,
    ledger_resumed: 0,
  };
}

/**
 * Extract a `CloudSendLogEntry` from a `cloud_send` event's payload.
 * Returns `undefined` if the payload is malformed.
 */
function extractCloudSend(payload: unknown): CloudSendLogEntry | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const p = payload as Record<string, unknown>;
  if (
    typeof p.ts === 'string' &&
    typeof p.provider === 'string' &&
    typeof p.model === 'string' &&
    typeof p.purpose === 'string' &&
    typeof p.retention === 'string'
  ) {
    return {
      ts: p.ts,
      provider: p.provider,
      model: p.model,
      purpose: p.purpose,
      retention: p.retention,
    };
  }
  return undefined;
}

/**
 * Extract an `ExternalInsertLogEntry` from an `external_insert` event's
 * payload. Returns `undefined` if the payload is malformed.
 */
function extractExternalInsert(payload: unknown): ExternalInsertLogEntry | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.ts === 'string' && typeof p.size === 'number' && typeof p.location === 'string') {
    return {
      ts: p.ts,
      size: p.size,
      location: p.location,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

/**
 * Compute a `TransparencyReport` by streaming over parsed ledger events.
 *
 * The report is a read-side computation (ADR-006): it never mutates the
 * ledger and carries no persistent state. The `integrity` parameter comes
 * from `LedgerImpl.verify()` — the report itself does not re-verify the chain.
 *
 * @param events  All events parsed from `ledger.jsonl`.
 * @param integrity  The chain-integrity status from `verify()`.
 */
export function computeReport(
  events: LedgerEvent[],
  integrity: { intact: boolean; brokenAt?: number },
): TransparencyReport {
  const countsByType = zeroedCounts();
  const cloudSends: CloudSendLogEntry[] = [];
  const externalInserts: ExternalInsertLogEntry[] = [];
  let declarableCount = 0;
  let nonDeclarableCount = 0;

  for (const event of events) {
    // Count by type.
    if (event.type in countsByType) {
      countsByType[event.type]++;
    }

    // Declarable vs non-declarable split.
    if (DECLARABLE_TYPES.has(event.type)) {
      declarableCount++;
    } else {
      nonDeclarableCount++;
    }

    // Extract structured log entries.
    if (event.type === 'cloud_send') {
      const entry = extractCloudSend(event.payload);
      if (entry) {
        cloudSends.push(entry);
      }
    }

    if (event.type === 'external_insert') {
      const entry = extractExternalInsert(event.payload);
      if (entry) {
        externalInserts.push(entry);
      }
    }
  }

  return {
    countsByType,
    cloudSends,
    integrity,
    declarableCount,
    nonDeclarableCount,
    externalInserts,
    scopingNote: SCOPING_NOTE,
  };
}
