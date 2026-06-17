//! The application state, key/paste/mouse handling, and the layout: a top menu
//! bar, a three-pane body (editor | preview+coach), a coach input line, and a
//! status bar. The UI is fully themed (see [`crate::ui::theme`]) and mouse-
//! driven (menus, theme picker, pane focus, scrolling), Fresh-style: familiar
//! shortcuts, no modes beyond the transient menu/overlay.
//!
//! The coach speaks OpenAI-compatible Chat Completions over any base URL; every
//! streamed reply is forced through [`crate::core::guard::screen_chat_reply`]
//! before it is shown.

use std::path::{Path, PathBuf};
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

use crate::coach::{CoachClient, CoachConfig, DEFAULT_MODEL, JudgeSettings, Provider, is_env_ref};
use crate::core::coaching::{ObservationKind, StructuredCoaching};
use crate::core::disclosure::{Composition, render_disclosure};
use crate::core::guard::{screen_chat_reply, screen_coaching_output, screen_injection};
use crate::core::mirror::{MirrorSnapshot, format_mirror_summary};
use crate::core::process_event::{
    FrictionPolicy, Instrument, Location, MetaValue, ProcessEvent, ProcessEventType,
};
use crate::core::prompts::{ChatTurn, ChatTurnRole, build_chat_messages, build_coach_messages};
use crate::editor::buffer::Buffer;
use crate::editor::quarantine::{Outcome, Quarantine, Region};
use crate::editor::transaction::{Change, ChangeSet};
use crate::grammar::{Diagnostic, FixAction, GrammarDialect, GrammarSettings, Linter, Severity};
use crate::instruments;
use crate::markdown::render::render_to_text;
use crate::ui::menu::{self, Menu, MenuAction};
use crate::ui::settings::Settings;
use crate::ui::theme::{self, Theme};

/// Which pane receives keyboard input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Editor,
    Coach,
    /// The Harper suggestions list (the other tab of the bottom-right pane).
    Suggestions,
}

/// Which tab the bottom-right pane shows: the coach, or Harper's suggestions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RightTab {
    Coach,
    Suggestions,
}

/// A finished coach request, tagged with the generation it belongs to so a
/// cancelled or superseded request's late result is ignored.
pub struct CoachEvent {
    generation: u64,
    result: Result<String, String>,
    /// The LLM judge's decision on a chat reply, when the judge is enabled and
    /// the reply passed the in-task deterministic pre-check. `None` = judge off
    /// or not applicable (structured coaching, or a deterministically-doomed
    /// reply); `Some(Err)` = judge could not be consulted (fail-open).
    judge: Option<Result<crate::coach::Verdict, String>>,
}

/// What the in-flight coach request is. `Structured` carries the selection it
/// was run on (kept so the reply is screened against the send-time text).
enum CoachMode {
    Chat,
    Structured(String),
}

/// An undo checkpoint. The journal is intentionally NOT part of this — it is an
/// append-only audit record, so undo restores the text/marks but never erases
/// what happened.
struct Snapshot {
    text: String,
    cursor: usize,
    regions: Vec<Region>,
}

/// Sends a failure result on drop unless disarmed — guarantees the UI is
/// unblocked even if the coach future panics/unwinds before it sends its own.
struct DoneGuard {
    tx: mpsc::Sender<CoachEvent>,
    generation: u64,
    armed: bool,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.tx.send(CoachEvent {
                generation: self.generation,
                result: Err("coach task aborted".to_string()),
                judge: None,
            });
        }
    }
}

/// Which undo group a contiguous run of edits belongs to (for coalescing).
#[derive(PartialEq, Eq)]
enum GroupKind {
    Insert,
    Delete,
}

struct UndoGroup {
    kind: GroupKind,
    /// Cursor position after the last edit of the group; the next edit
    /// coalesces only if it continues from here.
    caret: usize,
}

/// Max undo depth.
const UNDO_CAP: usize = 200;

/// Live-preview state for the theme picker popup. `original` is restored on
/// cancel (Esc); moving the selection applies the theme immediately.
struct ThemePicker {
    sel: usize,
    original: &'static Theme,
}

/// Grammar settings overlay: pick the dialect and toggle individual lint rules.
/// Row 0 is the dialect selector; rows 1.. are the lint rules.
struct GrammarSettingsUi {
    dialect: GrammarDialect,
    /// All lint rules as `(key, description)`, sorted by key.
    rules: Vec<(String, String)>,
    /// Keys of the rules currently turned off.
    disabled: std::collections::HashSet<String>,
    sel: usize,
    rect: Rect,
    rows_rect: Rect,
    row_start: usize,
}

// Field indices for the AI/coach settings dialog (the focus order).
const F_PROVIDER: usize = 0;
const F_BASE_URL: usize = 1;
const F_API_KEY: usize = 2;
const F_MODEL: usize = 3;
const F_JUDGE_ENABLED: usize = 4;
const F_JUDGE_PROVIDER: usize = 5;
const F_JUDGE_BASE_URL: usize = 6;
const F_JUDGE_API_KEY: usize = 7;
const F_JUDGE_MODEL: usize = 8;
const COACH_FIELD_COUNT: usize = 9;

/// Edit buffers for the AI/coach settings dialog. `field` selects the focused
/// input (see the `F_*` constants). Provider fields cycle Auto/OpenAI/Anthropic
/// (Left/Right/Space); the judge toggle and the rest are text inputs.
struct CoachSettings {
    /// Coach provider; `None` = auto-detect from the endpoint URL.
    provider: Option<Provider>,
    base_url: String,
    api_key: String,
    model: String,
    judge_enabled: bool,
    /// Judge provider; `None` = auto-detect / inherit the coach provider.
    judge_provider: Option<Provider>,
    judge_base_url: String,
    judge_api_key: String,
    judge_model: String,
    field: usize,
    /// True while a connection test is in flight.
    testing: bool,
    /// One-line result of the last connection test, shown in the dialog.
    status: Option<String>,
    /// Model ids returned by the last successful test (Ctrl+N/Ctrl+P / click
    /// to choose; populates the Model field).
    models: Vec<String>,
}

impl CoachSettings {
    /// Mutable handle to the text behind a text field, or `None` for the
    /// provider/toggle fields (which aren't free-text).
    fn text_mut(&mut self, field: usize) -> Option<&mut String> {
        match field {
            F_BASE_URL => Some(&mut self.base_url),
            F_API_KEY => Some(&mut self.api_key),
            F_MODEL => Some(&mut self.model),
            F_JUDGE_BASE_URL => Some(&mut self.judge_base_url),
            F_JUDGE_API_KEY => Some(&mut self.judge_api_key),
            F_JUDGE_MODEL => Some(&mut self.judge_model),
            _ => None,
        }
    }

    /// Cycle a provider field through Auto → OpenAI → Anthropic.
    fn adjust(&mut self, field: usize, dir: isize) {
        match field {
            F_PROVIDER => self.provider = cycle_provider(self.provider, dir),
            F_JUDGE_PROVIDER => self.judge_provider = cycle_provider(self.judge_provider, dir),
            F_JUDGE_ENABLED => self.judge_enabled = !self.judge_enabled,
            _ => {}
        }
    }
}

/// Step an optional provider through the cycle Auto → OpenAI → Anthropic.
fn cycle_provider(p: Option<Provider>, dir: isize) -> Option<Provider> {
    let order = [None, Some(Provider::OpenAi), Some(Provider::Anthropic)];
    let idx = order.iter().position(|x| *x == p).unwrap_or(0) as isize;
    order[(idx + dir).rem_euclid(order.len() as isize) as usize]
}

/// Step a grammar dialect through `GrammarDialect::ALL`.
fn cycle_dialect(d: GrammarDialect, dir: isize) -> GrammarDialect {
    let all = GrammarDialect::ALL;
    let idx = all.iter().position(|x| *x == d).unwrap_or(0) as isize;
    all[(idx + dir).rem_euclid(all.len() as isize) as usize]
}

/// Display label for a provider field value.
fn provider_label(p: Option<Provider>) -> &'static str {
    match p {
        None => "Auto-detect",
        Some(pr) => pr.label(),
    }
}

/// Result of a settings-dialog connection test, tagged with a generation so a
/// stale result (the endpoint was edited and retested) is ignored.
struct ConnTestEvent {
    generation: u64,
    result: Result<Vec<String>, String>,
}

/// Result of a background `quarto render`.
struct CompileEvent {
    ok: bool,
    /// Combined, trimmed stdout+stderr (or a spawn error).
    output: String,
}

/// Which single-/two-field input prompt is open.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PromptKind {
    Find,
    Replace,
    GotoLine,
    OpenFile,
    SaveAs,
}

impl PromptKind {
    fn title(self) -> &'static str {
        match self {
            PromptKind::Find => " Find ",
            PromptKind::Replace => " Replace ",
            PromptKind::GotoLine => " Go to line ",
            PromptKind::OpenFile => " Open file ",
            PromptKind::SaveAs => " Save as ",
        }
    }
    /// Field labels (1 or 2).
    fn labels(self) -> &'static [&'static str] {
        match self {
            PromptKind::Find => &["Find"],
            PromptKind::Replace => &["Find", "Replace"],
            PromptKind::GotoLine => &["Line"],
            PromptKind::OpenFile => &["Path"],
            PromptKind::SaveAs => &["Path"],
        }
    }
    fn hint(self) -> &'static str {
        match self {
            PromptKind::Find => "Enter next · Esc close",
            PromptKind::Replace => "Tab field · Enter replace all · Esc cancel",
            PromptKind::GotoLine => "Enter go · Esc cancel",
            PromptKind::OpenFile | PromptKind::SaveAs => "Enter confirm · Esc cancel",
        }
    }
}

/// A small input prompt overlay with one or two text fields.
struct Prompt {
    kind: PromptKind,
    fields: Vec<String>,
    active: usize,
}

/// The running editor application.
pub struct App {
    pub buffer: Buffer,
    pub path: PathBuf,
    pub dirty: bool,
    pub quit: bool,
    pub message: String,
    editor_scroll: usize,
    /// Horizontal scroll, in terminal display columns (long lines).
    editor_hscroll: usize,
    editor_height: usize,
    editor_inner: Rect,
    /// Undo/redo checkpoints (text + cursor + quarantine regions).
    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    /// The current coalescing group, so a typing burst is one undo step.
    undo_group: Option<UndoGroup>,
    /// Plain text awaiting an OSC 52 clipboard write by the run loop.
    clipboard_request: Option<String>,
    /// Last left-click `(time, col, row)` and the running click count, for
    /// double/triple-click word/line selection.
    last_click: Option<(Instant, u16, u16)>,
    click_count: u8,
    preview_scroll: usize,
    preview_height: usize,
    preview_inner: Rect,
    linter: Linter,
    diagnostics: Vec<Diagnostic>,
    lint_dirty: bool,
    last_edit: Option<Instant>,
    /// Current grammar settings (dialect + disabled rules); the linter is
    /// rebuilt from these when the grammar settings overlay changes them.
    grammar: GrammarSettings,
    /// The grammar settings overlay, when open.
    grammar_settings: Option<GrammarSettingsUi>,
    /// Which tab the bottom-right pane shows (coach vs Harper suggestions).
    right_tab: RightTab,
    /// Selected diagnostic in the suggestions list.
    suggest_sel: usize,
    /// First visible diagnostic row (the list scrolls when long).
    suggest_start: usize,
    /// Rect of the suggestions list body (for clicks).
    suggest_rect: Rect,
    /// Rect of the bottom-right pane's tab header (clicking it switches tabs).
    right_tab_rect: Rect,
    /// Column where the Coach tab label ends (the click boundary in the header).
    right_tab_split: u16,

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
    /// Next paragraph count at which proactive push-cadence coaching fires.
    next_push: usize,
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
    coach_busy: bool,
    /// When the in-flight request started (for the elapsed indicator).
    coach_started: Option<Instant>,
    /// Whether the in-flight request was a proactive push (for backoff).
    coach_is_push: bool,
    /// Consecutive push-coaching failures; pauses push after a couple.
    push_failures: u8,
    /// What the in-flight request is (chat vs structured-on-selection).
    coach_mode: CoachMode,
    /// Monotonic id; a reply is accepted only if it still matches (cancel/supersede).
    coach_generation: u64,
    /// Size (chars) of the in-flight consult's message+context, for journaling.
    coach_pending_size: u32,
    /// The context the in-flight reply must be screened against (send-time text).
    coach_pending_context: String,
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
    /// Rect of the discovered-model list inside the settings dialog (for clicks)
    /// and the index of its first visible row (the list scrolls when long).
    coach_models_rect: Rect,
    coach_models_start: usize,
    /// Absolute terminal row of each editable settings field (indexed by `F_*`),
    /// recorded during draw so clicks and the caret can locate them.
    coach_field_rows: [u16; COACH_FIELD_COUNT],
    /// Connection-test result channel + the latest in-flight generation.
    conn_tx: mpsc::Sender<ConnTestEvent>,
    conn_rx: mpsc::Receiver<ConnTestEvent>,
    conn_generation: u64,
    /// Whether the keybindings/help popup is showing, and its scroll offset.
    help_open: bool,
    help_scroll: usize,
    /// Whether the process/journal view is showing, and its scroll.
    journal_open: bool,
    journal_scroll: usize,
    journal_rect: Rect,
    /// Whether the unsaved-changes quit confirmation is showing.
    confirm_quit: bool,
    /// Active input prompt (find/replace/goto/open/save-as) + its rect.
    prompt: Option<Prompt>,
    prompt_rect: Rect,
    /// Cursor offset where the current find session started (for incremental).
    search_origin: usize,
    /// Whether the disclosure-preview overlay is showing, + its text and scroll.
    disclosure_open: bool,
    disclosure_text: String,
    disclosure_scroll: usize,

    /// Quarto render: a background subprocess reports back over this channel.
    compile_tx: mpsc::Sender<CompileEvent>,
    compile_rx: mpsc::Receiver<CompileEvent>,
    /// True while a `quarto render` is in flight.
    compiling: bool,
    /// Captured output of the last render, shown in a scrollable overlay when
    /// `compile_open` is set (auto-opened on failure).
    compile_open: bool,
    compile_output: String,
    compile_scroll: usize,
    compile_rect: Rect,

    /// Document outline overlay: the headings, the highlighted row, and its rect.
    outline_open: bool,
    outline_items: Vec<crate::markdown::Heading>,
    outline_sel: usize,
    outline_rect: Rect,
    /// Index of the first outline row drawn (the list scrolls when long), so the
    /// click handler maps a row to the same heading the renderer drew there.
    outline_start: usize,
    /// File mtime recorded at load/save, to detect external changes.
    file_mtime: Option<std::time::SystemTime>,

    /// Cached preview render: `(edit_version, width, theme_name, text, height)`.
    preview_cache: Option<(u64, u16, &'static str, Text<'static>, usize)>,
    /// Running process-mirror tallies, updated per journaled event (so the
    /// status bar never rescans the whole journal — O(1) amortized).
    m_typed: u32,
    m_pasted: u32,
    m_paste_count: u32,
    m_resolved: std::collections::BTreeMap<String, bool>,
    m_consults: u32,
    m_refused: u32,
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
        // Gate the editor only for brand-new (empty) documents. For existing
        // docs, read any claim/intent from the YAML frontmatter instead.
        let claim = crate::markdown::render::frontmatter_claim(&text);
        let gated = text.trim().is_empty();
        let pc0 = instruments::paragraph_count(&text);

        // Saved UI preferences (theme + friction + grammar); env vars override.
        let saved = Settings::load();

        // Grammar (Harper): saved settings, with WHETSTONE_DIALECT overriding
        // the dialect at startup. The linter is rebuilt when settings change.
        let mut grammar = saved.grammar.clone();
        if let Ok(d) = std::env::var("WHETSTONE_DIALECT")
            && let Some(d) = GrammarDialect::parse(&d)
        {
            grammar.dialect = d;
        }
        let mut linter = Linter::with_settings(&grammar);
        let diagnostics = linter.lint(&text);

        // Friction dial (ADR-008): institutional floor 0, writer preset from
        // WHETSTONE_FRICTION, else the saved preference, else 1 (Coach).
        let preset = std::env::var("WHETSTONE_FRICTION")
            .ok()
            .and_then(|s| s.trim().parse::<u8>().ok())
            .or(saved.friction)
            .unwrap_or(1);
        // Per-instrument overrides: start from the saved file, then let
        // `WHETSTONE_FRICTION_<INSTRUMENT>` env vars override at startup.
        let mut overrides = saved.friction_overrides;
        for inst in Instrument::ALL {
            if let Some(level) = env_instrument_override(inst) {
                overrides.set(inst, level);
            }
        }
        let friction = FrictionPolicy::new(0, preset).with_overrides(overrides);
        let mut quarantine = Quarantine::new();
        quarantine.set_thresholds(
            friction.paste_threshold(),
            friction.claim_survival_threshold(),
        );
        let next_teachback = match friction.teachback_interval() {
            Some(iv) => ((pc0 / iv) + 1) * iv,
            None => usize::MAX,
        };
        let next_push = match friction.push_interval() {
            Some(iv) => ((pc0 / iv) + 1) * iv,
            None => usize::MAX,
        };

