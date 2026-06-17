//! Generate PNG screenshots of the TUI for the docs.
//!
//! Drives the editor headlessly through a few named scenes and rasterizes each
//! to `docs/screenshots/<scene>.png` — no external tools. Run with:
//!
//! ```text
//! cargo run --features screenshots --bin whetstone-screenshots
//! ```

use std::path::PathBuf;

use crossterm::event::KeyCode;
use whetstone_tui::screenshot::buffer_to_png;
use whetstone_tui::ui::menu::MenuAction;
use whetstone_tui::ui::testkit::Harness;

const W: u16 = 100;
const H: u16 = 32;

const SAMPLE: &str = "# On Friction\n\nThe tool adds deliberate friction to writing. \
This is a sentance with an eror to show the grammar pane.\n\nWriting stays yours.\n";

/// A named scene: a label and a closure that arranges the harness state.
type Scene = (&'static str, Box<dyn Fn(&mut Harness)>);

fn main() {
    let out_dir = PathBuf::from(env_or("WHETSTONE_SCREENSHOT_DIR", "docs/screenshots"));
    std::fs::create_dir_all(&out_dir).expect("create screenshot dir");

    let scenes: Vec<Scene> = vec![
        ("editor", Box::new(|_h: &mut Harness| {})),
        (
            "suggestions",
            Box::new(|h: &mut Harness| {
                h.app.dispatch_for_test(MenuAction::ShowSuggestions);
            }),
        ),
        (
            "ai-settings",
            Box::new(|h: &mut Harness| {
                h.app.dispatch_for_test(MenuAction::CoachSettings);
            }),
        ),
        (
            "grammar-settings",
            Box::new(|h: &mut Harness| {
                h.app.dispatch_for_test(MenuAction::GrammarSettings);
            }),
        ),
        (
            "menu",
            Box::new(|h: &mut Harness| {
                h.key(KeyCode::F(10));
            }),
        ),
    ];

    for (name, setup) in scenes {
        let mut h = Harness::new(SAMPLE, "sample.qmd", W, H);
        setup(&mut h);
        let buf = h.render_to_buffer();
        let png = buffer_to_png(&buf);
        let path = out_dir.join(format!("{name}.png"));
        std::fs::write(&path, png).expect("write png");
        println!("wrote {}", path.display());
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
