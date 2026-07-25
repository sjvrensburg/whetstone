//! Generate shell completions for `whetstone-tui` into `docs/completions/`.
//!
//! Run: `cargo run --example gen_completions`
//!
//! Committed to the repo so the installers can ship them without a build step,
//! and so reviewers see the completion surface change in diffs. Regenerate when
//! subcommands or flags change (keep this in sync with `src/cli.rs`'s `Command`
//! enum and `src/main.rs`'s `Cli`). Produces bash, zsh, fish, and PowerShell.

use std::fs;
use std::path::PathBuf;

use clap::{Arg, Command};
use clap_complete::{Shell, generate};

/// Rebuild the top-level command tree. Mirrors the `Cli`/`Command` derives in
/// `src/main.rs` and `src/cli.rs`; if those change, update this too.
fn build_cli() -> Command {
    Command::new("whetstone-tui")
        .version("0.1.4")
        .about("Whetstone — a friction-first Quarto markdown editor for the terminal")
        .args_conflicts_with_subcommands(true)
        .arg(
            Arg::new("file")
                .help("Path to a `.qmd` / `.md` file to open in the editor (created if missing)"),
        )
        .subcommand_required(false)
        .subcommands(subcommands())
}

fn subcommands() -> Vec<Command> {
    vec![
        Command::new("open")
            .about("Open the editor (same as passing a bare file path)")
            .arg(
                Arg::new("file").help("Path to a `.qmd` / `.md` file to open (created if missing)"),
            ),
        Command::new("lint")
            .about("Lint a file with Harper; prints diagnostics as JSON")
            .arg(Arg::new("file").required(true)),
        Command::new("coach")
            .about("Run one coach turn over a file, screened by the guard (+ judge if set)")
            .arg(Arg::new("file").required(true))
            .arg(Arg::new("message").long("message").required(true)),
        Command::new("guard")
            .about("Screen an arbitrary reply with the deterministic guard (+ judge if set)")
            .arg(Arg::new("reply").long("reply").required(true))
            .arg(Arg::new("draft").long("draft")),
        Command::new("ownership")
            .about("Claim-to-own survival of an original paste within the current text")
            .arg(Arg::new("original").long("original").required(true))
            .arg(Arg::new("current").long("current").required(true)),
        Command::new("disclosure")
            .about("Render a disclosure document from a journal (a JSON array of events)")
            .arg(Arg::new("journal").long("journal").required(true))
            .arg(Arg::new("doc-id").long("doc-id")),
        Command::new("export")
            .about("Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed)")
            .arg(Arg::new("file").required(true))
            .arg(
                Arg::new("format")
                    .long("format")
                    .value_parser(["html", "text"])
                    .default_value("html"),
            )
            .arg(Arg::new("out").long("out")),
        // clap auto-adds a `help` subcommand; don't declare it explicitly.
    ]
}

fn main() {
    let out_dir = PathBuf::from("docs/completions");
    fs::create_dir_all(&out_dir).expect("create docs/completions");

    let files = [
        (Shell::Bash, "whetstone-tui.bash"),
        (Shell::Zsh, "_whetstone-tui"),
        (Shell::Fish, "whetstone-tui.fish"),
        (Shell::PowerShell, "_whetstone-tui.ps1"),
    ];
    for (shell, name) in files {
        let path = out_dir.join(name);
        let mut file = fs::File::create(&path).expect("create completion file");
        let mut cmd = build_cli();
        generate(shell, &mut cmd, "whetstone-tui", &mut file);
        println!("wrote {}", path.display());
    }
}