        let file_mtime = file_mtime_of(&path);

        // Theme: WHETSTONE_THEME, else the saved preference, else the default.
        let theme = std::env::var("WHETSTONE_THEME")
            .ok()
            .and_then(|n| theme::by_name(&n))
            .or_else(|| saved.theme.as_deref().and_then(theme::by_name))
            .unwrap_or(&theme::THEMES[0]);

        let client = coach_config.map(CoachClient::new);
        // Restore any prior coaching conversation for this document (empty for a
        // new buffer or a file that's never been coached).
        let coach_turns = crate::coach::history::load(&path);
        // The channel is always live so the coach can be enabled at runtime via
        // the AI settings dialog; `client.is_some()` is the single enabled flag.
        let (coach_tx, coach_rx) = mpsc::channel();
        let (conn_tx, conn_rx) = mpsc::channel();
        let (compile_tx, compile_rx) = mpsc::channel();

        Self {
            buffer,
            path,
            dirty: false,
            quit: false,
            message,
            editor_scroll: 0,
            editor_hscroll: 0,
            editor_height: 0,
            editor_inner: Rect::default(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            undo_group: None,
            clipboard_request: None,
            last_click: None,
            click_count: 0,
            preview_scroll: 0,
            preview_height: 0,
            preview_inner: Rect::default(),
            linter,
            diagnostics,
            lint_dirty: false,
            last_edit: None,
            grammar,
            grammar_settings: None,
            right_tab: RightTab::Coach,
            suggest_sel: 0,
            suggest_start: 0,
            suggest_rect: Rect::default(),
            right_tab_rect: Rect::default(),
            right_tab_split: 0,
            tokio,
            client,
            coach_tx,
            coach_rx,
            coach_turns,
            coach_input: String::new(),
            coach_busy: false,
            coach_started: None,
            coach_is_push: false,
            push_failures: 0,
            coach_mode: CoachMode::Chat,
            coach_generation: 0,
            coach_pending_size: 0,
            coach_pending_context: String::new(),
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
            next_push,
            friction,
            edit_version: 0,
            theme,
            menu_open: None,
            menu_item: 0,
            menu_bar_rect: Rect::default(),
            menu_titles: Vec::new(),
            menu_dropdown_rect: Rect::default(),
            theme_picker: None,
            theme_picker_rect: Rect::default(),
            coach_settings: None,
            coach_settings_rect: Rect::default(),
            coach_models_rect: Rect::default(),
            coach_models_start: 0,
            coach_field_rows: [0; COACH_FIELD_COUNT],
            conn_tx,
            conn_rx,
            conn_generation: 0,
            help_open: false,
            help_scroll: 0,
            journal_open: false,
            journal_scroll: 0,
            journal_rect: Rect::default(),
            confirm_quit: false,
            prompt: None,
            prompt_rect: Rect::default(),
            search_origin: 0,
            disclosure_open: false,
            disclosure_text: String::new(),
            disclosure_scroll: 0,
            compile_tx,
            compile_rx,
            compiling: false,
            compile_open: false,
            compile_output: String::new(),
            compile_scroll: 0,
            compile_rect: Rect::default(),
            outline_open: false,
            outline_items: Vec::new(),
            outline_sel: 0,
            outline_rect: Rect::default(),
            outline_start: 0,
            file_mtime,
            preview_cache: None,
            m_typed: 0,
            m_pasted: 0,
            m_paste_count: 0,
            m_resolved: std::collections::BTreeMap::new(),
            m_consults: 0,
            m_refused: 0,
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
        // Update the running mirror tallies incrementally so the status bar
        // never rescans the whole journal.
        let region_id = || match m.get("regionId") {
            Some(MetaValue::Str(s)) => Some(s.clone()),
            _ => None,
        };
        match kind {
            ProcessEventType::TypingBurst => self.m_typed += size.unwrap_or(0),
            ProcessEventType::PasteDetected => self.m_pasted += size.unwrap_or(0),
            ProcessEventType::PasteQuarantined => self.m_paste_count += 1,
            ProcessEventType::PasteClaimed => {
                if let Some(rid) = region_id() {
                    self.m_resolved.insert(rid, true);
                }
            }
            ProcessEventType::PasteAttributed => {
                if let Some(rid) = region_id() {
                    self.m_resolved.insert(rid, false);
                }
            }
            ProcessEventType::CoachConsult => {
                if matches!(m.get("refused"), Some(MetaValue::Bool(true))) {
                    self.m_refused += 1;
                } else {
                    self.m_consults += 1;
                }
            }
            _ => {}
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

    /// Build the current process-mirror snapshot from the running tallies.
    fn mirror_snapshot(&self) -> MirrorSnapshot {
        let claimed = self.m_resolved.values().filter(|c| **c).count() as u32;
        let attributed = self.m_resolved.values().filter(|c| !**c).count() as u32;
        let total = self.m_typed + self.m_pasted;
        MirrorSnapshot {
            composition: Composition {
                typed_chars: self.m_typed,
                pasted_chars: self.m_pasted,
                pastes_claimed: claimed,
                pastes_attributed: attributed,
                pastes_unclaimed: self
                    .m_paste_count
                    .saturating_sub(claimed)
                    .saturating_sub(attributed),
                paste_count: self.m_paste_count,
                typed_ratio: if total == 0 {
                    1.0
                } else {
                    self.m_typed as f64 / total as f64
                },
            },
            coach_consults: self.m_consults,
            coach_refused: self.m_refused,
        }
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
        self.edit_version += 1;
        self.dirty = true;
        self.lint_dirty = true;
        self.last_edit = Some(Instant::now());
        self.reveal_cursor();
    }

    // --- undo / redo -------------------------------------------------------

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.buffer.text(),
            cursor: self.buffer.cursor(),
            regions: self.quarantine.regions().to_vec(),
        }
    }

    /// Record a pre-edit snapshot for undo (call only when an edit happened).
    fn record_undo(&mut self, pre: Snapshot) {
        self.undo_stack.push(pre);
        if self.undo_stack.len() > UNDO_CAP {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
    }

    fn restore(&mut self, s: Snapshot) {
        self.buffer = Buffer::new(&s.text);
        self.buffer.set_cursor(s.cursor);
        self.quarantine.restore_regions(s.regions);
        self.undo_group = None;
        self.edit_version += 1;
        self.dirty = true;
        self.lint_dirty = true;
        self.last_edit = Some(Instant::now());
        self.reveal_cursor();
    }

    fn undo(&mut self) {
        if let Some(prev) = self.undo_stack.pop() {
            let cur = self.snapshot();
            self.redo_stack.push(cur);
            self.restore(prev);
            self.message = "Undo".into();
        } else {
            self.message = "Nothing to undo".into();
        }
    }

    fn redo(&mut self) {
        if let Some(next) = self.redo_stack.pop() {
            let cur = self.snapshot();
            self.undo_stack.push(cur);
            self.restore(next);
            self.message = "Redo".into();
        } else {
            self.message = "Nothing to redo".into();
        }
    }

    // --- clipboard (OSC 52) ------------------------------------------------

    fn copy_selection(&mut self) {
        match self.buffer.selected_text() {
            Some(t) => {
                let n = t.chars().count();
                self.clipboard_request = Some(t);
                self.message = format!("Copied {n} chars");
            }
            None => self.message = "Nothing selected".into(),
        }
    }

    fn cut_selection(&mut self) {
        let Some(text) = self.buffer.selected_text() else {
            self.message = "Nothing selected".into();
            return;
        };
        let pre = self.snapshot();
        if let Some(change) = self.buffer.delete_selection() {
            self.record_undo(pre);
            self.undo_group = None;
            let n = text.chars().count();
            self.clipboard_request = Some(text);
            self.commit_edit(ChangeSet::single(change));
            self.message = format!("Cut {n} chars");
        }
    }

    /// Take any pending OSC 52 clipboard payload (consumed by the run loop).
    pub fn take_clipboard_request(&mut self) -> Option<String> {
        self.clipboard_request.take()
    }

    /// Journal a `coach_consult` event — metadata only: provider/model, the
    /// message+context size, and whether the guard or provider refused.
    fn log_coach_consult(&mut self, refused: bool) {
        self.log_coach_consult_with(refused, Vec::new());
    }

    /// As [`Self::log_coach_consult`], plus extra metadata (e.g. the judge model
    /// and its verdict). Metadata only — never document prose.
    fn log_coach_consult_with(&mut self, refused: bool, mut extra: Vec<(&'static str, MetaValue)>) {
        let mut meta = vec![("refused", MetaValue::Bool(refused))];
        if let Some(client) = self.client.as_ref() {
            // Record the provider label and the RAW model string (which keeps
            // any `env:NAME` reference intact) — never the env-resolved values,
            // so a secret embedded via an env ref can't leak into the journal.
            let provider = client.coach_endpoint().provider;
            meta.push(("provider", MetaValue::Str(provider.label().to_string())));
            meta.push(("model", MetaValue::Str(client.config().model.clone())));
        }
        meta.append(&mut extra);
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
        if let Some(p) = self.prompt.as_mut() {
            // Paste into the active prompt field (first line only).
            let line = text.lines().next().unwrap_or("");
            p.fields[p.active].push_str(line);
            if matches!(p.kind, PromptKind::Find | PromptKind::Replace) && p.active == 0 {
                self.search_update();
            }
            return;
        }
        if let Some(s) = self.coach_settings.as_mut() {
            let field = s.field;
            if let Some(t) = s.text_mut(field) {
                // First line only — endpoints/keys/models are single-line.
                t.push_str(text.lines().next().unwrap_or(""));
            }
            return;
        }
        match self.focus {
            Focus::Editor => {
                if self.gated {
                    self.claim_input.push_str(text);
                    return;
                }
                let pre = self.snapshot();
                let n = text.chars().count();
                let at = self
                    .buffer
                    .selection()
                    .map(|(s, _)| s)
                    .unwrap_or_else(|| self.buffer.cursor());
                let change = self.insert_or_replace(text);
                self.record_undo(pre);
                self.undo_group = None;
                // Remap existing regions against the edit FIRST, then record the
                // new paste with its post-edit offsets.
                self.commit_edit(ChangeSet::single(change));
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
            // The suggestions list takes no text input.
            Focus::Suggestions => {}
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        // Overlays consume input first (most transient on top).
        if self.confirm_quit {
            self.handle_confirm_quit_key(key);
            return;
        }
        if self.help_open {
            // Arrows/PageUp/Down scroll the cheat-sheet; anything else dismisses.
            if !scroll_key(&mut self.help_scroll, key.code) {
                self.help_open = false;
            }
            return;
        }
        if self.disclosure_open {
            match key.code {
                KeyCode::Up => self.disclosure_scroll = self.disclosure_scroll.saturating_sub(1),
                KeyCode::Down => self.disclosure_scroll = self.disclosure_scroll.saturating_add(1),
                _ => self.disclosure_open = false,
            }
            return;
        }
        if self.compile_open {
            if !scroll_key(&mut self.compile_scroll, key.code) {
                self.compile_open = false;
            }
            return;
        }
        if self.outline_open {
            self.handle_outline_key(key);
            return;
        }
        if self.prompt.is_some() {
            self.handle_prompt_key(key);
            return;
        }
        if self.journal_open {
            self.handle_journal_key(key);
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
        if self.grammar_settings.is_some() {
            self.handle_grammar_settings_key(key);
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
            self.open_help();
            return;
        }
        // Global control keys (editor-scoped ones require editor focus).
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            let editing = self.focus == Focus::Editor;
            let shift = key.modifiers.contains(KeyModifiers::SHIFT);
            match key.code {
                KeyCode::Char('k') => self.dispatch(MenuAction::EditClaim),
                KeyCode::Char('d') => self.export_disclosure(),
                KeyCode::Char('m') if editing => self.attribute_region(),
                KeyCode::Char('j') if editing => self.coach_selection(),
                KeyCode::Char('s') => self.save(),
                KeyCode::Char('o') => self.open_prompt(PromptKind::OpenFile),
                KeyCode::Char('f') if editing => self.open_prompt(PromptKind::Find),
                KeyCode::Char('h') if editing => self.open_prompt(PromptKind::Replace),
                KeyCode::Char('g') if editing => self.open_prompt(PromptKind::GotoLine),
                KeyCode::Char('t') => self.open_theme_picker(),
                KeyCode::Char('e') => self.open_coach_settings(),
                KeyCode::Char('p') => self.toggle_journal(),
                KeyCode::Char('b') if editing => self.open_outline(),
                KeyCode::Char('r') => self.do_compile(),
                KeyCode::Char('z') if editing && shift => self.redo(),
                KeyCode::Char('z') if editing => self.undo(),
                KeyCode::Char('y') if editing => self.redo(),
                KeyCode::Char('a') if editing => self.buffer.select_all(),
                KeyCode::Char('c') if editing => self.copy_selection(),
                KeyCode::Char('x') if editing => self.cut_selection(),
                KeyCode::Left if editing => self.editor_word_move(false, shift),
                KeyCode::Right if editing => self.editor_word_move(true, shift),
                KeyCode::Backspace if editing => self.editor_delete_word(false),
                KeyCode::Delete if editing => self.editor_delete_word(true),
                KeyCode::Char('q') => self.request_quit(),
                KeyCode::Char('l') => self.dispatch(MenuAction::ToggleCoach),
                _ => {}
            }
            return;
        }

        match self.focus {
            Focus::Editor => self.handle_editor_key(key),
            Focus::Coach => self.handle_coach_key(key),
            Focus::Suggestions => self.handle_suggestions_key(key),
        }
    }

    /// Quit, guarding unsaved changes behind a confirmation dialog.
    fn request_quit(&mut self) {
        if self.dirty {
            self.confirm_quit = true;
        } else {
            self.quit = true;
        }
    }

    fn handle_confirm_quit_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => self.quit = true,
            KeyCode::Char('s') | KeyCode::Char('S') => {
                self.save();
                if self.dirty {
                    self.confirm_quit = false; // save failed — stay and show the error
                } else {
                    self.quit = true;
                }
            }
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {
                self.confirm_quit = false;
                self.message = "Quit cancelled.".into();
            }
            _ => {}
        }
    }

    fn toggle_journal(&mut self) {
        self.journal_open = !self.journal_open;
        self.journal_scroll = 0;
    }

    fn open_help(&mut self) {
        self.help_open = true;
        self.help_scroll = 0;
    }

    fn handle_journal_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.journal_open = false,
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.journal_open = false;
            }
            KeyCode::Up => self.journal_scroll = self.journal_scroll.saturating_sub(1),
            KeyCode::Down => self.journal_scroll = self.journal_scroll.saturating_add(1),
            _ => {}
        }
    }

    /// Whether any modal/overlay is up (suppresses the editor caret, etc.).
    fn has_overlay(&self) -> bool {
        self.gated
            || self.teachback_pending
            || self.menu_open.is_some()
            || self.theme_picker.is_some()
            || self.coach_settings.is_some()
            || self.grammar_settings.is_some()
            || self.help_open
            || self.journal_open
            || self.confirm_quit
            || self.prompt.is_some()
            || self.disclosure_open
            || self.compile_open
            || self.outline_open
    }

    // --- menus -------------------------------------------------------------

