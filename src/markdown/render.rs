//! Render markdown to `ratatui` text cells, converting LaTeX math to Unicode.
//!
//! Uses `pulldown-cmark` (with `ENABLE_MATH`) so `$...$` and `$$...$$` arrive
//! as `Event::InlineMath` / `Event::DisplayMath`, which we pass through the
//! vendored [`super::math::latex_to_unicode`].

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};

use super::math::latex_to_unicode;
use crate::ui::Theme;

/// Strip a leading YAML frontmatter block (`---\n…\n---` / `...`) from `src`.
/// Returns `src` unchanged if there is no frontmatter. Used so the preview
/// doesn't render raw YAML as prose.
pub fn strip_frontmatter(src: &str) -> &str {
    // CRLF-tolerant: a leading `---` line may end with `\r\n`. `fence` compares
    // a line's bytes to a fence marker, ignoring a trailing `\r`.
    fn fence(line: &[u8]) -> bool {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        line == b"---" || line == b"..."
    }
    let bytes = src.as_bytes();
    let first_end = bytes
        .iter()
        .position(|&b| b == b'\n')
        .unwrap_or(bytes.len());
    if bytes[..first_end]
        .strip_suffix(b"\r")
        .unwrap_or(&bytes[..first_end])
        != b"---"
    {
        return src;
    }
    let mut start = if first_end < bytes.len() {
        first_end + 1
    } else {
        return src;
    };
    loop {
        let end = match bytes[start..].iter().position(|&b| b == b'\n') {
            Some(p) => start + p,
            None => {
                // Last line with no trailing newline.
                return if fence(&bytes[start..]) { "" } else { src };
            }
        };
        if fence(&bytes[start..end]) {
            return &src[end + 1..];
        }
        start = end + 1;
    }
}

