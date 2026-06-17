# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Whetstone** — a friction-first writing surface for students under honor codes,
shipped as a single terminal editor (`whetstone-tui`, Rust, edition 2024) with a
Fresh/Micro-style UI (menus, theming, mouse, no modes). See `README.md` for
keybindings, env vars, and config files.

The product claim is **friction, not proof**: the tool adds deliberate friction
to the writing process (paste quarantine, claim-to-own, teach-back, an optional
question-only coach) and can produce an honest, self-reported disclosure of how
a piece was written — it never claims to *verify* authorship or personhood.

This was once a multi-surface project (a web composer and a legacy VS Code
extension). Both have been removed; the TUI is the whole product. The earlier
design history (ADRs, walking-skeleton spec) is not kept in-repo — it was
archived outside the repository.

## Commands

Run from the repo root:

- `cargo run -- path/to/file.qmd` — open (creates the file if missing)
- `cargo build --release` — produces `./target/release/whetstone-tui`
- `cargo test` — run the test suite
- `cargo clippy --all-targets -- -D warnings` — lint (CI treats warnings as errors)
- `cargo fmt --check` — formatting check (`cargo fmt` to apply)

CI runs fmt + clippy + test on Linux/macOS/Windows: `.github/workflows/ci.yml`.

## Architecture

Module dependency DAG (each module depends only on modules above it), declared
in `src/lib.rs`:

```text
core -> coach -> instruments -> editor -> grammar -> markdown -> ui
```

- `src/core/` — pure domain logic: n-gram overlap, claim-to-own ownership,
  forbidden-label guard, disclosure rendering, the process-event model, and the
  friction policy. No I/O, no editor/UI imports.
- `src/coach/` — the optional AI coach: an OpenAI-compatible Chat Completions
  client (streaming SSE over any base URL — Ollama, LM Studio, OpenAI, …),
  config resolution (incl. `env:NAME` references), and per-document chat history.
- `src/instruments/` — the friction instruments (paste cadence, teach-back,
  push-cadence) wired to the friction dial.
- `src/editor/` — the text buffer, change sets, and paste-quarantine regions.
- `src/grammar/` — local grammar checking via `harper-core` (zero external calls).
- `src/markdown/` — markdown/Quarto rendering to terminal cells, LaTeX→Unicode
  math, and the heading-outline extractor.
- `src/ui/` — the ratatui app: state, key/paste/mouse handling, layout, menus,
  theming, and all overlays (`app.rs` is the bulk). `menu.rs`, `theme.rs`,
  `settings.rs`.

## Project-specific invariants

- **Metadata only**: process events never carry document prose (sizes,
  locations, and the writer's own stated claim only).
- **Claim-to-own direction**: ownership is measured as *how much of the
  ORIGINAL paste survives in the current text* (`src/core/ownership.rs`), never
  the reverse — the reverse is the V1 padding-attack bug, guarded by a test.
- **Forbidden-label guard**: every user-facing artifact must pass
  `assertNoForbiddenLabels`/`screen_*` guards — nothing may imply "verified
  human" / proof-of-personhood. The product claim is *friction, not proof*.
- **Coach is question-only**: every coach/chat reply is screened
  (`src/core/guard.rs`) before it reaches the UI — length cap, rewrite/dictation
  patterns, n-gram overlap with the draft, forbidden labels — so the coach can
  never ghostwrite. The draft and the writer's message are injection-screened
  before egress.
- **Friction dial**: instruments respond to a friction level (0–3),
  overridable per-instrument via config and `WHETSTONE_FRICTION*` env vars.

## Working style

Keep `cargo test`, `cargo clippy --all-targets -- -D warnings`, and
`cargo fmt --check` green before committing. Match the surrounding code's
comment density and idiom (the codebase favors short "why" comments over "what").
