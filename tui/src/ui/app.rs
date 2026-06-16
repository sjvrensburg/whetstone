//! The application state, key/paste/mouse handling, and the layout: a top menu
//! bar, a three-pane body (editor | preview+coach), a coach input line, and a
//! status bar. The UI is fully themed (see [`crate::ui::theme`]) and mouse-
//! driven (menus, theme picker, pane focus, scrolling), Fresh-style: familiar
//! shortcuts, no modes beyond the transient menu/overlay.
//!
//! The coach speaks OpenAI-compatible Chat Completions over any base URL; every
//! streamed reply is forced through [`crate::core::guard::screen_chat_reply`]
//! before it is shown.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use chrono::Utc;
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};

use crate::coach::{CoachClient, CoachConfig, DEFAULT_MODEL};
use crate::core::disclosure::render_disclosure;
use crate::core::guard::{screen_chat_reply, screen_injection};
use crate::core::mirror::{MirrorSnapshot, compute_mirror};
use crate::core::process_event::{
    FrictionPolicy, Location, MetaValue, ProcessEvent, ProcessEventType,
};
use crate::core::prompts::{ChatTurn, ChatTurnRole, build_chat_messages};
use crate::editor::buffer::Buffer;
use crate::editor::quarantine::{Outcome, Quarantine, Region};
use crate::editor::transaction::{Change, ChangeSet};
use crate::grammar::{Diagnostic, Linter, Severity};
use crate::instruments;
use crate::markdown::render::render_to_text;
use crate::ui::menu::{self, Menu, MenuAction};
use crate::ui::theme::{self, Theme};

/// Which pane receives keyboard input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Editor,
    Coach,
}

/// A streaming coach event, pushed from the async coach task to the UI loop.
pub enum CoachEvent {
    Delta(String),
    Done(Result<String, String>),
}

/// Live-preview state for the theme picker popup. `original` is restored on
/// cancel (Esc); moving the selection applies the theme immediately.
struct ThemePicker {
    sel: usize,
    original: &'static Theme,
}

/// Edit buffers for the AI/coach settings dialog. `field` selects the focused
/// input (0 = endpoint, 1 = API key, 2 = model).
struct CoachSettings {
    base_url: String,
    api_key: String,
    model: String,
    field: usize,
}

/// The running editor application.
pub struct App {
    pub buffer: Buffer,
    pub path: PathBuf,
    pub dirty: bool,
    pub quit: bool,
    pub message: String,
    editor_scroll: usize,
    editor_height: usize,
    editor_inner: Rect,
    preview_scroll: usize,
    preview_height: usize,
    preview_inner: Rect,
    linter: Linter,
    diagnostics: Vec<Diagnostic>,
    lint_dirty: bool,
    last_edit: Option<Instant>,
    /// The most recent transaction, exposed for M4's quarantine region store.
    pub last_change: Option<ChangeSet>,

    journal: Vec<ProcessEvent>,
    event_seq: u64,
    quarantine: Quarantine,
    claim: Option<String>,
    gated: bool,
    claim_input: String,
    teachback_pending: bool,
    teachback_input: String,
    last_para_count: usize,
    next_teachback: usize,
    /// Friction dial (ADR-008): drives the quarantine, claim, and teach-back
    /// instruments. Set from `WHETSTONE_FRICTION` (0–3) at startup.
    friction: FrictionPolicy,
    /// Bumped on every buffer mutation; keys the preview render cache.
    edit_version: u64,

    tokio: tokio::runtime::Handle,
    client: Option<CoachClient>,
    coach_tx: mpsc::Sender<CoachEvent>,
    coach_rx: mpsc::Receiver<CoachEvent>,
    coach_turns: Vec<ChatTurn>,
    coach_input: String,
    coach_streaming: String,
    coach_busy: bool,
    /// Size (chars) of the in-flight consult's message+context, for journaling
    /// the `coach_consult` event when the reply resolves.
    coach_pending_size: u32,
    focus: Focus,
    coach_inner: Rect,
    coach_scroll: usize,
    coach_input_rect: Rect,

    /// Active color theme (swapped live via the theme picker).
    theme: &'static Theme,
    /// Which top-level menu is open, if any (index into [`Self::menus`]).
    menu_open: Option<usize>,
    /// Highlighted row within the open menu.
    menu_item: usize,
    /// Menu-bar area + per-title hit boxes `(x_start, x_end, index)` for mouse.
    menu_bar_rect: Rect,
    menu_titles: Vec<(u16, u16, usize)>,
    /// The open dropdown's popup rect (for mouse hit-testing).
    menu_dropdown_rect: Rect,
    /// Theme picker popup state + its rect.
    theme_picker: Option<ThemePicker>,
    theme_picker_rect: Rect,
    /// AI/coach settings dialog state + its rect.
    coach_settings: Option<CoachSettings>,
    coach_settings_rect: Rect,
    /// Whether the keybindings/help popup is showing.
    help_open: bool,

    /// Cached preview render: `(edit_version, width, theme_name, text, height)`.
    preview_cache: Option<(u64, u16, &'static str, Text<'static>, usize)>,
    /// Cached process mirror: `(event_seq, snapshot)`.
    mirror_cache: Option<(u64, MirrorSnapshot)>,
}

impl App {
    pub fn new(
        text: String,
        path: PathBuf,
        coach_config: Option<CoachConfig>,
        tokio: tokio::runtime::Handle,
    ) -> Self {
        let mut buffer = Buffer::new(&text);
        buffer.set_cursor(buffer.len_chars());
        let message = if path.as_os_str().is_empty() {
            "New buffer".to_string()
        } else {
            format!("Opened {}", path.display())
        };
        let mut linter = Linter::new();
        let diagnostics = linter.lint(&text);

        // Gate the editor only for brand-new (empty) documents. For existing
        // docs, read any claim/intent from the YAML frontmatter instead.
        let claim = crate::markdown::render::frontmatter_claim(&text);
        let gated = text.trim().is_empty();
        let pc0 = instruments::paragraph_count(&text);

        // Friction dial (ADR-008): institutional floor 0, writer preset from
        // WHETSTONE_FRICTION (0–3, default 1). Drives the instruments below.
        let friction = FrictionPolicy::new(
            0,
            std::env::var("WHETSTONE_FRICTION")
                .ok()
                .and_then(|s| s.trim().parse::<u8>().ok())
                .unwrap_or(1),
        );
        let mut quarantine = Quarantine::new();
        quarantine.set_thresholds(
            friction.paste_threshold(),
            friction.claim_survival_threshold(),
        );
        let next_teachback = match friction.teachback_interval() {
            Some(iv) => ((pc0 / iv) + 1) * iv,
            None => usize::MAX,
        };

        let client = coach_config.map(CoachClient::new);
        // The channel is always live so the coach can be enabled at runtime via
        // the AI settings dialog; `client.is_some()` is the single enabled flag.
        let (coach_tx, coach_rx) = mpsc::channel();

        Self {
            buffer,
            path,
            dirty: false,
            quit: false,
            message,
            editor_scroll: 0,
            editor_height: 0,
            editor_inner: Rect::default(),
            preview_scroll: 0,
            preview_height: 0,
            preview_inner: Rect::default(),
            linter,
            diagnostics,
            lint_dirty: false,
            last_edit: None,
            last_change: None,
            tokio,
            client,
            coach_tx,
            coach_rx,
            coach_turns: Vec::new(),
            coach_input: String::new(),
            coach_streaming: String::new(),
            coach_busy: false,
            coach_pending_size: 0,
            focus: Focus::Editor,
            coach_inner: Rect::default(),
            coach_scroll: 0,
            coach_input_rect: Rect::default(),
            journal: Vec::new(),
            event_seq: 0,
            quarantine,
            claim,
            gated,
            claim_input: String::new(),
            teachback_pending: false,
            teachback_input: String::new(),
            last_para_count: pc0,
            next_teachback,
            friction,
            edit_version: 0,
            theme: theme::default_theme(),
            menu_open: None,
            menu_item: 0,
            menu_bar_rect: Rect::default(),
            menu_titles: Vec::new(),
            menu_dropdown_rect: Rect::default(),
            theme_picker: None,
            theme_picker_rect: Rect::default(),
            coach_settings: None,
            coach_settings_rect: Rect::default(),
            help_open: false,
            preview_cache: None,
            mirror_cache: None,
        }
    }

