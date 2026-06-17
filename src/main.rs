//! Whetstone TUI — a friction-first Quarto markdown editor for the terminal.

use std::io::{self, Write, stdout};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use clap::Parser;
use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use whetstone_tui::coach::CoachConfig;
use whetstone_tui::ui::{App, draw};

mod cli;
use cli::Command;

#[derive(Parser)]
#[command(
    name = "whetstone-tui",
    version,
    about = "Whetstone — a friction-first Quarto markdown editor for the terminal",
    // `whetstone-tui file.qmd` opens the TUI; subcommands run headlessly.
    args_conflicts_with_subcommands = true
)]
struct Cli {
    /// Path to a `.qmd` / `.md` file to open in the editor (created if missing).
    file: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

type Tui = Terminal<CrosstermBackend<io::Stdout>>;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let file = match cli.command {
        // Headless subcommands print JSON and exit — no terminal setup.
        Some(Command::Open { file }) => file,
        Some(command) => return cli::run(command),
        None => match cli.file {
            Some(file) => file,
            None => {
                eprintln!(
                    "error: provide a file to edit (whetstone-tui FILE) or a subcommand \
                     (whetstone-tui --help)."
                );
                std::process::exit(2);
            }
        },
    };
    run_tui(file)
}

/// Launch the interactive editor on `file`.
fn run_tui(file: PathBuf) -> Result<()> {
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let coach_config = CoachConfig::load();
    let mut app = App::new(text, file, coach_config, rt.handle().clone());
    app.start_session();

    enable_raw_mode()?;
    execute!(
        stdout(),
        EnterAlternateScreen,
        EnableBracketedPaste,
        EnableMouseCapture
    )?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    // Restore the terminal even on panic so the user's shell isn't left raw.
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore();
        original_hook(info);
    }));

    let result = run(&mut terminal, &mut app);

    restore()?;
    result
}

fn restore() -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        stdout(),
        LeaveAlternateScreen,
        DisableBracketedPaste,
        DisableMouseCapture
    )?;
    Ok(())
}

fn run(terminal: &mut Tui, app: &mut App) -> Result<()> {
    loop {
        app.maybe_lint();
        app.maybe_autosave();
        app.drain_coach_events();
        app.drain_conn_test_events();
        app.drain_compile_events();
        terminal.draw(|f| draw(f, app))?;
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        match event::read()? {
            event::Event::Key(k) => app.handle_key(k),
            event::Event::Mouse(m) => app.handle_mouse(m),
            event::Event::Paste(s) => app.handle_paste(&s),
            event::Event::Resize(_, _) => {}
            _ => {}
        }
        // Copy/cut writes to the system clipboard via OSC 52 (works over SSH,
        // no platform clipboard library needed).
        if let Some(text) = app.take_clipboard_request() {
            copy_to_clipboard(&text);
        }
        if app.should_quit() {
            break;
        }
    }
    Ok(())
}

/// Emit an OSC 52 escape sequence to set the terminal's clipboard.
fn copy_to_clipboard(text: &str) {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let mut out = stdout();
    let _ = write!(out, "\x1b]52;c;{encoded}\x07");
    let _ = out.flush();
}
