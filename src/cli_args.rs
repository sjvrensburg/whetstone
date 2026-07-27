//! The `clap` argument-parsing tree: `main.rs`'s top-level `Cli`, and the
//! headless subcommands `cli.rs` (in the binary crate) executes.
//!
//! Kept in the library, dependency-free, so `examples/gen_completions.rs` can
//! build the exact `clap::Command` that runs at runtime via
//! `Cli::command()` (from `clap::CommandFactory`) instead of hand-duplicating
//! the tree — a hand-duplicated copy had already drifted from this one
//! (missing `required` on `open`'s file, a value-taking `--strict`).

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "whetstone-tui",
    version,
    about = "Whetstone — a friction-first Quarto markdown editor for the terminal",
    // `whetstone-tui file.qmd` opens the TUI; subcommands run headlessly.
    args_conflicts_with_subcommands = true
)]
pub struct Cli {
    /// Path to a `.qmd` / `.md` file to open in the editor (created if missing).
    pub file: Option<PathBuf>,
    /// Write a diagnostic log here (coach errors, judge fail-opens, panics).
    /// Default: `$XDG_STATE_HOME/whetstone/whetstone.log`. Also set via
    /// `WHETSTONE_LOG_FILE`. Use `--log-file off` to disable.
    #[arg(long, global = true)]
    pub log_file: Option<String>,
    /// Log verbosity for `--log-file`: `off`, `error`, `warn`, or `info`
    /// (default `info`). Also set via `WHETSTONE_LOG_LEVEL`.
    #[arg(long, global = true)]
    pub log_level: Option<String>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

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
