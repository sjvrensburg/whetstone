//! Menu-bar model + actions.
//!
//! The bar is always visible for discoverability; F10 (or a click on a title)
//! opens a dropdown. Opening a menu is the only transient mode — everything
//! else stays non-modal, and Esc always backs out (Fresh-style: familiar, no
//! modes to memorize). [`menus`] rebuilds the model from current state so
//! enabled/checked flags and dynamic labels (theme name, friction level) stay
//! in sync.

use crate::core::process_event::{FrictionPolicy, Instrument};

/// A command a menu item triggers. Dispatched by the app to existing handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAction {
    EditClaim,
    Save,
    SaveAs,
    Open,
    Export,
    PreviewDisclosure,
    Quit,
    AttributeRegion,
    Find,
    Replace,
    GotoLine,
    ThemePicker,
    SetFriction(u8),
    CycleInstrument(Instrument),
    ToggleCoach,
    CoachSelection,
    ResetCoach,
    CoachSettings,
    Journal,
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

/// Label for a per-instrument override row: the instrument name plus its current
/// state — its own level when overridden, else "follows preset". Also reused as
/// the status message when cycling an override.
pub fn instrument_label(inst: Instrument, friction: &FrictionPolicy) -> String {
    match friction.overrides.get(inst) {
        Some(level) => format!(
            "{}: {} (override)",
            inst.label(),
            friction_level_name(level)
        ),
        None => format!("{}: follows preset", inst.label()),
    }
}

/// Build the menu model for the current state.
pub fn menus(coach_enabled: bool, friction: &FrictionPolicy, theme_name: &str) -> Vec<Menu> {
    let friction_level = friction.level();
    vec![
        Menu {
            title: "File",
            items: vec![
                MenuItem::new("Open…", "Ctrl+O", MenuAction::Open),
                MenuItem::new("Save", "Ctrl+S", MenuAction::Save),
                MenuItem::new("Save as…", "", MenuAction::SaveAs),
                MenuItem::new("Edit claim", "Ctrl+K", MenuAction::EditClaim),
                MenuItem::new("Export disclosure", "Ctrl+D", MenuAction::Export),
                MenuItem::new("Preview disclosure", "", MenuAction::PreviewDisclosure),
                MenuItem::new("Quit", "Ctrl+Q", MenuAction::Quit),
            ],
        },
        Menu {
            title: "Edit",
            items: vec![
                MenuItem::new("Find…", "Ctrl+F", MenuAction::Find),
                MenuItem::new("Replace…", "Ctrl+H", MenuAction::Replace),
                MenuItem::new("Go to line…", "Ctrl+G", MenuAction::GotoLine),
                MenuItem::new(
                    "Mark paste as quotation",
                    "Ctrl+M",
                    MenuAction::AttributeRegion,
                ),
            ],
        },
        Menu {
            title: "View",
            items: {
                let mut items = vec![
                    MenuItem::new("Process / journal", "Ctrl+P", MenuAction::Journal),
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
                ];
                // One cycle row per dial-able instrument (ADR-008).
                items.extend(Instrument::ALL.map(|inst| {
                    MenuItem::new(
                        instrument_label(inst, friction),
                        "cycle",
                        MenuAction::CycleInstrument(inst),
                    )
                    .checked(friction.overrides.get(inst).is_some())
                }));
                items
            },
        },
        Menu {
            title: "Coach",
            items: vec![
                MenuItem::new("Focus coach", "Ctrl+L", MenuAction::ToggleCoach)
                    .enabled(coach_enabled),
                MenuItem::new("Coach selection", "Ctrl+J", MenuAction::CoachSelection)
                    .enabled(coach_enabled),
                MenuItem::new("Reset conversation", "", MenuAction::ResetCoach)
                    .enabled(coach_enabled),
                MenuItem::new("AI settings…", "Ctrl+E", MenuAction::CoachSettings),
            ],
        },
        Menu {
            title: "Help",
            items: vec![MenuItem::new("Keybindings…", "F1", MenuAction::Help)],
        },
    ]
}
