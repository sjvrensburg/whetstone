//! The application state, key/paste/mouse handling, and three-pane layout
//! (editor | preview+coach) with a coach input line and status bar.
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
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};

use crate::coach::{CoachClient, CoachConfig};
use crate::core::disclosure::render_disclosure;
use crate::core::guard::screen_chat_reply;
use crate::core::mirror::compute_mirror;
use crate::core::process_event::{Location, MetaValue, ProcessEvent, ProcessEventType};
use crate::core::prompts::{ChatTurn, ChatTurnRole, build_chat_messages};
use crate::editor::buffer::Buffer;
use crate::editor::quarantine::{Outcome, Quarantine, Region};
use crate::editor::transaction::ChangeSet;
use crate::grammar::{Diagnostic, Linter, Severity};
use crate::instruments;
use crate::markdown::render::render_to_text;

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

    tokio: tokio::runtime::Handle,
    client: Option<CoachClient>,
    coach_tx: Option<mpsc::Sender<CoachEvent>>,
    coach_rx: Option<mpsc::Receiver<CoachEvent>>,
    coach_turns: Vec<ChatTurn>,
    coach_input: String,
    coach_streaming: String,
    coach_busy: bool,
    focus: Focus,
    coach_inner: Rect,
    coach_scroll: usize,
    coach_input_rect: Rect,
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

        let client = coach_config.map(CoachClient::new);
        let (coach_tx, coach_rx) = mpsc::channel();
        let coach_enabled = client.is_some();

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
            coach_tx: if coach_enabled { Some(coach_tx) } else { None },
            coach_rx: if coach_enabled { Some(coach_rx) } else { None },
            coach_turns: Vec::new(),
            coach_input: String::new(),
            coach_streaming: String::new(),
            coach_busy: false,
            focus: Focus::Editor,
            coach_inner: Rect::default(),
            coach_scroll: 0,
            coach_input_rect: Rect::default(),
            journal: Vec::new(),
            event_seq: 0,
            quarantine: Quarantine::new(),
            claim,
            gated,
            claim_input: String::new(),
            teachback_pending: false,
            teachback_input: String::new(),
            last_para_count: pc0,
            next_teachback: ((pc0 / 3) + 1) * 3,
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

    pub fn should_quit(&self) -> bool {
        self.quit
    }

    pub fn handle_paste(&mut self, text: &str) {
        if text.is_empty() {
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
                self.last_change = Some(cs.clone());
                let after = self.buffer.text();
                let outcomes = self.quarantine.apply(&cs, &after);
                self.log_quarantine_outcomes(outcomes);
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
                self.dirty = true;
                self.lint_dirty = true;
                self.last_edit = Some(Instant::now());
                self.message = format!("Pasted {n} chars");
                self.reveal_cursor();
            }
            Focus::Coach => self.coach_input.push_str(text),
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
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
        // Global control keys.
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('k') => {
                    self.claim_input = self.claim.clone().unwrap_or_default();
                    self.gated = true;
                }
                KeyCode::Char('d') => self.export_disclosure(),
                KeyCode::Char('m') if self.focus == Focus::Editor => self.attribute_region(),
                KeyCode::Char('s') => self.save(),
                KeyCode::Char('c') | KeyCode::Char('q') => self.quit = true,
                KeyCode::Char('l') if self.client.is_some() => {
                    self.focus = match self.focus {
                        Focus::Editor => Focus::Coach,
                        Focus::Coach => Focus::Editor,
                    };
                    self.coach_input.clear();
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

    fn handle_editor_key(&mut self, key: KeyEvent) {
        let change = match key.code {
            KeyCode::Char(c) if !c.is_control() => Some(self.buffer.type_char(c)),
            KeyCode::Enter => Some(self.buffer.type_str("\n")),
            KeyCode::Tab => Some(self.buffer.type_str("    ")),
            KeyCode::Backspace => self.buffer.delete_backward(),
            KeyCode::Delete => self.buffer.delete_forward(),
            KeyCode::Left => {
                self.buffer.move_left();
                return;
            }
            KeyCode::Right => {
                self.buffer.move_right();
                return;
            }
            KeyCode::Up => {
                self.buffer.move_up();
                return;
            }
            KeyCode::Down => {
                self.buffer.move_down();
                return;
            }
            KeyCode::Home => {
                self.buffer.move_line_start();
                return;
            }
            KeyCode::End => {
                self.buffer.move_line_end();
                return;
            }
            KeyCode::PageUp => {
                let h = self.editor_height.max(1);
                for _ in 0..h {
                    self.buffer.move_up();
                }
                return;
            }
            KeyCode::PageDown => {
                let h = self.editor_height.max(1);
                for _ in 0..h {
                    self.buffer.move_down();
                }
                return;
            }
            _ => return,
        };
        let Some(change) = change else {
            return;
        };
        let cs = ChangeSet::single(change);
        self.last_change = Some(cs.clone());
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
        let after = self.buffer.text();
        let outcomes = self.quarantine.apply(&cs, &after);
        self.log_quarantine_outcomes(outcomes);
        self.maybe_trigger_teachback(&after);
        self.dirty = true;
        self.lint_dirty = true;
        self.last_edit = Some(Instant::now());
        self.reveal_cursor();
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
        // Insert the closer first so the opening-quote offset is unchanged.
        self.buffer.insert_str(r.to, closer);
        self.buffer.insert_str(r.from, "\"");
        self.quarantine.remove(&r.id);
        self.log_event(
            ProcessEventType::PasteAttributed,
            Some((r.to - r.from) as u32),
            Some(Location {
                from: r.from as u32,
                to: (r.to + closer_len + 1) as u32,
            }),
            vec![("regionId", MetaValue::Str(r.id))],
        );
        self.last_change = None;
        self.dirty = true;
        self.lint_dirty = true;
        self.last_edit = Some(Instant::now());
        self.reveal_cursor();
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
        let (Some(client), Some(tx)) = (self.client.clone(), self.coach_tx.clone()) else {
            self.message = "Coach not configured".into();
            return;
        };
        if self.coach_busy {
            self.message = "Coach is already thinking…".into();
            return;
        }
        let msg = std::mem::take(&mut self.coach_input);
        if msg.trim().is_empty() {
            return;
        }
        // History is everything before the turn we're about to send.
        let history: Vec<ChatTurn> = self.coach_turns.to_vec();
        self.coach_turns.push(ChatTurn {
            role: ChatTurnRole::Writer,
            text: msg.clone(),
        });
        let context = self.buffer.text();
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
        let Some(rx) = self.coach_rx.as_mut() else {
            return;
        };
        while let Ok(ev) = rx.try_recv() {
            match ev {
                CoachEvent::Delta(d) => self.coach_streaming.push_str(&d),
                CoachEvent::Done(res) => {
                    self.coach_busy = false;
                    self.coach_streaming.clear();
                    match res {
                        Ok(reply) => {
                            let ctx = self.buffer.text();
                            match screen_chat_reply(&reply, &ctx) {
                                Ok(()) => {
                                    self.coach_turns.push(ChatTurn {
                                        role: ChatTurnRole::Coach,
                                        text: reply,
                                    });
                                    self.message = "Coach replied.".into();
                                }
                                Err(reason) => {
                                    self.coach_turns.push(ChatTurn {
                                        role: ChatTurnRole::Coach,
                                        text: format!("(withheld by guard: {reason})"),
                                    });
                                    self.message = "Coach reply withheld by guard.".into();
                                }
                            }
                        }
                        Err(e) => self.message = format!("Coach error: {e}"),
                    }
                }
            }
        }
    }

    /// Check whether a new paragraph crossed a teach-back threshold.
    fn maybe_trigger_teachback(&mut self, text: &str) {
        let pc = instruments::paragraph_count(text);
        if pc > self.last_para_count && pc >= self.next_teachback {
            self.teachback_pending = true;
            self.teachback_input.clear();
            self.next_teachback = pc + 3;
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
                    let col = (ev.column as usize).saturating_sub(inner.x as usize);
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
    let cols = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(area);
    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(cols[0]);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(main[1]);

    draw_editor(frame, app, main[0]);
    draw_preview(frame, app, right[0]);
    draw_coach(frame, app, right[1]);
    draw_coach_input(frame, app, cols[1]);
    draw_status(frame, app, cols[2]);

    if app.gated {
        draw_claim_gate(frame, app, area);
    } else if app.teachback_pending {
        draw_teachback(frame, app, area);
    }
}

fn draw_claim_gate(frame: &mut Frame, app: &mut App, area: Rect) {
    let pop = centered_rect(76, 10, area);
    let title = if app.claim.is_some() {
        " Edit your claim "
    } else {
        " State your claim "
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    let inner = block.inner(pop);
    let lines = vec![
        Line::from("State what you intend to argue in this piece."),
        Line::from(Span::styled(
            "Recorded locally only — it is never sent to any model.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("▶ ", Style::default().fg(Color::Yellow)),
            Span::raw(app.claim_input.clone()),
        ]),
        Line::raw(""),
        Line::from(Span::styled(
            "Enter to save · Esc to cancel · Ctrl+K reopens this later",
            Style::default().fg(Color::DarkGray),
        )),
    ];
    frame.render_widget(Clear, pop);
    frame.render_widget(Paragraph::new(lines).block(block), pop);
    let cx = inner.x + 2 + app.claim_input.chars().count() as u16;
    frame.set_cursor_position((cx.min(inner.right().saturating_sub(1)), inner.y + 3));
}

fn draw_teachback(frame: &mut Frame, app: &mut App, area: Rect) {
    let pop = centered_rect(76, 10, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Teach-back checkpoint ");
    let inner = block.inner(pop);
    let lines = vec![
        Line::from("In a sentence or two, what is your argument so far?"),
        Line::from(Span::styled(
            "If you can't summarize it, that's signal — recorded locally only.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("▶ ", Style::default().fg(Color::Yellow)),
            Span::raw(app.teachback_input.clone()),
        ]),
        Line::raw(""),
        Line::from(Span::styled(
            "Enter to record · Esc to skip",
            Style::default().fg(Color::DarkGray),
        )),
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
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" EDIT — {} ", app.file_label()));
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
        ));
    }
    let para = Paragraph::new(lines).block(block);
    frame.render_widget(para, area);

    // Position the terminal cursor only when the editor is focused.
    if app.focus == Focus::Editor {
        let (line, col) = app.buffer.cursor_line_col();
        let max_col = inner.width.saturating_sub(1) as usize;
        let cx = inner.x + col.min(max_col) as u16;
        let cy = inner.y + line.saturating_sub(app.editor_scroll) as u16;
        frame.set_cursor_position((cx, cy));
    }

    render_scrollbar(frame, area, total, app.editor_scroll, app.editor_height);
}

fn draw_preview(frame: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default().borders(Borders::ALL).title(" PREVIEW ");
    let inner = block.inner(area);
    app.preview_height = inner.height as usize;
    app.preview_inner = inner;

    let text = render_to_text(&app.buffer.text());
    let content = wrapped_height(&text, inner.width as usize);
    let max = content.saturating_sub(app.preview_height);
    if app.preview_scroll > max {
        app.preview_scroll = max;
    }
    let para = Paragraph::new(text)
        .block(block)
        .wrap(Wrap { trim: false })
        .scroll((app.preview_scroll as u16, 0));
    frame.render_widget(para, area);
    render_scrollbar(frame, area, content, app.preview_scroll, app.preview_height);
}

fn draw_coach(frame: &mut Frame, app: &mut App, area: Rect) {
    let block = Block::default().borders(Borders::ALL).title(" COACH ");
    app.coach_inner = block.inner(area);

    let mut lines: Vec<Line<'static>> = Vec::new();
    if app.client.is_none() {
        lines.push(Line::from(Span::styled(
            "Coach disabled. Set WHETSTONE_BASE_URL (and optionally WHETSTONE_API_KEY,\nWHETSTONE_MODEL) to enable — e.g. an Ollama or LM Studio endpoint.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        for t in &app.coach_turns {
            let (label, color) = match t.role {
                ChatTurnRole::Writer => ("you", Color::Blue),
                ChatTurnRole::Coach => ("coach", Color::Green),
            };
            for (i, l) in t.text.split('\n').enumerate() {
                let prefix = if i == 0 {
                    format!("{label}: ")
                } else {
                    "    ".into()
                };
                lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(color)),
                    Span::raw(l.to_string()),
                ]));
            }
        }
        if app.coach_busy {
            lines.push(Line::from(vec![
                Span::styled("coach: ", Style::default().fg(Color::Green)),
                Span::raw(app.coach_streaming.clone()),
                Span::styled("▌", Style::default().fg(Color::DarkGray)),
            ]));
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "Ask about your draft. Press Ctrl+L (or click the input below) to focus.",
                Style::default().fg(Color::DarkGray),
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
        .wrap(Wrap { trim: false })
        .scroll((app.coach_scroll as u16, 0));
    frame.render_widget(para, area);
    render_scrollbar(
        frame,
        area,
        content,
        app.coach_scroll,
        app.coach_inner.height as usize,
    );
}

fn draw_coach_input(frame: &mut Frame, app: &mut App, area: Rect) {
    app.coach_input_rect = area;
    let enabled = app.client.is_some();
    let (prefix, pstyle) = match (enabled, app.focus == Focus::Coach) {
        (false, _) => (" coach: disabled ", Style::default().fg(Color::DarkGray)),
        (true, true) => ("> ", Style::default().fg(Color::Yellow)),
        (true, false) => (" coach (Ctrl+L) ", Style::default().fg(Color::DarkGray)),
    };
    let content = if enabled {
        app.coach_input.clone()
    } else {
        String::new()
    };
    let content_chars = content.chars().count();
    let line = Line::from(vec![Span::styled(prefix, pstyle), Span::raw(content)]);
    let para = Paragraph::new(line).style(Style::default().bg(Color::Black));
    frame.render_widget(para, area);

    if enabled && app.focus == Focus::Coach {
        let cx = area.x + prefix.chars().count() as u16 + content_chars as u16;
        let cx = cx.min(area.right().saturating_sub(1));
        frame.set_cursor_position((cx, area.y));
    }
}

fn draw_status(frame: &mut Frame, app: &mut App, area: Rect) {
    let (line, col) = app.buffer.cursor_line_col();
    let dirty = if app.dirty { "*" } else { " " };
    let gram = if app.diagnostics.is_empty() {
        "✓".to_string()
    } else {
        format!("⚠{}", app.diagnostics.len())
    };
    let mirror = {
        let c = compute_mirror(&app.journal).composition;
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
    let para = Paragraph::new(status).style(Style::default().fg(Color::Black).bg(Color::DarkGray));
    frame.render_widget(para, area);
}

/// Build a styled [`Line`] for one source line, underlining any diagnostics
/// that overlap it. `start` is the line's char offset in the document.
fn styled_line(
    text: &str,
    start: usize,
    diags: &[Diagnostic],
    regions: &[Region],
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
            if q { quarantine_style() } else { style_for(s) },
        ));
        i = j;
    }
    if spans.is_empty() {
        Line::raw("")
    } else {
        Line::from(spans)
    }
}

fn quarantine_style() -> Style {
    Style::default()
        .fg(Color::Black)
        .bg(Color::Yellow)
        .add_modifier(Modifier::BOLD)
}

fn style_for(sev: Option<Severity>) -> Style {
    match sev {
        Some(Severity::Error) => Style::default()
            .fg(Color::Red)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Warning) => Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Style) => Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::UNDERLINED),
        None => Style::default().fg(Color::Gray),
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
) {
    if content <= viewport {
        return;
    }
    let mut state = ScrollbarState::new(content)
        .position(position.min(content))
        .viewport_content_length(viewport);
    let bar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .begin_symbol(None)
        .end_symbol(None);
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
