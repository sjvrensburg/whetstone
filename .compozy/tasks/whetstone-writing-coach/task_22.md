---
status: completed
title: Claim-first commitment gate (instrument C)
type: backend
complexity: medium
dependencies:
  - task_14
  - task_17
  - task_20
---

# Task 22: Claim-first commitment gate (instrument C)

## Overview
Add ownership-before-assistance friction (ADR-008, instrument C): before the writer pulls coaching on a passage (or starts a section), they state their own point in a sentence. At the "required" dial the coaching command is gated on it; at "prompt" it nudges; at "off" it does nothing. Forces the writer to own the claim before the tool engages.

<critical>
- ALWAYS READ the PRD (`_prd.md`), TechSpec (`_techspec.md`), and ADR-008 before starting
- REFERENCE ADR-008 for instrument C's dial states — do not duplicate here
- FOCUS ON "WHAT" — describe what needs to be accomplished, not how
- MINIMIZE CODE — show code only to illustrate current structure or problem areas
- TESTS REQUIRED — every task MUST include tests in deliverables
</critical>

<requirements>
- MUST capture the writer's own claim for the passage/section via a lightweight QuickInput (reuse the brief capture infra, task 14).
- MUST gate on the dial: "off" (no-op) → "prompt" (offer, skippable) → "required" (coaching command blocked until a claim is given).
- MUST associate the claim with the passage and pass it as context into the coaching turn; MUST record the claim to the ledger (metadata only).
- MUST degrade gracefully: when "off", coaching behaves exactly as task 12/17 today.
</requirements>

## Subtasks
- [x] 22.1 Implement the claim capture (QuickInput) tied to the passage/section
- [x] 22.2 Gate the coaching command per dial state (off/required)
- [x] 22.3 Pass the claim as coaching context and record it to the ledger

## Implementation Details
Reuses the brief capture/persistence infra (`src/brief/index.ts`, task 14) for the QuickInput, hooks the coaching command (`src/ui/commands.ts`, task 17) before it invokes the turn, and reads its state from the dial (task 20). The claim becomes optional coaching context (the coaching orchestrator already accepts optional context, task 12).

### Relevant Files
- `src/friction/claimFirst.ts` *(new)* — claim capture + command gating + ledger event

### Dependent Files
- `src/ui/commands.ts` (task 17) — the coaching command consults the gate
- `src/coaching/index.ts` (task 12) — receives the claim as context

### Related ADRs
- [ADR-008: Friction-by-Architecture](../adrs/adr-008.md) — instrument C
- [ADR-002: PRD Product Approach](../adrs/adr-002.md) — optional brief becomes a dial-able commitment

## Deliverables
- Claim capture, dial-gated coaching command, claim-as-context + ledger event
- Unit tests with 80%+ coverage **(REQUIRED)**

## Tests
- Unit tests:
  - [x] At "required", the coaching command is blocked until a claim is provided
  - [x] At "off", coaching runs unchanged (no gate)
  - [x] The claim is passed as coaching context and recorded to the ledger
- Integration tests:
  - [x] Required gate: enter claim → coaching proceeds with the claim in context
- Test coverage target: >=80%
- All tests must pass

## Success Criteria
- All tests passing
- Test coverage >=80%
- The gate enforces claim-first only at "required"; "off" preserves today's behavior (asserted)
- The claim reaches the coaching turn as context and is logged
