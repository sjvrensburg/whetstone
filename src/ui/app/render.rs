//! The rendering layer: the `draw` entry point and every `draw_*` overlay,
//! pulled out of the application-state module. These functions read `App`
//! directly (they live in a child module, so they see its private fields) and
//! paint a single [`ratatui::Frame`]; they hold no state of their own.

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};

use super::*;

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
pub(super) fn format_structured_coaching(c: &StructuredCoaching) -> String {
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
    // The dialog is a fixed 76 cols wide (clamped to the terminal); the value
    // column is what's left after the borders and the gutter. Used to window
    // long values so they scroll rather than clip at the box edge.
    let value_w = 76u16
        .min(area.width)
        .saturating_sub(2)
        .saturating_sub(gutter);
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
        let (vis, _) = scroll_field_tail(&value, value_w);
        lines.push(Line::from(vec![
            Span::styled(format!("{marker}{label:<9} "), label_style),
            Span::styled(vis, theme.text()),
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

    // The key hint is a pinned footer (rendered on the last inner row, outside
    // the scroll region) so it stays visible no matter how the body scrolls.
    let hint =
        "Tab/↑↓ field · ←/→ provider/toggle · Ctrl+T test · Ctrl+N/P model · Enter save · Esc";

    // borders (2) + the body lines + a pinned 1-row footer.
    let height = (lines.len() as u16) + 3;
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
    // Reserve the last inner row for the pinned hint footer; the body scrolls
    // within what's left.
    let body_h = inner.height.saturating_sub(1) as usize;

    // When the content is taller than the terminal, scroll so the focused
    // field stays in view (rather than clipping the lower fields off the bottom
    // on a short terminal). Bottom-align the focus once it falls past the first
    // screenful; clamp so we never scroll past the end.
    let content = lines.len();
    let max_scroll = content.saturating_sub(body_h);
    let focus_line = field_line_idx[s.field];
    let scroll = if focus_line < body_h {
        0
    } else {
        (focus_line + 1 - body_h).min(max_scroll)
    };
    // On-screen row of a content line, or None when scrolled out of view.
    let visible_row = |line: usize| -> Option<u16> {
        if line >= scroll && line < scroll + body_h {
            Some(inner.y + (line - scroll) as u16)
        } else {
            None
        }
    };

    // Record where the (visible portion of the) model list landed so clicks can
    // hit it, accounting for the scroll offset.
    let vis_models_start = models_top.max(scroll);
    let vis_models_end = (models_top + models_shown).min(scroll + body_h);
    app.coach_models_rect = if models_shown > 0 && vis_models_end > vis_models_start {
        app.coach_models_start = models_start + (vis_models_start - models_top);
        Rect {
            x: inner.x,
            y: inner.y + (vis_models_start - scroll) as u16,
            width: inner.width,
            height: (vis_models_end - vis_models_start) as u16,
        }
    } else {
        Rect::default()
    };
    // Record each field's on-screen row so clicks and the caret can find them;
    // a field scrolled out of view gets a sentinel that no click row matches.
    for (idx, line_idx) in field_line_idx.iter().enumerate() {
        app.coach_field_rows[idx] = visible_row(*line_idx).unwrap_or(u16::MAX);
    }

    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    // Scrollable body (everything except the pinned footer row).
    let body = Rect {
        x: inner.x,
        y: inner.y,
        width: inner.width,
        height: body_h as u16,
    };
    frame.render_widget(Paragraph::new(lines).scroll((scroll as u16, 0)), body);
    // Pinned hint footer on the last inner row.
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(hint, theme.dim()))),
        Rect {
            x: inner.x,
            y: inner.bottom().saturating_sub(1),
            width: inner.width,
            height: 1,
        },
    );

    // Caret at the end of a text field's value (windowed to the value column);
    // provider/toggle fields aren't typed, so the caret sits at the value start.
    let typed_value = match s.field {
        F_BASE_URL => Some(s.base_url.as_str()),
        F_API_KEY => Some(s.api_key.as_str()),
        F_MODEL => Some(s.model.as_str()),
        F_JUDGE_BASE_URL => Some(s.judge_base_url.as_str()),
        F_JUDGE_API_KEY => Some(s.judge_api_key.as_str()),
        F_JUDGE_MODEL => Some(s.judge_model.as_str()),
        _ => None,
    };
    let caret_col = typed_value
        .map(|v| scroll_field_tail(v, value_w).1)
        .unwrap_or(0);
    let cx = (inner.x + gutter + caret_col).min(inner.right().saturating_sub(1));
    // The focused field is always within the scroll window by construction.
    let cy = visible_row(focus_line).unwrap_or_else(|| inner.bottom().saturating_sub(1));
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
        row("Ctrl+Shift+E / X", "Export HTML · export text (no Quarto needed)"),
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

/// Window a single-line input field whose caret sits at the end, so the tail
/// stays on screen once the value is wider than `width` cells. Returns the
/// slice to render and the caret column within the field. Measured in chars to
/// match the rest of the input/caret math; `width` is the cells available for
/// the value (after any prefix/gutter). Without this, a long value renders off
/// the box edge under a stationary caret — typed text becomes invisible.
fn scroll_field_tail(value: &str, width: u16) -> (String, u16) {
    let w = width.max(1) as usize;
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < w {
        (chars.iter().collect(), chars.len() as u16)
    } else {
        // Reserve the trailing cell for the caret; show the last `w - 1` chars.
        let start = chars.len() + 1 - w;
        (chars[start..].iter().collect(), (w - 1) as u16)
    }
}

fn draw_claim_gate(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let pop = centered_rect_abs(76, 10, area);
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
    let (claim_vis, claim_caret) =
        scroll_field_tail(&app.claim_input, inner.width.saturating_sub(2));
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
            Span::styled(claim_vis, theme.text()),
        ]),
        Line::raw(""),
        Line::from(Span::styled(
            "Enter to save · Esc to cancel · Ctrl+K reopens this later",
            theme.dim(),
        )),
    ];
    frame.render_widget(Clear, pop);
    frame.render_widget(Paragraph::new(lines).block(block), pop);
    let cx = inner.x + 2 + claim_caret;
    frame.set_cursor_position((cx.min(inner.right().saturating_sub(1)), inner.y + 3));
}