    /// The menu model for the current state (coach availability, friction
    /// level, active theme name drive enabled/checked flags + labels).
    fn menus(&self) -> Vec<Menu> {
        menu::menus(self.client.is_some(), &self.friction, self.theme.name)
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

    /// Whether a coach request is in flight (harness/screenshots only) — lets a
    /// headless driver poll until a real reply lands.
    #[cfg(any(test, feature = "harness"))]
    pub fn coach_busy_for_test(&self) -> bool {
        self.coach_busy
    }

    /// Whether the teach-back checkpoint overlay is currently showing
    /// (harness/screenshots only).
    #[cfg(any(test, feature = "harness"))]
    pub fn teachback_pending_for_test(&self) -> bool {
        self.teachback_pending
    }

    /// Run a menu/shortcut command from the headless harness/screenshots.
    #[cfg(any(test, feature = "harness"))]
    pub fn dispatch_for_test(&mut self, action: MenuAction) {
        self.dispatch(action);
    }

    /// Run a menu/shortcut command.
    fn dispatch(&mut self, action: MenuAction) {
        match action {
            MenuAction::EditClaim => {
                self.claim_input = self.claim.clone().unwrap_or_default();
                self.gated = true;
            }
            MenuAction::Save => self.save(),
            MenuAction::SaveAs => self.open_prompt(PromptKind::SaveAs),
            MenuAction::Open => self.open_prompt(PromptKind::OpenFile),
            MenuAction::Export => self.export_disclosure(),
            MenuAction::PreviewDisclosure => self.open_disclosure_preview(),
            MenuAction::Compile => self.do_compile(),
            MenuAction::Outline => self.open_outline(),
            MenuAction::Quit => self.request_quit(),
            MenuAction::AttributeRegion => self.attribute_region(),
            MenuAction::Find => self.open_prompt(PromptKind::Find),
            MenuAction::Replace => self.open_prompt(PromptKind::Replace),
            MenuAction::GotoLine => self.open_prompt(PromptKind::GotoLine),
            MenuAction::ThemePicker => self.open_theme_picker(),
            MenuAction::GrammarSettings => self.open_grammar_settings(),
            MenuAction::CycleInstrument(inst) => self.cycle_instrument_friction(inst),
            MenuAction::SetFriction(n) => self.set_friction(n),
            MenuAction::ToggleCoach => {
                // Ctrl+L moves between the editor and the bottom-right pane,
                // landing on whichever tab (Coach / Suggestions) is showing.
                self.focus = match self.focus {
                    Focus::Editor => self.right_pane_focus(),
                    _ => Focus::Editor,
                };
                self.coach_input.clear();
            }
            MenuAction::ShowSuggestions => self.show_right_tab(RightTab::Suggestions),
            MenuAction::CoachSelection => self.coach_selection(),
            MenuAction::ResetCoach => self.reset_coach(),
            MenuAction::CoachSettings => self.open_coach_settings(),
            MenuAction::Journal => self.toggle_journal(),
            MenuAction::Help => self.open_help(),
        }
    }

    /// Clear the coach conversation and cancel any in-flight request.
    fn reset_coach(&mut self) {
        self.coach_turns.clear();
        self.coach_generation += 1; // supersede any in-flight reply
        self.coach_busy = false;
        self.persist_coach_history(); // empty conversation → remove the file
        self.message = "Coach conversation reset.".into();
    }

    /// Mirror the current coach conversation to disk for this document so it
    /// survives across sessions. Best-effort: a failed history write is
    /// surfaced but never blocks editing or coaching.
    fn persist_coach_history(&mut self) {
        if let Err(e) = crate::coach::history::save(&self.path, &self.coach_turns) {
            self.message = format!("Coach history not saved: {e}");
        }
    }

    /// Re-set the friction level (ADR-008) live and re-tune the instruments.
    fn set_friction(&mut self, level: u8) {
        self.friction =
            FrictionPolicy::new(self.friction.floor, level).with_overrides(self.friction.overrides);
        let msg = format!(
            "Friction: {} (level {level})",
            menu::friction_level_name(level)
        );
        self.apply_friction_change(msg);
    }

    /// Cycle one instrument's per-instrument override (ADR-008): off → Quiet →
    /// Coach → Engaged → Deep Work → off. "off" clears the override so the
    /// instrument follows the global preset again.
    fn cycle_instrument_friction(&mut self, inst: Instrument) {
        let next = match self.friction.overrides.get(inst) {
            None => Some(0),
            Some(l) if l >= 3 => None,
            Some(l) => Some(l + 1),
        };
        let mut overrides = self.friction.overrides;
        overrides.set(inst, next);
        self.friction = self.friction.with_overrides(overrides);
        let msg = menu::instrument_label(inst, &self.friction);
        self.apply_friction_change(msg);
    }

    /// Apply a friction-policy change that's already been written to
    /// `self.friction`: re-tune the live instruments, surface `msg`, and persist.
    /// Shared by [`set_friction`] and [`cycle_instrument_friction`].
    fn apply_friction_change(&mut self, msg: String) {
        self.retune_instruments();
        self.message = msg;
        self.persist_settings();
    }

    /// Re-tune the live instruments to the current friction policy (quarantine
    /// thresholds + teach-back/push cadence counters). Called whenever the
    /// policy changes (preset or a per-instrument override).
    fn retune_instruments(&mut self) {
        self.quarantine.set_thresholds(
            self.friction.paste_threshold(),
            self.friction.claim_survival_threshold(),
        );
        self.next_teachback = match self.friction.teachback_interval() {
            Some(iv) => ((self.last_para_count / iv) + 1) * iv,
            None => usize::MAX,
        };
        self.next_push = match self.friction.push_interval() {
            Some(iv) => ((self.last_para_count / iv) + 1) * iv,
            None => usize::MAX,
        };
    }

    /// Persist the current theme + friction preference (best-effort).
    fn persist_settings(&mut self) {
        let s = Settings {
            theme: Some(self.theme.name.to_string()),
            friction: Some(self.friction.preset),
            friction_overrides: self.friction.overrides,
            grammar: self.grammar.clone(),
        };
        if let Err(e) = s.save() {
            self.message = format!("(preferences not saved: {e})");
        }
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
                self.persist_settings();
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

    // --- grammar settings --------------------------------------------------

    fn open_grammar_settings(&mut self) {
        let rules = self.linter.available_rules();
        self.grammar_settings = Some(GrammarSettingsUi {
            dialect: self.grammar.dialect,
            rules,
            disabled: self.grammar.disabled_rules.iter().cloned().collect(),
            sel: 0,
            rect: Rect::default(),
            rows_rect: Rect::default(),
            row_start: 0,
        });
    }

    fn handle_grammar_settings_key(&mut self, key: KeyEvent) {
        let Some(g) = self.grammar_settings.as_mut() else {
            return;
        };
        let count = g.rules.len() + 1; // +1 for the dialect row
        match key.code {
            KeyCode::Esc => {
                self.grammar_settings = None;
                self.message = "Grammar settings cancelled.".into();
            }
            KeyCode::Up => g.sel = (g.sel + count - 1) % count,
            KeyCode::Down => g.sel = (g.sel + 1) % count,
            KeyCode::Left if g.sel == 0 => g.dialect = cycle_dialect(g.dialect, -1),
            KeyCode::Right if g.sel == 0 => g.dialect = cycle_dialect(g.dialect, 1),
            KeyCode::Char(' ') if g.sel == 0 => g.dialect = cycle_dialect(g.dialect, 1),
            KeyCode::Char(' ') => {
                // Toggle the selected rule on/off.
                let rule = g.rules[g.sel - 1].0.clone();
                if !g.disabled.remove(&rule) {
                    g.disabled.insert(rule);
                }
            }
            KeyCode::Enter => self.commit_grammar_settings(),
            _ => {}
        }
    }

    /// Apply the overlay's choices: rebuild the linter, re-lint, persist.
    fn commit_grammar_settings(&mut self) {
        let Some(g) = self.grammar_settings.take() else {
            return;
        };
        let mut disabled: Vec<String> = g.disabled.into_iter().collect();
        disabled.sort();
        self.grammar = GrammarSettings {
            dialect: g.dialect,
            disabled_rules: disabled,
        };
        self.linter = Linter::with_settings(&self.grammar);
        self.diagnostics = self.linter.lint(&self.buffer.text());
        self.lint_dirty = false;
        self.persist_settings();
        self.message = format!(
            "Grammar: {} · {} rule(s) off",
            self.grammar.dialect.label(),
            self.grammar.disabled_rules.len()
        );
    }

    // --- AI / coach settings ----------------------------------------------

    fn open_coach_settings(&mut self) {
        let cfg = self.client.as_ref().map(|c| c.config().clone());
        let (provider, base_url, api_key, model, judge) = match cfg {
            Some(c) => (c.provider, c.base_url, c.api_key, c.model, c.judge),
            None => (
                None,
                String::new(),
                String::new(),
                DEFAULT_MODEL.to_string(),
                JudgeSettings::default(),
            ),
        };
        self.coach_settings = Some(CoachSettings {
            provider,
            base_url,
            api_key,
            model,
            judge_enabled: judge.enabled,
            judge_provider: judge.provider,
            judge_base_url: judge.base_url,
            judge_api_key: judge.api_key,
            judge_model: judge.model,
            field: 0,
            testing: false,
            status: None,
            models: Vec::new(),
        });
    }

    fn handle_coach_settings_key(&mut self, key: KeyEvent) {
        // Actions needing &mut self (or modifiers) come first, before the buffer
        // borrow below.
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
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
            KeyCode::Char('t') if ctrl => {
                self.test_connection();
                return;
            }
            KeyCode::Char('n') if ctrl => {
                self.cycle_model(1);
                return;
            }
            KeyCode::Char('p') if ctrl => {
                self.cycle_model(-1);
                return;
            }
            _ => {}
        }
        let Some(s) = self.coach_settings.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Tab | KeyCode::Down => s.field = (s.field + 1) % COACH_FIELD_COUNT,
            KeyCode::BackTab | KeyCode::Up => {
                s.field = (s.field + COACH_FIELD_COUNT - 1) % COACH_FIELD_COUNT
            }
            // Left/Right (and Space) cycle the provider / toggle the judge.
            KeyCode::Left => s.adjust(s.field, -1),
            KeyCode::Right => s.adjust(s.field, 1),
            KeyCode::Char(' ')
                if matches!(s.field, F_PROVIDER | F_JUDGE_PROVIDER | F_JUDGE_ENABLED) =>
            {
                s.adjust(s.field, 1)
            }
            KeyCode::Backspace => {
                let field = s.field;
                if let Some(t) = s.text_mut(field) {
                    t.pop();
                }
            }
            // Reject Ctrl-modified chars so e.g. Ctrl+T isn't also typed as 't'.
            KeyCode::Char(c) if !c.is_control() && !ctrl => {
                let field = s.field;
                if let Some(t) = s.text_mut(field) {
                    t.push(c);
                }
            }
            _ => {}
        }
    }

