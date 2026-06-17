//! Generate PNG screenshots of the TUI for the docs / website.
//!
//! Drives the editor headlessly through a set of named scenes and rasterizes
//! each to `docs/screenshots/<scene>.png` — no external tools. Run with:
//!
//! ```text
//! cargo run --features screenshots --bin whetstone-screenshots
//! ```
//!
//! The coach scenes make a *real* request against the configured endpoint when
//! one is set via the `WHETSTONE_*` env vars (see below); otherwise they fall
//! back to the empty coach pane. To capture live GLM coaching:
//!
//! ```text
//! WHETSTONE_BASE_URL=https://api.z.ai/api/coding/paas/v4 \
//! WHETSTONE_API_KEY=env:Z_AI_API_KEY \
//! WHETSTONE_MODEL=glm-5.1 \
//! WHETSTONE_JUDGE=true WHETSTONE_JUDGE_MODEL=glm-5-turbo \
//! cargo run --features screenshots --bin whetstone-screenshots
//! ```

use std::path::PathBuf;
use std::time::Duration;

use crossterm::event::KeyCode;
use whetstone_tui::screenshot::buffer_to_png;
use whetstone_tui::ui::menu::MenuAction;
use whetstone_tui::ui::testkit::Harness;

const W: u16 = 120;
const H: u16 = 38;

const PRIMARY_THEME: &str = "Whetstone Dark";

/// A small, self-contained Quarto essay that exercises the markdown renderer
/// (front matter, headings, emphasis, inline + block math, a code block, a
/// blockquote) and carries one deliberate misspelling for the grammar pane.
const SAMPLE: &str = r#"---
title: "On Friction"
author: "A. Student"
---

# On Friction

Writing well is hard, and it *should* be. The blank page resists you, and
that resistance is where the thinking actually happens.

## Why friction helps

When a draft arrives too easily, it is often because it was not really
**yours**. A sentance written in haste can hide a borrowed idea behind a
confident tone.

We can model accumulated effort as $E = \int_0^t f(\tau)\,d\tau$, where $f$ is
focus over time.

```python
def own(words):
    return [w for w in words if w.is_mine]
```

> The point is not proof. The point is friction — the words stay yours.
"#;

/// A named scene: a label, the theme to render it under, and a closure that
/// arranges the harness state before rendering.
struct Scene {
    name: &'static str,
    theme: &'static str,
    setup: Box<dyn Fn(&mut Harness)>,
}

fn scene(name: &'static str, setup: impl Fn(&mut Harness) + 'static) -> Scene {
    Scene {
        name,
        theme: PRIMARY_THEME,
        setup: Box::new(setup),
    }
}

fn themed(name: &'static str, theme: &'static str) -> Scene {
    Scene {
        name,
        theme,
        setup: Box::new(|_h: &mut Harness| {}),
    }
}