fn draw_teachback(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let pop = centered_rect_abs(76, 10, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border(true))
        .style(theme.panel_bg())
        .title(Line::from(Span::styled(
            " Teach-back checkpoint ",
            theme.title(true),
        )));
    let inner = block.inner(pop);
    let (tb_vis, tb_caret) = scroll_field_tail(&app.teachback_input, inner.width.saturating_sub(2));
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
            Span::styled(tb_vis, theme.text()),
        ]),
        Line::raw(""),
        Line::from(Span::styled("Enter to record · Esc to skip", theme.dim())),
    ];
    frame.render_widget(Clear, pop);
    frame.render_widget(Paragraph::new(lines).block(block), pop);
    let cx = inner.x + 2 + tb_caret;
    frame.set_cursor_position((cx.min(inner.right().saturating_sub(1)), inner.y + 3));
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
        // Diagnostics are sorted by `start` (harper.rs contract), so binary-
        // search to the subset that could overlap this line instead of scanning
        // the whole vector per visible line — O(log n + k) per line vs O(n).
        let line_diags =
            diagnostics_overlapping(&app.diagnostics, start, start + text.chars().count());
        lines.push(styled_line(
            &text,
            start,
            line_diags,
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
    // `preview_cache` was just populated above when `stale`, so it is `Some`
    // here — but guard anyway so a future refactor that skips the refresh can't
    // panic the TUI.
    let Some((_, _, _, text, content)) = app.preview_cache.as_ref() else {
        return;
    };
    let (text, content) = (text.clone(), *content);
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
        let body = super::truncate_to(&body, width);
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
    let prefix_w = prefix.chars().count() as u16;
    let (content, caret) = if enabled {
        scroll_field_tail(&app.coach_input, area.width.saturating_sub(prefix_w))
    } else {
        (String::new(), 0)
    };
    let line = Line::from(vec![
        Span::styled(prefix, pstyle),
        Span::styled(content, theme.text()),
    ]);
    let para = Paragraph::new(line).style(theme.panel_bg());
    frame.render_widget(para, area);

    if focused && !app.has_overlay() {
        let cx = area.x + prefix_w + caret;
        let cx = cx.min(area.right().saturating_sub(1));
        frame.set_cursor_position((cx, area.y));
    }
}

fn draw_status(frame: &mut Frame, app: &mut App, area: Rect) {
    let theme = app.theme;
    let (line, col) = app.buffer.cursor_line_col();
    let dirty = if app.dirty { "*" } else { " " };
    // A live word count is a basic expectation in a writing tool. Cached on the
    // App against edit_version (word_count NFKC-normalizes the whole buffer, so
    // calling it per-frame would freeze the editor on a large document).
    let words = app.word_count();
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
        " {}{dirty} │ {}:{} │ {words}w │ {gram} {mirror}│ {friction} │ {} ",
        app.file_label(),
        line + 1,
        col + 1,
        app.message,
    );
    frame.render_widget(Paragraph::new(status).style(theme.status()), area);
}

