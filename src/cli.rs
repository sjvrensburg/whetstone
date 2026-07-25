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
    Lint {
        file: PathBuf,
        /// Exit non-zero when any diagnostics are found (for CI: `lint --strict`
        /// fails the step on spelling/grammar issues). Without this flag the
        /// command always exits 0 and reports findings as JSON.
        #[arg(long)]
        strict: bool,
    },
    /// Run one coach turn over a file, screened by the guard (+ judge if set).
    Coach {
        file: PathBuf,
        /// The message to send the coach.
        #[arg(long)]
        message: String,
        /// Append a metadata-only `CoachConsult` event to this journal file, so
        /// a later `disclosure` render is honest that the coach was consulted
        /// headlessly (the agent/CI path is otherwise off-the-books). Creates
        /// the file if missing; appends to an existing JSON array. The judge
        /// fail-open path also records a `JudgeUnavailable` event.
        #[arg(long)]
        journal: Option<PathBuf>,
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
    // `lint --strict` is the one subcommand whose exit code depends on the
    // result (non-zero when diagnostics were found), so it owns its full
    // print-and-exit path instead of sharing the generic one below.
    if let Command::Lint { file, strict } = command {
        return lint(&file, strict);
    }
    let out = match command {
        Command::Open { .. } => unreachable!("Open is handled by the TUI entry point"),
        Command::Coach {
            file,
            message,
            journal,
        } => coach(&file, &message, journal.as_deref())?,
        Command::Guard { reply, draft } => guard(&reply, draft.as_deref())?,
        Command::Ownership { original, current } => ownership(&original, &current)?,
        Command::Disclosure { journal, doc_id } => disclosure(&journal, doc_id)?,
        Command::Export { file, format, out } => export(&file, format, out.as_deref())?,
        Command::Words { file } => words(&file)?,
        // Matched exhaustively above; this arm is unreachable but keeps the
        // compiler from complaining about `Lint` not being handled here.
        Command::Lint { .. } => unreachable!("Lint handled above"),
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

fn read(path: &std::path::Path) -> Result<String> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    // Strip a leading UTF-8 BOM so it doesn't skew counts / screening / exports.
    Ok(text
        .strip_prefix('\u{feff}')
        .map(|s| s.to_string())
        .unwrap_or(text))
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

fn lint(file: &std::path::Path, strict: bool) -> Result<()> {
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
    let count = diags.len();
    let out = json!({ "file": file.display().to_string(), "count": count, "diagnostics": diags });
    println!("{}", serde_json::to_string_pretty(&out)?);
    // In strict mode (CI), a non-zero count fails the step. We exit explicitly
    // so the JSON above is already flushed and the SIGPIPE reset in main keeps
    // a closing pipe from turning this into a broken-pipe panic.
    if strict && count > 0 {
        std::process::exit(1);
    }
    Ok(())
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

fn coach(
    file: &std::path::Path,
    message: &str,
    journal: Option<&std::path::Path>,
) -> Result<Value> {
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

    // If the caller asked us to journal, record the consult (and a judge
    // fail-open) so a later `disclosure` is honest about headless coaching.
    // Without this the agent/CI path is invisible to the disclosure system —
    // it would render "no AI assistance" despite a coaching turn having run.
    if let Some(jpath) = journal {
        let refused = !s.allowed;
        let judge_failed_open = matches!(
            &s.judge,
            Value::Object(m) if m.get("failed_open").and_then(|v| v.as_bool()) == Some(true)
        );
        append_coach_consult(jpath, refused, &endpoint, judge_failed_open)?;
    }

    Ok(json!({
        "model": endpoint.model,
        "reply": if s.allowed { Value::String(reply) } else { Value::Null },
        "withheld": !s.allowed,
        "guard": s.guard,
        "judge": s.judge,
    }))
}

/// Append a metadata-only `CoachConsult` event (and, on judge fail-open, a
/// `JudgeUnavailable` event) to a journal file. The file is a JSON array of
/// `ProcessEvent`s; it is created if missing, or read+extended if present.
///
/// Prose is never journaled — only the consult outcome, provider, and model —
/// matching the TUI's `log_coach_consult_with` discipline. `id` and `ts` are
/// stamped here because there is no Service in the headless path; the
/// disclosure's scoping note already states the record is local and self-reported.
fn append_coach_consult(
    path: &std::path::Path,
    refused: bool,
    endpoint: &whetstone_tui::coach::Endpoint,
    judge_failed_open: bool,
) -> Result<()> {
    use std::collections::BTreeMap;
    use whetstone_tui::core::process_event::{MetaValue, ProcessEvent, ProcessEventType};

    let now = chrono::Utc::now().to_rfc3339();
    let mut events: Vec<ProcessEvent> = if path.exists() {
        let data = std::fs::read_to_string(path)
            .with_context(|| format!("reading journal {}", path.display()))?;
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    };
    let seq = events.len();

    let mut coach_meta: BTreeMap<String, MetaValue> = BTreeMap::new();
    coach_meta.insert("refused".into(), MetaValue::Bool(refused));
    coach_meta.insert(
        "provider".into(),
        MetaValue::Str(endpoint.provider.label().to_string()),
    );
    coach_meta.insert("model".into(), MetaValue::Str(endpoint.model.clone()));
    coach_meta.insert(
        "headless".into(),
        MetaValue::Bool(true), // mark this consult came from the CLI, not the TUI
    );

    events.push(ProcessEvent {
        id: format!("e{seq}"),
        ts: now.clone(),
        kind: ProcessEventType::CoachConsult,
        size: None,
        location: None,
        meta: Some(coach_meta),
    });

    if judge_failed_open {
        let mut judge_meta: BTreeMap<String, MetaValue> = BTreeMap::new();
        judge_meta.insert("headless".into(), MetaValue::Bool(true));
        events.push(ProcessEvent {
            id: format!("e{}", seq + 1),
            ts: now,
            kind: ProcessEventType::JudgeUnavailable,
            size: None,
            location: None,
            meta: Some(judge_meta),
        });
    }

    let out = serde_json::to_string_pretty(&events)?;
    std::fs::write(path, out).with_context(|| format!("writing journal {}", path.display()))?;
    Ok(())
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
    use whetstone_tui::core::process_event::ProcessEvent;
    use whetstone_tui::core::process_event::{MetaValue, ProcessEventType};

    #[test]
    fn lint_reports_spelling_with_suggestions() {
        // `lint` prints JSON to stdout; for a unit test we re-run the core
        // logic directly to inspect the diagnostics without capturing stdout.
        let dir = std::env::temp_dir();
        let path = dir.join("whetstone_cli_lint_test.md");
        std::fs::write(&path, "This is a sentance.").unwrap();
        let text = read(&path).unwrap();
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
        assert!(!diags.is_empty());
        assert!(diags.iter().any(|d| !d.suggestions.is_empty()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_coach_consult_creates_and_extends_a_journal() {
        let dir = std::env::temp_dir();
        let path = dir.join("whetstone_cli_journal_test.json");
        let _ = std::fs::remove_file(&path);

        // Build a synthetic endpoint for the metadata (no network).
        let cfg = CoachConfig {
            provider: None,
            base_url: "http://localhost".into(),
            api_key: String::new(),
            model: "test-model".into(),
            judge: whetstone_tui::coach::JudgeSettings::default(),
        };
        let client = CoachClient::new(cfg);
        let endpoint = client.coach_endpoint();

        // First consult: creates the journal with one event.
        append_coach_consult(&path, false, &endpoint, false).unwrap();
        let data = std::fs::read_to_string(&path).unwrap();
        let events: Vec<ProcessEvent> = serde_json::from_str(&data).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].kind, ProcessEventType::CoachConsult));
        let meta = events[0].meta.as_ref().unwrap();
        assert_eq!(meta.get("refused"), Some(&MetaValue::Bool(false)));
        assert_eq!(meta.get("headless"), Some(&MetaValue::Bool(true)));
        assert_eq!(
            meta.get("model"),
            Some(&MetaValue::Str("test-model".into()))
        );

        // Second consult with a judge fail-open: appends two events (consult + JudgeUnavailable).
        append_coach_consult(&path, true, &endpoint, true).unwrap();
        let data = std::fs::read_to_string(&path).unwrap();
        let events: Vec<ProcessEvent> = serde_json::from_str(&data).unwrap();
        assert_eq!(events.len(), 3);
        assert!(matches!(events[2].kind, ProcessEventType::JudgeUnavailable));
        // Sequential ids.
        assert_eq!(events[0].id, "e0");
        assert_eq!(events[1].id, "e1");
        assert_eq!(events[2].id, "e2");

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