fn main() {
    let out_dir = PathBuf::from(env_or("WHETSTONE_SCREENSHOT_DIR", "docs/screenshots"));
    std::fs::create_dir_all(&out_dir).expect("create screenshot dir");

    // Isolate the config dir to a throwaway location so we never touch the
    // user's real coach.json / history, and so the coach conversation persisted
    // by one scene cannot bleed into the next (history is keyed by doc path).
    let cfg_dir = std::env::temp_dir().join("whetstone-screenshots-config");
    let history_dir = cfg_dir.join("whetstone").join("coach-history");
    // SAFETY: single-threaded; set before any `Harness`/runtime is built.
    unsafe {
        std::env::set_var("XDG_CONFIG_HOME", &cfg_dir);
    }

    let coach_configured = std::env::var("WHETSTONE_BASE_URL")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !coach_configured {
        eprintln!(
            "note: WHETSTONE_BASE_URL unset — coach scenes will show the empty pane (no live reply)"
        );
    }

    let scenes: Vec<Scene> = vec![
        // — Core editor + the two right-pane tabs. —
        scene("editor", |_h| {}),
        scene("suggestions", |h| {
            h.app.dispatch_for_test(MenuAction::ShowSuggestions);
        }),
        scene("coach", run_coach_chat),
        // — Overlays / dialogs. —
        scene("ai-settings", |h| {
            h.app.dispatch_for_test(MenuAction::CoachSettings);
        }),
        scene("grammar-settings", |h| {
            h.app.dispatch_for_test(MenuAction::GrammarSettings);
        }),
        scene("outline", |h| {
            h.app.dispatch_for_test(MenuAction::Outline);
        }),
        scene("find", |h| {
            h.app.dispatch_for_test(MenuAction::Find);
            h.type_str("friction");
        }),
        scene("help", |h| {
            h.key(KeyCode::F(1));
        }),
        // — Friction instruments. —
        scene("paste-quarantine", |h| {
            h.app.dispatch_for_test(MenuAction::SetFriction(2));
            h.paste(
                "Friction is the resistance encountered when one surface moves over \
                 another, and it is also, by analogy, the productive resistance a \
                 writer feels when an idea has to be earned rather than borrowed.",
            );
            h.drain();
        }),
        scene("teach-back", |h| {
            // Deep Work makes the teach-back interval one paragraph, so adding a
            // fresh paragraph trips the checkpoint.
            h.app.dispatch_for_test(MenuAction::SetFriction(3));
            h.key(KeyCode::Enter);
            h.key(KeyCode::Enter);
            h.type_str("And so the argument turns on a single distinction.");
            h.drain();
        }),
        scene("edit-claim", |h| {
            h.app.dispatch_for_test(MenuAction::EditClaim);
            h.type_str("My claim: friction in the writing process keeps the ideas mine.");
        }),
        // — Provenance: the journal and the self-reported disclosure. —
        scene("journal", |h| {
            seed_history(h);
            h.app.dispatch_for_test(MenuAction::Journal);
        }),
        scene("disclosure", |h| {
            seed_history(h);
            h.app.dispatch_for_test(MenuAction::PreviewDisclosure);
        }),
        // — Menus (discoverability). —
        scene("menu-file", |h| {
            h.key(KeyCode::F(10));
        }),
        scene("menu-view", |h| {
            h.key(KeyCode::F(10));
            h.key(KeyCode::Right);
            h.key(KeyCode::Right);
        }),
        // — Theme gallery (same editor view, every built-in theme). —
        themed("theme-whetstone-dark", "Whetstone Dark"),
        themed("theme-fresh-dark", "Fresh Dark"),
        themed("theme-fresh-light", "Fresh Light"),
        themed("theme-solarized-dark", "Solarized Dark"),
        themed("theme-gruvbox-dark", "Gruvbox Dark"),
        themed("theme-terminal", "Terminal"),
    ];

    for sc in scenes {
        // SAFETY: `main` is single-threaded here and any prior scene's tokio
        // runtime was already dropped (joined) when its `Harness` went out of
        // scope, so no other thread is reading the environment concurrently.
        unsafe {
            std::env::set_var("WHETSTONE_THEME", sc.theme);
        }
        // Start each scene from a clean slate so a prior scene's persisted coach
        // conversation never reappears.
        std::fs::remove_dir_all(&history_dir).ok();
        let mut h = Harness::new_with_coach_from_env(SAMPLE, "on-friction.qmd", W, H);
        (sc.setup)(&mut h);
        let buf = h.render_to_buffer();
        let png = buffer_to_png(&buf);
        let path = out_dir.join(format!("{}.png", sc.name));
        std::fs::write(&path, png).expect("write png");
        println!("wrote {}", path.display());
    }
}

/// Ask the coach a (question-only) question and block on the real reply so the
/// pane shows a live exchange. Falls back to the empty pane if unconfigured or
/// the endpoint is slow/unreachable.
fn run_coach_chat(h: &mut Harness) {
    h.app.dispatch_for_test(MenuAction::ToggleCoach); // focus the coach pane
    h.type_str("What is one question I should ask myself about the argument in this draft?");
    h.key(KeyCode::Enter);
    // Poll the runtime for up to ~120s; the reply arrives on a channel that
    // `drain()` pumps into the app state. The window is generous because, with
    // the judge enabled, a turn makes two sequential model calls.
    for _ in 0..480 {
        h.drain();
        if !h.app.coach_busy_for_test() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    h.drain();
    if h.app.coach_busy_for_test() {
        eprintln!("note: coach reply did not arrive in time — rendering the pending pane");
    }
}

/// Seed a few process events (paste, attribution, a claim, some typing) so the
/// journal and disclosure overlays have something honest to show.
fn seed_history(h: &mut Harness) {
    h.app.dispatch_for_test(MenuAction::SetFriction(2));
    h.paste(
        "Friction, in physics, is the force resisting relative motion between \
         two surfaces in contact.",
    );
    h.drain();
    h.app.dispatch_for_test(MenuAction::EditClaim);
    h.type_str("My claim: the analogy between physical and creative friction is my own framing.");
    h.key(KeyCode::Enter);
    h.type_str(" The same word does double duty here.");
    h.drain();
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