    /// Record the session start (call once after construction).
    pub fn start_session(&mut self) {
        self.log_event(ProcessEventType::SessionStart, None, None, vec![]);
    }

    /// Append a metadata-only event to the journal. The Service (v2: a remote
    /// witness) would assign `id`/`ts`; v1 stamps them locally.
    fn log_event(
        &mut self,
        kind: ProcessEventType,
        size: Option<u32>,
        location: Option<Location>,
        meta: Vec<(&'static str, MetaValue)>,
    ) {
        self.event_seq += 1;
        let id = format!("e{}", self.event_seq);
        let ts = Utc::now().to_rfc3339();
        let mut m = crate::core::process_event::Meta::new();
        for (k, v) in meta {
            m.insert(k.into(), v);
        }
        self.journal.push(ProcessEvent {
            id,
            ts,
            kind,
            size,
            location,
            meta: if m.is_empty() { None } else { Some(m) },
        });
    }

    fn log_quarantine_outcomes(&mut self, outcomes: Vec<Outcome>) {
        for o in outcomes {
            match o {
                Outcome::Claimed {
                    id,
                    survival,
                    deleted,
                } => self.log_event(
                    ProcessEventType::PasteClaimed,
                    None,
                    None,
                    vec![
                        ("regionId", MetaValue::Str(id)),
                        ("survival", MetaValue::Num(survival)),
                        ("deleted", MetaValue::Bool(deleted)),
                    ],
                ),
                Outcome::Revised { id, survival } => self.log_event(
                    ProcessEventType::RegionRevised,
                    None,
                    None,
                    vec![
                        ("regionId", MetaValue::Str(id)),
                        ("survival", MetaValue::Num(survival)),
                    ],
                ),
            }
        }
    }

    /// The single post-edit chokepoint. Every buffer mutation routes through
    /// here so region remapping, journaling, the render version, and the
    /// dirty/lint/scroll state can never drift between handlers.
    fn commit_edit(&mut self, cs: ChangeSet) {
        let after = self.buffer.text();
        let outcomes = self.quarantine.apply(&cs, &after);
        self.log_quarantine_outcomes(outcomes);
        self.last_change = Some(cs);
        self.edit_version += 1;
        self.dirty = true;
        self.lint_dirty = true;
        self.last_edit = Some(Instant::now());
        self.reveal_cursor();
    }

    /// Journal a `coach_consult` event — metadata only: provider/model, the
    /// message+context size, and whether the guard or provider refused.
    fn log_coach_consult(&mut self, refused: bool) {
        let mut meta = vec![("refused", MetaValue::Bool(refused))];
        if let Some(cfg) = self.client.as_ref().map(|c| c.config().clone()) {
            meta.push(("provider", MetaValue::Str(cfg.base_url)));
            meta.push(("model", MetaValue::Str(cfg.model)));
        }
        let size = self.coach_pending_size;
        self.log_event(
            ProcessEventType::CoachConsult,
            (size > 0).then_some(size),
            None,
            meta,
        );
    }

    pub fn should_quit(&self) -> bool {
        self.quit
    }

    pub fn handle_paste(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some(s) = self.coach_settings.as_mut() {
            match s.field {
                0 => s.base_url.push_str(text),
                1 => s.api_key.push_str(text),
                _ => s.model.push_str(text),
            }
            return;
        }
        match self.focus {
            Focus::Editor => {
                if self.gated {
                    self.claim_input.push_str(text);
                    return;
                }
                let n = text.chars().count();
                let at = self.buffer.cursor();
                let change = self.buffer.type_str(text);
                let cs = ChangeSet::single(change);
                // Remap existing regions against the insertion FIRST, then
                // record the new paste with its post-insert offsets.
                self.commit_edit(cs);
                self.log_event(
                    ProcessEventType::PasteDetected,
                    Some(n as u32),
                    Some(Location {
                        from: at as u32,
                        to: (at + n) as u32,
                    }),
                    vec![],
                );
                if let Some(id) = self.quarantine.record_paste(at, at + n, text) {
                    self.log_event(
                        ProcessEventType::PasteQuarantined,
                        Some(n as u32),
                        Some(Location {
                            from: at as u32,
                            to: (at + n) as u32,
                        }),
                        vec![("regionId", MetaValue::Str(id))],
                    );
                }
                self.message = format!("Pasted {n} chars");
            }
            Focus::Coach => self.coach_input.push_str(text),
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        // Overlays consume input first (most transient on top).
        if self.help_open {
            self.help_open = false; // any key dismisses
            return;
        }
        if self.theme_picker.is_some() {
            self.handle_theme_picker_key(key);
            return;
        }
        if self.coach_settings.is_some() {
            self.handle_coach_settings_key(key);
            return;
        }
        if self.menu_open.is_some() {
            self.handle_menu_key(key);
            return;
        }
        if self.gated {
            self.handle_claim_key(key);
            return;
        }
        if self.teachback_pending {
            self.handle_teachback_key(key);
            return;
        }
        // Open the menu bar (Fresh-style: F10, then arrows + Enter).
        if key.code == KeyCode::F(10) {
            self.open_menu();
            return;
        }
        if key.code == KeyCode::F(1) {
            self.help_open = true;
            return;
        }
        // Global control keys.
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('k') => self.dispatch(MenuAction::EditClaim),
                KeyCode::Char('d') => self.export_disclosure(),
                KeyCode::Char('m') if self.focus == Focus::Editor => self.attribute_region(),
                KeyCode::Char('s') => self.save(),
                KeyCode::Char('t') => self.open_theme_picker(),
                KeyCode::Char('e') => self.open_coach_settings(),
                KeyCode::Char('c') | KeyCode::Char('q') => self.quit = true,
                KeyCode::Char('l') if self.client.is_some() => {
                    self.dispatch(MenuAction::ToggleCoach)
                }
                _ => {}
            }
            return;
        }

        match self.focus {
            Focus::Editor => self.handle_editor_key(key),
            Focus::Coach => self.handle_coach_key(key),
        }
    }

    /// Whether any modal/overlay is up (suppresses the editor caret, etc.).
    fn has_overlay(&self) -> bool {
        self.gated
            || self.teachback_pending
            || self.menu_open.is_some()
            || self.theme_picker.is_some()
            || self.coach_settings.is_some()
            || self.help_open
    }

    // --- menus -------------------------------------------------------------

    /// The menu model for the current state (coach availability, friction
    /// level, active theme name drive enabled/checked flags + labels).
    fn menus(&self) -> Vec<Menu> {
        menu::menus(
            self.client.is_some(),
            self.friction.level(),
            self.theme.name,
        )
    }

    fn open_menu(&mut self) {
        self.menu_open = Some(0);
        self.menu_item = self.first_enabled(0);
    }

    fn close_menu(&mut self) {
        self.menu_open = None;
        self.menu_item = 0;
    }

    /// First enabled row in menu `m` (0 if none — the menu still renders).
    fn first_enabled(&self, m: usize) -> usize {
        let menus = self.menus();
        menus
            .get(m)
            .and_then(|menu| menu.items.iter().position(|it| it.enabled))
            .unwrap_or(0)
    }