/// The subset of `diags` (sorted by `start`) whose `[start, end)` overlaps the
/// char range `[from, to)`. Binary-searches for the first diag that starts at
/// or after `from`, then walks backward and forward to include earlier diags
/// whose end extends into the range. O(log n + k) where k is the overlap count.
fn diagnostics_overlapping(diags: &[Diagnostic], from: usize, to: usize) -> &[Diagnostic] {
    if diags.is_empty() || to <= from {
        return &[];
    }
    // First diag with start >= from (lower bound on `start`).
    let lower = diags.partition_point(|d| d.start < from);
    // Walk backward to catch diags that start before `from` but end inside it.
    let mut lo = lower;
    while lo > 0 && diags[lo - 1].end > from {
        lo -= 1;
    }
    // Walk forward from `lower`; diags with start < to overlap (sorted, so we
    // can stop at the first diag starting at or after `to`).
    let mut hi = lower;
    while hi < diags.len() && diags[hi].start < to {
        hi += 1;
    }
    &diags[lo..hi]
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
            // Quarantine is signalled by color alone in the theme; add an
            // underline so a colorblind user (esp. deuteranopia against the
            // amber-on-dark default) can tell a quarantined region apart from a
            // selection. Layered on top of theme.quarantine() (which keeps its
            // own BOLD) rather than changing the theme, so existing palettes are
            // unaffected apart from the added non-color cue.
            theme.quarantine().add_modifier(Modifier::UNDERLINED)
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

/// The style for one grammar severity. Error and Warning both underline (a real
/// problem), differing by color; Style (a suggestion) is dimmed instead, so the
/// underline itself encodes "this needs fixing" rather than only the color — a
/// second non-color cue for colorblind users beyond the status-bar count.
fn severity_style(sev: Option<Severity>, theme: &Theme) -> Style {
    match sev {
        Some(Severity::Error) => Style::default()
            .fg(theme.error)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Warning) => Style::default()
            .fg(theme.warning)
            .add_modifier(Modifier::UNDERLINED),
        Some(Severity::Style) => Style::default().fg(theme.hint).add_modifier(Modifier::DIM),
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
    let value_w = inner.width.saturating_sub(gutter);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut active_caret = 0u16;
    for (i, label) in labels.iter().enumerate() {
        let focused = p.active == i;
        let marker = if focused { "▸ " } else { "  " };
        let lstyle = if focused { theme.accent() } else { theme.dim() };
        let (vis, caret) = scroll_field_tail(&p.fields[i], value_w);
        if focused {
            active_caret = caret;
        }
        lines.push(Line::from(vec![
            Span::styled(format!("{marker}{label:<6} "), lstyle),
            Span::styled(vis, theme.text()),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(p.kind.hint(), theme.dim())));
    frame.render_widget(Clear, rect);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
    let cx = (inner.x + gutter + active_caret).min(inner.right().saturating_sub(1));
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
    use crate::grammar::{Diagnostic, Severity};

    fn diag(start: usize, end: usize) -> Diagnostic {
        Diagnostic {
            start,
            end,
            message: String::new(),
            severity: Severity::Error,
            suggestions: vec![],
        }
    }

    #[test]
    fn diagnostics_overlapping_returns_only_the_subset() {
        // Sorted by start (the harper contract).
        let diags = vec![
            diag(0, 5),
            diag(10, 20),
            diag(20, 30),
            diag(100, 110),
            diag(200, 205),
        ];
        // Line covering chars [15, 25): overlaps diag(10,20), diag(20,30).
        let got = diagnostics_overlapping(&diags, 15, 25);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].start, 10);
        assert_eq!(got[1].start, 20);
    }

    #[test]
    fn diagnostics_overlapping_catches_diag_starting_before_the_line() {
        // A diag starting before `from` but ending inside the range must be
        // included (the backward walk).
        let diags = vec![diag(5, 15), diag(50, 60)];
        let got = diagnostics_overlapping(&diags, 10, 20);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].start, 5);
    }

    #[test]
    fn diagnostics_overlapping_handles_empty_and_no_overlap() {
        assert!(diagnostics_overlapping(&[], 0, 10).is_empty());
        let diags = vec![diag(100, 200)];
        assert!(diagnostics_overlapping(&diags, 0, 50).is_empty());
        // Zero-width range.
        let diags = vec![diag(5, 10)];
        assert!(diagnostics_overlapping(&diags, 7, 7).is_empty());
    }

    #[test]
    fn diagnostics_overlapping_returns_all_when_all_overlap() {
        let diags = vec![diag(0, 5), diag(5, 10), diag(10, 15)];
        let got = diagnostics_overlapping(&diags, 0, 15);
        assert_eq!(got.len(), 3);
    }
}
