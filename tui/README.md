# whetstone-tui

A friction-first Quarto/Markdown editor for the terminal — a Rust port of the
Whetstone web composer. It keeps the writing *yours*: pastes are quarantined and
must be rewritten ("claim-to-own") or attributed, the optional AI coach can only
ask questions (never ghostwrite), and an append-only journal lets you export an
honest "how this was written" disclosure.

## Build & run

```sh
cargo run -- path/to/file.qmd      # opens (creates if missing)
cargo build --release              # ./target/release/whetstone-tui
```

The UI is mouse- and keyboard-driven (Fresh/Micro-style: familiar, no modes
beyond transient menus/dialogs). Press **F1** for the keybinding cheat-sheet or
**F10** for the menu bar.

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+S` / `Ctrl+O` | Save · open file (Save as via File menu); autosaves when idle |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (`Ctrl+Shift+Z` also redoes) |
| `Ctrl+F` / `Ctrl+H` / `Ctrl+G` | Find · replace · go to line |
| `Shift+arrows` | Select; `Ctrl+A` select all; `Ctrl+←/→` move by word |
| `Ctrl+C` / `Ctrl+X` | Copy / cut selection (system clipboard via OSC 52) |
| `Ctrl+K` | State / edit your claim |
| `Ctrl+M` | Mark the pasted region under the cursor as a quotation |
| `Ctrl+B` | Outline — list headings and jump to one |
| `Ctrl+R` | Render the document with Quarto (saves first) |
| `Ctrl+L` | Focus the coach panel; `Ctrl+J` coach the current selection |
| `Ctrl+E` | AI settings (endpoint, API key, model) |
| `Ctrl+P` | Process / journal view |
| `Ctrl+T` | Theme picker (live preview) |
| `Ctrl+D` | Export the disclosure document (File ▸ Preview to view in-app) |
| `Ctrl+Q` | Quit (asks if there are unsaved changes) |
| `F10` / `F1` | Menu bar / help (the help cheat-sheet scrolls with ↑/↓/wheel) |

Mouse: click to place the cursor, click-drag to select, double-click a word,
triple-click a line, wheel to scroll, and click menu titles / dialog rows.
Typing coalesces into single undo steps. When the caret sits on (or just after)
a `()`, `[]`, or `{}` bracket, it and its matching partner are highlighted.

## AI coach (optional)

The coach speaks the OpenAI-compatible Chat Completions API against **any** base
URL (Ollama, LM Studio, OpenAI, OpenRouter, …). Configure it in-app via
**Coach ▸ AI settings** (`Ctrl+E`) — endpoint, API key, and model — applied
immediately and saved to `~/.config/whetstone/coach.json` (`0600`).

Inside that dialog, `Ctrl+T` runs a **connection test**: it fetches the
endpoint's `/models` list, so you get an immediate ✓/✗ on whether the URL and
key are right instead of finding out the first time you ask the coach. On
success the discovered models are listed — cycle through them with
`Ctrl+N` / `Ctrl+P` or click one to fill the Model field.

Any field in the dialog also accepts an **environment-variable reference** —
`env:NAME` or `${NAME}` — instead of a literal value. Only the reference is
written to `coach.json`; the value is read from the environment at request
time, so a secret key need never be stored on disk. For example, set the API
key field to `env:OPENAI_API_KEY` and export that variable in your shell.

Environment variables still work and override the saved file at startup:

| Variable | Meaning |
| --- | --- |
| `WHETSTONE_BASE_URL` | e.g. `http://localhost:11434/v1` (no trailing slash) |
| `WHETSTONE_API_KEY` | bearer token (optional for local servers) |
| `WHETSTONE_MODEL` | e.g. `llama3.1`, `gpt-oss:latest` (default `gpt-oss:latest`) |

Every coach reply is screened before it is shown (length cap, rewrite/dictation
patterns, n-gram overlap with the draft, and the forbidden-label guard); the
draft and your message are injection-screened before egress.

## Preferences

| Variable | Meaning |
| --- | --- |
| `WHETSTONE_THEME` | theme name, e.g. `Fresh Dark` (see the theme picker) |
| `WHETSTONE_FRICTION` | friction level `0`–`3` (Quiet / Coach / Engaged / Deep Work) |

The theme and friction level chosen in-app persist to
`~/.config/whetstone/ui.json`; the env vars override them at startup. The
friction level drives the paste-quarantine threshold, the claim-to-own floor,
the teach-back cadence, and — at "Engaged"/"Deep Work" — proactive
push-cadence coaching that reviews each finished paragraph (ADR-008).

### Per-instrument friction overrides

The four dial-able instruments can each be pinned to their own level,
independent of the global preset (ADR-008). Open the **View** menu and click a
row to cycle it: *off* (follow the preset) → Quiet → Coach → Engaged → Deep
Work → *off*. A checked row is currently overridden. This lets you, say, keep
the global preset at "Coach" but turn the paste quarantine up to "Deep Work",
or switch on proactive push-cadence coaching without raising everything else.

| Instrument | What it tunes |
| --- | --- |
| Paste quarantine | the paste size that triggers quarantine |
| Claim-to-own | how much rewriting clears a paste mark |
| Teach-back | the per-paragraph teach-back cadence |
| Push cadence | proactive coaching cadence (off below "Engaged") |

Overrides persist to `ui.json` alongside the preset. They can also be set at
startup via `WHETSTONE_FRICTION_<INSTRUMENT>` (`PASTE`, `CLAIM`, `TEACHBACK`,
`PUSH`) — a level `0`–`3`, or `off`/`none`/`preset` to clear a saved override.
An institutional floor (when set) still applies to every instrument: an
override can raise an instrument or lower it, but never below the floor.

## Coach-conversation persistence

The coach chat is mirrored to disk per document, so reopening a file restores
its coaching thread. History lives under
`$XDG_CONFIG_HOME/whetstone/coach-history/` (falling back to
`$HOME/.config/...`), keyed by the document's absolute path, `0600` on Unix
since the writer's own messages may quote draft prose. Resetting the
conversation (Coach ▸ Reset conversation) clears the saved copy. New/unsaved buffers keep no
history (there's no stable key until the file has a path). Only the chat is
stored — the process journal stays metadata-only and the draft is never written
here.

## Outline & navigation

Press **Ctrl+B** (or **View ▸ Outline…**) to open a document outline: every
Markdown heading, indented by level. Move the selection with ↑/↓ (or the wheel)
and press **Enter** to jump the cursor to that section; **Esc** closes it. The
heading the cursor is currently in is pre-selected when the outline opens.

## Render with Quarto

Press **Ctrl+R** (or **File ▸ Render (Quarto)**) to render the current document.
Whetstone saves first, then runs `quarto render <file>` in the background so the
editor stays responsive. On success the status bar confirms it; if the render
fails (or Quarto isn't installed), the captured output opens in a scrollable
overlay so you can read the error. Requires [Quarto](https://quarto.org) on your
`PATH`.

## Not yet implemented

The editor is deliberately single-document and single-buffer — it is built to
keep you focused on writing one piece well, so multiple files / tabs are out of
scope by design.
