//! Generate shell completions for `whetstone-tui` into `docs/completions/`.
//!
//! Run: `cargo run --example gen_completions`
//!
//! Committed to the repo so the installers can ship them without a build step,
//! and so reviewers see the completion surface change in diffs. Regenerate when
//! subcommands or flags change (keep this in sync with `src/cli.rs`'s `Command`
//! enum and `src/main.rs`'s `Cli`). Produces bash, zsh, fish, and PowerShell.

use std::fs;
use std::io::Cursor;
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
            .arg(Arg::new("file").required(true))
            .arg(Arg::new("strict").long("strict")),
        Command::new("coach")
            .about("Run one coach turn over a file, screened by the guard (+ judge if set)")
            .arg(Arg::new("file").required(true))
            .arg(Arg::new("message").long("message").required(true))
            .arg(Arg::new("journal").long("journal")),
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
        Command::new("words")
            .about("Word/character/line counts for a document (JSON)")
            .arg(Arg::new("file").required(true)),
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
        let mut cmd = build_cli();

        // Generate bash to a buffer first: clap_complete 4.6.x emits case-match
        // arms whose internal `cmd` token ordering disagrees with the `cmd=`
        // assignment arms when the bin name contains a hyphen (e.g.
        // `whetstone-tui`). The assignment sets `cmd="whetstone__tui__subcmd__x"`
        // but the case arm matches `whetstone__subcmd__tui__subcmd__x)` — so no
        // arm ever fires and bash completion silently returns nothing after any
        // subcommand. We normalize the case arms to match the assignments. See
        // https://github.com/clap-rs/clap/issues/<upstream-tracking-issue>.
        if matches!(shell, Shell::Bash) {
            let mut buf = Vec::new();
            generate(shell, &mut cmd, "whetstone-tui", &mut Cursor::new(&mut buf));
            let fixed = fix_bash_subcmd_swap(&String::from_utf8(buf).expect("utf8"));
            fs::write(&path, fixed).expect("write completion file");
        } else {
            let mut file = fs::File::create(&path).expect("create completion file");
            generate(shell, &mut cmd, "whetstone-tui", &mut file);
        }
        println!("wrote {}", path.display());
    }
}

/// Repair the `cmd` case-match arms so they agree with the `cmd=` assignments.
///
/// The bug swaps the first subcommand boundary: `whetstone__tui__subcmd__` (in
/// assignments) becomes `whetstone__subcmd__tui__subcmd__` (in case arms). We
/// rewrite every case-arm pattern accordingly. Idempotent: if a future
/// clap_complete release fixes the bug, this function becomes a no-op.
fn fix_bash_subcmd_swap(bash: &str) -> String {
    bash.replace(
        "whetstone__subcmd__tui__subcmd__",
        "whetstone__tui__subcmd__",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed bash completion must be internally consistent: every
    /// `cmd="..."` assignment must have a matching case-arm pattern, otherwise
    /// completion silently returns nothing after a subcommand (the original bug
    /// this generator post-processes around). This guards against a future
    /// clap_complete change that alters the swap pattern without us noticing.
    #[test]
    fn committed_bash_completion_assignments_match_case_arms() {
        let bash =
            fs::read_to_string("docs/completions/whetstone-tui.bash").expect("read committed bash");
        let assignments: Vec<&str> = bash
            .lines()
            .filter_map(|l| {
                l.trim()
                    .strip_prefix("cmd=\"")
                    .and_then(|s| s.strip_suffix('"'))
            })
            .filter(|s| s.contains("__subcmd__"))
            .collect();
        assert!(!assignments.is_empty(), "no cmd assignments found");
        for a in &assignments {
            let pat = format!("{a})");
            assert!(
                bash.contains(&pat),
                "case arm for cmd assignment {a:?} not found — bash completion is broken"
            );
        }
    }

    /// `fix_bash_subcmd_swap` must be idempotent and must produce a file whose
    /// assignments and case arms agree.
    #[test]
    fn fix_bash_subcmd_swap_is_idempotent_and_consistent() {
        let mut buf = Vec::new();
        generate(
            Shell::Bash,
            &mut build_cli(),
            "whetstone-tui",
            &mut Cursor::new(&mut buf),
        );
        let raw = String::from_utf8(buf).expect("utf8");
        let fixed = fix_bash_subcmd_swap(&raw);
        // Idempotent: fixing the fixed output changes nothing.
        assert_eq!(fixed, fix_bash_subcmd_swap(&fixed));
        // Consistent: every assignment has a matching case arm.
        let assignments: Vec<&str> = fixed
            .lines()
            .filter_map(|l| {
                l.trim()
                    .strip_prefix("cmd=\"")
                    .and_then(|s| s.strip_suffix('"'))
            })
            .filter(|s| s.contains("__subcmd__"))
            .collect();
        for a in &assignments {
            assert!(
                fixed.contains(&format!("{a})")),
                "missing case arm for {a:?}"
            );
        }
    }
}