    fn handle_menu_key(&mut self, key: KeyEvent) {
        let Some(open) = self.menu_open else { return };
        let menus = self.menus();
        let count = menus.len();
        let items = menus[open].items.len();
        match key.code {
            KeyCode::Esc | KeyCode::F(10) => self.close_menu(),
            KeyCode::Left => {
                let next = (open + count - 1) % count;
                self.menu_open = Some(next);
                self.menu_item = self.first_enabled(next);
            }
            KeyCode::Right => {
                let next = (open + 1) % count;
                self.menu_open = Some(next);
                self.menu_item = self.first_enabled(next);
            }
            KeyCode::Up => {
                for step in 1..=items {
                    let cand = (self.menu_item + items - step) % items;
                    if menus[open].items[cand].enabled {
                        self.menu_item = cand;
                        break;
                    }
                }
            }
            KeyCode::Down => {
                for step in 1..=items {
                    let cand = (self.menu_item + step) % items;
                    if menus[open].items[cand].enabled {
                        self.menu_item = cand;
                        break;
                    }
                }
            }
            KeyCode::Enter => {
                if let Some(item) = menus[open].items.get(self.menu_item)
                    && item.enabled
                {
                    let action = item.action;
                    self.close_menu();
                    self.dispatch(action);
                }
            }
            _ => {}
        }
    }

    /// Run a menu/shortcut command.
    fn dispatch(&mut self, action: MenuAction) {
        match action {
            MenuAction::EditClaim => {
                self.claim_input = self.claim.clone().unwrap_or_default();
                self.gated = true;
            }
            MenuAction::Save => self.save(),
            MenuAction::Export => self.export_disclosure(),
            MenuAction::Quit => self.quit = true,
            MenuAction::AttributeRegion => self.attribute_region(),
            MenuAction::ThemePicker => self.open_theme_picker(),
            MenuAction::SetFriction(n) => self.set_friction(n),
            MenuAction::ToggleCoach => {
                if self.client.is_some() {
                    self.focus = match self.focus {
                        Focus::Editor => Focus::Coach,
                        Focus::Coach => Focus::Editor,
                    };
                    self.coach_input.clear();
                }
            }
            MenuAction::CoachSettings => self.open_coach_settings(),
            MenuAction::Help => self.help_open = true,
        }
    }

    /// Re-set the friction level (ADR-008) live and re-tune the instruments.
    fn set_friction(&mut self, level: u8) {
        self.friction = FrictionPolicy::new(self.friction.floor, level);
        self.quarantine.set_thresholds(
            self.friction.paste_threshold(),
            self.friction.claim_survival_threshold(),
        );
        self.next_teachback = match self.friction.teachback_interval() {
            Some(iv) => ((self.last_para_count / iv) + 1) * iv,
            None => usize::MAX,
        };
        self.message = format!(
            "Friction: {} (level {level})",
            menu::friction_level_name(level)
        );
    }

    // --- theme picker ------------------------------------------------------

    fn open_theme_picker(&mut self) {
        self.theme_picker = Some(ThemePicker {
            sel: theme::index_of(self.theme),
            original: self.theme,
        });
    }

    /// Apply the theme at `idx` immediately (live preview) and invalidate the
    /// preview cache, which embeds theme colors.
    fn apply_theme(&mut self, idx: usize) {
        self.theme = &theme::THEMES[idx];
        self.preview_cache = None;
    }

    fn handle_theme_picker_key(&mut self, key: KeyEvent) {
        if self.theme_picker.is_none() {
            return;
        }
        let count = theme::THEMES.len();
        let sel = self.theme_picker.as_ref().unwrap().sel;
        match key.code {
            KeyCode::Up => {
                let next = (sel + count - 1) % count;
                self.theme_picker.as_mut().unwrap().sel = next;
                self.apply_theme(next);
            }
            KeyCode::Down => {
                let next = (sel + 1) % count;
                self.theme_picker.as_mut().unwrap().sel = next;
                self.apply_theme(next);
            }
            KeyCode::Enter => {
                self.message = format!("Theme: {}", self.theme.name);
                self.theme_picker = None;
            }
            KeyCode::Esc => {
                let original = self.theme_picker.as_ref().unwrap().original;
                self.theme = original;
                self.preview_cache = None;
                self.theme_picker = None;
            }
            _ => {}
        }
    }

    // --- AI / coach settings ----------------------------------------------

    fn open_coach_settings(&mut self) {
        let (base_url, api_key, model) = match self.client.as_ref().map(|c| c.config().clone()) {
            Some(c) => (c.base_url, c.api_key, c.model),
            None => (String::new(), String::new(), DEFAULT_MODEL.to_string()),
        };
        self.coach_settings = Some(CoachSettings {
            base_url,
            api_key,
            model,
            field: 0,
        });
    }