    /// Probe the endpoint currently typed in the dialog (not the saved client)
    /// for reachability and its model list. Result arrives via `conn_rx` and is
    /// folded in by [`Self::drain_conn_test_events`].
    fn test_connection(&mut self) {
        let Some(s) = self.coach_settings.as_mut() else {
            return;
        };
        let base_url = s.base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            s.status = Some("Enter an endpoint first.".into());
            return;
        }
        if s.testing {
            return;
        }
        let cfg = CoachConfig {
            provider: s.provider,
            base_url,
            api_key: s.api_key.clone(),
            model: s.model.clone(),
            judge: JudgeSettings::default(),
        };
        s.testing = true;
        s.status = Some("Testing connection…".into());
        self.conn_generation += 1;
        let generation = self.conn_generation;
        let tx = self.conn_tx.clone();
        let client = CoachClient::new(cfg);
        self.tokio.spawn(async move {
            let result = client.list_models().await.map_err(|e| e.to_string());
            let _ = tx.send(ConnTestEvent { generation, result });
        });
    }

    /// Step the Model field through the discovered model list (Ctrl+N/Ctrl+P).
    fn cycle_model(&mut self, dir: isize) {
        let Some(s) = self.coach_settings.as_mut() else {
            return;
        };
        if s.models.is_empty() {
            s.status = Some("Test the connection first (Ctrl+T) to list models.".into());
            return;
        }
        let n = s.models.len() as isize;
        let next = match s.models.iter().position(|m| m == &s.model) {
            Some(i) => (i as isize + dir).rem_euclid(n) as usize,
            None if dir >= 0 => 0,
            None => (n - 1) as usize,
        };
        s.model = s.models[next].clone();
        s.field = F_MODEL;
    }

    /// Fold finished connection tests into the open dialog, ignoring stale
    /// results (superseded generation) and results that arrive after the dialog
    /// closed.
    pub fn drain_conn_test_events(&mut self) {
        while let Ok(ev) = self.conn_rx.try_recv() {
            if ev.generation != self.conn_generation {
                continue;
            }
            let Some(s) = self.coach_settings.as_mut() else {
                continue;
            };
            s.testing = false;
            match ev.result {
                Ok(models) => {
                    s.status = Some(match models.len() {
                        0 => "✓ Reachable — server listed no models.".to_string(),
                        1 => "✓ Reachable — 1 model. Ctrl+N/Ctrl+P or click to choose.".to_string(),
                        n => format!("✓ Reachable — {n} models. Ctrl+N/Ctrl+P or click to choose."),
                    });
                    // If the typed model isn't on offer, default to the first.
                    if !models.is_empty() && !models.iter().any(|m| m == &s.model) {
                        s.model = models[0].clone();
                    }
                    s.models = models;
                }
                Err(e) => {
                    s.status = Some(format!("✗ {}", truncate_status(&e)));
                    s.models.clear();
                }
            }
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
            provider: s.provider,
            base_url: base_url.clone(),
            api_key: s.api_key,
            model,
            judge: JudgeSettings {
                enabled: s.judge_enabled,
                model: s.judge_model.trim().to_string(),
                provider: s.judge_provider,
                base_url: s.judge_base_url.trim().trim_end_matches('/').to_string(),
                api_key: s.judge_api_key,
            },
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
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        // Cursor movement: Shift extends a selection; anything else clears it.
        let is_move = matches!(
            key.code,
            KeyCode::Left
                | KeyCode::Right
                | KeyCode::Up
                | KeyCode::Down
                | KeyCode::Home
                | KeyCode::End
                | KeyCode::PageUp
                | KeyCode::PageDown
        );
        if is_move {
            if shift {
                self.buffer.begin_selection();
            } else {
                self.buffer.clear_selection();
            }
            let h = self.editor_height.max(1);
            match key.code {
                KeyCode::Left => self.buffer.move_left(),
                KeyCode::Right => self.buffer.move_right(),
                KeyCode::Up => self.buffer.move_up(),
                KeyCode::Down => self.buffer.move_down(),
                KeyCode::Home => self.buffer.move_smart_home(),
                KeyCode::End => self.buffer.move_line_end(),
                KeyCode::PageUp => {
                    for _ in 0..h {
                        self.buffer.move_up();
                    }
                }
                KeyCode::PageDown => {
                    for _ in 0..h {
                        self.buffer.move_down();
                    }
                }
                _ => {}
            }
            self.undo_group = None; // moving the caret breaks the typing group
            self.reveal_cursor();
            return;
        }

        // Editing: an active selection is replaced/deleted as one change.
        let had_selection = self.buffer.selection().is_some();
        let caret_before = self.buffer.cursor();
        // A run of plain typing (or a run of deletes) coalesces into one undo
        // step; newlines, tabs, and selection-replacements start their own.
        let kind = match key.code {
            KeyCode::Backspace | KeyCode::Delete => GroupKind::Delete,
            _ => GroupKind::Insert,
        };
        let coalescible =
            !had_selection && !matches!(key.code, KeyCode::Enter | KeyCode::Tab | KeyCode::BackTab);
        let pre = self.snapshot();
        let change = match key.code {
            KeyCode::Char(c) if !c.is_control() => Some(self.insert_or_replace(&c.to_string())),
            KeyCode::Enter => {
                // Auto-indent: carry the current line's leading whitespace.
                let (line, _) = self.buffer.cursor_line_col();
                let indent = self.buffer.line_indent(line);
                Some(self.insert_or_replace(&format!("\n{indent}")))
            }
            KeyCode::Tab => Some(self.insert_or_replace("    ")),
            KeyCode::BackTab => self.dedent_current_line(),
            KeyCode::Backspace => {
                if had_selection {
                    self.buffer.delete_selection()
                } else {
                    self.buffer.delete_backward()
                }
            }
            KeyCode::Delete => {
                if had_selection {
                    self.buffer.delete_selection()
                } else {
                    self.buffer.delete_forward()
                }
            }
            _ => return,
        };
        let Some(change) = change else {
            return;
        };
        // Coalesce contiguous same-kind edits: only the first edit of a group
        // records an undo checkpoint, so undo reverts the whole burst at once.
        let continues = coalescible
            && matches!(&self.undo_group, Some(g) if g.kind == kind && g.caret == caret_before);
        if !continues {
            self.record_undo(pre);
        }
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
        self.undo_group = if coalescible {
            Some(UndoGroup {
                kind,
                caret: self.buffer.cursor(),
            })
        } else {
            None
        };
        let after = self.buffer.text();
        self.maybe_trigger_teachback(&after);
    }

    /// Insert `s`, replacing the active selection if there is one.
    fn insert_or_replace(&mut self, s: &str) -> Change {
        if self.buffer.selection().is_some() {
            self.buffer.replace_selection(s).expect("selection present")
        } else {
            self.buffer.type_str(s)
        }
    }

    /// Remove up to one indent (a tab, or up to 4 leading spaces) from the
    /// current line. Returns the change, or `None` if the line isn't indented.
    fn dedent_current_line(&mut self) -> Option<Change> {
        let (line, _) = self.buffer.cursor_line_col();
        let start = self.buffer.line_char_start(line);
        let indent = self.buffer.line_indent(line);
        let remove = if indent.starts_with('\t') {
            1
        } else {
            indent.chars().take(4).take_while(|c| *c == ' ').count()
        };
        (remove > 0).then(|| self.buffer.remove(start, start + remove))
    }

    /// Word-wise caret move (Ctrl+←/→), extending the selection with Shift.
    fn editor_word_move(&mut self, forward: bool, shift: bool) {
        if shift {
            self.buffer.begin_selection();
        } else {
            self.buffer.clear_selection();
        }
        if forward {
            self.buffer.move_word_right();
        } else {
            self.buffer.move_word_left();
        }
        self.undo_group = None;
        self.reveal_cursor();
    }

    /// Delete a word (Ctrl+Backspace / Ctrl+Delete), or the selection if any.
    fn editor_delete_word(&mut self, forward: bool) {
        let pre = self.snapshot();
        let change = if self.buffer.selection().is_some() {
            self.buffer.delete_selection()
        } else if forward {
            self.buffer.delete_word_right()
        } else {
            self.buffer.delete_word_left()
        };
        if let Some(change) = change {
            self.record_undo(pre);
            self.undo_group = None;
            self.commit_edit(ChangeSet::single(change));
        }
    }

    // --- input prompts: find / replace / goto / open / save-as ------------

    fn open_prompt(&mut self, kind: PromptKind) {
        let mut fields: Vec<String> = kind.labels().iter().map(|_| String::new()).collect();
        match kind {
            PromptKind::Find | PromptKind::Replace => {
                if let Some(sel) = self.buffer.selected_text()
                    && !sel.contains('\n')
                {
                    fields[0] = sel;
                }
                self.search_origin = self.buffer.cursor();
            }
            PromptKind::OpenFile | PromptKind::SaveAs => {
                fields[0] = self.path.display().to_string();
            }
            PromptKind::GotoLine => {}
        }
        let prefilled = !fields[0].is_empty();
        self.prompt = Some(Prompt {
            kind,
            fields,
            active: 0,
        });
        if matches!(kind, PromptKind::Find | PromptKind::Replace) && prefilled {
            self.search_update();
        }
    }

    fn handle_prompt_key(&mut self, key: KeyEvent) {
        let Some(kind) = self.prompt.as_ref().map(|p| p.kind) else {
            return;
        };
        let is_find = matches!(kind, PromptKind::Find | PromptKind::Replace);
        match key.code {
            KeyCode::Esc => self.prompt = None,
            KeyCode::Tab => {
                if let Some(p) = self.prompt.as_mut() {
                    let n = p.fields.len();
                    p.active = (p.active + 1) % n;
                }
            }
            KeyCode::Enter => self.confirm_prompt(),
            KeyCode::Backspace => {
                let mut research = false;
                if let Some(p) = self.prompt.as_mut() {
                    p.fields[p.active].pop();
                    research = is_find && p.active == 0;
                }
                if research {
                    self.search_update();
                }
            }
            KeyCode::Char(c) if !c.is_control() => {
                let mut research = false;
                if let Some(p) = self.prompt.as_mut() {
                    p.fields[p.active].push(c);
                    research = is_find && p.active == 0;
                }
                if research {
                    self.search_update();
                }
            }
            _ => {}
        }
    }

    fn confirm_prompt(&mut self) {
        let (kind, f0, f1) = match self.prompt.as_ref() {
            Some(p) => (
                p.kind,
                p.fields[0].clone(),
                p.fields.get(1).cloned().unwrap_or_default(),
            ),
            None => return,
        };
        match kind {
            PromptKind::Find => self.find_next(true), // keep the prompt open
            PromptKind::Replace => {
                self.replace_all(&f0, &f1);
                self.prompt = None;
            }
            PromptKind::GotoLine => {
                if let Ok(n) = f0.trim().parse::<usize>() {
                    self.buffer.clear_selection();
                    self.buffer.set_cursor_line_col(n.saturating_sub(1), 0);
                    self.reveal_cursor();
                }
                self.prompt = None;
            }
            PromptKind::OpenFile => {
                self.do_open(&f0);
                self.prompt = None;
            }
            PromptKind::SaveAs => {
                self.do_save_as(&f0);
                self.prompt = None;
            }
        }
    }

    /// All case-insensitive (ASCII) matches of `query`, as char ranges.
    fn search_all(&self, query: &str) -> Vec<(usize, usize)> {
        let needle: Vec<char> = query.chars().collect();
        if needle.is_empty() {
            return Vec::new();
        }
        let hay: Vec<char> = self.buffer.text().chars().collect();
        let mut out = Vec::new();
        if needle.len() > hay.len() {
            return out;
        }
        let eq = |a: char, b: char| a.eq_ignore_ascii_case(&b);
        let mut i = 0;
        while i + needle.len() <= hay.len() {
            if (0..needle.len()).all(|k| eq(hay[i + k], needle[k])) {
                out.push((i, i + needle.len()));
                i += needle.len();
            } else {
                i += 1;
            }
        }
        out
    }

    /// Incremental find: select the first match at/after the find origin.
    fn search_update(&mut self) {
        let Some(query) = self.prompt.as_ref().map(|p| p.fields[0].clone()) else {
            return;
        };
        if query.is_empty() {
            self.buffer.clear_selection();
            return;
        }
        let matches = self.search_all(&query);
        if let Some(&(s, e)) = matches
            .iter()
            .find(|(s, _)| *s >= self.search_origin)
            .or_else(|| matches.first())
        {
            self.buffer.set_selection(s, e);
            self.reveal_cursor();
        }
    }

    fn find_next(&mut self, forward: bool) {
        let Some(query) = self.prompt.as_ref().map(|p| p.fields[0].clone()) else {
            return;
        };
        if query.is_empty() {
            return;
        }
        let matches = self.search_all(&query);
        if matches.is_empty() {
            self.message = "No matches".into();
            return;
        }
        let cur = self.buffer.cursor();
        let idx = if forward {
            matches.iter().position(|(s, _)| *s > cur).unwrap_or(0)
        } else {
            matches
                .iter()
                .rposition(|(s, _)| *s < cur)
                .unwrap_or(matches.len() - 1)
        };
        let (s, e) = matches[idx];
        self.buffer.set_selection(s, e);
        self.reveal_cursor();
        self.message = format!("Match {}/{}", idx + 1, matches.len());
    }

    fn replace_all(&mut self, find: &str, repl: &str) {
        if find.is_empty() {
            return;
        }
        let matches = self.search_all(find);
        if matches.is_empty() {
            self.message = "No matches".into();
            return;
        }
        let pre = self.snapshot();
        let chars: Vec<char> = self.buffer.text().chars().collect();
        let mut out = String::new();
        let mut last = 0;
        let cs = ChangeSet {
            changes: matches
                .iter()
                .map(|&(s, e)| Change {
                    from: s,
                    to: e,
                    insert: repl.to_string(),
                })
                .collect(),
        };
        for &(s, e) in &matches {
            out.extend(chars[last..s].iter());
            out.push_str(repl);
            last = e;
        }
        out.extend(chars[last..].iter());
        let count = matches.len();
        self.buffer = Buffer::new(&out);
        self.record_undo(pre);
        self.undo_group = None;
        // Remap quarantine regions through the same change set.
        self.commit_edit(cs);
        self.message = format!("Replaced {count} occurrence(s)");
    }

    // --- open / save-as / disclosure preview ------------------------------

    fn do_open(&mut self, path: &str) {
        if self.dirty {
            self.message = "Unsaved changes — save first (Ctrl+S).".into();
            return;
        }
        let p = PathBuf::from(path);
        match std::fs::read_to_string(&p) {
            Ok(text) => {
                self.load_document(text, p);
                self.message = format!("Opened {}", self.path.display());
            }
            Err(e) => self.message = format!("Open failed: {e}"),
        }
    }

    /// Replace the open document (buffer + per-document state) and start a fresh
    /// journal session. Preferences (theme/friction) are kept.
    fn load_document(&mut self, text: String, path: PathBuf) {
        self.buffer = Buffer::new(&text);
        self.buffer.set_cursor(self.buffer.len_chars());
        self.path = path;
        self.file_mtime = file_mtime_of(&self.path);
        self.dirty = false;
        self.diagnostics = self.linter.lint(&text);
        self.quarantine = Quarantine::new();
        self.quarantine.set_thresholds(
            self.friction.paste_threshold(),
            self.friction.claim_survival_threshold(),
        );
        self.claim = crate::markdown::render::frontmatter_claim(&text);
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.undo_group = None;
        // Restore the newly-opened document's saved coaching thread (if any).
        self.coach_turns = crate::coach::history::load(&self.path);
        // Supersede any in-flight coach request so its reply can't land in the
        // newly-opened document, and clear the "thinking…" indicator.
        self.coach_generation += 1;
        self.coach_busy = false;
        self.coach_started = None;
        self.editor_scroll = 0;
        self.editor_hscroll = 0;
        // Fresh journal + tallies for the new document.
        self.journal.clear();
        self.event_seq = 0;
        self.m_typed = 0;
        self.m_pasted = 0;
        self.m_paste_count = 0;
        self.m_resolved.clear();
        self.m_consults = 0;
        self.m_refused = 0;
        let pc0 = instruments::paragraph_count(&text);
        self.last_para_count = pc0;
        self.next_teachback = match self.friction.teachback_interval() {
            Some(iv) => ((pc0 / iv) + 1) * iv,
            None => usize::MAX,
        };
        self.next_push = match self.friction.push_interval() {
            Some(iv) => ((pc0 / iv) + 1) * iv,
            None => usize::MAX,
        };
        self.gated = text.trim().is_empty();
        self.edit_version += 1;
        self.lint_dirty = false;
        self.start_session();
    }

    fn do_save_as(&mut self, path: &str) {
        self.path = PathBuf::from(path);
        // Re-baseline the mtime to the target so the external-change guard in
        // `save()` doesn't fire against an unrelated file's timestamp.
        self.file_mtime = file_mtime_of(&self.path);
        self.save();
    }

    fn open_disclosure_preview(&mut self) {
        match render_disclosure(&self.file_label(), &self.journal) {
            Ok(doc) => {
                self.disclosure_text = doc.markdown;
                self.disclosure_scroll = 0;
                self.disclosure_open = true;
            }
            Err(e) => self.message = format!("Disclosure blocked: {e}"),
        }
    }

    // --- Quarto render -----------------------------------------------------

    /// Save the document, then run `quarto render <file>` in the background.
    /// The result is folded in by [`Self::drain_compile_events`]; output is
    /// captured (the alt-screen is never handed to the child) and shown in a
    /// scrollable overlay on failure.
    fn do_compile(&mut self) {
        if self.path.as_os_str().is_empty() {
            self.message = "Save the document first (Ctrl+S) before rendering.".into();
            return;
        }
        if self.compiling {
            self.message = "Quarto is already rendering…".into();
            return;
        }
        // Quarto reads the file from disk, so flush any pending edits first.
        if self.dirty {
            self.save();
            if self.dirty {
                return; // save failed — `save()` already set the message
            }
        }
        let path = self.path.clone();
        let tx = self.compile_tx.clone();
        self.compiling = true;
        self.message = format!("Rendering {} with Quarto…", self.file_label());
        // A plain OS thread (no tokio process feature needed): run quarto to
        // completion, capture both streams, and report back over the channel.
        std::thread::spawn(move || {
            let ev = match std::process::Command::new("quarto")
                .arg("render")
                .arg(&path)
                .output()
            {
                Ok(out) => {
                    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
                    let err = String::from_utf8_lossy(&out.stderr);
                    if !err.trim().is_empty() {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&err);
                    }
                    CompileEvent {
                        ok: out.status.success(),
                        output: text.trim().to_string(),
                    }
                }
                Err(e) => CompileEvent {
                    ok: false,
                    output: format!(
                        "Could not run `quarto`: {e}\n\nIs Quarto installed and on your PATH? \
                         See https://quarto.org/docs/get-started/."
                    ),
                },
            };
            let _ = tx.send(ev);
        });
    }

    /// Fold a finished render into the UI: a one-line status on success, or a
    /// scrollable output overlay on failure.
    pub fn drain_compile_events(&mut self) {
        while let Ok(ev) = self.compile_rx.try_recv() {
            self.compiling = false;
            self.compile_output = ev.output;
            self.compile_scroll = 0;
            if ev.ok {
                self.compile_open = false;
                self.message = format!("Quarto rendered {}.", self.file_label());
            } else {
                self.compile_open = true; // surface the error
                self.message = "Quarto render failed — see the output.".into();
            }
        }
    }

    // --- document outline --------------------------------------------------

    /// Open the outline overlay, highlighting the heading the cursor is in.
    fn open_outline(&mut self) {
        self.outline_items = crate::markdown::outline(&self.buffer.text());
        if self.outline_items.is_empty() {
            self.message = "No headings to outline yet.".into();
            return;
        }
        let (cursor_line, _) = self.buffer.cursor_line_col();
        // Select the last heading at or before the cursor (else the first).
        self.outline_sel = self
            .outline_items
            .iter()
            .rposition(|h| h.line <= cursor_line)
            .unwrap_or(0);
        self.outline_open = true;
    }

    fn handle_outline_key(&mut self, key: KeyEvent) {
        let n = self.outline_items.len();
        if n == 0 {
            self.outline_open = false;
            return;
        }
        match key.code {
            KeyCode::Esc => self.outline_open = false,
            KeyCode::Up => self.outline_sel = (self.outline_sel + n - 1) % n,
            KeyCode::Down => self.outline_sel = (self.outline_sel + 1) % n,
            KeyCode::Home => self.outline_sel = 0,
            KeyCode::End => self.outline_sel = n - 1,
            KeyCode::Enter => self.jump_to_outline(self.outline_sel),
            _ => {}
        }
    }

    /// Jump the editor cursor to the start of the selected heading and close.
    fn jump_to_outline(&mut self, idx: usize) {
        if let Some(h) = self.outline_items.get(idx) {
            let (line, title) = (h.line, h.title.clone());
            self.buffer.clear_selection();
            self.buffer.set_cursor_line_col(line, 0);
            self.undo_group = None;
            self.reveal_cursor();
            self.message = format!("Jumped to “{title}”");
        }
        self.outline_open = false;
        self.focus = Focus::Editor;
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
        let pre = self.snapshot();
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
        self.record_undo(pre);
        self.undo_group = None;
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
            KeyCode::Esc => {
                if self.coach_busy {
                    self.cancel_coach();
                } else {
                    self.focus = Focus::Editor;
                }
            }
            KeyCode::Enter => self.ask_coach(),
            KeyCode::Backspace => {
                self.coach_input.pop();
            }
            KeyCode::Tab => self.show_right_tab(RightTab::Suggestions),
            KeyCode::Char(c) if !c.is_control() => self.coach_input.push(c),
            _ => {}
        }
    }

    // --- Harper suggestions pane ------------------------------------------

    /// The focus target for the bottom-right pane, given its active tab.
    fn right_pane_focus(&self) -> Focus {
        match self.right_tab {
            RightTab::Coach => Focus::Coach,
            RightTab::Suggestions => Focus::Suggestions,
        }
    }

    /// Switch the bottom-right pane to `tab` and focus it.
    fn show_right_tab(&mut self, tab: RightTab) {
        self.right_tab = tab;
        self.focus = self.right_pane_focus();
        if tab == RightTab::Suggestions {
            self.suggest_sel = self
                .suggest_sel
                .min(self.diagnostics.len().saturating_sub(1));
        }
    }

    fn handle_suggestions_key(&mut self, key: KeyEvent) {
        let n = self.diagnostics.len();
        match key.code {
            KeyCode::Esc => self.focus = Focus::Editor,
            KeyCode::Tab => self.show_right_tab(RightTab::Coach),
            KeyCode::Up if n > 0 => {
                self.suggest_sel = (self.suggest_sel + n - 1) % n;
                self.reveal_selected_diagnostic();
            }
            KeyCode::Down if n > 0 => {
                self.suggest_sel = (self.suggest_sel + 1) % n;
                self.reveal_selected_diagnostic();
            }
            // Enter / 1 apply the primary fix; 2-9 pick among multiple fixes.
            KeyCode::Enter => self.apply_suggestion(0),
            KeyCode::Char(c @ '1'..='9') => {
                self.apply_suggestion(c as usize - '1' as usize);
            }
            _ => {}
        }
    }

    /// Scroll the editor so the selected diagnostic's line is in view.
    fn reveal_selected_diagnostic(&mut self) {
        let Some(start) = self.diagnostics.get(self.suggest_sel).map(|d| d.start) else {
            return;
        };
        self.buffer.set_cursor(start);
        let (line, _) = self.buffer.cursor_line_col();
        let h = self.editor_height.max(1);
        if line < self.editor_scroll {
            self.editor_scroll = line;
        } else if line >= self.editor_scroll + h {
            self.editor_scroll = line + 1 - h;
        }
    }

    /// Apply fix `which` of the selected diagnostic as one undoable edit, then
    /// re-lint. Harper is local/deterministic, so this is a plain edit — never
    /// journaled as AI assistance.
    fn apply_suggestion(&mut self, which: usize) {
        // Diagnostic spans are char offsets into the buffer as it was last
        // linted; linting is debounced, so if the buffer changed since, the
        // spans are stale and would edit the wrong range. Re-lint first.
        if self.lint_dirty {
            self.diagnostics = self.linter.lint(&self.buffer.text());
            self.lint_dirty = false;
            if self.suggest_sel >= self.diagnostics.len() {
                self.suggest_sel = self.diagnostics.len().saturating_sub(1);
            }
        }
        let Some(d) = self.diagnostics.get(self.suggest_sel) else {
            return;
        };
        let Some(fix) = d.suggestions.get(which) else {
            if d.suggestions.is_empty() {
                self.message = "No automatic fix for this one.".into();
            }
            return;
        };
        let (start, end) = (d.start, d.end);
        let action = fix.action.clone();
        let pre = self.snapshot();
        let change = match action {
            FixAction::Replace(text) => {
                self.buffer.set_selection(start, end);
                self.buffer.replace_selection(&text)
            }
            FixAction::Remove => {
                self.buffer.set_selection(start, end);
                self.buffer.replace_selection("")
            }
            FixAction::InsertAfter(text) => {
                self.buffer.clear_selection();
                self.buffer.set_cursor(end);
                Some(self.buffer.type_str(&text))
            }
        };
        if let Some(change) = change {
            self.record_undo(pre);
            self.undo_group = None;
            self.commit_edit(ChangeSet::single(change));
            // Re-lint now so the list reflects the fix immediately.
            self.diagnostics = self.linter.lint(&self.buffer.text());
            self.lint_dirty = false;
            if self.suggest_sel >= self.diagnostics.len() {
                self.suggest_sel = self.diagnostics.len().saturating_sub(1);
            }
            self.message = "Applied suggestion.".into();
        }
    }

    /// Cancel an in-flight coach request: bump the generation so its late reply
    /// is ignored, and clear the busy state (the task itself just finishes
    /// into the void).
    fn cancel_coach(&mut self) {
        if self.coach_busy {
            self.coach_generation += 1;
            self.coach_busy = false;
            self.message = "Coach request cancelled.".into();
        }
    }

    /// Spawn a coach request, sending its result tagged with the current
    /// generation so a cancel/supersede can discard a stale reply. A `DoneGuard`
    /// reports an error result if the future unwinds, so the UI never gets stuck
    /// "thinking". `json_mode` asks for a JSON response (structured coaching).
    /// Spawn the coach request. `judge_against` is `Some(draft_excerpt)` only
    /// for the free-text chat path when an LLM judge is configured; the judge
    /// then screens the reply in-task (after a deterministic pre-check, so a
    /// doomed reply never burns a judge call).
    fn spawn_coach(
        &mut self,
        messages: Vec<crate::core::prompts::ChatMessage>,
        json_mode: bool,
        judge_against: Option<String>,
    ) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.coach_generation += 1;
        let generation = self.coach_generation;
        let tx = self.coach_tx.clone();
        self.coach_busy = true;
        self.coach_started = Some(Instant::now());
        self.message = "Asking coach…".into();
        let coach_endpoint = client.coach_endpoint();
        let judge_endpoint = judge_against.as_ref().and_then(|_| client.judge_endpoint());
        self.tokio.spawn(async move {
            let mut guard = DoneGuard {
                tx: tx.clone(),
                generation,
                armed: true,
            };
            let result = client
                .chat(&coach_endpoint, &messages, json_mode, |_| {})
                .await
                .map_err(|e| e.to_string());
            // Run the LLM judge only on a successful chat reply that already
            // clears the (pure, local) deterministic guard — deterministic-first.
            let mut judge = None;
            if let (Ok(reply), Some(jep), Some(draft)) =
                (&result, judge_endpoint.as_ref(), judge_against.as_ref())
                && screen_chat_reply(reply, draft).is_ok()
            {
                judge =
                    Some(crate::coach::screen_with_judge(&client, jep, reply, Some(draft)).await);
            }
            guard.armed = false;
            let _ = tx.send(CoachEvent {
                generation,
                result,
                judge,
            });
        });
    }

    /// Send the current coach input as a chat turn. The reply is guarded on
    /// completion (see `drain_coach_events`).
    fn ask_coach(&mut self) {
        if self.client.is_none() {
            self.message = "Coach not configured — set it in Coach ▸ AI settings (Ctrl+E)".into();
            return;
        }
        if self.coach_busy {
            self.message = "Coach is already thinking… (Esc to cancel)".into();
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
            self.persist_coach_history();
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
        // Screen the reply against the text as it is NOW (send-time), not a
        // possibly-edited buffer at completion.
        self.coach_pending_context = context;
        self.coach_mode = CoachMode::Chat;
        self.coach_is_push = false;
        self.persist_coach_history(); // save the writer turn before the reply lands
        // The judge (if enabled) screens the free-text reply against the draft.
        let judge_against = self
            .client
            .as_ref()
            .and_then(|c| c.judge_endpoint())
            .map(|_| self.coach_pending_context.clone());
        self.spawn_coach(messages, false, judge_against);
    }

    /// Run structured coaching on the current selection (anchored observations,
    /// no prose) — exercises the structured guard.
    fn coach_selection(&mut self) {
        let Some(selection) = self.buffer.selected_text() else {
            self.message = "Select a passage first, then Ctrl+J to coach it.".into();
            return;
        };
        if self.client.is_none() {
            self.message = "Coach not configured — set it in Coach ▸ AI settings (Ctrl+E)".into();
            return;
        }
        if self.coach_busy {
            self.message = "Coach is already thinking… (Esc to cancel)".into();
            return;
        }
        if let Err(reason) = screen_injection(&selection) {
            self.message = format!("Selection blocked by injection screen: {reason}");
            return;
        }
        self.coach_pending_size = selection.chars().count() as u32;
        self.coach_turns.push(ChatTurn {
            role: ChatTurnRole::Writer,
            text: format!("[coach this selection · {} chars]", self.coach_pending_size),
        });
        let messages = build_coach_messages(&selection, self.claim.as_deref());
        self.coach_mode = CoachMode::Structured(selection);
        self.coach_is_push = false;
        self.focus = Focus::Coach;
        self.persist_coach_history();
        // Structured coaching is bound by the schema + deterministic guard
        // (ghostwriting is structurally impossible), so the LLM judge — which
        // screens free-text replies — does not apply here.
        self.spawn_coach(messages, true, None);
    }

    /// Pump finished coach requests into the app state, screening every reply
    /// before it is shown.
    pub fn drain_coach_events(&mut self) {
        // Drain into a local buffer first so we can call the &mut self
        // journaling/guard helpers below without holding the receiver borrow.
        let mut events = Vec::new();
        while let Ok(ev) = self.coach_rx.try_recv() {
            events.push(ev);
        }
        for ev in events {
            // Ignore replies from a cancelled or superseded request.
            if ev.generation != self.coach_generation {
                continue;
            }
            self.coach_busy = false;
            self.coach_started = None;
            match ev.result {
                Ok(reply) => self.accept_coach_reply(reply, ev.judge),
                Err(e) => {
                    self.log_coach_consult(true);
                    self.message = format!("Coach error: {e}");
                }
            }
        }
    }

    /// Screen and render a completed coach reply per the request mode.
    fn accept_coach_reply(
        &mut self,
        reply: String,
        judge: Option<Result<crate::coach::Verdict, String>>,
    ) {
        match std::mem::replace(&mut self.coach_mode, CoachMode::Chat) {
            CoachMode::Chat => {
                let ctx = std::mem::take(&mut self.coach_pending_context);
                match screen_chat_reply(&reply, &ctx) {
                    Ok(()) => self.accept_judged_chat_reply(reply, judge),
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
            CoachMode::Structured(selection) => {
                let parsed = serde_json::from_str::<serde_json::Value>(reply.trim())
                    .map_err(|_| "coach did not return structured JSON".to_string())
                    .and_then(|v| screen_coaching_output(v, &selection).map_err(|e| e.to_string()));
                match parsed {
                    Ok(coaching) => {
                        self.push_failures = 0;
                        self.log_coach_consult(false);
                        self.coach_turns.push(ChatTurn {
                            role: ChatTurnRole::Coach,
                            text: format_structured_coaching(&coaching),
                        });
                        self.message = "Coach returned observations.".into();
                    }
                    Err(reason) => {
                        self.log_coach_consult(true);
                        self.coach_turns.push(ChatTurn {
                            role: ChatTurnRole::Coach,
                            text: format!("(withheld by guard: {reason})"),
                        });
                        self.message = "Coach reply withheld by guard.".into();
                        // Back off proactive coaching if the backend keeps
                        // failing to return usable JSON.
                        if self.coach_is_push {
                            self.push_failures = self.push_failures.saturating_add(1);
                            if self.push_failures >= 2 {
                                self.next_push = usize::MAX;
                                self.message =
                                    "Auto-review paused (backend not returning JSON).".into();
                            }
                        }
                    }
                }
            }
        }
        // Every arm above appends a coach turn — mirror the updated thread.
        self.persist_coach_history();
    }

    /// Commit a chat reply that already cleared the deterministic guard, applying
    /// the optional LLM-judge verdict. The judge can only *withhold* a reply; if
    /// it could not be consulted we fail open (the deterministic guard already
    /// passed and the product claim is friction, not proof) and say so.
    fn accept_judged_chat_reply(
        &mut self,
        reply: String,
        judge: Option<Result<crate::coach::Verdict, String>>,
    ) {
        // Metadata-only: which judge model ran (if any), so the disclosure can
        // note the reply was double-screened. Never any prose, and the RAW model
        // string (keeps any `env:NAME` ref) so a secret can't leak via the journal.
        let judge_model = self.client.as_ref().and_then(|c| {
            c.judge_endpoint().map(|_| {
                let cfg = c.config();
                if cfg.judge.model.trim().is_empty() {
                    cfg.model.clone()
                } else {
                    cfg.judge.model.clone()
                }
            })
        });
        let mut meta: Vec<(&'static str, MetaValue)> = Vec::new();
        if let Some(m) = judge_model {
            meta.push(("judge_model", MetaValue::Str(m)));
        }
        match judge {
            Some(Ok(v)) if !v.allow => {
                meta.push(("judge_allowed", MetaValue::Bool(false)));
                self.log_coach_consult_with(true, meta);
                let reason = if v.reason.trim().is_empty() {
                    "flagged by the judge".to_string()
                } else {
                    v.reason
                };
                self.coach_turns.push(ChatTurn {
                    role: ChatTurnRole::Coach,
                    text: format!("(withheld by judge: {reason})"),
                });
                self.message = "Coach reply withheld by LLM judge.".into();
            }
            other => {
                let unavailable = matches!(other, Some(Err(_)));
                if let Some(Ok(_)) = other {
                    meta.push(("judge_allowed", MetaValue::Bool(true)));
                }
                self.log_coach_consult_with(false, meta);
                self.coach_turns.push(ChatTurn {
                    role: ChatTurnRole::Coach,
                    text: reply,
                });
                self.message = if unavailable {
                    "Coach replied (LLM judge unavailable — deterministic guard only).".into()
                } else {
                    "Coach replied.".into()
                };
            }
        }
    }

    /// Check whether a new paragraph crossed a teach-back threshold.
    fn maybe_trigger_teachback(&mut self, text: &str) {
        let pc = instruments::paragraph_count(text);
        let mut fired_teachback = false;
        if let Some(interval) = self.friction.teachback_interval()
            && pc > self.last_para_count
            && pc >= self.next_teachback
        {
            self.teachback_pending = true;
            self.teachback_input.clear();
            self.next_teachback = pc + interval;
            self.message = "Teach-back checkpoint — summarize your argument.".into();
            fired_teachback = true;
        }
        // Proactive push-cadence coaching (Instrument A) — only when it didn't
        // just interrupt with a teach-back, to avoid stacking prompts.
        if !fired_teachback {
            self.maybe_push_coaching(text, pc);
        }
        self.last_para_count = pc;
    }

    /// At the push-cadence boundary, run a structured coaching pass on the most
    /// recent paragraph in the background (no focus steal). Gated on a high
    /// enough friction level and an idle, configured coach.
    fn maybe_push_coaching(&mut self, text: &str, pc: usize) {
        let Some(interval) = self.friction.push_interval() else {
            return;
        };
        if self.client.is_none()
            || self.coach_busy
            || pc <= self.last_para_count
            || pc < self.next_push
        {
            return;
        }
        self.next_push = pc + interval;
        let Some(para) = instruments::extract_paragraphs(text).pop() else {
            return;
        };
        // Skip trivial paragraphs and anything that fails injection screening.
        if para.split_whitespace().count() < 20 || screen_injection(&para).is_err() {
            return;
        }
        self.log_event(
            ProcessEventType::PushCoaching,
            Some(para.chars().count() as u32),
            None,
            vec![],
        );
        self.coach_pending_size = para.chars().count() as u32;
        self.coach_turns.push(ChatTurn {
            role: ChatTurnRole::Writer,
            text: format!("[auto-review · {pc} paragraphs in]"),
        });
        let messages = build_coach_messages(&para, self.claim.as_deref());
        self.coach_mode = CoachMode::Structured(para);
        self.coach_is_push = true;
        self.persist_coach_history();
        self.spawn_coach(messages, true, None);
        self.message = "Coach is reviewing your latest paragraph…".into();
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

        // Confirm-quit: ignore mouse (decision must be explicit).
        if self.confirm_quit {
            return;
        }

        // Help popup: wheel scrolls the cheat-sheet, a left-click dismisses it.
        if self.help_open {
            match ev.kind {
                MouseEventKind::ScrollDown => self.help_scroll = self.help_scroll.saturating_add(1),
                MouseEventKind::ScrollUp => self.help_scroll = self.help_scroll.saturating_sub(1),
                MouseEventKind::Down(MouseButton::Left) => self.help_open = false,
                _ => {}
            }
            return;
        }

        // Journal view: wheel scrolls, a click dismisses.
        if self.journal_open {
            match ev.kind {
                MouseEventKind::ScrollDown => {
                    self.journal_scroll = self.journal_scroll.saturating_add(1)
                }
                MouseEventKind::ScrollUp => {
                    self.journal_scroll = self.journal_scroll.saturating_sub(1)
                }
                MouseEventKind::Down(MouseButton::Left) => self.journal_open = false,
                _ => {}
            }
            return;
        }

        // Disclosure preview: wheel scrolls, a click dismisses.
        if self.disclosure_open {
            match ev.kind {
                MouseEventKind::ScrollDown => {
                    self.disclosure_scroll = self.disclosure_scroll.saturating_add(1)
                }
                MouseEventKind::ScrollUp => {
                    self.disclosure_scroll = self.disclosure_scroll.saturating_sub(1)
                }
                MouseEventKind::Down(MouseButton::Left) => self.disclosure_open = false,
                _ => {}
            }
            return;
        }

        // Quarto output: wheel scrolls, a click dismisses.
        if self.compile_open {
            match ev.kind {
                MouseEventKind::ScrollDown => {
                    self.compile_scroll = self.compile_scroll.saturating_add(1)
                }
                MouseEventKind::ScrollUp => {
                    self.compile_scroll = self.compile_scroll.saturating_sub(1)
                }
                MouseEventKind::Down(MouseButton::Left) => self.compile_open = false,
                _ => {}
            }
            return;
        }

        // Outline: wheel moves the selection; click a row to jump, outside to close.
        if self.outline_open {
            let n = self.outline_items.len();
            match ev.kind {
                MouseEventKind::ScrollDown if n > 0 => {
                    self.outline_sel = (self.outline_sel + 1) % n
                }
                MouseEventKind::ScrollUp if n > 0 => {
                    self.outline_sel = (self.outline_sel + n - 1) % n
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    let rect = self.outline_rect;
                    if over(rect) && ev.row > rect.y && ev.row + 1 < rect.y + rect.height {
                        // Map the click to the heading draw_outline put on that row
                        // (it recorded the first visible index in outline_start).
                        let list_h = rect.height.saturating_sub(3) as usize;
                        let row = (ev.row - rect.y - 1) as usize;
                        let idx = self.outline_start + row;
                        // Only the list rows are clickable (not the hint line).
                        if row < list_h && idx < n {
                            self.jump_to_outline(idx);
                        }
                    } else {
                        self.outline_open = false;
                    }
                }
                _ => {}
            }
            return;
        }

        // Input prompt: click a field row to focus it, click outside to cancel.
        if self.prompt.is_some() {
            if let MouseEventKind::Down(MouseButton::Left) = ev.kind {
                let rect = self.prompt_rect;
                if over(rect) {
                    if ev.row > rect.y && ev.row + 1 < rect.y + rect.height {
                        let row = (ev.row - rect.y - 1) as usize;
                        if let Some(p) = self.prompt.as_mut()
                            && row < p.fields.len()
                        {
                            p.active = row;
                        }
                    }
                } else {
                    self.prompt = None;
                }
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
                            self.persist_settings();
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

        // AI settings dialog: click a field row to focus it, a model row to
        // select it, outside to cancel.
        if self.coach_settings.is_some() {
            if let MouseEventKind::Down(MouseButton::Left) = ev.kind {
                let rect = self.coach_settings_rect;
                let models = self.coach_models_rect;
                if models.height > 0 && over(models) {
                    let idx = self.coach_models_start + (ev.row - models.y) as usize;
                    if let Some(s) = self.coach_settings.as_mut()
                        && let Some(m) = s.models.get(idx)
                    {
                        s.model = m.clone();
                        s.field = F_MODEL;
                    }
                } else if over(rect) {
                    // Click an editable field row to focus it.
                    if let Some(field) = self.coach_field_rows.iter().position(|&r| r == ev.row)
                        && let Some(s) = self.coach_settings.as_mut()
                    {
                        s.field = field;
                    }
                } else {
                    self.coach_settings = None;
                    self.message = "AI settings cancelled.".into();
                }
            }
            return;
        }

        // Grammar settings overlay: wheel scrolls, a click toggles a rule row
        // (or selects the dialect row), a click outside cancels.
        if self.grammar_settings.is_some() {
            let count = self.grammar_settings.as_ref().unwrap().rules.len() + 1;
            match ev.kind {
                MouseEventKind::ScrollDown => {
                    let g = self.grammar_settings.as_mut().unwrap();
                    g.sel = (g.sel + 1) % count;
                }
                MouseEventKind::ScrollUp => {
                    let g = self.grammar_settings.as_mut().unwrap();
                    g.sel = (g.sel + count - 1) % count;
                }
                MouseEventKind::Down(MouseButton::Left) => {
                    let rect = self.grammar_settings.as_ref().unwrap().rect;
                    let rows = self.grammar_settings.as_ref().unwrap().rows_rect;
                    if rows.height > 0 && over(rows) {
                        let idx = self.grammar_settings.as_ref().unwrap().row_start
                            + (ev.row - rows.y) as usize;
                        let g = self.grammar_settings.as_mut().unwrap();
                        if let Some((rule, _)) = g.rules.get(idx) {
                            let rule = rule.clone();
                            g.sel = idx + 1;
                            if !g.disabled.remove(&rule) {
                                g.disabled.insert(rule);
                            }
                        }
                    } else if !over(rect) {
                        self.grammar_settings = None;
                        self.message = "Grammar settings cancelled.".into();
                    }
                }
                _ => {}
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
                if over(self.right_tab_rect) {
                    // Split at the end of the Coach label so clicking each tab's
                    // text selects that tab (a midpoint split misses the labels,
                    // which are packed at the left).
                    self.show_right_tab(if ev.column < self.right_tab_split {
                        RightTab::Coach
                    } else {
                        RightTab::Suggestions
                    });
                } else if self.suggest_rect.height > 0 && over(self.suggest_rect) {
                    let idx = self.suggest_start + (ev.row - self.suggest_rect.y) as usize;
                    if idx < self.diagnostics.len() {
                        self.suggest_sel = idx;
                        self.focus = Focus::Suggestions;
                        self.reveal_selected_diagnostic();
                    }
                } else if over(self.coach_input_rect) && self.client.is_some() {
                    self.focus = Focus::Coach;
                } else if over_editor {
                    let (line, col) = self.editor_cell_to_pos(ev.column, ev.row);
                    // Detect double/triple click: same cell within 400ms.
                    let now = Instant::now();
                    self.click_count = match self.last_click {
                        Some((t, c, r))
                            if c == ev.column
                                && r == ev.row
                                && now.duration_since(t) < Duration::from_millis(400) =>
                        {
                            (self.click_count % 3) + 1
                        }
                        _ => 1,
                    };
                    self.last_click = Some((now, ev.column, ev.row));
                    self.undo_group = None;
                    self.focus = Focus::Editor;
                    match self.click_count {
                        2 => {
                            let off = self.buffer.line_char_start(line) + col;
                            self.buffer.select_word(off);
                        }
                        3 => self.buffer.select_line(line),
                        _ => {
                            // Single click: place caret and anchor for drag.
                            self.buffer.clear_selection();
                            self.buffer.set_cursor_line_col(line, col);
                            self.buffer.begin_selection();
                        }
                    }
                    self.reveal_cursor();
                }
            }
            MouseEventKind::Drag(MouseButton::Left)
                if self.focus == Focus::Editor && self.editor_inner.height > 0 =>
            {
                let (line, col) = self.editor_cell_to_pos(ev.column, ev.row);
                self.buffer.begin_selection(); // anchor already set on press
                self.buffer.set_cursor_line_col(line, col);
                self.reveal_cursor();
            }
            _ => {}
        }
    }

    /// Map a terminal cell `(column, row)` to an editor `(line, char-col)`,
    /// accounting for scroll and wide glyphs. Clamps into the visible window.
    fn editor_cell_to_pos(&self, column: u16, row: u16) -> (usize, usize) {
        let inner = self.editor_inner;
        let row = row.clamp(inner.y, inner.y + inner.height.saturating_sub(1));
        let line = self.editor_scroll + (row - inner.y) as usize;
        let target = self.editor_hscroll + (column as usize).saturating_sub(inner.x as usize);
        (line, self.buffer.char_col_for_display(line, target))
    }

    /// Bring the cursor back into the viewport after a move (vertical + the
    /// horizontal display-column window for long lines).
    fn reveal_cursor(&mut self) {
        let (line, col) = self.buffer.cursor_line_col();
        let h = self.editor_height;
        if h > 0 {
            if line < self.editor_scroll {
                self.editor_scroll = line;
            } else if line >= self.editor_scroll + h {
                self.editor_scroll = line - h + 1;
            }
        }
        let w = self.editor_inner.width as usize;
        if w > 0 {
            let disp = self.buffer.display_width(line, col);
            if disp < self.editor_hscroll {
                self.editor_hscroll = disp;
            } else if disp >= self.editor_hscroll + w {
                self.editor_hscroll = disp - w + 1;
            }
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
        // Warn if the file changed on disk since we loaded/saved it.
        if let (Some(known), Some(now)) = (self.file_mtime, file_mtime_of(&self.path))
            && now > known
        {
            self.message = "File changed on disk — Ctrl+S again to overwrite.".into();
            self.file_mtime = Some(now); // a second Ctrl+S now proceeds
            return;
        }
        match atomic_write(&self.path, self.buffer.text().as_bytes()) {
            Ok(()) => {
                self.dirty = false;
                self.file_mtime = file_mtime_of(&self.path);
                self.message = format!("Saved {}", self.path.display());
            }
            Err(e) => self.message = format!("Save failed: {e}"),
        }
    }

    /// Autosave a dirty buffer that has been idle briefly (called from the run
    /// loop). No-op for an unnamed buffer.
    pub fn maybe_autosave(&mut self) {
        if !self.dirty || self.path.as_os_str().is_empty() {
            return;
        }
        let Some(last) = self.last_edit else { return };
        if last.elapsed() < Duration::from_secs(3) {
            return;
        }
        if atomic_write(&self.path, self.buffer.text().as_bytes()).is_ok() {
            self.dirty = false;
            self.file_mtime = file_mtime_of(&self.path);
            self.message = format!("Autosaved {}", self.file_label());
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
    draw_right_pane(frame, app, right[1]);
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
    if app.grammar_settings.is_some() {
        draw_grammar_settings(frame, app, area);
    }
    if app.journal_open {
        draw_journal(frame, app, area);
    }
    if app.disclosure_open {
        draw_disclosure(frame, app, area);
    }
    if app.outline_open {
        draw_outline(frame, app, area);
    }
    if app.compile_open {
        draw_compile_output(frame, app, area);
    }
    if app.prompt.is_some() {
        draw_prompt(frame, app, area);
    }
    if app.help_open {
        draw_help(frame, app, area);
    }
    if app.confirm_quit {
        draw_confirm_quit(frame, app, area);
    }
}

/// Process / journal view: the live mirror summary plus a scrollable list of
/// the metadata-only events recorded so far.
fn draw_journal(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let rect = centered_rect_abs(72, (area.height * 4 / 5).max(8), area);
    app.journal_rect = rect;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Process / journal ",
            theme.title(true),
        )));
    let inner = block.inner(rect);

    let snap = app.mirror_snapshot();
    let mut lines: Vec<Line<'static>> = vec![
        Line::from(Span::styled(format_mirror_summary(&snap), theme.accent())),
        Line::raw(""),
    ];
    for e in &app.journal {
        let ts = e.ts.get(11..19).unwrap_or(&e.ts); // HH:MM:SS
        let kind = format!("{:?}", e.kind);
        let size = e.size.map(|n| format!(" {n}c")).unwrap_or_default();
        lines.push(Line::from(vec![
            Span::styled(format!("{ts}  "), theme.dim()),
            Span::styled(kind, theme.text()),
            Span::styled(size, theme.dim()),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ scroll · Esc to close · Ctrl+D exports the full disclosure",
        theme.dim(),
    )));

    let content = lines.len();
    let view = inner.height as usize;
    let max = content.saturating_sub(view);
    if app.journal_scroll > max {
        app.journal_scroll = max;
    }
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .style(theme.text())
            .scroll((app.journal_scroll as u16, 0)),
        rect,
    );
}

fn draw_confirm_quit(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let rect = centered_rect_abs(54, 7, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Unsaved changes ",
            theme.title(true),
        )));
    let lines = vec![
        Line::from(Span::styled(
            format!("{} has unsaved changes.", app.file_label()),
            theme.text(),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("S", theme.accent()),
            Span::styled("ave & quit · ", theme.text()),
            Span::styled("Y", theme.accent()),
            Span::styled(" quit anyway · ", theme.text()),
            Span::styled("N", theme.accent()),
            Span::styled("/Esc cancel", theme.text()),
        ]),
    ];
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

/// Render structured coaching observations as plain coach-pane text.
fn format_structured_coaching(c: &StructuredCoaching) -> String {
    if c.observations.is_empty() {
        return "(no observations)".to_string();
    }
    let mut out = String::new();
    for (i, o) in c.observations.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "• [{}] {}\n    ? {}",
            kind_label(o.kind),
            o.reflection,
            o.question
        ));
    }
    out
}

