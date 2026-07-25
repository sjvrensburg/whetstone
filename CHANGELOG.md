# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-07-25

### Added
- **Document export** (HTML and plain text) — `Ctrl+Shift+E` / `Ctrl+Shift*X`
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
- `lint --strict` (exit non-zero on findings) and `coach --journal` (append a
  metadata-only consult event so headless coaching is honest in the disclosure)
  for CI / agentic use.
- `rust-version = "1.85"` declared in `Cargo.toml` (edition 2024 requires it).
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
- **Broken bash completions**: `clap_complete` 4.6.x emits `cmd` case-match arms
  whose token ordering disagrees with the assignments when the bin name contains
  a hyphen, so bash completion silently returned nothing after any subcommand.
  The generator now normalizes the arms and a drift test guards the invariant.
- **Autosave clobbering concurrent external edits**: autosave now runs the same
  external-change (mtime) guard as a manual save, so another tool rewriting the
  file while the editor is idle no longer gets silently overwritten.
- **Opaque coach HTTP errors**: `error_for_status()` discarded the response body,
  so a misconfigured Ollama (404 "model not found") or proxy (502) showed an
  opaque status. The body is now read, parsed (OpenAI/Ollama JSON shapes), and
  excerpted into the error.
- **SIGPIPE panics**: piped output (`lint | head`) no longer panics with a broken
  pipe; SIGPIPE is reset to the OS default at startup for clean pipeline exits.
- **Uncapped paste freeze**: a multi-MB paste is now capped (256 KB) with a
  status message instead of locking the editor for seconds on the synchronous
  insert + re-lint + word-count recompute.
- **atomic_write durability**: the parent directory is now fsynced after the
  rename so a power loss can't roll the rename back (the file-data fsync alone
  didn't protect the directory entry).
- **Stale coach reply after settings change**: saving coach settings now bumps
  `coach_generation`, so an in-flight request against the old endpoint/model is
  superseded instead of landing as a mislabelled coach turn.
- **UTF-8 BOM**: a leading BOM (Windows/PowerShell exports) is stripped on load
  so it isn't persisted back into the file or skewing word/char counts.
- **Forbidden-label bypass**: the guard now normalizes zero-width characters,
  soft hyphens, and joiner punctuation before matching, so `verified\u{200b}human`
  and `verified-human` can't slip past the substring check.
- **Save-As overwrite**: saving to a path that already exists now requires a
  second confirmation of the same path, preventing a typo from destroying an
  unrelated file.
- **Disclosure honesty**: the scoping note now states the record is not
  tamper-evident (anyone with the file can edit entries).
- **Connection-test secret scrubbing**: the settings dialog's test-connection
  error path now scrubs secrets, matching the runtime coach-error path.

## [0.1.3] — earlier

See `git log` for changes prior to 0.1.4. This changelog begins at 0.1.4.

[0.1.4]: https://github.com/sjvrensburg/whetstone/releases/tag/v0.1.4