    fn handle_coach_settings_key(&mut self, key: KeyEvent) {
        // Enter/Esc need &mut self, so handle them before borrowing the buffers.
        match key.code {
            KeyCode::Esc => {
                self.coach_settings = None;
                self.message = "AI settings cancelled.".into();
                return;
            }
            KeyCode::Enter => {
                self.save_coach_settings();
                return;
            }
            _ => {}
        }
        let Some(s) = self.coach_settings.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Tab | KeyCode::Down => s.field = (s.field + 1) % 3,
            KeyCode::BackTab | KeyCode::Up => s.field = (s.field + 2) % 3,
            KeyCode::Backspace => {
                match s.field {
                    0 => s.base_url.pop(),
                    1 => s.api_key.pop(),
                    _ => s.model.pop(),
                };
            }
            KeyCode::Char(c) if !c.is_control() => match s.field {
                0 => s.base_url.push(c),
                1 => s.api_key.push(c),
                _ => s.model.push(c),
            },
            _ => {}
        }
    }

    /// Apply the dialog: rebuild (or disable) the coach client and persist.
    fn save_coach_settings(&mut self) {
        let Some(s) = self.coach_settings.take() else {
            return;
        };
        let base_url = s.base_url.trim().trim_end_matches('/').to_string();
        let model = {
            let m = s.model.trim();
            if m.is_empty() {
                DEFAULT_MODEL.to_string()
            } else {
                m.to_string()
            }
        };
        let cfg = CoachConfig {
            base_url: base_url.clone(),
            api_key: s.api_key,
            model,
        };
        // An empty endpoint disables the coach; otherwise (re)build the client.
        self.client = if base_url.is_empty() {
            None
        } else {
            Some(CoachClient::new(cfg.clone()))
        };
        let state = if base_url.is_empty() {
            "Coach disabled"
        } else {
            "Coach configured"
        };
        self.message = match cfg.save() {
            Ok(path) => format!("{state} · saved {}", path.display()),
            Err(e) => format!("{state} · save failed: {e}"),
        };
    }

    fn menu_title_at(&self, col: u16) -> Option<usize> {
        self.menu_titles
            .iter()
            .find(|(start, end, _)| col >= *start && col < *end)
            .map(|(_, _, idx)| *idx)
    }

    fn activate_menu_row(&mut self, row: usize) {
        let Some(open) = self.menu_open else { return };
        let menus = self.menus();
        if let Some(item) = menus.get(open).and_then(|m| m.items.get(row))
            && item.enabled
        {
            let action = item.action;
            self.close_menu();
            self.dispatch(action);
        }
    }

    fn handle_editor_key(&mut self, key: KeyEvent) {
        let change = match key.code {
            KeyCode::Char(c) if !c.is_control() => Some(self.buffer.type_char(c)),
            KeyCode::Enter => Some(self.buffer.type_str("\n")),
            KeyCode::Tab => Some(self.buffer.type_str("    ")),
            KeyCode::Backspace => self.buffer.delete_backward(),
            KeyCode::Delete => self.buffer.delete_forward(),
            KeyCode::Left => {
                self.buffer.move_left();
                self.reveal_cursor();
                return;
            }
            KeyCode::Right => {
                self.buffer.move_right();
                self.reveal_cursor();
                return;
            }
            KeyCode::Up => {
                self.buffer.move_up();
                self.reveal_cursor();
                return;
            }
            KeyCode::Down => {
                self.buffer.move_down();
                self.reveal_cursor();
                return;
            }
            KeyCode::Home => {
                self.buffer.move_line_start();
                self.reveal_cursor();
                return;
            }
            KeyCode::End => {
                self.buffer.move_line_end();
                self.reveal_cursor();
                return;
            }
            KeyCode::PageUp => {
                let h = self.editor_height.max(1);
                for _ in 0..h {
                    self.buffer.move_up();
                }
                self.reveal_cursor();
                return;
            }
            KeyCode::PageDown => {
                let h = self.editor_height.max(1);
                for _ in 0..h {
                    self.buffer.move_down();
                }
                self.reveal_cursor();
                return;
            }
            _ => return,
        };
        let Some(change) = change else {
            return;
        };
        let cs = ChangeSet::single(change);
        // Typing bursts are journaled as metadata (size only) when they add text.
        let inserted: usize = cs.changes.iter().map(|c| c.inserted_len()).sum();
        if inserted > 0 {
            self.log_event(
                ProcessEventType::TypingBurst,
                Some(inserted as u32),
                None,
                vec![],
            );
        }
        self.commit_edit(cs);
        let after = self.buffer.text();
        self.maybe_trigger_teachback(&after);
    }

    /// Claim-gate input (before the editor is unlocked).
    fn handle_claim_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => {
                let claim = self.claim_input.trim().to_string();
                if !claim.is_empty() {
                    self.claim = Some(claim.clone());
                    self.log_event(
                        ProcessEventType::ClaimSet,
                        None,
                        None,
                        vec![("claim", MetaValue::Str(claim))],
                    );
                    self.message = "Claim recorded — write on.".into();
                }
                self.gated = false;
                self.claim_input.clear();
            }
            KeyCode::Esc => {
                self.gated = false;
                self.claim_input.clear();
                self.message = "No claim recorded.".into();
            }
            KeyCode::Backspace => {
                self.claim_input.pop();
            }
            KeyCode::Char(c) if !c.is_control() => self.claim_input.push(c),
            _ => {}
        }
    }

    /// Mark the quarantined region under the cursor as a quotation.
    fn attribute_region(&mut self) {
        let pos = self.buffer.cursor();
        let Some(r) = self.quarantine.region_at(pos).cloned() else {
            self.message = "No quarantined paste at the cursor.".into();
            return;
        };
        let closer = " (citation needed)";
        let closer_len = closer.chars().count();
        // Drop the attributed region, then apply both insertions to the buffer
        // (closer first so the opening-quote offset is unchanged).
        self.quarantine.remove(&r.id);
        self.buffer.insert_str(r.to, closer);
        self.buffer.insert_str(r.from, "\"");
        // Represent both edits as one change set (pre-edit, sorted coords) and
        // route through commit_edit so the OTHER regions are remapped past the
        // inserted text rather than left with stale offsets.
        let cs = ChangeSet {
            changes: vec![
                Change {
                    from: r.from,
                    to: r.from,
                    insert: "\"".to_string(),
                },
                Change {
                    from: r.to,
                    to: r.to,
                    insert: closer.to_string(),
                },
            ],
        };
        self.commit_edit(cs);
        self.log_event(
            ProcessEventType::PasteAttributed,
            Some((r.to - r.from) as u32),
            Some(Location {
                from: r.from as u32,
                to: (r.to + closer_len + 1) as u32,
            }),
            vec![("regionId", MetaValue::Str(r.id))],
        );
        self.message = "Marked as quotation (citation needed).".into();
    }

    fn handle_coach_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.focus = Focus::Editor,
            KeyCode::Enter => self.ask_coach(),
            KeyCode::Backspace => {
                self.coach_input.pop();
            }
            KeyCode::Char(c) if !c.is_control() => self.coach_input.push(c),
            _ => {}
        }
    }

    /// Send the current coach input as a chat turn and spawn the streaming
    /// request. The reply is guarded on completion (see `drain_coach_events`).
    fn ask_coach(&mut self) {
        let Some(client) = self.client.clone() else {
            self.message = "Coach not configured — set it in Coach ▸ AI settings (Ctrl+E)".into();
            return;
        };
        let tx = self.coach_tx.clone();
        if self.coach_busy {
            self.message = "Coach is already thinking…".into();
            return;
        }
        let msg = std::mem::take(&mut self.coach_input);
        if msg.trim().is_empty() {
            return;
        }
        let context = self.buffer.text();
        self.coach_pending_size = (msg.chars().count() + context.chars().count()) as u32;
        // Both the writer's message and the draft excerpt are inputs that could
        // smuggle instructions — screen both BEFORE any egress (defense-in-depth
        // on top of the untrusted-channel wrapping and the reply guard).
        if let Err(reason) = screen_injection(&format!("{msg}\n{context}")) {
            self.log_coach_consult(true);
            self.coach_turns.push(ChatTurn {
                role: ChatTurnRole::Coach,
                text: format!("(request not sent — input flagged by injection screen: {reason})"),
            });
            self.message = "Coach request blocked by injection screen.".into();
            return;
        }
        // History is everything before the turn we're about to send.
        let history: Vec<ChatTurn> = self.coach_turns.to_vec();
        self.coach_turns.push(ChatTurn {
            role: ChatTurnRole::Writer,
            text: msg.clone(),
        });
        let messages = build_chat_messages(&msg, &history, Some(&context), self.claim.as_deref());
        self.coach_streaming.clear();
        self.coach_busy = true;
        self.message = "Asking coach…".into();
        self.tokio.spawn(async move {
            let result = client
                .chat(&messages, |d: &str| {
                    let _ = tx.send(CoachEvent::Delta(d.to_string()));
                })
                .await;
            let _ = tx.send(CoachEvent::Done(result.map_err(|e| e.to_string())));
        });
    }

    /// Pump coach streaming events into the app state.
    pub fn drain_coach_events(&mut self) {
        // Drain into a local buffer first so we can call the &mut self
        // journaling/guard helpers below without holding the receiver borrow.
        let mut events = Vec::new();
        while let Ok(ev) = self.coach_rx.try_recv() {
            events.push(ev);
        }
        for ev in events {
            match ev {
                CoachEvent::Delta(d) => self.coach_streaming.push_str(&d),
                CoachEvent::Done(res) => {
                    self.coach_busy = false;
                    self.coach_streaming.clear();
                    match res {
                        Ok(reply) => {
                            // Screen the assembled reply (length/rewrite/overlap +
                            // forbidden-label guard) BEFORE it is ever shown.
                            let ctx = self.buffer.text();
                            match screen_chat_reply(&reply, &ctx) {
                                Ok(()) => {
                                    self.log_coach_consult(false);
                                    self.coach_turns.push(ChatTurn {
                                        role: ChatTurnRole::Coach,
                                        text: reply,
                                    });
                                    self.message = "Coach replied.".into();
                                }
                                Err(reason) => {
                                    self.log_coach_consult(true);
                                    self.coach_turns.push(ChatTurn {
                                        role: ChatTurnRole::Coach,
                                        text: format!("(withheld by guard: {reason})"),
                                    });
                                    self.message = "Coach reply withheld by guard.".into();
                                }
                            }
                        }
                        Err(e) => {
                            self.log_coach_consult(true);
                            self.message = format!("Coach error: {e}");
                        }
                    }
                }
            }
        }
    }

    /// Check whether a new paragraph crossed a teach-back threshold.
    fn maybe_trigger_teachback(&mut self, text: &str) {
        let pc = instruments::paragraph_count(text);
        if let Some(interval) = self.friction.teachback_interval()
            && pc > self.last_para_count
            && pc >= self.next_teachback
        {
            self.teachback_pending = true;
            self.teachback_input.clear();
            self.next_teachback = pc + interval;
            self.message = "Teach-back checkpoint — summarize your argument.".into();
        }
        self.last_para_count = pc;
    }

    /// Teach-back modal input.
    fn handle_teachback_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => {
                let response = std::mem::take(&mut self.teachback_input);
                let disconnect = instruments::is_disconnect(&response);
                self.log_event(
                    ProcessEventType::TeachBack,
                    Some(response.chars().count() as u32),
                    None,
                    vec![("disconnect", MetaValue::Bool(disconnect))],
                );
                self.teachback_pending = false;
                self.message = if disconnect {
                    "Teach-back flagged as hard to summarize.".into()
                } else {
                    "Teach-back recorded.".into()
                };
            }
            KeyCode::Esc => {
                self.log_event(
                    ProcessEventType::TeachBack,
                    None,
                    None,
                    vec![
                        ("disconnect", MetaValue::Bool(true)),
                        ("skipped", MetaValue::Bool(true)),
                    ],
                );
                self.teachback_pending = false;
                self.message = "Teach-back skipped.".into();
            }
            KeyCode::Backspace => {
                self.teachback_input.pop();
            }
            KeyCode::Char(c) if !c.is_control() => self.teachback_input.push(c),
            _ => {}
        }
    }

    /// Render the disclosure document and write it next to the source file.
    fn export_disclosure(&mut self) {
        let doc_id = self.file_label();
        match render_disclosure(&doc_id, &self.journal) {
            Ok(doc) => {
                let out = self.path.with_extension("disclosure.md");
                match std::fs::write(&out, doc.markdown.as_bytes()) {
                    Ok(()) => self.message = format!("Disclosure → {}", out.display()),
                    Err(e) => self.message = format!("Disclosure write failed: {e}"),
                }
            }
            Err(e) => self.message = format!("Disclosure blocked: {e}"),
        }
    }

    /// Mouse: wheel scrolls whichever pane the pointer is over; left-click in
    /// the editor positions the cursor; click the coach input to focus it.
    pub fn handle_mouse(&mut self, ev: MouseEvent) {
        let over = |r: Rect| {
            r.width > 0
                && ev.column >= r.x
                && ev.column < r.x + r.width
                && ev.row >= r.y
                && ev.row < r.y + r.height
        };

        // Help popup: a left-click anywhere dismisses it.
        if self.help_open {
            if matches!(ev.kind, MouseEventKind::Down(MouseButton::Left)) {
                self.help_open = false;
            }
            return;
        }

        // Theme picker: wheel changes the live preview; click a row to apply,
        // click outside to cancel.
        if self.theme_picker.is_some() {
            let count = theme::THEMES.len();
            let sel = self.theme_picker.as_ref().unwrap().sel;
            match ev.kind {
                MouseEventKind::ScrollDown => {
                    let n = (sel + 1) % count;
                    self.theme_picker.as_mut().unwrap().sel = n;
                    self.apply_theme(n);
                }
                MouseEventKind::ScrollUp => {
                    let n = (sel + count - 1) % count;
                    self.theme_picker.as_mut().unwrap().sel = n;
                    self.apply_theme(n);
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    let rect = self.theme_picker_rect;
                    if over(rect) && ev.row > rect.y && ev.row + 1 < rect.y + rect.height {
                        let idx = (ev.row - rect.y - 1) as usize;
                        if idx < count {
                            self.apply_theme(idx);
                            self.message = format!("Theme: {}", self.theme.name);
                            self.theme_picker = None;
                        }
                    } else if !over(rect) {
                        let original = self.theme_picker.as_ref().unwrap().original;
                        self.theme = original;
                        self.preview_cache = None;
                        self.theme_picker = None;
                    }
                }
                _ => {}
            }
            return;
        }

        // AI settings dialog: click a field row to focus it, outside to cancel.
        if self.coach_settings.is_some() {
            if let MouseEventKind::Down(MouseButton::Left) = ev.kind {
                let rect = self.coach_settings_rect;
                if over(rect) {
                    if ev.row > rect.y && ev.row + 1 < rect.y + rect.height {
                        let row = (ev.row - rect.y - 1) as usize;
                        if row < 3 {
                            self.coach_settings.as_mut().unwrap().field = row;
                        }
                    }
                } else {
                    self.coach_settings = None;
                    self.message = "AI settings cancelled.".into();
                }
            }
            return;
        }

        // Menu bar + open dropdown.
        if matches!(ev.kind, MouseEventKind::Down(MouseButton::Left)) {
            if over(self.menu_bar_rect) {
                match self.menu_title_at(ev.column) {
                    Some(idx) if self.menu_open == Some(idx) => self.close_menu(),
                    Some(idx) => {
                        self.menu_open = Some(idx);
                        self.menu_item = self.first_enabled(idx);
                    }
                    None => self.close_menu(),
                }
                return;
            }
            if self.menu_open.is_some() {
                let rect = self.menu_dropdown_rect;
                if over(rect) && ev.row > rect.y && ev.row + 1 < rect.y + rect.height {
                    let row = (ev.row - rect.y - 1) as usize;
                    self.activate_menu_row(row);
                } else {
                    self.close_menu();
                }
                return;
            }
        } else if self.menu_open.is_some() {
            return; // swallow wheel/move while a menu is open
        }

        let over_editor = over(self.editor_inner);
        let over_preview = over(self.preview_inner);
        let over_coach = over(self.coach_inner) || over(self.coach_input_rect);

        match ev.kind {
            MouseEventKind::ScrollDown => {
                if over_preview {
                    self.preview_scroll = self.preview_scroll.saturating_add(1);
                } else if over_coach {
                    self.coach_scroll = self.coach_scroll.saturating_add(1);
                } else {
                    let max = self
                        .buffer
                        .line_count()
                        .saturating_sub(self.editor_height.max(1));
                    self.editor_scroll = (self.editor_scroll + 1).min(max);
                }
            }
            MouseEventKind::ScrollUp => {
                if over_preview {
                    self.preview_scroll = self.preview_scroll.saturating_sub(1);
                } else if over_coach {
                    self.coach_scroll = self.coach_scroll.saturating_sub(1);
                } else {
                    self.editor_scroll = self.editor_scroll.saturating_sub(1);
                }
            }
            MouseEventKind::Down(MouseButton::Left) => {
                if over(self.coach_input_rect) && self.client.is_some() {
                    self.focus = Focus::Coach;
                } else if over_editor {
                    let inner = self.editor_inner;
                    let line = self.editor_scroll + (ev.row - inner.y) as usize;
                    // The click column is in terminal display cells; convert it
                    // to a char offset so wide glyphs (CJK/emoji) land correctly.
                    let target = (ev.column as usize).saturating_sub(inner.x as usize);
                    let col = self.buffer.char_col_for_display(line, target);
                    self.buffer.set_cursor_line_col(line, col);
                    self.focus = Focus::Editor;
                    self.reveal_cursor();
                }
            }
            _ => {}
        }
    }

    /// Bring the cursor's line back into the viewport after a cursor move.
    fn reveal_cursor(&mut self) {
        let (line, _) = self.buffer.cursor_line_col();
        let h = self.editor_height;
        if h == 0 {
            return;
        }
        if line < self.editor_scroll {
            self.editor_scroll = line;
        } else if line >= self.editor_scroll + h {
            self.editor_scroll = line - h + 1;
        }
    }

    /// Re-lint the buffer once it has been idle long enough since the last edit.
    pub fn maybe_lint(&mut self) {
        if !self.lint_dirty {
            return;
        }
        let Some(last) = self.last_edit else {
            return;
        };
        if last.elapsed() < Duration::from_millis(300) {
            return;
        }
        let text = self.buffer.text();
        self.diagnostics = self.linter.lint(&text);
        self.lint_dirty = false;
    }

    fn save(&mut self) {
        match std::fs::write(&self.path, self.buffer.text()) {
            Ok(()) => {
                self.dirty = false;
                self.message = format!("Saved {}", self.path.display());
            }
            Err(e) => self.message = format!("Save failed: {e}"),
        }
    }

    fn file_label(&self) -> String {
        match self.path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => self.path.display().to_string(),
        }
    }
}

