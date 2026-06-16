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
| `Ctrl+L` | Focus the coach panel; `Ctrl+J` coach the current selection |
| `Ctrl+E` | AI settings (endpoint, API key, model) |
| `Ctrl+P` | Process / journal view |
| `Ctrl+T` | Theme picker (live preview) |
| `Ctrl+D` | Export the disclosure document (File ▸ Preview to view in-app) |
| `Ctrl+Q` | Quit (asks if there are unsaved changes) |
| `F10` / `F1` | Menu bar / help |

Mouse: click to place the cursor, click-drag to select, double-click a word,
triple-click a line, wheel to scroll, and click menu titles / dialog rows.
Typing coalesces into single undo steps.

## AI coach (optional)

The coach speaks the OpenAI-compatible Chat Completions API against **any** base
URL (Ollama, LM Studio, OpenAI, OpenRouter, …). Configure it in-app via
**Coach ▸ AI settings** (`Ctrl+E`) — endpoint, API key, and model — applied
immediately and saved to `~/.config/whetstone/coach.json` (`0600`).

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

## Not yet implemented

Multiple files / tabs (the editor holds one buffer at a time), an interactive
keybinding editor, a connection test / model listing in the settings dialog,
cross-session coach-conversation persistence, per-instrument friction overrides,
and bracket matching are not built yet.
