//! A reusable harness for driving the TUI headlessly.
//!
//! Builds an [`App`], feeds it scripted key/paste/mouse events, and renders to a
//! ratatui [`TestBackend`] — no real terminal. The same render path powers the
//! string-assertion tests and the in-process PNG screenshots (see
//! `crate::screenshot`), so what tests see and what screenshots capture can
//! never drift apart.
//!
//! Compiled under `cargo test` and behind the `harness` feature.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;

use super::app::{App, draw};

/// A headless driver around an [`App`] at a fixed terminal size.
pub struct Harness {
    pub app: App,
    width: u16,
    height: u16,
    // Kept alive so the App's tokio handle stays valid for the harness lifetime.
    _rt: tokio::runtime::Runtime,
}

impl Harness {
    /// Build a harness over a fresh document at `width`×`height` cells. The
    /// coach is disabled (no endpoint) so tests stay offline and deterministic.
    pub fn new(text: &str, path: &str, width: u16, height: u16) -> Self {
        Self::build(text, path, width, height, None)
    }

    /// Like [`Harness::new`], but resolves the coach config from the environment
    /// (`WHETSTONE_*`), so a configured endpoint produces a live client. Used by
    /// the screenshot tool to capture real coaching exchanges.
    pub fn new_with_coach_from_env(text: &str, path: &str, width: u16, height: u16) -> Self {
        Self::build(text, path, width, height, crate::coach::CoachConfig::load())
    }

    fn build(
        text: &str,
        path: &str,
        width: u16,
        height: u16,
        coach: Option<crate::coach::CoachConfig>,
    ) -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime");
        let app = App::new(
            text.to_string(),
            std::path::PathBuf::from(path),
            coach,
            rt.handle().clone(),
        );
        Self {
            app,
            width,
            height,
            _rt: rt,
        }
    }

    /// Press a key with no modifiers.
    pub fn key(&mut self, code: KeyCode) -> &mut Self {
        self.app.handle_key(KeyEvent::new(code, KeyModifiers::NONE));
        self
    }

    /// Press a key with modifiers.
    pub fn key_mods(&mut self, code: KeyCode, mods: KeyModifiers) -> &mut Self {
        self.app.handle_key(KeyEvent::new(code, mods));
        self
    }

    /// Press Ctrl + a character (e.g. `ctrl('s')`).
    pub fn ctrl(&mut self, c: char) -> &mut Self {
        self.key_mods(KeyCode::Char(c), KeyModifiers::CONTROL)
    }

    /// Type a run of characters into the focused field/buffer.
    pub fn type_str(&mut self, s: &str) -> &mut Self {
        for c in s.chars() {
            self.key(KeyCode::Char(c));
        }
        self
    }

    /// Deliver a bracketed paste.
    pub fn paste(&mut self, text: &str) -> &mut Self {
        self.app.handle_paste(text);
        self
    }

    /// Pump any pending background events (coach replies, connection tests,
    /// compile output) into the app state.
    pub fn drain(&mut self) -> &mut Self {
        self.app.drain_coach_events();
        self.app.drain_conn_test_events();
        self.app.drain_compile_events();
        self
    }

    /// Render the current state to a ratatui [`Buffer`].
    pub fn render_to_buffer(&mut self) -> Buffer {
        let mut term = Terminal::new(TestBackend::new(self.width, self.height)).unwrap();
        let app = &mut self.app;
        term.draw(|f| draw(f, app)).unwrap();
        term.backend().buffer().clone()
    }

    /// Render the current state to the concatenated cell symbols (the form the
    /// existing tests assert against).
    pub fn render_to_string(&mut self) -> String {
        self.render_to_buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::menu::MenuAction;

    #[test]
    fn drives_editor_and_renders() {
        let mut h = Harness::new("# Title\n\nHello world.", "t.qmd", 100, 30);
        let s = h.render_to_string();
        assert!(s.contains("Title"));
        // Typing in the editor lands in the buffer/preview.
        h.type_str(" more");
        assert!(h.render_to_string().contains("more"));
    }

    #[test]
    fn opens_overlays_via_dispatch() {
        let mut h = Harness::new("hello", "t.qmd", 100, 30);
        h.app.dispatch_for_test(MenuAction::GrammarSettings);
        assert!(h.render_to_string().contains("Grammar (Harper)"));
    }

    #[test]
    fn switches_to_the_suggestions_tab() {
        let mut h = Harness::new("This is a sentance.", "t.qmd", 100, 30);
        h.app.dispatch_for_test(MenuAction::ShowSuggestions);
        let s = h.render_to_string();
        assert!(s.contains("SUGGESTIONS"));
    }

    #[test]
    fn claim_gate_shows_typed_input() {
        // An empty doc opens gated on the claim prompt. What the writer types
        // must be visible — regression for the popup being collapsed to 3 rows,
        // which clipped the input line (and the caret) off entirely.
        let mut h = Harness::new("", "", 100, 30);
        h.type_str("friction keeps the ideas mine");
        let s = h.render_to_string();
        assert!(
            s.contains("State what you intend to argue"),
            "claim prompt is shown: {s}"
        );
        assert!(
            s.contains("friction keeps the ideas mine"),
            "typed claim is rendered inside the gate: {s}"
        );
    }

    #[test]
    fn coach_settings_hint_stays_visible_on_a_short_terminal() {
        // The dialog is taller than this terminal; the key-hint footer must
        // stay pinned/visible rather than being clipped off the bottom.
        let mut h = Harness::new("draft", "t.qmd", 100, 14);
        h.app.dispatch_for_test(MenuAction::CoachSettings);
        let s = h.render_to_string();
        assert!(
            s.contains("Ctrl+T test"),
            "the save/test hint must remain visible on a short terminal: {s}"
        );
    }

    #[test]
    fn overlay_input_scrolls_to_keep_the_tail_visible() {
        // A value wider than the input box must scroll so the most recent
        // characters (where the caret is) stay on screen — regression for
        // single-line fields clipping at the box edge with no horizontal scroll.
        let mut h = Harness::new("", "", 100, 30);
        // Long claim ending in a marker; the head will scroll off, the tail must
        // remain visible.
        let long = format!("{}END_MARKER", "filler word ".repeat(12));
        assert!(long.chars().count() > 90, "input must exceed the box width");
        h.type_str(&long);
        let s = h.render_to_string();
        assert!(
            s.contains("END_MARKER"),
            "the tail of a long claim input must stay visible: {s}"
        );
    }

    #[test]
    fn opens_untitled_buffer_with_no_path() {
        // `whetstone-tui` with no file opens an unnamed buffer (empty path).
        // Use non-empty text so the brand-new-doc claim gate doesn't cover the
        // chrome we're asserting on.
        let mut h = Harness::new("Some draft text.", "", 100, 30);
        let s = h.render_to_string();
        assert!(s.contains("untitled"), "status/title shows untitled: {s}");
        // Saving an untitled buffer prompts for a name rather than failing.
        h.app.dispatch_for_test(MenuAction::Save);
        assert!(h.render_to_string().contains("Save as"));
    }
}