/// Render the whole frame.
pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    // Fill the whole frame with the theme background first so any uncovered
    // gap (and borders) sit on a consistent backdrop.
    frame.render_widget(Block::default().style(app.theme.panel_bg()), area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // menu bar
            Constraint::Min(1),    // editor | preview/coach
            Constraint::Length(1), // coach input
            Constraint::Length(1), // status
        ])
        .split(area);
    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[1]);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main[1]);

    draw_menu_bar(frame, app, rows[0]);
    draw_editor(frame, app, main[0]);
    draw_preview(frame, app, right[0]);
    draw_coach(frame, app, right[1]);
    draw_coach_input(frame, app, rows[2]);
    draw_status(frame, app, rows[3]);

    if app.gated {
        draw_claim_gate(frame, app, area);
    } else if app.teachback_pending {
        draw_teachback(frame, app, area);
    }
    if app.menu_open.is_some() {
        draw_menu_dropdown(frame, app);
    }
    if app.theme_picker.is_some() {
        draw_theme_picker(frame, app, area);
    }
    if app.coach_settings.is_some() {
        draw_coach_settings(frame, app, area);
    }
    if app.help_open {
        draw_help(frame, app, area);
    }
}

fn draw_coach_settings(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(s) = app.coach_settings.as_ref() else {
        return;
    };
    let theme = app.theme;
    let rect = centered_rect_abs(66, 9, area);
    app.coach_settings_rect = rect;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " AI / Coach settings ",
            theme.title(true),
        )));
    let inner = block.inner(rect);

    // Marker (2) + label padded to 9 + space = 12-cell gutter before the value.
    let gutter = 12u16;
    let field_line = |idx: usize, label: &str, value: String| {
        let focused = s.field == idx;
        let marker = if focused { "▸ " } else { "  " };
        let label_style = if focused { theme.accent() } else { theme.dim() };
        Line::from(vec![
            Span::styled(format!("{marker}{label:<9} "), label_style),
            Span::styled(value, theme.text()),
        ])
    };
    let masked: String = "•".repeat(s.api_key.chars().count());
    let lines = vec![
        field_line(0, "Endpoint", s.base_url.clone()),
        field_line(1, "API key", masked),
        field_line(2, "Model", s.model.clone()),
        Line::raw(""),
        Line::from(Span::styled(
            "Tab/↑↓ field · Enter save · Esc cancel · empty endpoint disables",
            theme.dim(),
        )),
    ];
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);

    // Caret at the end of the focused field's value.
    let val_len = match s.field {
        0 => s.base_url.chars().count(),
        1 => s.api_key.chars().count(),
        _ => s.model.chars().count(),
    } as u16;
    let cx = (inner.x + gutter + val_len).min(inner.right().saturating_sub(1));
    let cy = inner.y + s.field as u16;
    frame.set_cursor_position((cx, cy));
}

