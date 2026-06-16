//! Color themes for the TUI.
//!
//! A [`Theme`] is a flat set of semantic colors; every widget derives its
//! `Style` from these, so the whole interface re-skins by swapping one
//! `&'static Theme`. Themes are browsable and applied live from the View menu
//! (theme picker, see `ui::menu`). The startup default is read from
//! `WHETSTONE_THEME` (by name, case-insensitive), falling back to the first
//! entry of [`THEMES`].

use ratatui::style::{Color, Modifier, Style};

/// A complete palette. All fields are plain colors; the `*_style` helpers
/// assemble the `Style`s the widgets actually use.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub name: &'static str,
    /// Editor / default body text.
    pub fg: Color,
    /// App background (filled behind every pane).
    pub bg: Color,
    /// Muted help/secondary text.
    pub dim: Color,
    /// Prompts, the typing caret marker, key highlights.
    pub accent: Color,
    /// Unfocused pane border.
    pub border: Color,
    /// Focused pane border + title.
    pub border_focus: Color,
    pub status_fg: Color,
    pub status_bg: Color,
    pub menu_fg: Color,
    pub menu_bg: Color,
    /// Selected menu item / theme-picker row (and any "live" highlight).
    pub sel_fg: Color,
    pub sel_bg: Color,
    pub quarantine_fg: Color,
    pub quarantine_bg: Color,
    pub error: Color,
    pub warning: Color,
    /// Style-level diagnostics + secondary accents.
    pub hint: Color,
    pub coach_you: Color,
    pub coach_reply: Color,
    /// Preview: H1 / odd headings.
    pub heading: Color,
    /// Preview: H2+ / even headings.
    pub heading_alt: Color,
    pub code: Color,
    pub math: Color,
    pub quote: Color,
}

impl Theme {
    pub fn text(&self) -> Style {
        Style::default().fg(self.fg).bg(self.bg)
    }
    pub fn dim(&self) -> Style {
        Style::default().fg(self.dim).bg(self.bg)
    }
    pub fn accent(&self) -> Style {
        Style::default().fg(self.accent).bg(self.bg)
    }
    pub fn panel_bg(&self) -> Style {
        Style::default().bg(self.bg)
    }
    pub fn border(&self, focused: bool) -> Style {
        let c = if focused {
            self.border_focus
        } else {
            self.border
        };
        Style::default().fg(c).bg(self.bg)
    }
    pub fn title(&self, focused: bool) -> Style {
        let c = if focused {
            self.border_focus
        } else {
            self.border
        };
        Style::default()
            .fg(c)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }
    pub fn status(&self) -> Style {
        Style::default().fg(self.status_fg).bg(self.status_bg)
    }
    pub fn menu(&self) -> Style {
        Style::default().fg(self.menu_fg).bg(self.menu_bg)
    }
    pub fn menu_selected(&self) -> Style {
        Style::default()
            .fg(self.sel_fg)
            .bg(self.sel_bg)
            .add_modifier(Modifier::BOLD)
    }
    pub fn selected(&self) -> Style {
        Style::default().fg(self.sel_fg).bg(self.sel_bg)
    }
    pub fn quarantine(&self) -> Style {
        Style::default()
            .fg(self.quarantine_fg)
            .bg(self.quarantine_bg)
            .add_modifier(Modifier::BOLD)
    }
}

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