fn kind_label(k: ObservationKind) -> &'static str {
    match k {
        ObservationKind::ImplicitClaim => "implicit claim",
        ObservationKind::IntendedMove => "intended move",
        ObservationKind::LogicFork => "logic fork",
    }
}

fn draw_coach_settings(frame: &mut Frame, app: &mut App, area: Rect) {
    /// Most discovered models to show at once; the rest are reachable by cycling.
    const MODEL_ROWS: usize = 6;

    let Some(s) = app.coach_settings.as_ref() else {
        return;
    };
    let theme = app.theme;

    // Marker (2) + label padded to 9 + space = 12-cell gutter before the value.
    let gutter = 12u16;
    // Mask a literal API key; show an `env:NAME` reference verbatim (the name
    // isn't a secret and the writer needs to see it).
    let mask_key = |k: &str| {
        if is_env_ref(k) {
            k.to_string()
        } else {
            "•".repeat(k.chars().count())
        }
    };

    let mut lines: Vec<Line> = Vec::new();
    // Line index where each field landed, filled as we push (for caret + clicks).
    let mut field_line_idx = [0usize; COACH_FIELD_COUNT];

    let mut push_field = |lines: &mut Vec<Line>, idx: usize, label: &str, value: String| {
        field_line_idx[idx] = lines.len();
        let focused = s.field == idx;
        let marker = if focused { "▸ " } else { "  " };
        let label_style = if focused { theme.accent() } else { theme.dim() };
        lines.push(Line::from(vec![
            Span::styled(format!("{marker}{label:<9} "), label_style),
            Span::styled(value, theme.text()),
        ]));
    };

    let inherits = "(inherits coach)".to_string();
    let judge_text = |raw: &str, masked: bool| {
        if raw.trim().is_empty() {
            inherits.clone()
        } else if masked {
            mask_key(raw)
        } else {
            raw.to_string()
        }
    };

    lines.push(Line::from(Span::styled("Coach", theme.dim())));
    push_field(
        &mut lines,
        F_PROVIDER,
        "Provider",
        provider_label(s.provider).to_string(),
    );
    push_field(&mut lines, F_BASE_URL, "Endpoint", s.base_url.clone());
    push_field(&mut lines, F_API_KEY, "API key", mask_key(&s.api_key));
    push_field(&mut lines, F_MODEL, "Model", s.model.clone());

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "Response judge — a second LLM that can only withhold a reply",
        theme.dim(),
    )));
    push_field(
        &mut lines,
        F_JUDGE_ENABLED,
        "Judge",
        if s.judge_enabled {
            "on".to_string()
        } else {
            "off".to_string()
        },
    );
    push_field(
        &mut lines,
        F_JUDGE_PROVIDER,
        "Provider",
        provider_label(s.judge_provider).to_string(),
    );
    push_field(
        &mut lines,
        F_JUDGE_BASE_URL,
        "Endpoint",
        judge_text(&s.judge_base_url, false),
    );
    push_field(
        &mut lines,
        F_JUDGE_API_KEY,
        "API key",
        judge_text(&s.judge_api_key, true),
    );
    push_field(
        &mut lines,
        F_JUDGE_MODEL,
        "Model",
        judge_text(&s.judge_model, false),
    );

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "Tip: enter env:NAME (or ${NAME}) to read a value from an environment",
        theme.dim(),
    )));
    lines.push(Line::from(Span::styled(
        "variable — only the name is saved, never the resolved value.",
        theme.dim(),
    )));

    // Status line from the last connection test (color-coded by outcome).
    if let Some(status) = &s.status {
        let style = if status.starts_with('✓') {
            theme.accent()
        } else if status.starts_with('✗') {
            Style::default().fg(theme.error).bg(theme.bg)
        } else {
            theme.dim()
        };
        lines.push(Line::from(Span::styled(status.clone(), style)));
    }

    // Discovered models: keep the selected one in view, mark it.
    let model_count = s.models.len();
    let mut models_top = 0usize; // y of the first model row inside `inner`
    let mut models_start = 0usize;
    let mut models_shown = 0usize;
    if model_count > 0 {
        let sel = s.models.iter().position(|m| m == &s.model).unwrap_or(0);
        let start = sel
            .saturating_sub(MODEL_ROWS - 1)
            .min(model_count.saturating_sub(MODEL_ROWS));
        models_top = lines.len();
        models_start = start;
        for (i, m) in s.models.iter().enumerate().skip(start).take(MODEL_ROWS) {
            let chosen = i == sel;
            let marker = if chosen { "  ● " } else { "  ○ " };
            let style = if chosen { theme.accent() } else { theme.dim() };
            lines.push(Line::from(Span::styled(format!("{marker}{m}"), style)));
        }
        models_shown = MODEL_ROWS.min(model_count - start);
        if model_count > models_shown {
            lines.push(Line::from(Span::styled(
                format!("  … {model_count} total"),
                theme.dim(),
            )));
        }
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "Tab/↑↓ field · ←/→ provider/toggle · Ctrl+T test · Ctrl+N/P model · Enter save · Esc",
        theme.dim(),
    )));

    let height = (lines.len() as u16) + 2; // borders
    let rect = centered_rect_abs(76, height, area);
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

    // Record where the model list landed so clicks can hit it.
    app.coach_models_start = models_start;
    app.coach_models_rect = if models_shown > 0 {
        Rect {
            x: inner.x,
            y: inner.y + models_top as u16,
            width: inner.width,
            height: models_shown as u16,
        }
    } else {
        Rect::default()
    };
    // Record each field's absolute row so clicks and the caret can find them.
    for (idx, line_idx) in field_line_idx.iter().enumerate() {
        app.coach_field_rows[idx] = inner.y + *line_idx as u16;
    }

    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);

    // Caret at the end of a text field's value; for provider/toggle fields it
    // sits at the value start (they're cycled, not typed).
    let val_len = match s.field {
        F_BASE_URL => s.base_url.chars().count(),
        F_API_KEY => s.api_key.chars().count(),
        F_MODEL => s.model.chars().count(),
        F_JUDGE_BASE_URL => s.judge_base_url.chars().count(),
        F_JUDGE_API_KEY => s.judge_api_key.chars().count(),
        F_JUDGE_MODEL => s.judge_model.chars().count(),
        _ => 0,
    } as u16;
    let cx = (inner.x + gutter + val_len).min(inner.right().saturating_sub(1));
    // Clamp into the (possibly screen-clipped) dialog so the caret never lands
    // outside it on a short terminal where the lower fields are cut off.
    let cy = app.coach_field_rows[s.field].min(inner.bottom().saturating_sub(1));
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