fn draw_menu_bar(frame: &mut Frame, app: &mut App, area: Rect) {
    app.menu_bar_rect = area;
    let theme = app.theme;
    let menus = app.menus();
    let mut spans: Vec<Span<'static>> = vec![Span::styled(" ", theme.menu())];
    let mut titles: Vec<(u16, u16, usize)> = Vec::new();
    let mut x = area.x.saturating_add(1);
    for (i, m) in menus.iter().enumerate() {
        let label = format!(" {} ", m.title);
        let w = label.chars().count() as u16;
        let style = if app.menu_open == Some(i) {
            theme.menu_selected()
        } else {
            theme.menu()
        };
        titles.push((x, x.saturating_add(w), i));
        spans.push(Span::styled(label, style));
        x = x.saturating_add(w);
    }
    app.menu_titles = titles;

    let hint = format!("F10 menu · F1 help · {} ", theme.name);
    let used = x.saturating_sub(area.x);
    let hint_w = hint.chars().count() as u16;
    if area.width > used + hint_w {
        let pad = (area.width - used - hint_w) as usize;
        spans.push(Span::styled(" ".repeat(pad), theme.menu()));
        spans.push(Span::styled(
            hint,
            Style::default().fg(theme.dim).bg(theme.menu_bg),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)).style(theme.menu()), area);
}

fn draw_menu_dropdown(frame: &mut Frame, app: &mut App) {
    let Some(open) = app.menu_open else { return };
    let theme = app.theme;
    let menus = app.menus();
    let menu = &menus[open];

    let content_w = menu
        .items
        .iter()
        .map(|it| 2 + it.label.chars().count() + 2 + it.hint.chars().count())
        .max()
        .unwrap_or(8);
    let width = (content_w as u16 + 4).min(frame.area().width);
    let height = (menu.items.len() as u16 + 2).min(frame.area().height);
    let title_x = app
        .menu_titles
        .iter()
        .find(|(_, _, i)| *i == open)
        .map(|(s, _, _)| *s)
        .unwrap_or(app.menu_bar_rect.x);
    let y = app.menu_bar_rect.y.saturating_add(1);
    let x = title_x.min(frame.area().width.saturating_sub(width));
    let rect = Rect {
        x,
        y,
        width,
        height,
    };
    app.menu_dropdown_rect = rect;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.menu())
        .title(Line::from(Span::styled(
            format!(" {} ", menu.title),
            theme.title(true),
        )));
    let inner = block.inner(rect);
    let total = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(menu.items.len());
    for (i, it) in menu.items.iter().enumerate() {
        let style = if !it.enabled {
            Style::default().fg(theme.dim).bg(theme.menu_bg)
        } else if i == app.menu_item {
            theme.menu_selected()
        } else {
            theme.menu()
        };
        let mark = if it.checked { "✓ " } else { "  " };
        let left = format!("{mark}{}", it.label);
        let pad = total.saturating_sub(left.chars().count() + it.hint.chars().count());
        let text = format!("{left}{}{}", " ".repeat(pad), it.hint);
        lines.push(Line::from(Span::styled(text, style)));
    }
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

fn draw_theme_picker(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(sel) = app.theme_picker.as_ref().map(|p| p.sel) else {
        return;
    };
    let theme = app.theme;
    let items = theme::THEMES;
    let rect = centered_rect_abs(40, items.len() as u16 + 4, area);
    app.theme_picker_rect = rect;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" Theme ", theme.title(true))));
    let inner = block.inner(rect);
    let total = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, t) in items.iter().enumerate() {
        let style = if i == sel {
            theme.selected()
        } else {
            theme.text()
        };
        let mark = if i == sel { "▸ " } else { "  " };
        let label = format!("{mark}{}", t.name);
        let pad = total.saturating_sub(label.chars().count());
        lines.push(Line::from(Span::styled(
            format!("{label}{}", " ".repeat(pad)),
            style,
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ preview · Enter apply · Esc cancel",
        Style::default().fg(theme.dim),
    )));
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

fn draw_help(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let rect = centered_rect_abs(60, 16, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" Keybindings ", theme.title(true))));
    let key = Style::default()
        .fg(theme.accent)
        .add_modifier(Modifier::BOLD);
    let row = |k: &'static str, desc: &'static str| {
        Line::from(vec![
            Span::styled(format!("  {k:<10}"), key),
            Span::styled(desc.to_string(), theme.text()),
        ])
    };
    let lines = vec![
        row("Ctrl+S", "Save"),
        row("Ctrl+D", "Export disclosure"),
        row("Ctrl+K", "State / edit your claim"),
        row("Ctrl+M", "Mark paste under cursor as a quotation"),
        row("Ctrl+L", "Focus the coach panel"),
        row("Ctrl+E", "AI settings (endpoint, API key, model)"),
        row("Ctrl+T", "Theme picker (live preview)"),
        row("F10", "Open the menu bar"),
        row("F1", "This help"),
        row("Ctrl+Q", "Quit"),
        Line::raw(""),
        Line::from(Span::styled(
            "  Arrows / PgUp / PgDn move · mouse click & wheel supported",
            theme.dim(),
        )),
        Line::from(Span::styled("  Esc or any key to close", theme.dim())),
    ];
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

