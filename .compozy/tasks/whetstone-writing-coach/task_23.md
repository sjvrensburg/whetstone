---
status: completed
title: Teach-back checkpoints (instrument D)
type: backend
complexity: medium
dependencies:
  - task_12
  - task_07
  - task_17
  - task_20
---

# Task 23: Teach-back checkpoints (instrument D)

## Overview
Add reflection friction (ADR-008, instrument D): after a section, the writer summarizes their own argument in one line. If they can't — that *is* the signal of disconnection from their own thinking. Supportive, not punitive: it surfaces the gap, it does not block by default. Dial-gated (off → per-section).

<critical>
- ALWAYS READ the PRD (`_prd.md`), TechSpec (`_techspec.md`), and ADR-008 before starting
- REFERENCE ADR-008 for instrument D's dial states — do not duplicate here
- FOCUS ON "WHAT" — describe what needs to be accomplished, not how
- MINIMIZE CODE — show code only to illustrate current structure or problem areas
- TESTS REQUIRED — every task MUST include tests in deliverables
</critical>

<requirements>
- MUST trigger a teach-back prompt at section boundaries when the dial enables it (off → per-section), asking the writer to summarize the section's argument in one line.
- MUST detect a "disconnect" signal (empty / too-short / placeholder summary) and surface it supportively (a gentle nudge, NOT a block) — framing per ADR-008 (desirable difficulty, never punitive).
- MUST record the teach-back outcome (given / skipped / disconnect-flagged) to the ledger as metadata only — never the summary prose where sensitive.
- MUST NOT block writing; the checkpoint is dismissible.
</requirements>

## Subtasks
- [x] 23.1 Detect section boundaries and trigger the checkpoint per dial state
- [x] 23.2 Capture the one-line self-summary (QuickInput), dismissible
- [x] 23.3 Compute the disconnect signal and surface it supportively
- [x] 23.4 Record the teach-back outcome to the ledger (metadata only)

## Implementation Details
Triggers off the document structure (section/heading boundaries), captures via QuickInput, and records through the ledger (`src/ledger/index.ts`, task 07). Reads its state from the dial (task 20); surfaced through the UI (task 17). Keep framing supportive per ADR-008 — the teach-back is a mirror moment, not a gate.

### Relevant Files
- `src/friction/teachBack.ts` *(new)* — boundary trigger + summary capture + disconnect signal + ledger event

### Dependent Files
- `src/friction/mirror.ts` (task 25) — may surface teach-back engagement
- `src/ledger/index.ts` (task 07) — receives teach-back outcome events

### Related ADRs
- [ADR-008: Friction-by-Architecture](../adrs/adr-008.md) — instrument D; supportive-not-punitive framing
- [ADR-001: V1 Scope](../adrs/adr-001.md) — honest "evidence of process"; metadata-only ledger

## Deliverables
- Section-boundary teach-back, disconnect signal, dial gating, ledger event
- Unit tests with 80%+ coverage **(REQUIRED)**

## Tests
- Unit tests:
  - [x] A section boundary triggers the checkpoint only when the dial enables it
  - [x] An empty/too-short summary raises a disconnect signal (nudge, not block)
  - [x] A given summary records a "teach-back given" outcome; skipping records "skipped"
  - [x] The ledger payload contains no summary prose where flagged sensitive
  - [x] Writing is never blocked by the checkpoint (dismissible)
- Integration tests:
  - [x] Finish a section → prompt appears → summary or skip → outcome logged, writing uninterrupted
- Test coverage target: >=80%
- All tests must pass

## Success Criteria
- All tests passing
- Test coverage >=80%
- Disconnect is surfaced supportively and never blocks writing (asserted)
- Teach-back outcomes are logged as metadata only
