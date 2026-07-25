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

/// Render `src` as a standalone HTML5 document, stripping any leading YAML
/// frontmatter first. Uses pulldown-cmark's built-in HTML writer (no feature
/// gate required) with the same parsing options as the terminal renderer, so a
/// `.qmd`/`.md` file exports faithfully without needing Quarto installed. The
/// rendered body is **sanitized** (raw `<script>`, inline event handlers,
/// `javascript:` URLs, and other XSS vectors are stripped) before it is wrapped
/// in a minimal styled template; the result is then run through the
/// forbidden-label guard so an export can't carry proof-of-personhood language.
///
/// The sanitizer is load-bearing: pulldown-cmark is a Markdown→HTML serializer,
/// not a sanitizer — it emits raw inline/block HTML verbatim, so without
/// ammonia a draft containing `<script>` or `<img onerror=…>` would produce an
/// HTML file that executes that payload when opened in a browser. The exported
/// file is meant to be shared (handed in, emailed), so XSS matters here.
pub fn render_to_html(src: &str) -> Result<String, String> {
    let body = strip_frontmatter(src);
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH;
    let parser = Parser::new_ext(body, opts);
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    // Sanitize the rendered body before wrapping. ammonia's defaults strip
    // <script>, on* event handlers, javascript: URLs, and unknown elements,
    // while keeping the Markdown-derived tags (h1-h6, p, a, code, pre, table,
    // blockquote, ul/ol/li, strong/em/del, etc.) intact.
    let safe_body = ammonia::clean(html.trim());
    let doc = HTML_TEMPLATE.replacen("{body}", &safe_body, 1);
    crate::core::labels::assert_no_forbidden_labels(&doc, "HTML export")?;
    Ok(doc)
}

/// A minimal styled HTML5 shell. The CSS is deliberately small and system-font
/// based so the export reads cleanly on its own without external assets, and so
/// the only interpolated value is the rendered body (kept `{body}` so a single
/// `replacen` is the whole substitution).
const HTML_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  pre, code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  pre { background: rgba(127, 127, 127, 0.12); padding: 0.75rem 1rem; overflow-x: auto; }
  code { background: rgba(127, 127, 127, 0.12); padding: 0.1em 0.3em; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid rgba(127, 127, 127, 0.4); margin: 0; padding-left: 1rem; color: rgba(127, 127, 127, 1); }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(127, 127, 127, 0.4); padding: 0.3em 0.6em; }
</style>
</head>
<body>
{body}
</body>
</html>"#;

/// Render `src` as plain text using the same terminal renderer, flattening the
/// styled `Text` to a string. This is the "no tooling at all" export: no
/// Markdown, no HTML, just the readable text as it renders in the preview pane.
pub fn render_to_plain(src: &str, theme: &Theme) -> Result<String, String> {
    let text = render_to_text(src, theme);
    let mut out = String::new();
    for line in text.lines {
        for span in line.spans {
            out.push_str(span.content.as_ref());
        }
        out.push('\n');
    }
    crate::core::labels::assert_no_forbidden_labels(&out, "text export")?;
    Ok(out)
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

    #[test]
    fn render_to_html_wraps_body_and_strips_frontmatter() {
        let src = "---\ntitle: Hi\n---\n\n# Heading\n\nSome **bold** text.\n";
        let html = render_to_html(src).unwrap();
        assert!(
            html.starts_with("<!doctype html>"),
            "missing doctype: {html}"
        );
        assert!(html.contains("<h1>Heading</h1>"), "missing h1: {html}");
        assert!(
            html.contains("<strong>bold</strong>"),
            "missing strong: {html}"
        );
        // Frontmatter must not leak into the body.
        assert!(!html.contains("title: Hi"), "frontmatter leaked: {html}");
    }

    #[test]
    fn render_to_html_renders_code_blocks() {
        let src = "Text.\n\n```rust\nfn main() {}\n```\n";
        let html = render_to_html(src).unwrap();
        assert!(html.contains("<pre><code"), "missing code block: {html}");
        assert!(html.contains("fn main()"), "missing code text: {html}");
    }

    #[test]
    fn render_to_html_blocks_a_forbidden_label() {
        // A proof-of-personhood label in the draft must not be exported.
        let src = "This draft is verified human writing.";
        assert!(render_to_html(src).is_err());
    }

    #[test]
    fn render_to_html_strips_script_tags() {
        // pulldown-cmark emits raw HTML verbatim; without sanitization a draft
        // containing <script> would execute when the exported file is opened.
        let src = "Text <script>alert(1)</script> more.";
        let html = render_to_html(src).unwrap();
        assert!(!html.contains("<script"), "script tag survived: {html}");
        assert!(!html.contains("alert(1)"), "script body survived: {html}");
        // The surrounding text is preserved.
        assert!(html.contains("Text"), "legit text dropped: {html}");
    }

    #[test]
    fn render_to_html_strips_inline_event_handlers() {
        // onerror / onload / onmouseover etc. must be stripped from kept tags.
        let src = "![alt](x) <img src=x onerror=alert(2)>";
        let html = render_to_html(src).unwrap();
        assert!(
            !html.contains("onerror"),
            "onerror handler survived: {html}"
        );
        assert!(!html.contains("alert"), "alert payload survived: {html}");
    }

    #[test]
    fn render_to_html_strips_javascript_urls() {
        // A javascript: link must not survive as a clickable href.
        let src = "[click](javascript:alert(4))";
        let html = render_to_html(src).unwrap();
        assert!(
            !html.contains("javascript:"),
            "javascript: URL survived: {html}"
        );
        // The link text is still there (ammonia keeps the anchor, drops the href).
        assert!(html.contains("click"), "link text dropped: {html}");
    }

    #[test]
    fn render_to_html_preserves_legit_markdown() {
        // The sanitizer must not strip the Markdown-derived tags that make the
        // export useful: headings, emphasis, code, lists, tables, blockquotes.
        let src = "# H\n\nA paragraph with **bold**, *italic*, `code`.\n\n> quote\n\n- item\n";
        let html = render_to_html(src).unwrap();
        assert!(html.contains("<h1>H</h1>"), "heading dropped: {html}");
        assert!(
            html.contains("<strong>bold</strong>"),
            "bold dropped: {html}"
        );
        assert!(html.contains("<em>italic</em>"), "italic dropped: {html}");
        assert!(html.contains("<code>code</code>"), "code dropped: {html}");
        assert!(html.contains("<blockquote>"), "blockquote dropped: {html}");
        assert!(html.contains("<li>"), "list item dropped: {html}");
    }

    #[test]
    fn render_to_plain_flattens_rendered_text() {
        let src = "# Title\n\nA paragraph with `code`.\n";
        let plain = render_to_plain(src, &THEMES[0]).unwrap();
        assert!(plain.contains("Title"));
        assert!(plain.contains("code"));
        assert!(!plain.contains("**"));
    }
}