/// A centered rect of an absolute size, clamped to `area`.
fn centered_rect_abs(width: u16, height: u16, area: Rect) -> Rect {
    let w = width.min(area.width);
    let h = height.min(area.height);
    Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    }
}

fn draw_claim_gate(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let pop = centered_rect(76, 10, area);
    let title = if app.claim.is_some() {
        " Edit your claim "
    } else {
        " State your claim "
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(title, theme.title(true))));
    let inner = block.inner(pop);
    let lines = vec![
        Line::from(Span::styled(
            "State what you intend to argue in this piece.",
            theme.text(),
        )),
        Line::from(Span::styled(
            "Recorded locally only — it is never sent to any model.",
            theme.dim(),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("▶ ", theme.accent()),
            Span::styled(app.claim_input.clone(), theme.text()),
        ]),
        Line::raw(""),
        Line::from(Span::styled(
            "Enter to save · Esc to cancel · Ctrl+K reopens this later",
            theme.dim(),
        )),
    ];
    frame.render_widget(Clear, pop);
    frame.render_widget(Paragraph::new(lines).block(block), pop);
    let cx = inner.x + 2 + app.claim_input.chars().count() as u16;
    frame.set_cursor_position((cx.min(inner.right().saturating_sub(1)), inner.y + 3));
}

fn draw_teachback(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let pop = centered_rect(76, 10, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Teach-back checkpoint ",
            theme.title(true),
        )));
    let inner = block.inner(pop);
    let lines = vec![
        Line::from(Span::styled(
            "In a sentence or two, what is your argument so far?",
            theme.text(),
        )),
        Line::from(Span::styled(
            "If you can't summarize it, that's signal — recorded locally only.",
            theme.dim(),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("▶ ", theme.accent()),
            Span::styled(app.teachback_input.clone(), theme.text()),
        ]),
        Line::raw(""),
        Line::from(Span::styled("Enter to record · Esc to skip", theme.dim())),
    ];
    frame.render_widget(Clear, pop);
    frame.render_widget(Paragraph::new(lines).block(block), pop);
    let cx = inner.x + 2 + app.teachback_input.chars().count() as u16;
    frame.set_cursor_position((cx.min(inner.right().saturating_sub(1)), inner.y + 3));
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let popup = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area)[1];
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup)[1]
}

fn draw_editor(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.focus == Focus::Editor;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(focused))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            format!(" EDIT — {} ", app.file_label()),
            theme.title(focused),
        )));
    let inner = block.inner(area);
    app.editor_height = inner.height as usize;
    app.editor_inner = inner;

    // Render only the visible window, with grammar diagnostics underlined.
    let total = app.buffer.line_count();
    let first = app.editor_scroll.min(total);
    let last_exclusive = (first + app.editor_height).min(total);
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(app.editor_height);
    for i in first..last_exclusive {
        let start = app.buffer.line_char_start(i);
        let text = app.buffer.line_text(i);
        lines.push(styled_line(
            &text,
            start,
            &app.diagnostics,
            app.quarantine.regions(),
            theme,
        ));
    }
    let para = Paragraph::new(lines).block(block).style(theme.text());
    frame.render_widget(para, area);

    // Position the terminal cursor only when the editor is focused and no
    // overlay is up.
    if focused && !app.has_overlay() {
        let (line, col) = app.buffer.cursor_line_col();
        let disp = app.buffer.display_width(line, col);
        let max_col = inner.width.saturating_sub(1) as usize;
        let cx = inner.x + disp.min(max_col) as u16;
        let cy = inner.y + line.saturating_sub(app.editor_scroll) as u16;
        frame.set_cursor_position((cx, cy));
    }

    render_scrollbar(
        frame,
        area,
        total,
        app.editor_scroll,
        app.editor_height,
        theme,
    );
}

fn draw_preview(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(false))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" PREVIEW ", theme.title(false))));
    let inner = block.inner(area);
    app.preview_height = inner.height as usize;
    app.preview_inner = inner;

    // Re-render the markdown only when the document, width, or theme changed —
    // not on every frame (the loop draws ~10×/s even while idle).
    let width = inner.width;
    let stale = match &app.preview_cache {
        Some((v, w, name, _, _)) => *v != app.edit_version || *w != width || *name != theme.name,
        None => true,
    };
    if stale {
        let text = render_to_text(&app.buffer.text(), theme);
        let content = wrapped_height(&text, width as usize);
        app.preview_cache = Some((app.edit_version, width, theme.name, text, content));
    }
    let (text, content) = {
        let (_, _, _, t, c) = app.preview_cache.as_ref().unwrap();
        (t.clone(), *c)
    };
    let max = content.saturating_sub(app.preview_height);
    if app.preview_scroll > max {
        app.preview_scroll = max;
    }
    let para = Paragraph::new(text)
        .block(block)
        .style(theme.text())
        .wrap(Wrap { trim: false })
        .scroll((app.preview_scroll as u16, 0));
    frame.render_widget(para, area);
    render_scrollbar(
        frame,
        area,
        content,
        app.preview_scroll,
        app.preview_height,
        theme,
    );
}

fn draw_coach(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.focus == Focus::Coach;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(focused))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" COACH ", theme.title(focused))));
    app.coach_inner = block.inner(area);

    let mut lines: Vec<Line<'static>> = Vec::new();
    if app.client.is_none() {
        lines.push(Line::from(Span::styled(
            "Coach disabled. Open Coach ▸ AI settings (Ctrl+E) to set an endpoint, API\nkey, and model — e.g. an Ollama or LM Studio server. WHETSTONE_* env vars work too.",
            theme.dim(),
        )));
    } else {
        for t in &app.coach_turns {
            let (label, color) = match t.role {
                ChatTurnRole::Writer => ("you", theme.coach_you),
                ChatTurnRole::Coach => ("coach", theme.coach_reply),
            };
            for (i, l) in t.text.split('\n').enumerate() {
                let prefix = if i == 0 {
                    format!("{label}: ")
                } else {
                    "    ".into()
                };
                lines.push(Line::from(vec![
                    Span::styled(
                        prefix,
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(l.to_string(), theme.text()),
                ]));
            }
        }
        if app.coach_busy {
            // The reply is shown only AFTER it passes the guard (see
            // drain_coach_events). Streaming text is never rendered, so an
            // unscreened rewrite can't flash on screen mid-stream.
            lines.push(Line::from(vec![
                Span::styled(
                    "coach: ",
                    Style::default()
                        .fg(theme.coach_reply)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("thinking…", theme.dim().add_modifier(Modifier::ITALIC)),
            ]));
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "Ask about your draft. Press Ctrl+L (or click the input below) to focus.",
                theme.dim(),
            )));
        }
    }

    let text = Text::from(lines);
    let content = wrapped_height(&text, app.coach_inner.width as usize);
    let max = content.saturating_sub(app.coach_inner.height as usize);
    if app.coach_scroll > max {
        app.coach_scroll = max;
    }
    let para = Paragraph::new(text)
        .block(block)
        .style(theme.text())
        .wrap(Wrap { trim: false })
        .scroll((app.coach_scroll as u16, 0));
    frame.render_widget(para, area);
    render_scrollbar(
        frame,
        area,
        content,
        app.coach_scroll,
        app.coach_inner.height as usize,
        theme,
    );
}