/// Read a `claim:` (or `intent:`) value from a leading YAML frontmatter block.
/// Returns the trimmed, unquoted value if present.
pub fn frontmatter_claim(src: &str) -> Option<String> {
    let mut lines = src.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let t = line.trim();
        if t == "---" || t == "..." {
            break;
        }
        if let Some(rest) = t
            .strip_prefix("claim:")
            .or_else(|| t.strip_prefix("intent:"))
        {
            let v = rest
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .trim()
                .to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// A heading extracted from the document outline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    /// ATX level, `1..=6`.
    pub level: u8,
    pub title: String,
    /// 0-based line index in the source, matching the editor buffer's line
    /// numbering (newline-split), so jumping to it is a `set_cursor_line_col`.
    pub line: usize,
}

/// Extract the ATX-heading outline from `src`, skipping a leading YAML
/// frontmatter block and fenced code blocks (so a `#` comment in code is not
/// mistaken for a heading). Setext (`===` / `---` underline) headings are not
/// included — they collide with the frontmatter/`<hr>` syntax `.qmd` files use.
pub fn outline(src: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    // `Some(marker)` while inside a fenced code block; the marker is the fence
    // that opened it, so only a matching fence closes it.
    let mut fence: Option<&str> = None;
    let mut in_frontmatter = false;
    for (i, raw) in src.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        // A `---` on the very first line opens a frontmatter block.
        if i == 0 && line.trim() == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            let t = line.trim();
            if t == "---" || t == "..." {
                in_frontmatter = false;
            }
            continue;
        }
        // Toggle fenced code blocks (``` or ~~~); ignore everything inside one.
        let ts = line.trim_start();
        if ts.starts_with("```") || ts.starts_with("~~~") {
            let marker = if ts.starts_with("```") { "```" } else { "~~~" };
            match fence {
                None => fence = Some(marker),
                Some(open) if ts.starts_with(open) => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some(h) = parse_atx_heading(line, i) {
            out.push(h);
        }
    }
    out
}

/// Parse one line as an ATX heading (`# …` through `###### …`). Requires a
/// space after the hashes per CommonMark, so `#tag` is not a heading.
fn parse_atx_heading(line: &str, idx: usize) -> Option<Heading> {
    let t = line.trim_start();
    let hashes = t.chars().take_while(|&c| c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    // `#` is ASCII, so the byte offset equals the hash count.
    let rest = &t[hashes..];
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    // Drop any closing run of `#` (ATX closing sequence) and surrounding space.
    let title = rest.trim().trim_end_matches('#').trim().to_string();
    Some(Heading {
        level: hashes as u8,
        title,
        line: idx,
    })
}

/// Render markdown source to ratatui [`Text`], with inline/display math
/// converted to Unicode. Best-effort styling: headings, bold/italic,
/// inline + block code, lists, blockquotes, task-list markers.
pub fn render_to_text(src: &str, theme: &Theme) -> Text<'static> {
    let body = strip_frontmatter(src);
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let parser = Parser::new_ext(body, opts);

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut style = Style::default();
    let mut in_code_block = false;

    for event in parser {
        match event {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => flush_line(&mut lines, &mut cur),

            Event::Start(Tag::Heading { level, .. }) => {
                flush_line(&mut lines, &mut cur);
                style = heading_style(level, theme);
            }
            Event::End(TagEnd::Heading(_)) => {
                flush_line(&mut lines, &mut cur);
                style = Style::default();
            }

            Event::Start(Tag::Strong) => style = style.add_modifier(Modifier::BOLD),
            Event::End(TagEnd::Strong) => style = style.remove_modifier(Modifier::BOLD),
            Event::Start(Tag::Emphasis) => style = style.add_modifier(Modifier::ITALIC),
            Event::End(TagEnd::Emphasis) => style = style.remove_modifier(Modifier::ITALIC),
            Event::Start(Tag::Strikethrough) => {
                style = style.add_modifier(Modifier::CROSSED_OUT);
            }
            Event::End(TagEnd::Strikethrough) => {
                style = style.remove_modifier(Modifier::CROSSED_OUT);
            }

            Event::Start(Tag::CodeBlock(_)) => {
                flush_line(&mut lines, &mut cur);
                in_code_block = true;
                style = code_style(theme);
            }
            Event::End(TagEnd::CodeBlock) => {
                flush_line(&mut lines, &mut cur);
                in_code_block = false;
                style = Style::default();
            }
            Event::Code(s) => cur.push(Span::styled(s.into_string(), code_style(theme))),

            Event::Text(s) => {
                if in_code_block {
                    for (i, line) in s.lines().enumerate() {
                        if i > 0 {
                            flush_line(&mut lines, &mut cur);
                        }
                        cur.push(Span::styled(line.to_string(), code_style(theme)));
                    }
                } else {
                    cur.push(Span::styled(s.into_string(), style));
                }
            }

            Event::InlineMath(s) => cur.push(Span::styled(latex_to_unicode(&s), math_style(theme))),
            Event::DisplayMath(s) => {
                flush_line(&mut lines, &mut cur);
                lines.push(Line::from(vec![Span::styled(
                    latex_to_unicode(&s),
                    math_style(theme),
                )]));
            }

            Event::SoftBreak | Event::HardBreak => flush_line(&mut lines, &mut cur),

            Event::Start(Tag::List(_)) | Event::End(TagEnd::List(_)) => {
                flush_line(&mut lines, &mut cur);
            }
            Event::Start(Tag::Item) => {
                flush_line(&mut lines, &mut cur);
                cur.push(Span::raw("• "));
            }
            Event::End(TagEnd::Item) => flush_line(&mut lines, &mut cur),

            Event::Start(Tag::BlockQuote(_)) => style = style.fg(theme.quote),
            Event::End(TagEnd::BlockQuote(_)) => style = Style::default(),

            Event::TaskListMarker(checked) => {
                cur.push(Span::raw(if checked { "[x] " } else { "[ ] " }));
            }

            _ => {}
        }
    }
    flush_line(&mut lines, &mut cur);
    Text::from(lines)
}

fn flush_line(lines: &mut Vec<Line<'static>>, cur: &mut Vec<Span<'static>>) {
    lines.push(Line::from(std::mem::take(cur)));
}

fn heading_style(level: HeadingLevel, theme: &Theme) -> Style {
    let color = match level {
        HeadingLevel::H1 | HeadingLevel::H3 => theme.heading,
        _ => theme.heading_alt,
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn math_style(theme: &Theme) -> Style {
    Style::default()
        .fg(theme.math)
        .add_modifier(Modifier::ITALIC)
}

fn code_style(theme: &Theme) -> Style {
    Style::default().fg(theme.code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::THEMES;

    fn all_text(t: &Text<'_>) -> String {
        t.lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref().to_string()))
            .collect::<Vec<_>>()
            .join("")
    }

    #[test]
    fn strips_yaml_frontmatter() {
        let src = "---\ntitle: Hi\nauthor: Me\n---\n\n# Body\nText.";
        assert_eq!(strip_frontmatter(src), "\n# Body\nText.");
    }

    #[test]
    fn strips_crlf_frontmatter() {
        let src = "---\r\ntitle: Hi\r\n---\r\n\r\n# Body";
        assert_eq!(strip_frontmatter(src), "\r\n# Body");
    }

    #[test]
    fn leaves_text_without_frontmatter_untouched() {
        assert_eq!(
            strip_frontmatter("# No frontmatter\n"),
            "# No frontmatter\n"
        );
    }

    #[test]
    fn renders_inline_math_as_unicode() {
        let t = render_to_text("Energy is $E = mc^2$ here.", &THEMES[0]);
        let rendered = all_text(&t);
        assert!(rendered.contains("E = mc²"), "got: {rendered}");
    }

    #[test]
    fn renders_display_math_on_its_own_line() {
        let t = render_to_text("Intro.\n\n$$\\sum_{i=1}^{n} x_i$$\n\nOutro.", &THEMES[0]);
        let rendered = all_text(&t);
        assert!(rendered.contains('∑'), "got: {rendered}");
    }

    #[test]
    fn outline_collects_atx_headings_with_line_numbers() {
        let src = "---\ntitle: T\n---\n\n# One\n\ntext\n\n## Two\n\n### Three\n";
        let o = outline(src);
        assert_eq!(o.len(), 3);
        assert_eq!((o[0].level, o[0].title.as_str(), o[0].line), (1, "One", 4));
        assert_eq!((o[1].level, o[1].title.as_str(), o[1].line), (2, "Two", 8));
        assert_eq!(
            (o[2].level, o[2].title.as_str(), o[2].line),
            (3, "Three", 10)
        );
    }

    #[test]
    fn outline_skips_hashes_in_code_and_non_headings() {
        let src = "# Real\n\n```\n# not a heading\n```\n\n#notspaced\n## Also real\n";
        let o = outline(src);
        let titles: Vec<&str> = o.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(titles, vec!["Real", "Also real"]);
    }

    #[test]
    fn outline_strips_closing_hashes() {
        assert_eq!(outline("## Heading ##\n")[0].title, "Heading");
    }

    #[test]
    fn renders_heading_and_bold() {
        let t = render_to_text("# Title\n**bold**", &THEMES[0]);
        let rendered = all_text(&t);
        assert!(rendered.contains("Title"));
        assert!(rendered.contains("bold"));
    }
}