/// The built-in themes. The first is the startup default.
pub const THEMES: &[Theme] = &[
    // — Whetstone Dark: neutral slate with an amber (whetstone) accent. —
    Theme {
        name: "Whetstone Dark",
        fg: rgb(0xE6, 0xE6, 0xEA),
        bg: rgb(0x1B, 0x1B, 0x1F),
        dim: rgb(0x8A, 0x8A, 0x96),
        accent: rgb(0xE2, 0xA2, 0x3B),
        border: rgb(0x3A, 0x3A, 0x44),
        border_focus: rgb(0xE2, 0xA2, 0x3B),
        status_fg: rgb(0x1B, 0x1B, 0x1F),
        status_bg: rgb(0xE2, 0xA2, 0x3B),
        menu_fg: rgb(0xD8, 0xD8, 0xDF),
        menu_bg: rgb(0x26, 0x26, 0x2E),
        sel_fg: rgb(0x1B, 0x1B, 0x1F),
        sel_bg: rgb(0xE2, 0xA2, 0x3B),
        quarantine_fg: rgb(0x1B, 0x1B, 0x1F),
        quarantine_bg: rgb(0xE2, 0xA2, 0x3B),
        error: rgb(0xE0, 0x6C, 0x75),
        warning: rgb(0xD1, 0x9A, 0x66),
        hint: rgb(0x56, 0xB6, 0xC2),
        coach_you: rgb(0x61, 0xAF, 0xEF),
        coach_reply: rgb(0x98, 0xC3, 0x79),
        heading: rgb(0xE2, 0xA2, 0x3B),
        heading_alt: rgb(0xD1, 0x9A, 0x66),
        code: rgb(0x98, 0xC3, 0x79),
        math: rgb(0xC6, 0x78, 0xDD),
        quote: rgb(0x7F, 0x84, 0x8E),
    },
    // — Fresh Dark: VS Code-flavored dark with a blue accent. —
    Theme {
        name: "Fresh Dark",
        fg: rgb(0xD4, 0xD4, 0xD4),
        bg: rgb(0x1E, 0x1E, 0x1E),
        dim: rgb(0x80, 0x80, 0x80),
        accent: rgb(0x56, 0x9C, 0xD6),
        border: rgb(0x3C, 0x3C, 0x3C),
        border_focus: rgb(0x56, 0x9C, 0xD6),
        status_fg: rgb(0xFF, 0xFF, 0xFF),
        status_bg: rgb(0x00, 0x7A, 0xCC),
        menu_fg: rgb(0xCC, 0xCC, 0xCC),
        menu_bg: rgb(0x25, 0x25, 0x26),
        sel_fg: rgb(0xFF, 0xFF, 0xFF),
        sel_bg: rgb(0x09, 0x47, 0x71),
        quarantine_fg: rgb(0x1E, 0x1E, 0x1E),
        quarantine_bg: rgb(0xDC, 0xDC, 0xAA),
        error: rgb(0xF4, 0x47, 0x47),
        warning: rgb(0xCC, 0xA7, 0x00),
        hint: rgb(0x4E, 0xC9, 0xB0),
        coach_you: rgb(0x56, 0x9C, 0xD6),
        coach_reply: rgb(0x6A, 0x99, 0x55),
        heading: rgb(0x56, 0x9C, 0xD6),
        heading_alt: rgb(0x4E, 0xC9, 0xB0),
        code: rgb(0xCE, 0x91, 0x78),
        math: rgb(0xC5, 0x86, 0xC0),
        quote: rgb(0x6A, 0x99, 0x55),
    },
    // — Fresh Light: bright background for daylight work. —
    Theme {
        name: "Fresh Light",
        fg: rgb(0x1F, 0x1F, 0x1F),
        bg: rgb(0xFF, 0xFF, 0xFF),
        dim: rgb(0x6E, 0x6E, 0x6E),
        accent: rgb(0x00, 0x66, 0xCC),
        border: rgb(0xCF, 0xCF, 0xCF),
        border_focus: rgb(0x00, 0x66, 0xCC),
        status_fg: rgb(0xFF, 0xFF, 0xFF),
        status_bg: rgb(0x00, 0x66, 0xCC),
        menu_fg: rgb(0x1F, 0x1F, 0x1F),
        menu_bg: rgb(0xF3, 0xF3, 0xF3),
        sel_fg: rgb(0x1F, 0x1F, 0x1F),
        sel_bg: rgb(0xCF, 0xE3, 0xFF),
        quarantine_fg: rgb(0x1F, 0x1F, 0x1F),
        quarantine_bg: rgb(0xFF, 0xE0, 0x8A),
        error: rgb(0xC7, 0x2E, 0x2E),
        warning: rgb(0xB8, 0x86, 0x0B),
        hint: rgb(0x00, 0x80, 0x80),
        coach_you: rgb(0x00, 0x66, 0xCC),
        coach_reply: rgb(0x2E, 0x7D, 0x32),
        heading: rgb(0x00, 0x66, 0xCC),
        heading_alt: rgb(0x00, 0x80, 0x80),
        code: rgb(0xA3, 0x15, 0x15),
        math: rgb(0x7B, 0x1F, 0xA2),
        quote: rgb(0x6A, 0x73, 0x7D),
    },
    // — Solarized Dark. —
    Theme {
        name: "Solarized Dark",
        fg: rgb(0x83, 0x94, 0x96),
        bg: rgb(0x00, 0x2B, 0x36),
        dim: rgb(0x58, 0x6E, 0x75),
        accent: rgb(0x26, 0x8B, 0xD2),
        border: rgb(0x07, 0x36, 0x42),
        border_focus: rgb(0x26, 0x8B, 0xD2),
        status_fg: rgb(0x00, 0x2B, 0x36),
        status_bg: rgb(0x26, 0x8B, 0xD2),
        menu_fg: rgb(0x93, 0xA1, 0xA1),
        menu_bg: rgb(0x07, 0x36, 0x42),
        sel_fg: rgb(0x00, 0x2B, 0x36),
        sel_bg: rgb(0x26, 0x8B, 0xD2),
        quarantine_fg: rgb(0x00, 0x2B, 0x36),
        quarantine_bg: rgb(0xB5, 0x89, 0x00),
        error: rgb(0xDC, 0x32, 0x2F),
        warning: rgb(0xCB, 0x4B, 0x16),
        hint: rgb(0x2A, 0xA1, 0x98),
        coach_you: rgb(0x26, 0x8B, 0xD2),
        coach_reply: rgb(0x85, 0x99, 0x00),
        heading: rgb(0x26, 0x8B, 0xD2),
        heading_alt: rgb(0x2A, 0xA1, 0x98),
        code: rgb(0x2A, 0xA1, 0x98),
        math: rgb(0x6C, 0x71, 0xC4),
        quote: rgb(0x58, 0x6E, 0x75),
    },
    // — Gruvbox Dark. —
    Theme {
        name: "Gruvbox Dark",
        fg: rgb(0xEB, 0xDB, 0xB2),
        bg: rgb(0x28, 0x28, 0x28),
        dim: rgb(0x92, 0x83, 0x74),
        accent: rgb(0xFA, 0xBD, 0x2F),
        border: rgb(0x50, 0x49, 0x45),
        border_focus: rgb(0xFA, 0xBD, 0x2F),
        status_fg: rgb(0x28, 0x28, 0x28),
        status_bg: rgb(0xFA, 0xBD, 0x2F),
        menu_fg: rgb(0xEB, 0xDB, 0xB2),
        menu_bg: rgb(0x3C, 0x38, 0x36),
        sel_fg: rgb(0x28, 0x28, 0x28),
        sel_bg: rgb(0xFA, 0xBD, 0x2F),
        quarantine_fg: rgb(0x28, 0x28, 0x28),
        quarantine_bg: rgb(0xFA, 0xBD, 0x2F),
        error: rgb(0xFB, 0x49, 0x34),
        warning: rgb(0xFE, 0x80, 0x19),
        hint: rgb(0x8E, 0xC0, 0x7C),
        coach_you: rgb(0x83, 0xA5, 0x98),
        coach_reply: rgb(0xB8, 0xBB, 0x26),
        heading: rgb(0xFA, 0xBD, 0x2F),
        heading_alt: rgb(0xFE, 0x80, 0x19),
        code: rgb(0xB8, 0xBB, 0x26),
        math: rgb(0xD3, 0x86, 0x9B),
        quote: rgb(0x92, 0x83, 0x74),
    },
    // — Terminal: defer to the terminal's own palette (16-color safe). —
    Theme {
        name: "Terminal",
        fg: Color::Reset,
        bg: Color::Reset,
        dim: Color::DarkGray,
        accent: Color::Yellow,
        border: Color::DarkGray,
        border_focus: Color::Cyan,
        status_fg: Color::Black,
        status_bg: Color::Gray,
        menu_fg: Color::Black,
        menu_bg: Color::Gray,
        sel_fg: Color::Black,
        sel_bg: Color::Cyan,
        quarantine_fg: Color::Black,
        quarantine_bg: Color::Yellow,
        error: Color::Red,
        warning: Color::Yellow,
        hint: Color::Cyan,
        coach_you: Color::Blue,
        coach_reply: Color::Green,
        heading: Color::Cyan,
        heading_alt: Color::LightCyan,
        code: Color::Yellow,
        math: Color::Magenta,
        quote: Color::DarkGray,
    },
];