fn draw_grammar_settings(frame: &mut Frame, app: &mut App, area: Rect) {
    /// Lint rules visible at once; the rest scroll into view.
    const RULE_ROWS: usize = 12;

    let Some(g) = app.grammar_settings.as_ref() else {
        return;
    };
    let theme = app.theme;

    let rect = centered_rect_abs(70, RULE_ROWS as u16 + 8, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Grammar (Harper) ",
            theme.title(true),
        )));
    let inner = block.inner(rect);

    let mut lines: Vec<Line<'static>> = Vec::new();
    // Row 0: dialect selector.
    let dialect_focused = g.sel == 0;
    lines.push(Line::from(vec![
        Span::styled(
            if dialect_focused { "▸ " } else { "  " }.to_string(),
            theme.accent(),
        ),
        Span::styled(
            "Dialect  ".to_string(),
            if dialect_focused {
                theme.accent()
            } else {
                theme.dim()
            },
        ),
        Span::styled(format!("◄ {} ►", g.dialect.label()), theme.text()),
    ]));
    lines.push(Line::from(Span::styled(
        "Lint rules (Space toggles):",
        theme.dim(),
    )));

    // Scroll the rule list to keep the selected rule visible.
    let n = g.rules.len();
    let sel_rule = g.sel.saturating_sub(1);
    let start = if g.sel == 0 {
        0
    } else {
        sel_rule
            .saturating_sub(RULE_ROWS - 1)
            .min(n.saturating_sub(RULE_ROWS))
    };
    let rows_top = lines.len();
    for (i, (key, _desc)) in g.rules.iter().enumerate().skip(start).take(RULE_ROWS) {
        let enabled = !g.disabled.contains(key);
        let selected = g.sel == i + 1;
        let check = if enabled { "[x]" } else { "[ ]" };
        let marker = if selected { "▸ " } else { "  " };
        let style = if selected {
            theme.selected()
        } else if enabled {
            theme.text()
        } else {
            theme.dim()
        };
        lines.push(Line::from(Span::styled(
            format!("{marker}{check} {key}"),
            style,
        )));
    }
    let shown = RULE_ROWS.min(n.saturating_sub(start));
    if n > start + shown {
        lines.push(Line::from(Span::styled(
            format!("  … {n} rules total"),
            theme.dim(),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ move · ←/→ dialect · Space toggle · Enter apply · Esc cancel",
        theme.dim(),
    )));

    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);

    // Record geometry for click hit-testing.
    if let Some(g) = app.grammar_settings.as_mut() {
        g.rect = rect;
        g.row_start = start;
        g.rows_rect = Rect {
            x: inner.x,
            y: inner.y + rows_top as u16,
            width: inner.width,
            height: shown as u16,
        };
    }
}

