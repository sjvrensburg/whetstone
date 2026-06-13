# Task Memory: task_22.md

Keep only task-local execution context here. Do not duplicate facts that are obvious from the repository, task file, PRD documents, or git history.

## Objective Snapshot

Implement claim-first commitment gate (instrument C, ADR-008):
- QuickInput for writer to state their claim before coaching
- Dial-gated: off (no-op) → required (block until claim)
- Pass claim as context to coaching turn; record to ledger

## Important Decisions

- `ClaimFirstState` has only 2 states (`off`, `required`) — no `prompt`. The task spec mentioned "prompt" but ADR-008 and presets.ts only define off/required. "Required" IS the prompt-and-block behavior.
- `ClaimFirstGateDeps.ledger` typed as `{ append(...) }` (not full `Ledger`) — the gate only needs `append`. Matches `PasteQuarantineDeps` pattern.
- Gate runs in coaching command AFTER consent but BEFORE `buildCoachingDeps` — the claim is needed before coaching starts.
- `claim_captured` ledger event records metadata only (claim length, dial state) — not the claim text itself.

## Learnings

- Adding to `LedgerEventType` union requires updating: `zeroedCounts()` in `report.ts`, ALL test files with inline `countsByType` objects (3 locations in `documents.test.ts`, 1 in `shared-types.test.ts`).
- Adding to `CoachingRequest`/`CoachingTurnInput` requires updating `buildCoachingRequest` spread + `buildAiConsultPayload` + the orchestration test's payload assertion.

## Files / Surfaces

- **New**: `src/friction/claimFirst.ts` — ClaimFirstGate class + ClaimPrompter DI seam
- **New**: `test/unit/friction-claimFirst.test.ts` — 23 tests
- **Modified**: `src/friction/index.ts` — barrel exports
- **Modified**: `src/shared/types.ts` — added `claim_captured` to LedgerEventType, `claim?` to CoachingRequest
- **Modified**: `src/coaching/index.ts` — `claim?` on CoachingTurnInput, buildCoachingRequest, buildAiConsultPayload
- **Modified**: `src/ui/commands.ts` — ClaimFirstGate wired into UICommandDeps + handleCoachSelection
- **Modified**: `src/extension.ts` — wiring: create ClaimFirstGate + ClaimPrompter
- **Modified**: `src/ledger/report.ts` — `claim_captured` in zeroedCounts()
- **Modified**: test/unit/ledger/documents.test.ts, shared-types.test.ts, coaching-orchestration.test.ts, ui-commands.test.ts

## Errors / Corrections

## Ready for Next Run
