# Contributing to Whetstone

Thanks for considering a contribution. Whetstone is a small, opinionated tool
and this guide keeps changes aligned with its design.

## Before you start

Read [`CLAUDE.md`](CLAUDE.md) — especially the **Project-specific invariants**.
The product claim is *friction, not proof*: nothing may imply "verified human"
or proof-of-personhood, process events carry metadata only (never prose), and
the coach is question-only by construction. Most design questions resolve to one
of these invariants.

## Development setup

You need a recent Rust toolchain (edition 2024, so Rust 1.85+):

```sh
git clone https://github.com/sjvrensburg/whetstone.git
cd whetstone
cargo build
cargo test
```

## The bar for merging

Every change must keep these green:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI runs all three on Linux, macOS, and Windows. Treat warnings as errors
locally too — `cargo clippy --all-targets -- -D warnings`.

## Adding tests

- **Domain logic** (`src/core/`): inline `#[cfg(test)] mod tests` in the file.
  These are pure functions — easy to test exhaustively.
- **UI logic**: drive the editor headlessly via `src/ui/testkit.rs` (feature
  `harness`, on under `cargo test`). See the `test_app` / `rt` / `render`
  helpers in `src/ui/app/mod.rs`'s test module for the pattern.
- **Screenshots**: `cargo run --features screenshots --example screenshots`
  regenerates `docs/screenshots/*.png` from the same harness.

Match the surrounding code's style: short "why" comments over "what", no
leftover TODO/FIXME markers.

## Commit and PR style

- Commits: imperative mood, present tense ("Add word count", not "Added"). Wrap
  at ~72 chars in the subject; explain the *why* in the body.
- Keep PRs focused — one logical change per PR is easiest to review. If a change
  spans many areas, split it into separately-reviewable commits.
- Branch from `main`; open a PR against `main`.

## Releasing

Releases are tag-driven via `cargo-dist`. See the **Releasing** section of
`CLAUDE.md`. Don't hand-edit `.github/workflows/release.yml` (it's generated).

## Reporting a guard bypass

If you find a way to bypass the coach guard, the injection screen, or the
forbidden-label check, please report it privately — see
[`SECURITY.md`](SECURITY.md) — rather than opening a public issue immediately.
