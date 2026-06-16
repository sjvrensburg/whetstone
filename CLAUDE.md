# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Whetstone** — a friction-first writing surface for students under honor codes.
There are two active surfaces sharing the same domain model:

- The **web composer** in `composer/` (TypeScript, the ADR-009 walking
  skeleton).
- The **terminal editor** in `tui/` (Rust, `whetstone-tui`) — a port of the
  composer's domain logic with a Fresh/Micro-style UI (menus, theming, mouse,
  no modes). See `tui/README.md` for keybindings, env vars, and config files.

The top-level `src/` and root package is the **legacy VS Code extension** (V1,
superseded by ADR-009) — kept for reference and as the source of ported domain
logic; do not extend it.

Design history lives in `.compozy/tasks/whetstone-writing-coach/` (ADRs,
walking-skeleton spec). **ADR-009** and **_walking-skeleton.md** are the governing
documents for `composer/`; **ADR-008** governs the friction-dial UX.

## Two project contexts

- **Root** — legacy VS Code extension (reference only). Root `package.json` defines vitest config used by both projects.
- **`composer/`** — active web product (ADR-009). Has its own `package.json` and build pipeline (Vite).
- **`tui/`** — active terminal editor (`whetstone-tui`, Rust, edition 2024). Self-contained Cargo crate; ports the same `core/` domain invariants. Run checks inside `tui/`: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`. CI: `.github/workflows/tui-ci.yml`.

## Commands (run inside `composer/`)

**Dev and build:**
- `npm run dev` — Vite dev server (HMR-enabled, port 5173 by default)
- `npm run build` — TypeScript type check + production build
- `npm run preview` — preview production build locally

**Testing:**
- `npm test` — run all tests with coverage report
- `npm run test:watch` — continuous test watch mode (useful during development)
- `npx vitest run test/ownership.test.ts` — run one test file
- `npx vitest run -t "pattern"` — run tests matching a name pattern
- Coverage reports are generated in `composer/coverage/`

**Code quality (root or composer):**
- `npm run check-types` — TypeScript type checking (critical before commits; catches errors the type checker missed)
- `npm run lint` — ESLint check
- `npm run format` — Prettier format in-place
- `npm run format:check` — Prettier check without modifying

**Critical: keep `test/serviceSeam.test.ts` passing** when modifying `composer/src/service/types.ts`. This test enforces that the Service API is substitutable (local IndexedDB ↔ remote witness server).

## Architecture (composer)

The keystone is the **Service API seam** (`composer/src/service/types.ts`):
the client never writes the journal or stamps time — every record mutation
goes through a `WhetstoneService`, which assigns event `id`/`ts`. v1 is
`LocalService` (IndexedDB); v2 swaps in a hosted "witness" server behind the
same interface with no client change. `test/serviceSeam.test.ts` enforces this
substitutability — keep it passing when touching the interface.

**Core modules:**

- `src/core/` — pure domain logic ported from V1 (n-gram overlap, claim-to-own
  ownership, forbidden-label guard, disclosure rendering). No editor or DOM imports.
  - `ownership.ts` — critical invariant: measures "how much of the ORIGINAL paste survives", never the reverse.

- `src/editor/` — CodeMirror 6 integration. Editor-only, no service calls.
  - Paste-quarantine: `transactionExtender` on `input.paste` creates regions in the same transaction
  - Claim-clearing dispatch deferred via `queueMicrotask`
  - Typing-burst journaling with cadence batching

- `src/grammar/` — local grammar checking via harper.js. Wired as CodeMirror diagnostics.

- `src/instruments/` — wires core domain logic, service calls, and coaching events into the editor and coaching pipeline.
  - Examples: `pushCadence.ts` (batching coaching), `quarantine.ts` (paste handling), `teachBack.ts` (coaching prompts)

- `src/service/` — defines the Service API seam and implements LocalService (IndexedDB-backed).
  - `types.ts` — the WhetstoneService interface (substitutability contract)
  - `localService.ts` — IndexedDB implementation
  - `coach.ts` — delegates to Anthropic API via @anthropic-ai/sdk

- `src/ui/` — thin DOM components (claim gate, journal panel, disclosure modal, coach chat box).

- `src/main.ts` — wiring and initialization only.

**Key dependencies:**

- `@anthropic-ai/sdk` — Anthropic API client for coaching inference (routed through service layer)
- `@codemirror/*` — editor state, view, commands, and lint diagnostics
- `harper.js` — local grammar checking (zero external API calls)
- `idb` + `fake-indexeddb` — IndexedDB abstraction; fake used in tests
- `vite` — dev server and production bundler
- `vitest` — test runner with jsdom for DOM tests

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
- **Friction dial** (ADR-008): instruments respond to friction level (0–3). Overridable per-instrument via config.
