//! Whetstone TUI — a friction-first Quarto markdown editor for the terminal.

use std::io::{self, stdout};
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

#[derive(Parser)]
#[command(
    name = "whetstone-tui",
    version,
    about = "Whetstone — a friction-first Quarto markdown editor for the terminal"
)]
struct Cli {
    /// Path to a `.qmd` / `.md` file to open (created if missing).
    file: PathBuf,
}

type Tui = Terminal<CrosstermBackend<io::Stdout>>;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let text = std::fs::read_to_string(&cli.file).unwrap_or_default();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let coach_config = CoachConfig::load();
    let mut app = App::new(text, cli.file.clone(), coach_config, rt.handle().clone());
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
        app.drain_coach_events();
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
        if app.should_quit() {
            break;
        }
    }
    Ok(())
}