fn draw_help(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    // Size to the screen so the cheat-sheet is never clipped on a short
    // terminal — it word-wraps to the width and scrolls past the height.
    let rect = centered_rect_abs(64, area.height.saturating_sub(2).clamp(8, 28), area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" Keybindings ", theme.title(true))));
    let inner = block.inner(rect);
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
        row("Ctrl+S / O", "Save · open file (Save as via File menu)"),
        row("Ctrl+Z / Y", "Undo / redo"),
        row(
            "Ctrl+C / X",
            "Copy / cut selection (Shift+arrows to select)",
        ),
        row("Ctrl+A", "Select all"),
        row("Ctrl+F / H / G", "Find · replace · go to line"),
        row("Ctrl+←/→", "Move by word (Ctrl+Backspace/Del deletes word)"),
        row("Ctrl+D", "Export disclosure (File ▸ Preview to view)"),
        row("Ctrl+K", "State / edit your claim"),
        row("Ctrl+M", "Mark paste under cursor as a quotation"),
        row("Ctrl+B", "Outline — jump to a heading"),
        row("Ctrl+R", "Render with Quarto (saves first)"),
        row("Ctrl+L / J", "Focus coach · coach the selection"),
        row("Ctrl+E", "AI settings (endpoint, API key, model)"),
        row("Ctrl+P", "Process / journal view"),
        row("Ctrl+T", "Theme picker (live preview)"),
        row("F10 / F1", "Menu bar · this help"),
        row("Ctrl+Q", "Quit (asks if unsaved)"),
        Line::raw(""),
        Line::from(vec![
            Span::styled("  Yellow highlight", theme.quarantine()),
            Span::styled(
                " = a pasted region; rewrite it (claim-to-own) or Ctrl+M to attribute.",
                theme.dim(),
            ),
        ]),
        Line::from(Span::styled(
            "  Mouse: click / drag to select, double = word, triple = line.",
            theme.dim(),
        )),
        Line::from(Span::styled(
            "  ↑/↓ or wheel to scroll · Esc or any other key to close",
            theme.dim(),
        )),
    ];
    let text = Text::from(lines);
    let content = wrapped_height(&text, inner.width as usize);
    let max = content.saturating_sub(inner.height as usize);
    if app.help_scroll > max {
        app.help_scroll = max;
    }
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(text)
            .block(block)
            .style(theme.text())
            .wrap(Wrap { trim: false })
            .scroll((app.help_scroll as u16, 0)),
        rect,
    );
    render_scrollbar(
        frame,
        rect,
        content,
        app.help_scroll,
        inner.height as usize,
        theme,
    );
}

/// A centered rect of an absolute size, clamped to `area`.
/// Clamp a connection-test error to one dialog line (errors from reqwest can be
/// long), appending an ellipsis when truncated.
fn truncate_status(msg: &str) -> String {
    const MAX: usize = 56;
    truncate_to(&msg.replace('\n', " "), MAX)
}

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

    // Render only the visible window, with grammar diagnostics underlined and
    // any selection highlighted. Horizontal scroll is applied by the Paragraph.
    let total = app.buffer.line_count();
    let first = app.editor_scroll.min(total);
    let last_exclusive = (first + app.editor_height).min(total);
    let selection = app.buffer.selection();
    // Highlight the matched bracket pair only when the editor is focused and no
    // overlay is up (so it tracks the live caret, not a stale position).
    let brackets = (focused && !app.has_overlay())
        .then(|| app.buffer.matching_bracket())
        .flatten();
    let mut lines: Vec<Line<'static>> = Vec::with_capacity(app.editor_height);
    for i in first..last_exclusive {
        let start = app.buffer.line_char_start(i);
        let text = app.buffer.line_text(i);
        lines.push(styled_line(
            &text,
            start,
            &app.diagnostics,
            app.quarantine.regions(),
            selection,
            brackets,
            theme,
        ));
    }
    let para = Paragraph::new(lines)
        .block(block)
        .style(theme.text())
        .scroll((0, app.editor_hscroll as u16));
    frame.render_widget(para, area);

    // Position the terminal cursor only when the editor is focused and no
    // overlay is up.
    if focused && !app.has_overlay() {
        let (line, col) = app.buffer.cursor_line_col();
        let disp = app
            .buffer
            .display_width(line, col)
            .saturating_sub(app.editor_hscroll);
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

/// Draw the bottom-right pane: a one-row tab header (Coach ⇄ Suggestions) over
/// whichever tab is active.
fn draw_right_pane(frame: &mut Frame, app: &mut App, area: Rect) {
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(0)])
        .split(area);
    let theme = app.theme;
    app.right_tab_rect = parts[0];

    let coach_sel = app.right_tab == RightTab::Coach;
    let issues = app.diagnostics.len();
    let tab = |label: String, selected: bool| {
        let style = if selected {
            theme.menu_selected()
        } else {
            theme.menu()
        };
        Span::styled(label, style)
    };
    let coach_label = " Coach ";
    // The boundary between the two clickable tab labels (end of the Coach tab),
    // so a click lands on the label actually under the pointer (not a midpoint).
    app.right_tab_split = parts[0].x + coach_label.chars().count() as u16;
    let header = Line::from(vec![
        tab(coach_label.to_string(), coach_sel),
        Span::styled(" ", theme.menu()),
        tab(format!(" Suggestions ({issues}) "), !coach_sel),
    ]);
    frame.render_widget(Paragraph::new(header).style(theme.menu()), parts[0]);

    // Only the active tab's pane is drawn, so clear the OTHER pane's recorded
    // rect to stop stale mouse hit-testing against a region it no longer owns.
    match app.right_tab {
        RightTab::Coach => {
            app.suggest_rect = Rect::default();
            draw_coach(frame, app, parts[1]);
        }
        RightTab::Suggestions => {
            app.coach_inner = Rect::default();
            draw_suggestions(frame, app, parts[1]);
        }
    }
}

/// Draw the Harper suggestions list: one selectable row per diagnostic, each
/// showing a severity icon, the message, and (if any) the primary fix.
fn draw_suggestions(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let focused = app.focus == Focus::Suggestions;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(focused))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " SUGGESTIONS ",
            theme.title(focused),
        )));
    let inner = block.inner(area);
    frame.render_widget(Clear, area);

    if app.diagnostics.is_empty() {
        let p = Paragraph::new(Line::from(Span::styled(
            "No grammar issues found.",
            theme.dim(),
        )))
        .block(block)
        .style(theme.text());
        frame.render_widget(p, area);
        app.suggest_rect = Rect::default();
        return;
    }

    // Reserve the last inner row for a key hint; the rest is the scrolling list.
    let hint_h = if inner.height >= 2 { 1 } else { 0 };
    let list_h = inner.height.saturating_sub(hint_h) as usize;
    let n = app.diagnostics.len();
    if app.suggest_sel >= n {
        app.suggest_sel = n - 1;
    }
    let start = app
        .suggest_sel
        .saturating_sub(list_h.saturating_sub(1))
        .min(n.saturating_sub(list_h.max(1)));
    app.suggest_start = start;

    let width = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, d) in app.diagnostics.iter().enumerate().skip(start).take(list_h) {
        let (icon, color) = match d.severity {
            Severity::Error => ("✗", theme.error),
            Severity::Warning => ("▲", theme.accent),
            Severity::Style => ("•", theme.dim),
        };
        let selected = i == app.suggest_sel;
        let marker = if selected { "▸" } else { " " };
        let fix = d
            .suggestions
            .first()
            .map(|f| format!("  →  {}", f.label))
            .unwrap_or_default();
        let body = format!("{marker}{icon} {}{fix}", d.message);
        let body = truncate_to(&body, width);
        let style = if selected {
            theme.selected()
        } else {
            Style::default().fg(color).bg(theme.bg)
        };
        lines.push(Line::from(Span::styled(body, style)));
    }
    if hint_h == 1 {
        lines.push(Line::from(Span::styled(
            "↑/↓ select · Enter apply · Tab → Coach · Esc editor",
            theme.dim(),
        )));
    }

    frame.render_widget(Paragraph::new(lines).block(block), area);
    app.suggest_rect = Rect {
        x: inner.x,
        y: inner.y,
        width: inner.width,
        height: list_h as u16,
    };
}

