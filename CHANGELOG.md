# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-07-25

### Added
- **Document export** (HTML and plain text) — `Ctrl+Shift+E` / `Ctrl+Shift+X`
  in the editor, or the headless `export` subcommand. No Quarto required; both
  pass the forbidden-label guard.
- **Live word count** in the status bar.
- **Accessibility**: quarantine regions are underlined (not color-only), and
  grammar severity uses underline (Error/Warning) vs dim (Style) as a non-color
  cue. README documents the keyboard-only operation and the headless escape
  hatch for screen-reader users.
- Two auditable process events — `JudgeUnavailable` and `HistoryScreened` — so a
  judge fail-open and a replayed-turn injection screen appear in the disclosure.
- `cargo install --git` one-liner in the README install section (works without
  a crates.io publish).
- Tests for the `grammar/harper.rs` bridge module (char-offset correctness,
  severity/fix mapping, dialect aliases, disabled-rule round-trip).

### Changed
- **Coach error surfacing**: provider errors are now truncated to one status-bar
  line and scrubbed of `sk-…`/`Bearer`/`Authorization` tokens before display.
- **Chat history** is re-screened against the injection patterns on every
  request (it was sent unscreened before).
- **File writes** (save, autosave, export) run on worker threads so a slow disk
  or network mount (NFS/SMB) can't freeze the editor. A read error at launch is
  surfaced as a message rather than silently blanking the buffer.
- **Copy alignment**: the README and landing page now distinguish the structured
  coaching path (ghostwrite-proof by schema) from free-text chat (length-capped,
  small residual risk), matching the code's own doc comments. "injection-screened"
  is softened to "best-effort injection screen (defence-in-depth)".
- **Rendering layer** extracted into `src/ui/app/render.rs` (~1,600 lines) from
  the previously monolithic `app.rs`.

### Fixed
- Load-bearing overlay-state `unwrap()`s converted to fallible guards, removing
  a class of TUI-crashing panics (a crash drops the user into a raw shell).
- The `insert_or_replace` `expect()` now falls back to a plain insert if the
  buffer's selection invariant drifts.
- **Data-loss race**: a save dispatched on a slow disk no longer clears `dirty`
  for edits made after the save was captured (which let `Ctrl+Q` silently lose
  them). Each write is now stamped with the buffer's edit-version and the drain
  only clears `dirty` when no edits occurred since dispatch.
- **Editor freeze on large docs**: the status-bar word count is now cached
  against `edit_version` instead of recomputed every frame (it NFKC-normalizes
  the whole buffer — 842ms/draw on a 100k-word thesis).
- **Stored XSS in HTML export**: the rendered body is now sanitized with
  `ammonia` (pulldown-cmark emits raw `<script>`/`onerror`/`javascript:`
  verbatim; the export is meant to be shared).
- **Symlink + race in atomic_write**: the fixed-name temp file is replaced with
  a random, exclusively-created `NamedTempFile` (closes a CWE-377/59 symlink
  attack and overlapping-autosave data loss on slow disks).
- **Release pipeline**: `checksum = true` (a parse error) is now `checksum =
  "sha256"`; the unrecognized `man-pages` key is removed (cargo-dist 0.32 has no
  manpage installer; the man page ships via the repo + README).

## [0.1.3] — earlier

See `git log` for changes prior to 0.1.4. This changelog begins at 0.1.4.

[0.1.4]: https://github.com/sjvrensburg/whetstone/releases/tag/v0.1.4