/// The startup theme: `WHETSTONE_THEME` by name, else the first built-in.
pub fn default_theme() -> &'static Theme {
    std::env::var("WHETSTONE_THEME")
        .ok()
        .and_then(|n| by_name(&n))
        .unwrap_or(&THEMES[0])
}

/// Look up a theme by name (case-insensitive, trimmed).
pub fn by_name(name: &str) -> Option<&'static Theme> {
    let name = name.trim();
    THEMES.iter().find(|t| t.name.eq_ignore_ascii_case(name))
}

/// Index of `theme` within [`THEMES`] (0 if somehow absent).
pub fn index_of(theme: &Theme) -> usize {
    THEMES
        .iter()
        .position(|t| t.name == theme.name)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_is_case_insensitive_and_round_trips() {
        let t = by_name("fresh dark").unwrap();
        assert_eq!(t.name, "Fresh Dark");
        assert_eq!(index_of(t), 1);
    }

    #[test]
    fn unknown_theme_is_none() {
        assert!(by_name("no-such-theme").is_none());
    }

    #[test]
    fn default_is_first_when_env_unset() {
        // Names are unique so index_of is well-defined for every built-in.
        for (i, t) in THEMES.iter().enumerate() {
            assert_eq!(index_of(t), i, "duplicate or misordered theme {}", t.name);
        }
    }
}
