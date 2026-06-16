//! Menu-bar model + actions.
//!
//! The bar is always visible for discoverability; F10 (or a click on a title)
//! opens a dropdown. Opening a menu is the only transient mode — everything
//! else stays non-modal, and Esc always backs out (Fresh-style: familiar, no
//! modes to memorize). [`menus`] rebuilds the model from current state so
//! enabled/checked flags and dynamic labels (theme name, friction level) stay
//! in sync.

/// A command a menu item triggers. Dispatched by the app to existing handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAction {
    EditClaim,
    Save,
    Export,
    Quit,
    AttributeRegion,
    ThemePicker,
    SetFriction(u8),
    ToggleCoach,
    Help,
}

/// One row in a dropdown. `hint` is a right-aligned shortcut reminder.
pub struct MenuItem {
    pub label: String,
    pub hint: &'static str,
    pub action: MenuAction,
    pub enabled: bool,
    pub checked: bool,
}

impl MenuItem {
    fn new(label: impl Into<String>, hint: &'static str, action: MenuAction) -> Self {
        Self {
            label: label.into(),
            hint,
            action,
            enabled: true,
            checked: false,
        }
    }
    fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
    fn checked(mut self, on: bool) -> Self {
        self.checked = on;
        self
    }
}

/// A top-level menu and its rows.
pub struct Menu {
    pub title: &'static str,
    pub items: Vec<MenuItem>,
}

/// Human name for a friction level (ADR-008).
pub fn friction_level_name(level: u8) -> &'static str {
    match level {
        0 => "Quiet",
        1 => "Coach",
        2 => "Engaged",
        _ => "Deep Work",
    }
}

/// Build the menu model for the current state.
pub fn menus(coach_enabled: bool, friction_level: u8, theme_name: &str) -> Vec<Menu> {
    vec![
        Menu {
            title: "File",
            items: vec![
                MenuItem::new("Edit claim", "Ctrl+K", MenuAction::EditClaim),
                MenuItem::new("Save", "Ctrl+S", MenuAction::Save),
                MenuItem::new("Export disclosure", "Ctrl+D", MenuAction::Export),
                MenuItem::new("Quit", "Ctrl+Q", MenuAction::Quit),
            ],
        },
        Menu {
            title: "Edit",
            items: vec![MenuItem::new(
                "Mark paste as quotation",
                "Ctrl+M",
                MenuAction::AttributeRegion,
            )],
        },
        Menu {
            title: "View",
            items: vec![
                MenuItem::new(
                    format!("Theme: {theme_name}"),
                    "Ctrl+T",
                    MenuAction::ThemePicker,
                ),
                MenuItem::new("Friction: Quiet", "", MenuAction::SetFriction(0))
                    .checked(friction_level == 0),
                MenuItem::new("Friction: Coach", "", MenuAction::SetFriction(1))
                    .checked(friction_level == 1),
                MenuItem::new("Friction: Engaged", "", MenuAction::SetFriction(2))
                    .checked(friction_level == 2),
                MenuItem::new("Friction: Deep Work", "", MenuAction::SetFriction(3))
                    .checked(friction_level == 3),
            ],
        },
        Menu {
            title: "Coach",
            items: vec![
                MenuItem::new("Focus coach", "Ctrl+L", MenuAction::ToggleCoach)
                    .enabled(coach_enabled),
            ],
        },
        Menu {
            title: "Help",
            items: vec![MenuItem::new("Keybindings…", "F1", MenuAction::Help)],
        },
    ]
}
