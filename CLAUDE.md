# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Whetstone** — a friction-first writing surface for students under honor codes.
The active product is the **web composer** in `composer/` (the ADR-009 walking
skeleton). The top-level `src/` is the **legacy VS Code extension** (V1,
superseded by ADR-009) — kept for reference and as the source of ported domain
logic; do not extend it.

Design history lives in `.compozy/tasks/whetstone-writing-coach/` (ADRs,
walking-skeleton spec). ADR-009 and `_walking-skeleton.md` are the governing
documents for `composer/`.

## Commands (run inside `composer/`)

- `npm run dev` — Vite dev server
- `npm run build` — `tsc --noEmit` + production build
- `npm test` — full vitest suite; `npx vitest run test/ownership.test.ts` for one file,
  `npx vitest run -t "padding"` for one test by name

Legacy extension commands are in the root `package.json` (vitest config at root).

## Architecture (composer)

The keystone is the **Service API seam** (`composer/src/service/types.ts`):
the client never writes the journal or stamps time — every record mutation
goes through a `WhetstoneService`, which assigns event `id`/`ts`. v1 is
`LocalService` (IndexedDB); v2 swaps in a hosted "witness" server behind the
same interface with no client change. `test/serviceSeam.test.ts` enforces this
substitutability — keep it passing when touching the interface.

- `src/core/` — pure domain logic ported from V1 (n-gram overlap, claim-to-own
  ownership, forbidden-label guard, disclosure rendering). No editor or DOM imports.
- `src/editor/` — CodeMirror 6 instruments: paste-quarantine (a
  `transactionExtender` on `input.paste` creates regions in the same
  transaction; claim-clearing dispatch is deferred via `queueMicrotask`) and
  typing-burst journaling.
- `src/ui/` — thin DOM components (claim gate, journal panel, disclosure modal).
- `src/main.ts` — wiring only.

## Project-specific invariants

- **Metadata only**: process events never carry document prose (sizes,
  locations, and the writer's own stated claim only).
- **Claim-to-own direction**: ownership is measured as *how much of the
  ORIGINAL paste survives in the current text* (`src/core/ownership.ts`), never
  the reverse — the reverse is the V1 padding-attack bug, guarded by a
  regression test.
- **Forbidden-label guard**: every user-facing artifact must pass
  `assertNoForbiddenLabels` — nothing may imply "verified human" /
  proof-of-personhood. The product claim is *friction, not proof*.
- **Honest scoping note**: exports state the record is local and self-reported.
