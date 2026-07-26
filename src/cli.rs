//! Headless subcommands — the agentic interface.
//!
//! Each command runs non-interactively and prints a single JSON document to
//! stdout, so an agent, script, or CI step can drive Whetstone's core logic
//! (grammar, the coach, the guard + LLM judge, claim-to-own ownership,
//! disclosure rendering) without the TUI. The same `core`/`coach`/`grammar`
//! modules the editor uses back these, so the layering stays honest.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};

use whetstone_tui::cli_args::{Command, ExportFormat};
use whetstone_tui::coach::{CoachClient, CoachConfig};
use whetstone_tui::core::guard::screen_chat_reply;
use whetstone_tui::core::ownership::{is_claimed_to_own, survival_ratio};
use whetstone_tui::core::process_event::ProcessEvent;
use whetstone_tui::core::prompts::build_chat_messages;
use whetstone_tui::grammar::{Linter, Severity};

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
        // An empty file is a legitimate "no events yet" journal (`touch`), but
        // anything that fails to parse must be an error: this function rewrites
        // `path` wholesale, so defaulting to an empty list would replace the
        // file — a mistyped `--journal essay.qmd` would eat the draft, and a
        // truncated journal would lose every event recorded before the crash.
        if data.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&data).with_context(|| {
                format!(
                    "journal {} must be a JSON array of process events",
                    path.display()
                )
            })?
        }
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
    whetstone_tui::fs_util::atomic_write(path, out.as_bytes())
        .with_context(|| format!("writing journal {}", path.display()))?;
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
    whetstone_tui::fs_util::atomic_write(&out, content.as_bytes())
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

    #[test]
    fn append_coach_consult_refuses_to_rewrite_an_unparseable_journal() {
        // `--journal` is rewritten wholesale, so a file that isn't a journal —
        // a mistyped `--journal essay.qmd`, or a journal truncated by a crash —
        // must be an error, not an empty starting point that eats the file.
        let dir = std::env::temp_dir();
        let path = dir.join("whetstone_cli_journal_not_json.qmd");
        std::fs::write(&path, "---\ntitle: My essay\n---\n\nThe draft.\n").unwrap();

        let cfg = CoachConfig {
            provider: None,
            base_url: "http://localhost".into(),
            api_key: String::new(),
            model: "test-model".into(),
            judge: whetstone_tui::coach::JudgeSettings::default(),
        };
        let client = CoachClient::new(cfg);
        let endpoint = client.coach_endpoint();

        assert!(append_coach_consult(&path, false, &endpoint, false).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: My essay\n---\n\nThe draft.\n",
            "the file was rewritten"
        );

        // An empty file is still a legitimate "no events yet" journal.
        std::fs::write(&path, "").unwrap();
        append_coach_consult(&path, false, &endpoint, false).unwrap();
        let events: Vec<ProcessEvent> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(events.len(), 1);

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
