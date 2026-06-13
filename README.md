# Whetstone

A friction-first writing surface for students operating under honor codes. Whetstone provides real-time coaching and provenance tracking to help you develop your own voice while maintaining academic integrity.

## Features

- **Real-time writing coaching** — Claude-powered suggestions that sharpen your draft without writing for you
- **Provenance ledger** — transparent, always-on tracking of what text came from where (pastes, external sources, typing)
- **Local grammar checking** — instant grammar diagnostics powered by harper.js (no external API calls)
- **Honor code compliance** — built on friction, not proof. Everything is self-reported; nothing claims to verify authorship
- **Customizable friction** — dial the intensity of coaching and friction instruments to match your workflow

## What's in this repo

**Active product:** `composer/` — a web-based writing surface (built with Vite + TypeScript + CodeMirror 6)

**Reference:** root `src/` — legacy VS Code extension (V1, superseded by the web composer)

**Design history:** `.compozy/tasks/whetstone-writing-coach/` — ADRs, PRD, tech spec, and task tracking

## Getting Started

### Prerequisites

- Node.js 20 or higher
- npm

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd whetstone

# Install dependencies (both root and composer)
npm install
cd composer && npm install && cd ..
```

### Running the development server

```bash
cd composer
npm run dev
```

The app will be available at `http://localhost:5173` (Vite default). Hot module replacement (HMR) is enabled—changes save and reload instantly.

### Building for production

```bash
cd composer
npm run build
```

Output goes to `composer/dist/`. Type checking runs automatically during the build.

## Development

### Running tests

```bash
cd composer

# Run all tests once with coverage
npm test

# Watch mode (re-run on file change)
npm run test:watch

# Run a single test file
npx vitest run test/ownership.test.ts

# Run tests matching a name pattern
npx vitest run -t "paste"
```

Test coverage is reported to `composer/coverage/`. Coverage includes unit and integration tests; notable test files:

- `test/ownership.test.ts` — critical domain logic for the V1 padding-attack guard
- `test/serviceSeam.test.ts` — enforces that the Service API is substitutable (local ↔ remote)
- `test/quarantine.test.ts` — paste-region boundary handling
- `test/disclosure.test.ts` — provenance ledger export formats

### Code quality

```bash
cd composer

# Type checking (catches TypeScript errors)
npm run check-types

# Lint check
npm run lint

# Format code
npm run format

# Check formatting without modifying
npm run format:check
```

Run `npm run check-types` before commits—it's critical and catches errors the type checker missed.

### Understanding the architecture

The keystone is the **Service API seam** (`src/service/types.ts`). The client never writes the journal or stamps time—every record mutation goes through a `WhetstoneService` interface, which assigns event `id`/`ts`. This allows swapping implementations:

- **v1 (current):** `LocalService` — IndexedDB-backed, fully local
- **v2 (future):** Remote "witness" server, same interface, zero client changes

Core modules:

- **`src/core/`** — pure domain logic (n-gram overlap, ownership calculation, forbidden-label guard, disclosure rendering). No editor or DOM imports.
- **`src/editor/`** — CodeMirror 6 integration (paste quarantine, typing-burst journaling). Editor state only, no service calls.
- **`src/grammar/`** — local grammar diagnostics via harper.js, wired as CodeMirror linter.
- **`src/instruments/`** — wires domain logic and coaching into the editor pipeline (e.g., `pushCadence.ts`, `quarantine.ts`, `teachBack.ts`).
- **`src/service/`** — Service API interface and LocalService implementation (IndexedDB).
- **`src/ui/`** — thin DOM components (claim gate, journal panel, disclosure modal, coach chat box).
- **`src/main.ts`** — initialization and wiring.

For more details, see `CLAUDE.md`.

## Key project invariants

- **Metadata only** — process events never carry document prose. Only sizes, locations, and the writer's stated claim.
- **Claim-to-own direction** — ownership measures how much of the *original* paste survives in current text, never the reverse. (The reverse is the V1 padding-attack bug.)
- **Forbidden-label guard** — all user-facing artifacts pass `assertNoForbiddenLabels`. Nothing may imply "verified human" or proof-of-personhood. The product claim is *friction, not proof*.
- **Honest scoping note** — exports state that the record is local and self-reported.
- **Friction dial** (ADR-008) — instruments respond to configurable friction levels (0–3).

## Configuring Whetstone

### Local development

The web app reads and writes to IndexedDB in the browser. No server required for local development.

### Model configuration

By default, Whetstone uses the Anthropic API for coaching. Set your API key in the browser when first prompting for coaching (SecureStorage in production).

## Design documents

- **ADR-009:** Architecture Decision Record for the web compositor (walking skeleton)
- **ADR-008:** Friction dial—configurable intensity for coaching and friction instruments
- **_walking-skeleton.md:** Feature spec and design for the current sprint
- **_techspec.md:** Technical architecture and service layer design

See `.compozy/tasks/whetstone-writing-coach/` for the full design history.

## License

MIT

## Contributing

This is an active research project. Design changes are tracked in ADRs. Before making large changes, review ADR-009 and the walking-skeleton spec.

For development guidance, see `CLAUDE.md`.

## Support

For issues, questions, or feedback, please open an issue on GitHub.