/// Truncate `s` to at most `width` columns (char-approximate), adding an ellipsis.
fn truncate_to(s: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if s.chars().count() <= width {
        return s.to_string();
    }
    let mut out: String = s.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
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
            let elapsed = app
                .coach_started
                .map(|t| format!("thinking… ({}s · Esc to cancel)", t.elapsed().as_secs()))
                .unwrap_or_else(|| "thinking…".to_string());
            lines.push(Line::from(vec![
                Span::styled(
                    "coach: ",
                    Style::default()
                        .fg(theme.coach_reply)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(elapsed, theme.dim().add_modifier(Modifier::ITALIC)),
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
    let c = app.mirror_snapshot().composition;
    let mirror = if c.paste_count == 0 {
        String::new()
    } else {
        format!(
            "│ {}%t · {} mark ",
            (c.typed_ratio * 100.0).round() as u32,
            c.pastes_unclaimed
        )
    };
    let friction = menu::friction_level_name(app.friction.level());
    let status = format!(
        " {}{dirty} │ {}:{} │ {gram} {mirror}│ {friction} │ {} ",
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
    selection: Option<(usize, usize)>,
    brackets: Option<(usize, usize)>,
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
    let mut sel = vec![false; n];
    if let Some((s, e)) = selection {
        let lo = s.saturating_sub(start).min(n);
        let hi = e.saturating_sub(start).min(n);
        for x in sel.iter_mut().take(hi).skip(lo) {
            *x = true;
        }
    }
    let mut brk = vec![false; n];
    if let Some((a, b)) = brackets {
        for pos in [a, b] {
            if pos >= start && pos - start < n {
                brk[pos - start] = true;
            }
        }
    }
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut i = 0;
    while i < n {
        let key = (sev[i], quar[i], sel[i], brk[i]);
        let mut j = i;
        while j < n && (sev[j], quar[j], sel[j], brk[j]) == key {
            j += 1;
        }
        let seg: String = chars[i..j].iter().collect();
        let (_, q, s, br) = key;
        // Precedence: selection (most explicit) > matched bracket > paste
        // quarantine > grammar severity.
        let style = if s {
            theme.selected()
        } else if br {
            theme.bracket_match()
        } else if q {
            theme.quarantine()
        } else {
            severity_style(sev[i], theme)
        };
        spans.push(Span::styled(seg, style));
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

/// Apply a vertical-scroll key (↑/↓ by one, PageUp/Down by a page) to `scroll`,
/// returning whether the key was a scroll key. Used by the read-only overlays so
/// a non-scroll key falls through to dismiss them.
fn scroll_key(scroll: &mut usize, code: KeyCode) -> bool {
    match code {
        KeyCode::Up => *scroll = scroll.saturating_sub(1),
        KeyCode::Down => *scroll = scroll.saturating_add(1),
        KeyCode::PageUp => *scroll = scroll.saturating_sub(8),
        KeyCode::PageDown => *scroll = scroll.saturating_add(8),
        _ => return false,
    }
    true
}

/// First outline row to draw so the selected heading (`sel`) stays visible in a
/// `list_h`-row window over `count` items. Shared by the renderer and the click
/// handler so a click lands on the heading actually drawn at that row.
fn outline_view_start(sel: usize, count: usize, list_h: usize) -> usize {
    if list_h == 0 || count <= list_h {
        0
    } else {
        sel.saturating_sub(list_h - 1).min(count - list_h)
    }
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

/// File modification time, if the path exists.
fn file_mtime_of(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Parse a per-instrument friction override from the environment at startup.
///
/// `WHETSTONE_FRICTION_<INSTRUMENT>` (e.g. `WHETSTONE_FRICTION_PASTE`) sets one
/// instrument's level. Returns:
/// - `None` — the var is unset or unparseable (leave the saved value as-is);
/// - `Some(None)` — `off` / `none` / `preset` (clear the override → follow the
///   global preset);
/// - `Some(Some(n))` — a level `0..=3`.
fn env_instrument_override(inst: Instrument) -> Option<Option<u8>> {
    let var = format!("WHETSTONE_FRICTION_{}", inst.key().to_uppercase());
    let raw = std::env::var(var).ok()?;
    match raw.trim().to_lowercase().as_str() {
        "" => None,
        "off" | "none" | "preset" => Some(None),
        n => n.parse::<u8>().ok().filter(|l| *l <= 3).map(Some),
    }
}

/// Write `bytes` to `path` atomically (temp file in the same dir, then rename),
/// so a crash mid-write can't truncate the document.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("whetstone-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// A one-/two-field input prompt (find/replace/goto/open/save-as).
fn draw_prompt(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(p) = app.prompt.as_ref() else { return };
    let theme = app.theme;
    let labels = p.kind.labels();
    let height = labels.len() as u16 + 4; // fields + blank + hint + borders
    let rect = centered_rect_abs(64, height, area);
    app.prompt_rect = rect;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(p.kind.title(), theme.title(true))));
    let inner = block.inner(rect);
    let gutter = 9u16;
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, label) in labels.iter().enumerate() {
        let focused = p.active == i;
        let marker = if focused { "▸ " } else { "  " };
        let lstyle = if focused { theme.accent() } else { theme.dim() };
        lines.push(Line::from(vec![
            Span::styled(format!("{marker}{label:<6} "), lstyle),
            Span::styled(p.fields[i].clone(), theme.text()),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(p.kind.hint(), theme.dim())));
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
    let val_len = p.fields[p.active].chars().count() as u16;
    let cx = (inner.x + gutter + val_len).min(inner.right().saturating_sub(1));
    frame.set_cursor_position((cx, inner.y + p.active as u16));
}

/// Scrollable read-only preview of the rendered disclosure document.
fn draw_disclosure(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let rect = centered_rect_abs(78, (area.height * 4 / 5).max(8), area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Disclosure preview ",
            theme.title(true),
        )));
    let inner = block.inner(rect);
    let mut lines: Vec<Line<'static>> = app
        .disclosure_text
        .lines()
        .map(|l| Line::from(Span::styled(l.to_string(), theme.text())))
        .collect();
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ scroll · Esc close · Ctrl+D writes the file",
        theme.dim(),
    )));
    let max = lines.len().saturating_sub(inner.height as usize);
    if app.disclosure_scroll > max {
        app.disclosure_scroll = max;
    }
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .style(theme.text())
            .wrap(Wrap { trim: false })
            .scroll((app.disclosure_scroll as u16, 0)),
        rect,
    );
}

/// Document-outline overlay: a scrollable, indented list of headings; the
/// selected row is highlighted and Enter jumps the cursor to it.
fn draw_outline(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let count = app.outline_items.len();
    let height = (count as u16 + 4).min((area.height * 4 / 5).max(6));
    let rect = centered_rect_abs(60, height, area);
    app.outline_rect = rect;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(" Outline ", theme.title(true))));
    let inner = block.inner(rect);

    // Keep the selected row in view (the list scrolls when it's taller than the
    // popup). Reserve the last inner row for the hint line.
    let list_h = inner.height.saturating_sub(1) as usize;
    let start = outline_view_start(app.outline_sel, count, list_h);
    // Record it so a click maps to the same heading this renders (see handle_mouse).
    app.outline_start = start;
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (i, h) in app
        .outline_items
        .iter()
        .enumerate()
        .skip(start)
        .take(list_h)
    {
        let indent = "  ".repeat((h.level.saturating_sub(1)) as usize);
        let marker = if i == app.outline_sel { "▸ " } else { "  " };
        let style = if i == app.outline_sel {
            theme.selected()
        } else {
            theme.text()
        };
        lines.push(Line::from(Span::styled(
            format!("{marker}{indent}{}", h.title),
            style,
        )));
    }
    lines.push(Line::from(Span::styled(
        "↑/↓ select · Enter jump · Esc close",
        theme.dim(),
    )));
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

/// Scrollable read-only view of the last Quarto render's output (auto-opened
/// when a render fails).
fn draw_compile_output(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let rect = centered_rect_abs(78, (area.height * 4 / 5).max(8), area);
    app.compile_rect = rect;
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Quarto render ",
            theme.title(true),
        )));
    let inner = block.inner(rect);
    let mut lines: Vec<Line<'static>> = app
        .compile_output
        .lines()
        .map(|l| Line::from(Span::styled(l.to_string(), theme.text())))
        .collect();
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "↑/↓ scroll · Esc close",
        theme.dim(),
    )));
    let text = Text::from(lines);
    let content = wrapped_height(&text, inner.width as usize);
    let max = content.saturating_sub(inner.height as usize);
    if app.compile_scroll > max {
        app.compile_scroll = max;
    }
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(text)
            .block(block)
            .style(theme.text())
            .wrap(Wrap { trim: false })
            .scroll((app.compile_scroll as u16, 0)),
        rect,
    );
    render_scrollbar(
        frame,
        rect,
        content,
        app.compile_scroll,
        inner.height as usize,
        theme,
    );
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
        // Field 0 is the provider selector; Tab to the endpoint field and type.
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.coach_settings.as_ref().unwrap().field, F_BASE_URL);
        for ch in "http://x".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE));
        }
        assert_eq!(app.coach_settings.as_ref().unwrap().base_url, "http://x");
        // Tab advances the focused field.
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.coach_settings.as_ref().unwrap().field, F_API_KEY);
        // ←/→ cycles the provider selector (field 0).
        app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE));
        assert_eq!(app.coach_settings.as_ref().unwrap().field, F_PROVIDER);
        app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        assert_eq!(
            app.coach_settings.as_ref().unwrap().provider,
            Some(Provider::OpenAi)
        );
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

    #[test]
    fn cycling_an_instrument_override_retunes_live() {
        let rt = rt();
        let mut app = test_app(&rt);
        // Pin a known starting policy in-memory (the test harness's `App::new`
        // loads the real `ui.json`, so don't depend on whatever it found).
        app.friction = FrictionPolicy::new(0, 1); // Coach, no overrides
        app.retune_instruments();
        // Global preset is Coach (1) → push cadence off, quarantine at 40.
        assert_eq!(app.next_push, usize::MAX);
        assert_eq!(app.friction.paste_threshold(), 40);

        // Cycle the Push instrument: None → 0 → 1 → 2 (Engaged), which turns
        // proactive coaching on while the global preset stays Coach.
        for _ in 0..3 {
            app.dispatch(MenuAction::CycleInstrument(Instrument::Push));
        }
        assert_eq!(app.friction.overrides.get(Instrument::Push), Some(2));
        assert_eq!(app.friction.level(), 1); // global preset unchanged
        assert_ne!(app.next_push, usize::MAX); // push now scheduled

        // Cycle Paste up to Deep Work (3) and confirm the quarantine retunes.
        for _ in 0..4 {
            app.dispatch(MenuAction::CycleInstrument(Instrument::Paste));
        }
        assert_eq!(app.friction.overrides.get(Instrument::Paste), Some(3));
        assert_eq!(app.friction.paste_threshold(), 12);

        // One more cycle past Deep Work clears the override (follows preset).
        app.dispatch(MenuAction::CycleInstrument(Instrument::Paste));
        assert_eq!(app.friction.overrides.get(Instrument::Paste), None);
        assert_eq!(app.friction.paste_threshold(), 40);

        // Leave the persisted preferences free of overrides so a later
        // `App::new` (this suite or the real app) isn't contaminated.
        app.friction = FrictionPolicy::new(0, 1);
        app.persist_settings();
    }

    #[test]
    fn undo_redo_round_trip() {
        let rt = rt();
        let mut app = test_app(&rt);
        let before = app.buffer.text();
        app.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE));
        let after = app.buffer.text();
        assert_ne!(before, after);
        app.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert_eq!(app.buffer.text(), before);
        app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL));
        assert_eq!(app.buffer.text(), after);
    }

    #[test]
    fn select_all_and_copy_sets_clipboard() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.handle_key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
        app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(
            app.take_clipboard_request().as_deref(),
            Some("# Title\n\nHello world.")
        );
    }

    #[test]
    fn shift_arrow_selects_and_typing_replaces() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.buffer.set_cursor(0);
        for _ in 0..7 {
            app.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::SHIFT));
        }
        assert_eq!(app.buffer.selected_text().as_deref(), Some("# Title"));
        app.handle_key(KeyEvent::new(KeyCode::Char('X'), KeyModifiers::NONE));
        assert!(app.buffer.text().starts_with('X'));
        assert!(app.buffer.selection().is_none());
    }

    #[test]
    fn dirty_quit_is_guarded() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.handle_key(KeyEvent::new(KeyCode::Char('!'), KeyModifiers::NONE)); // make dirty
        app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL));
        assert!(!app.should_quit(), "dirty quit must ask first");
        assert!(app.confirm_quit);
        app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));
        assert!(!app.confirm_quit);
        assert!(!app.should_quit());
    }

    #[test]
    fn journal_view_toggles_and_renders() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert!(app.journal_open);
        let s = render(&mut app);
        assert!(s.contains("Process"));
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(!app.journal_open);
    }

    #[test]
    fn typing_coalesces_into_one_undo_step() {
        let rt = rt();
        let mut app = test_app(&rt);
        let before = app.buffer.text();
        for c in "abc".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert!(app.buffer.text().ends_with("abc"));
        // A single undo reverts the whole contiguous burst.
        app.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::CONTROL));
        assert_eq!(app.buffer.text(), before);
    }

    #[test]
    fn replace_all_replaces_every_match() {
        let rt = rt();
        let mut app = test_app(&rt); // "# Title\n\nHello world."
        app.replace_all("l", "L");
        assert_eq!(app.buffer.text(), "# TitLe\n\nHeLLo worLd.");
    }

    #[test]
    fn find_selects_next_match() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.buffer.set_cursor(0);
        app.open_prompt(PromptKind::Find);
        for c in "world".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        assert_eq!(app.buffer.selected_text().as_deref(), Some("world"));
    }

    #[test]
    fn incremental_mirror_matches_full_recompute() {
        let rt = rt();
        let mut app = test_app(&rt);
        for c in "abcde".chars() {
            app.handle_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
        app.handle_paste(&"z".repeat(50));
        assert_eq!(
            app.mirror_snapshot(),
            crate::core::mirror::compute_mirror(&app.journal)
        );
    }

    #[test]
    fn structured_coaching_formats_observations() {
        use crate::core::coaching::{Anchor, Observation, ObservationKind, StructuredCoaching};
        let c = StructuredCoaching {
            observations: vec![Observation {
                anchor: Anchor { start: 0, end: 3 },
                kind: ObservationKind::LogicFork,
                reflection: "the argument forks here".into(),
                question: "which branch do you mean?".into(),
            }],
        };
        let s = format_structured_coaching(&c);
        assert!(s.contains("logic fork"));
        assert!(s.contains("the argument forks here"));
        assert!(s.contains("which branch do you mean?"));
    }

    #[test]
    fn double_click_selects_word() {
        let rt = rt();
        let mut app = test_app(&rt);
        let _ = render(&mut app); // populate editor_inner
        let inner = app.editor_inner;
        let (col, row) = (inner.x + 2, inner.y); // 'T' in "# Title"
        for _ in 0..2 {
            app.handle_mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: col,
                row,
                modifiers: KeyModifiers::NONE,
            });
        }
        assert_eq!(app.buffer.selected_text().as_deref(), Some("Title"));
    }

    #[test]
    fn outline_opens_and_jumps_to_heading() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.buffer = Buffer::new("# A\n\ntext\n\n## B\n\nmore");
        app.buffer.set_cursor(0);
        app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
        assert!(app.outline_open);
        assert_eq!(app.outline_items.len(), 2);
        // Select the second heading and jump to it.
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(!app.outline_open);
        assert_eq!(app.buffer.cursor_line_col().0, 4); // "## B" is line index 4
    }

    #[test]
    fn outline_without_headings_does_not_open() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.buffer = Buffer::new("just prose, no headings");
        app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
        assert!(!app.outline_open);
        assert!(app.message.contains("No headings"));
    }

    #[test]
    fn help_scrolls_then_dismisses() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.handle_key(KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE));
        assert!(app.help_open);
        app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(app.help_scroll, 1);
        // Any non-scroll key closes the cheat-sheet.
        app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
        assert!(!app.help_open);
    }

    #[test]
    fn compile_requires_a_saved_path() {
        let rt = rt();
        let mut app = App::new(
            "hi".into(),
            std::path::PathBuf::new(),
            None,
            rt.handle().clone(),
        );
        app.do_compile();
        assert!(!app.compiling);
        assert!(app.message.contains("Save"));
    }

    #[test]
    fn compile_failure_opens_output_overlay() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.compiling = true;
        app.compile_tx
            .send(CompileEvent {
                ok: false,
                output: "render error: boom".into(),
            })
            .unwrap();
        app.drain_compile_events();
        assert!(!app.compiling);
        assert!(app.compile_open);
        assert_eq!(app.compile_output, "render error: boom");
    }

    #[test]
    fn compile_success_reports_without_overlay() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.compiling = true;
        app.compile_tx
            .send(CompileEvent {
                ok: true,
                output: "Output created: test.html".into(),
            })
            .unwrap();
        app.drain_compile_events();
        assert!(!app.compiling);
        assert!(!app.compile_open);
        assert!(app.message.contains("rendered"));
    }

    #[test]
    fn truncate_status_collapses_and_clamps() {
        assert_eq!(truncate_status("line one\nline two"), "line one line two");
        let long = "x".repeat(80);
        let out = truncate_status(&long);
        assert_eq!(out.chars().count(), 56);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn cycle_model_steps_and_wraps_through_discovered_list() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.open_coach_settings();
        {
            let s = app.coach_settings.as_mut().unwrap();
            s.models = vec!["a".into(), "b".into(), "c".into()];
            s.model = "b".into();
        }
        app.cycle_model(1);
        assert_eq!(app.coach_settings.as_ref().unwrap().model, "c");
        app.cycle_model(1); // wraps past the end
        assert_eq!(app.coach_settings.as_ref().unwrap().model, "a");
        app.cycle_model(-1); // wraps before the start
        assert_eq!(app.coach_settings.as_ref().unwrap().model, "c");
        // Cycling also moves focus to the Model field.
        assert_eq!(app.coach_settings.as_ref().unwrap().field, F_MODEL);
    }

    #[test]
    fn suggestions_tab_lists_and_applies_a_fix() {
        let rt = rt();
        let mut app = App::new(
            "This is a sentance.".to_string(),
            std::path::PathBuf::from("test.qmd"),
            None,
            rt.handle().clone(),
        );
        // A misspelling should produce at least one fixable diagnostic.
        let fixable = app
            .diagnostics
            .iter()
            .position(|d| !d.suggestions.is_empty());
        assert!(fixable.is_some(), "expected a fixable spelling diagnostic");

        // Switch to the Suggestions tab and confirm it renders.
        app.show_right_tab(RightTab::Suggestions);
        assert_eq!(app.focus, Focus::Suggestions);
        let screen = render(&mut app);
        assert!(screen.contains("SUGGESTIONS"), "suggestions pane not shown");

        // Select the fixable diagnostic and apply its primary fix.
        app.suggest_sel = fixable.unwrap();
        let before = app.buffer.text();
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_ne!(
            app.buffer.text(),
            before,
            "applying a fix should edit the buffer"
        );
        assert!(
            !app.buffer.text().contains("sentance"),
            "misspelling not corrected"
        );

        // The edit is a single undo step.
        app.undo();
        assert_eq!(app.buffer.text(), before, "fix should undo in one step");
    }

    #[test]
    fn judge_withholds_a_disallowed_reply() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.coach_mode = CoachMode::Chat;
        app.accept_coach_reply(
            "What is the core claim you want the reader to accept?".into(),
            Some(Ok(crate::coach::Verdict {
                allow: false,
                reason: "smuggles a rewrite".into(),
            })),
        );
        let last = app.coach_turns.last().unwrap();
        assert!(
            last.text.contains("withheld by judge") && last.text.contains("smuggles a rewrite"),
            "got: {}",
            last.text
        );
    }

    #[test]
    fn judge_failure_fails_open_with_a_note() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.coach_mode = CoachMode::Chat;
        let reply = "What is the core claim you want the reader to accept?".to_string();
        app.accept_coach_reply(reply.clone(), Some(Err("connection refused".into())));
        assert_eq!(app.coach_turns.last().unwrap().text, reply);
        assert!(
            app.message.contains("judge unavailable"),
            "expected a fail-open note, got: {}",
            app.message
        );
    }

    #[test]
    fn cycle_model_without_a_list_just_hints() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.open_coach_settings();
        app.cycle_model(1);
        let s = app.coach_settings.as_ref().unwrap();
        assert!(s.model.is_empty() || s.model == DEFAULT_MODEL);
        assert!(s.status.as_deref().unwrap().contains("Test the connection"));
    }

    #[test]
    fn conn_test_event_fills_dialog_and_defaults_model() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.open_coach_settings();
        app.coach_settings.as_mut().unwrap().testing = true;
        // Mimic test_connection bumping the generation before the task runs.
        app.conn_generation += 1;
        app.conn_tx
            .send(ConnTestEvent {
                generation: app.conn_generation,
                result: Ok(vec!["m1".into(), "m2".into()]),
            })
            .unwrap();
        app.drain_conn_test_events();
        let s = app.coach_settings.as_ref().unwrap();
        assert!(!s.testing);
        assert_eq!(s.models, vec!["m1".to_string(), "m2".to_string()]);
        assert_eq!(s.model, "m1"); // typed model wasn't offered → first listed
        assert!(s.status.as_deref().unwrap().starts_with('✓'));
    }

    #[test]
    fn stale_conn_test_event_is_ignored() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.open_coach_settings();
        app.conn_generation = 5;
        app.conn_tx
            .send(ConnTestEvent {
                generation: 4, // superseded
                result: Ok(vec!["old".into()]),
            })
            .unwrap();
        app.drain_conn_test_events();
        assert!(app.coach_settings.as_ref().unwrap().models.is_empty());
    }

    #[test]
    fn failed_conn_test_shows_error_and_clears_models() {
        let rt = rt();
        let mut app = test_app(&rt);
        app.open_coach_settings();
        app.coach_settings.as_mut().unwrap().models = vec!["stale".into()];
        app.conn_generation += 1;
        app.conn_tx
            .send(ConnTestEvent {
                generation: app.conn_generation,
                result: Err("connection refused".into()),
            })
            .unwrap();
        app.drain_conn_test_events();
        let s = app.coach_settings.as_ref().unwrap();
        assert!(s.models.is_empty());
        assert!(s.status.as_deref().unwrap().starts_with('✗'));
    }
}
