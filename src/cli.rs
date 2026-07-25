//! Headless subcommands — the agentic interface.
//!
//! Each command runs non-interactively and prints a single JSON document to
//! stdout, so an agent, script, or CI step can drive Whetstone's core logic
//! (grammar, the coach, the guard + LLM judge, claim-to-own ownership,
//! disclosure rendering) without the TUI. The same `core`/`coach`/`grammar`
//! modules the editor uses back these, so the layering stays honest.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Subcommand;
use serde::Serialize;
use serde_json::{Value, json};

use whetstone_tui::coach::{CoachClient, CoachConfig};
use whetstone_tui::core::guard::screen_chat_reply;
use whetstone_tui::core::ownership::{is_claimed_to_own, survival_ratio};
use whetstone_tui::core::process_event::ProcessEvent;
use whetstone_tui::core::prompts::build_chat_messages;
use whetstone_tui::grammar::{Linter, Severity};

#[derive(Subcommand)]
pub enum Command {
    /// Open the editor (same as passing a bare file path).
    Open {
        /// Path to a `.qmd` / `.md` file to open (created if missing).
        file: PathBuf,
    },
    /// Lint a file with Harper; prints diagnostics as JSON.
    Lint { file: PathBuf },
    /// Run one coach turn over a file, screened by the guard (+ judge if set).
    Coach {
        file: PathBuf,
        /// The message to send the coach.
        #[arg(long)]
        message: String,
    },
    /// Screen an arbitrary reply with the deterministic guard (+ judge if set).
    Guard {
        /// The candidate reply text to screen.
        #[arg(long)]
        reply: String,
        /// Optional draft file for n-gram-overlap screening.
        #[arg(long)]
        draft: Option<PathBuf>,
    },
    /// Claim-to-own survival of an original paste within the current text.
    Ownership {
        /// The original pasted text.
        #[arg(long)]
        original: PathBuf,
        /// The current text.
        #[arg(long)]
        current: PathBuf,
    },
    /// Render a disclosure document from a journal (a JSON array of events).
    Disclosure {
        /// Path to a JSON array of `ProcessEvent`s.
        #[arg(long)]
        journal: PathBuf,
        /// Document id shown in the disclosure (default: the journal path).
        #[arg(long = "doc-id")]
        doc_id: Option<String>,
    },
    /// Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed).
    Export {
        /// The source Markdown/Quarto document.
        file: PathBuf,
        /// Output format.
        #[arg(long, value_enum, default_value_t = ExportFormat::Html)]
        format: ExportFormat,
        /// Output path (default: `<file>.html` or `<file>.txt`).
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Word counts for a document (prose + raw + characters/lines).
    Words { file: PathBuf },
}

/// The export format for the headless `export` subcommand.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    /// A standalone HTML5 document.
    Html,
    /// Plain text, as rendered by the preview pane.
    Text,
}

