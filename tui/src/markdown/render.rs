//! Render markdown to `ratatui` text cells, converting LaTeX math to Unicode.
//!
//! Uses `pulldown-cmark` (with `ENABLE_MATH`) so `$...$` and `$$...$$` arrive
//! as `Event::InlineMath` / `Event::DisplayMath`, which we pass through the
//! vendored [`super::math::latex_to_unicode`].

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

use super::math::latex_to_unicode;

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

/// Render markdown source to ratatui [`Text`], with inline/display math
/// converted to Unicode. Best-effort styling: headings, bold/italic,
/// inline + block code, lists, blockquotes, task-list markers.
pub fn render_to_text(src: &str) -> Text<'static> {
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
                style = heading_style(level);
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
                style = code_style();
            }
            Event::End(TagEnd::CodeBlock) => {
                flush_line(&mut lines, &mut cur);
                in_code_block = false;
                style = Style::default();
            }
            Event::Code(s) => cur.push(Span::styled(s.into_string(), code_style())),

            Event::Text(s) => {
                if in_code_block {
                    for (i, line) in s.lines().enumerate() {
                        if i > 0 {
                            flush_line(&mut lines, &mut cur);
                        }
                        cur.push(Span::styled(line.to_string(), code_style()));
                    }
                } else {
                    cur.push(Span::styled(s.into_string(), style));
                }
            }

            Event::InlineMath(s) => cur.push(Span::styled(latex_to_unicode(&s), math_style())),
            Event::DisplayMath(s) => {
                flush_line(&mut lines, &mut cur);
                lines.push(Line::from(vec![Span::styled(
                    latex_to_unicode(&s),
                    math_style(),
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

            Event::Start(Tag::BlockQuote(_)) => style = style.fg(Color::DarkGray),
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

fn heading_style(level: HeadingLevel) -> Style {
    let color = match level {
        HeadingLevel::H1 => Color::Cyan,
        HeadingLevel::H2 => Color::LightCyan,
        HeadingLevel::H3 => Color::Blue,
        _ => Color::LightBlue,
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn math_style() -> Style {
    Style::default()
        .fg(Color::Magenta)
        .add_modifier(Modifier::ITALIC)
}

fn code_style() -> Style {
    Style::default().fg(Color::Yellow)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let t = render_to_text("Energy is $E = mc^2$ here.");
        let rendered = all_text(&t);
        assert!(rendered.contains("E = mc²"), "got: {rendered}");
    }

    #[test]
    fn renders_display_math_on_its_own_line() {
        let t = render_to_text("Intro.\n\n$$\\sum_{i=1}^{n} x_i$$\n\nOutro.");
        let rendered = all_text(&t);
        assert!(rendered.contains('∑'), "got: {rendered}");
    }

    #[test]
    fn renders_heading_and_bold() {
        let t = render_to_text("# Title\n**bold**");
        let rendered = all_text(&t);
        assert!(rendered.contains("Title"));
        assert!(rendered.contains("bold"));
    }
}
