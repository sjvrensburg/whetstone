---
status: completed
title: Writing brief capture (QuickInput) + persistence
type: frontend
complexity: medium
dependencies:
  - task_02
---

# Task 14: Writing brief capture (QuickInput) + persistence

## Overview
Implement the optional ~3-field writing brief (F5) via a multi-step QuickInput (purpose/claim, audience/venue, success criterion), persisted per workspace to `brief.json`, fully skippable, and editable anytime. When present it makes coaching specific rather than generic; coaching works fully without it, protecting time-to-first-value.

<critical>
- ALWAYS READ the PRD (`_prd.md`) and TechSpec (`_techspec.md`) before starting
- REFERENCE TECHSPEC for implementation details — do not duplicate interfaces or code here
- FOCUS ON "WHAT" — describe what needs to be accomplished, not how
- MINIMIZE CODE — show code only to illustrate current structure or problem areas
- TESTS REQUIRED — every task MUST include tests in deliverables
</critical>

<requirements>
- MUST capture the three optional fields via a multi-step QuickInput/QuickPick flow (ADR-007), each field skippable.
- MUST persist the brief per workspace to `brief.json` with `updatedAt`; all fields optional.
- MUST be editable anytime and fully skippable — no field is required.
- MUST expose the brief as optional context for coaching (consumed by task 12 when present).
</requirements>

## Subtasks
- [x] 14.1 Implement the multi-step QuickInput capture for the three optional fields
- [x] 14.2 Persist and load `brief.json` per workspace with `updatedAt`
- [x] 14.3 Expose read access for coaching context and an edit command

## Implementation Details
See PRD F5, ADR-007 (the brief is a QuickInput flow, no webview), and TechSpec "Data Models" (`brief.json` shape). Reuses the `Brief` type from task 02. The coaching orchestrator (task 12) reads the brief when present; the UI (task 17) registers the brief edit command.

### Relevant Files
- `src/brief/index.ts` *(new)* — QuickInput capture + `brief.json` persistence + read access

### Dependent Files
- `src/coaching/index.ts` (task 12) — reads the brief as optional context
- `src/ui/commands.ts` (task 17) — registers the brief edit/capture command

### Related ADRs
- [ADR-007: Sidebar UI — Native-First](../adrs/adr-007.md) — QuickInput for the brief; no webview
- [ADR-002: PRD Product Approach](../adrs/adr-002.md) — optional brief; protects time-to-first-value

## Deliverables
- The brief capture flow and per-workspace persistence with read access
- Unit tests with 80%+ coverage **(REQUIRED)**
- Integration test of the QuickInput capture/edit flow **(REQUIRED)**

## Tests
- Unit tests:
  - [x] Skipping all fields persists an empty-but-valid brief
  - [x] Partial fields persist correctly and load back identically
  - [x] `updatedAt` changes when the brief is edited
  - [x] Read access returns the persisted brief for coaching context
- Integration tests:
  - [x] The QuickInput flow captures and persists a brief in the test host
  - [x] Re-running the flow edits the existing brief
- Test coverage target: >=80%
- All tests must pass

## Success Criteria
- All tests passing
- Test coverage >=80%
- The brief is fully skippable and editable anytime
- A persisted brief is available to coaching as optional context