/// Run a headless subcommand, printing its JSON result to stdout.
pub fn run(command: Command) -> Result<()> {
    let out = match command {
        Command::Open { .. } => unreachable!("Open is handled by the TUI entry point"),
        Command::Lint { file } => lint(&file)?,
        Command::Coach { file, message } => coach(&file, &message)?,
        Command::Guard { reply, draft } => guard(&reply, draft.as_deref())?,
        Command::Ownership { original, current } => ownership(&original, &current)?,
        Command::Disclosure { journal, doc_id } => disclosure(&journal, doc_id)?,
        Command::Export { file, format, out } => export(&file, format, out.as_deref())?,
        Command::Words { file } => words(&file)?,
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

fn read(path: &std::path::Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

#[derive(Serialize)]
struct DiagnosticJson {
    start: usize,
    end: usize,
    severity: &'static str,
    message: String,
    suggestions: Vec<String>,
}

fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Style => "style",
    }
}

fn lint(file: &std::path::Path) -> Result<Value> {
    let text = read(file)?;
    let mut linter = Linter::new();
    let diags: Vec<DiagnosticJson> = linter
        .lint(&text)
        .into_iter()
        .map(|d| DiagnosticJson {
            start: d.start,
            end: d.end,
            severity: severity_str(d.severity),
            message: d.message,
            suggestions: d.suggestions.into_iter().map(|f| f.label).collect(),
        })
        .collect();
    Ok(json!({ "file": file.display().to_string(), "count": diags.len(), "diagnostics": diags }))
}

/// The outcome of screening a reply: the deterministic guard, the optional LLM
/// judge, and whether the reply is ultimately allowed through.
struct Screened {
    allowed: bool,
    guard: Value,
    judge: Value,
}

/// Screen `reply` with the deterministic guard and, if a judge is configured and
/// the guard passes, the LLM judge. The caller supplies the runtime so a single
/// one is reused (the `coach` path already has one for the chat request).
fn screen_reply(rt: &tokio::runtime::Runtime, reply: &str, draft: &str) -> Screened {
    let guard = screen_chat_reply(reply, draft);
    let guard_ok = guard.is_ok();
    let guard_json = match &guard {
        Ok(()) => json!({ "ok": true }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    };

    // The LLM judge runs only when configured and the deterministic guard passes.
    let mut judge_json = Value::Null;
    let mut allowed = guard_ok;
    if guard_ok
        && let Some(cfg) = CoachConfig::load()
        && let Some(endpoint) = cfg.judge_endpoint()
    {
        let client = CoachClient::new(cfg);
        match rt.block_on(whetstone_tui::coach::screen_with_judge(
            &client,
            &endpoint,
            reply,
            Some(draft),
        )) {
            Ok(v) => {
                allowed = v.allow;
                judge_json = json!({ "allow": v.allow, "reason": v.reason });
            }
            // Fail-open: the deterministic guard already passed.
            Err(e) => judge_json = json!({ "error": e, "failed_open": true }),
        }
    }

    Screened {
        allowed,
        guard: guard_json,
        judge: judge_json,
    }
}

fn guard(reply: &str, draft: Option<&std::path::Path>) -> Result<Value> {
    let draft = match draft {
        Some(p) => read(p)?,
        None => String::new(),
    };
    let rt = tokio::runtime::Runtime::new()?;
    let s = screen_reply(&rt, reply, &draft);
    Ok(json!({ "allowed": s.allowed, "guard": s.guard, "judge": s.judge }))
}

fn coach(file: &std::path::Path, message: &str) -> Result<Value> {
    let draft = read(file)?;
    let cfg = CoachConfig::load()
        .context("coach not configured (set WHETSTONE_BASE_URL or run the AI settings dialog)")?;
    let client = CoachClient::new(cfg);
    let endpoint = client.coach_endpoint();
    let claim = whetstone_tui::markdown::render::frontmatter_claim(&draft);
    let messages = build_chat_messages(message, &[], Some(&draft), claim.as_deref());

    let rt = tokio::runtime::Runtime::new()?;
    let reply = rt
        .block_on(client.chat(&endpoint, &messages, false, |_| {}))
        .map_err(|e| anyhow::anyhow!("coach request failed: {e}"))?;

    let s = screen_reply(&rt, &reply, &draft);
    Ok(json!({
        "model": endpoint.model,
        "reply": if s.allowed { Value::String(reply) } else { Value::Null },
        "withheld": !s.allowed,
        "guard": s.guard,
        "judge": s.judge,
    }))
}

fn ownership(original: &std::path::Path, current: &std::path::Path) -> Result<Value> {
    let original = read(original)?;
    let current = read(current)?;
    Ok(json!({
        "survival_ratio": survival_ratio(&current, &original),
        "claimed_to_own": is_claimed_to_own(&current, &original),
    }))
}

fn disclosure(journal: &std::path::Path, doc_id: Option<String>) -> Result<Value> {
    let data = read(journal)?;
    let events: Vec<ProcessEvent> =
        serde_json::from_str(&data).context("journal must be a JSON array of process events")?;
    let id = doc_id.unwrap_or_else(|| journal.display().to_string());
    let doc = whetstone_tui::core::disclosure::render_disclosure(&id, &events)
        .map_err(|e| anyhow::anyhow!("disclosure rejected by forbidden-label guard: {e}"))?;
    Ok(json!({
        "doc_id": id,
        "markdown": doc.markdown,
        "scoping_note": doc.scoping_note,
    }))
}

fn export(
    file: &std::path::Path,
    format: ExportFormat,
    out: Option<&std::path::Path>,
) -> Result<Value> {
    let text = read(file)?;
    let ext = match format {
        ExportFormat::Html => "html",
        ExportFormat::Text => "txt",
    };
    let (content, out) = match format {
        ExportFormat::Html => {
            let html = whetstone_tui::markdown::render::render_to_html(&text)
                .map_err(|e| anyhow::anyhow!("export rejected by forbidden-label guard: {e}"))?;
            let out = out
                .map(PathBuf::from)
                .unwrap_or_else(|| file.with_extension(ext));
            (html, out)
        }
        ExportFormat::Text => {
            let theme = whetstone_tui::ui::theme::default_theme();
            let plain = whetstone_tui::markdown::render::render_to_plain(&text, theme)
                .map_err(|e| anyhow::anyhow!("export rejected by forbidden-label guard: {e}"))?;
            let out = out
                .map(PathBuf::from)
                .unwrap_or_else(|| file.with_extension(ext));
            (plain, out)
        }
    };
    let bytes = content.len();
    std::fs::write(&out, content.as_bytes())
        .with_context(|| format!("writing {}", out.display()))?;
    Ok(json!({
        "source": file.display().to_string(),
        "path": out.display().to_string(),
        "format": format!("{ext}"),
        "bytes": bytes,
    }))
}

/// Word/character/line counts for a document, mirroring the status-bar count.
/// `prose` is the Markdown-noise-stripped count (what the TUI shows); `raw` is
/// the unstripped tokenizer count (what the ownership metric uses); `chars` and
/// `lines` are the obvious totals. Gives a screen-reader user the same
/// orientation the status bar gives a sighted one.
fn words(file: &std::path::Path) -> Result<Value> {
    let text = read(file)?;
    let prose = whetstone_tui::core::ngram::prose_word_count(&text);
    let raw = whetstone_tui::core::ngram::word_count(&text);
    let chars = text.chars().count();
    let lines = text.lines().count();
    Ok(json!({
        "file": file.display().to_string(),
        "prose_words": prose,
        "raw_words": raw,
        "chars": chars,
        "lines": lines,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lint_reports_spelling_with_suggestions() {
        let dir = std::env::temp_dir();
        let path = dir.join("whetstone_cli_lint_test.md");
        std::fs::write(&path, "This is a sentance.").unwrap();
        let out = lint(&path).unwrap();
        assert!(out["count"].as_u64().unwrap() >= 1);
        let diags = out["diagnostics"].as_array().unwrap();
        assert!(
            diags
                .iter()
                .any(|d| !d["suggestions"].as_array().unwrap().is_empty())
        );
        let _ = std::fs::remove_file(&path);
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn guard_blocks_forbidden_labels() {
        let s = screen_reply(&rt(), "Your authorship is a verified human result.", "");
        assert!(!s.allowed);
        assert_eq!(s.guard["ok"], json!(false));
    }

    #[test]
    fn guard_allows_a_clean_question() {
        let s = screen_reply(
            &rt(),
            "What claim do you want the reader to accept?",
            "a draft",
        );
        assert!(s.allowed);
        assert_eq!(s.guard["ok"], json!(true));
    }

    #[test]
    fn export_html_writes_a_standalone_document() {
        let dir = std::env::temp_dir();
        let src = dir.join("whetstone_cli_export_html_src.md");
        let out = dir.join("whetstone_cli_export_html_out.html");
        std::fs::write(&src, "# Hello\n\nA paragraph.\n").unwrap();
        let v = export(&src, ExportFormat::Html, Some(&out)).unwrap();
        assert_eq!(v["format"], json!("html"));
        assert_eq!(v["path"].as_str().unwrap(), out.display().to_string());
        let body = std::fs::read_to_string(&out).unwrap();
        assert!(body.starts_with("<!doctype html>"));
        assert!(body.contains("<h1>Hello</h1>"));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn export_text_writes_plain_rendered_text() {
        let dir = std::env::temp_dir();
        let src = dir.join("whetstone_cli_export_text_src.md");
        let out = dir.join("whetstone_cli_export_text_out.txt");
        std::fs::write(&src, "# Hello\n\nA paragraph.\n").unwrap();
        let v = export(&src, ExportFormat::Text, Some(&out)).unwrap();
        assert_eq!(v["format"], json!("txt"));
        let body = std::fs::read_to_string(&out).unwrap();
        assert!(body.contains("Hello"));
        assert!(body.contains("paragraph"));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn words_reports_prose_and_raw_counts() {
        let dir = std::env::temp_dir();
        let src = dir.join("whetstone_cli_words_src.md");
        std::fs::write(
            &src,
            "# Title\n\nSee https://example.com/a/b/c for `code`.\n",
        )
        .unwrap();
        let v = words(&src).unwrap();
        // prose strips the URL + inline code; raw does not, so prose < raw.
        let prose = v["prose_words"].as_u64().unwrap();
        let raw = v["raw_words"].as_u64().unwrap();
        assert!(prose < raw, "prose ({prose}) should be < raw ({raw})");
        assert!(v["chars"].as_u64().unwrap() > 0);
        assert!(v["lines"].as_u64().unwrap() >= 2);
        let _ = std::fs::remove_file(&src);
    }
}