fn draw_coach_input(frame: &mut Frame, app: &mut App, area: Rect) {
    app.coach_input_rect = area;
    let theme = app.theme;
    let enabled = app.client.is_some();
    let focused = enabled && app.focus == Focus::Coach;
    let (prefix, pstyle) = match (enabled, focused) {
        (false, _) => (
            " coach: disabled ",
            Style::default().fg(theme.dim).bg(theme.bg),
        ),
        (true, true) => (
            "> ",
            Style::default()
                .fg(theme.accent)
                .bg(theme.bg)
                .add_modifier(Modifier::BOLD),
        ),
        (true, false) => (
            " coach (Ctrl+L) ",
            Style::default().fg(theme.dim).bg(theme.bg),
        ),
    };
    let content = if enabled {
        app.coach_input.clone()
    } else {
        String::new()
    };
    let content_chars = content.chars().count();
    let line = Line::from(vec![
        Span::styled(prefix, pstyle),
        Span::styled(content, theme.text()),
    ]);
    let para = Paragraph::new(line).style(theme.panel_bg());
    frame.render_widget(para, area);

    if focused && !app.has_overlay() {
        let cx = area.x + prefix.chars().count() as u16 + content_chars as u16;
        let cx = cx.min(area.right().saturating_sub(1));
        frame.set_cursor_position((cx, area.y));
    }
}

fn draw_status(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let (line, col) = app.buffer.cursor_line_col();
    let dirty = if app.dirty { "*" } else { " " };
    let gram = if app.diagnostics.is_empty() {
        "✓".to_string()
    } else {
        format!("⚠{}", app.diagnostics.len())
    };
    let mirror = {
        // Recompute the mirror only when a new event was journaled.
        if app.mirror_cache.as_ref().map(|(seq, _)| *seq) != Some(app.event_seq) {
            let snap = compute_mirror(&app.journal);
            app.mirror_cache = Some((app.event_seq, snap));
        }
        let c = &app.mirror_cache.as_ref().unwrap().1.composition;
        if c.paste_count == 0 {
            String::new()
        } else {
            format!(
                "│ {}%t · {} mark",
                (c.typed_ratio * 100.0).round() as u32,
                c.pastes_unclaimed
            )
        }
    };
    let status = format!(
        " {}{dirty} │ {}:{} │ {gram} {mirror} │ {} ",
        app.file_label(),
        line + 1,
        col + 1,
        app.message,
    );
    frame.render_widget(Paragraph::new(status).style(theme.status()), area);
}

/// Build a styled [`Line`] for one source line, underlining any diagnostics
/// that overlap it. `start` is the line's char offset in the document.
fn styled_line(
    text: &str,
    start: usize,
    diags: &[Diagnostic],
    regions: &[Region],
    theme: &Theme,
) -> Line<'static> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut sev: Vec<Option<Severity>> = vec![None; n];
    for d in diags {
        let s = d.start.saturating_sub(start);
        let e = d.end.saturating_sub(start).min(n);
        if s >= n || e <= s {
            continue;
        }
        for m in &mut sev[s..e] {
            if severity_rank(*m) <= severity_rank(Some(d.severity)) {
                *m = Some(d.severity);
            }
        }
    }
    let mut quar: Vec<bool> = vec![false; n];
    for r in regions {
        let lo = r.from.saturating_sub(start).min(n);
        let hi = r.to.saturating_sub(start).min(n);
        if hi <= lo {
            continue;
        }
        for q in &mut quar[lo..hi] {
            *q = true;
        }
    }
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut i = 0;
    while i < n {
        let (s, q) = (sev[i], quar[i]);
        let mut j = i;
        while j < n && (sev[j], quar[j]) == (s, q) {
            j += 1;
        }
        let seg: String = chars[i..j].iter().collect();
        spans.push(Span::styled(
            seg,
            if q {
                theme.quarantine()
            } else {
                severity_style(s, theme)
            },
        ));
        i = j;
    }
    if spans.is_empty() {
        Line::raw("")
    } else {
        Line::from(spans)
    }
}

fn severity_style(sev: Option<Severity>, theme: &Theme) -> Style {
    match sev {
        Some(Severity::Error) => Style::default()
            .fg(theme.error)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Warning) => Style::default()
            .fg(theme.warning)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Style) => Style::default()
            .fg(theme.hint)
            .add_modifier(Modifier::UNDERLINED),
        None => Style::default().fg(theme.fg),
    }
}

fn severity_rank(s: Option<Severity>) -> u8 {
    match s {
        None => 0,
        Some(Severity::Style) => 1,
        Some(Severity::Warning) => 2,
        Some(Severity::Error) => 3,
    }
}

/// Render a thin vertical scrollbar on `area` when content exceeds the
/// viewport, so the user can see there is more to scroll.
fn render_scrollbar(
    frame: &mut Frame,
    area: Rect,
    content: usize,
    position: usize,
    viewport: usize,
    theme: &Theme,
) {
    if content <= viewport {
        return;
    }
    let mut state = ScrollbarState::new(content)
        .position(position.min(content))
        .viewport_content_length(viewport);
    let bar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .begin_symbol(None)
        .end_symbol(None)
        .thumb_style(Style::default().fg(theme.border_focus).bg(theme.bg))
        .track_style(Style::default().fg(theme.border).bg(theme.bg));
    frame.render_stateful_widget(bar, area, &mut state);
}

/// Estimate how many terminal rows `text` occupies when wrapped to `width`.
/// Used to clamp preview scrolling. (`Line::width` is unicode display width.)
fn wrapped_height(text: &Text<'_>, width: usize) -> usize {
    if width == 0 {
        return text.lines.len();
    }
    text.lines
        .iter()
        .map(|l| {
            let w = l.width();
            w.div_ceil(width).max(1)
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn test_app(rt: &tokio::runtime::Runtime) -> App {
        App::new(
            "# Title\n\nHello world.".to_string(),
            std::path::PathBuf::from("test.qmd"),
            None,
            rt.handle().clone(),
        )
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
    }

    /// Render into an off-screen buffer and flatten it to a string of symbols.
    fn render(app: &mut App) -> String {
        let mut term = Terminal::new(TestBackend::new(100, 30)).unwrap();
        term.draw(|f| draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        buf.content().iter().map(|c| c.symbol()).collect()
    }

    #[test]
    fn renders_menu_bar_and_panes() {
        let rt = rt();
        let mut app = test_app(&rt);
        let s = render(&mut app);
        for needle in ["File", "Edit", "View", "Coach", "Help", "EDIT", "PREVIEW"] {
            assert!(s.contains(needle), "missing {needle:?} in render");
        }
    }

    #[test]
    fn f10_opens_menu_and_shows_dropdown() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.handle_key(KeyEvent::new(KeyCode::F(10), KeyModifiers::NONE));
        assert_eq!(app.menu_open, Some(0));
        let s = render(&mut app);
        assert!(s.contains("Save"), "dropdown should list Save");
        assert!(s.contains("Quit"), "dropdown should list Quit");
        // Esc closes it again.
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.menu_open, None);
    }

    #[test]
    fn theme_picker_previews_and_applies() {
        let rt = rt();
        let mut app = test_app(&rt);
        let first = app.theme.name;
        app.open_theme_picker();
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_ne!(
            app.theme.name, first,
            "Down should live-preview a new theme"
        );
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.theme_picker.is_none());
        let _ = render(&mut app); // re-renders cleanly under the new theme
    }

    #[test]
    fn theme_picker_esc_restores_original() {
        let rt = rt();
        let mut app = test_app(&rt);
        let first = app.theme.name;
        app.open_theme_picker();
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.theme.name, first, "Esc must restore the original theme");
    }

    #[test]
    fn coach_settings_dialog_opens_edits_and_cancels() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.dispatch(MenuAction::CoachSettings);
        assert!(app.coach_settings.is_some());
        let s = render(&mut app);
        for needle in ["Endpoint", "API key", "Model"] {
            assert!(s.contains(needle), "settings dialog missing {needle:?}");
        }
        // Type into the focused (endpoint) field.
        for ch in "http://x".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
        }
        assert_eq!(app.coach_settings.as_ref().unwrap().base_url, "http://x");
        // Tab advances the focused field.
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.coach_settings.as_ref().unwrap().field, 1);
        // Esc cancels without enabling the coach (no disk write).
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.coach_settings.is_none());
        assert!(app.client.is_none());
    }

    #[test]
    fn menu_sets_friction_level_live() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.dispatch(MenuAction::SetFriction(3));
        assert_eq!(app.friction.level(), 3);
    }
}
