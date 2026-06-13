# Task Memory: task_23.md

Keep only task-local execution context here. Do not duplicate facts that are obvious from the repository, task file, PRD documents, or git history.

## Objective Snapshot

Implement teach-back checkpoints (instrument D): section-boundary trigger, one-line self-summary capture, disconnect signal detection, dial gating, ledger recording. Supportive, never blocking.

## Important Decisions

- Single event type `teach_back` in ledger (not separate given/skipped events) — outcome is in `payload.outcome` field
- `isDisconnect()` is exported as a pure function for testability and reuse by the mirror module (task 25)
- Placeholder patterns are case-insensitive regex; includes common non-answers (idk, n/a, dots, dashes)
- `MIN_SUMMARY_LENGTH = 10` chars — below this is a disconnect signal
- Follows ClaimFirstGate DI pattern: `{ dial, ledger, now }` deps + separate `SummaryPrompter` seam

## Learnings

- Adding `LedgerEventType` members requires updating: `src/shared/types.ts`, `zeroedCounts()` in `src/ledger/report.ts`, AND all test files with inline `countsByType` objects (3 in `documents.test.ts`, 1 in `shared-types.test.ts`)
- The unused import `TeachBackResult` caused TS6196 — fixed by removing the unused type import from test file

## Files / Surfaces

- `src/friction/teachBack.ts` *(new)* — 263 lines, 100% coverage
- `test/unit/friction-teachBack.test.ts` *(new)* — 45 tests
- `src/shared/types.ts` — added `teach_back` to `LedgerEventType`
- `src/ledger/report.ts` — added `teach_back: 0` to `zeroedCounts()`
- `src/friction/index.ts` — exported new module
- `vitest.config.ts` — added `teachBack.ts` to coverage include
- `test/unit/ledger/documents.test.ts` — 3x `countsByType` updates
- `test/unit/shared-types.test.ts` — 1x `countsByType` update

## Errors / Corrections

- None during implementation

## Ready for Next Run

- Task 24 (push cadence, instrument A) and task 25 (mirror, instrument E) can consume `TeachBackCheckpoint` for engagement data
- `isDisconnect()` is available for mirror module reuse
