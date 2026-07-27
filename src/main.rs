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

use whetstone_tui::cli_args::{Cli, Command};
use whetstone_tui::coach::CoachConfig;
use whetstone_tui::ui::{App, draw};

mod cli;

type Tui = Terminal<CrosstermBackend<io::Stdout>>;

fn main() -> Result<()> {
    // Rust ignores SIGPIPE by default, so writing JSON to a closing pipe (e.g.
    // `whetstone-tui lint f.qmd | head`) raises EPIPE, which anyhow surfaces as
    // a noisy "Broken pipe" error with exit 101. Restoring the OS default means
    // a piped consumer that exits early terminates us cleanly and silently —
    // the conventional Unix pipeline behavior. It is set before `parse` so
    // `--help | head` behaves too; `run_tui` puts it back to ignored for the
    // interactive path, which must never be killed by a socket write.
    reset_sigpipe_to_default();
    let cli = Cli::parse();
    let file = match cli.command {
        // Headless subcommands print JSON and exit — no terminal setup, and no
        // diagnostic log either: those commands were side-effect-free before,
        // and the log is a TUI diagnostic (the status bar truncates coach
        // errors; a panic kills the process). `lint f.qmd | head` must not
        // touch the filesystem or print "could not create log dir".
        Some(Command::Open { file }) => file,
        Some(command) => return cli::run(command),
        // No file and no subcommand: open an untitled buffer. The empty path
        // marks it unnamed — Ctrl+S prompts for a name, and autosave/history
        // stay off until it is saved.
        None => cli.file.unwrap_or_default(),
    };
    // Start the diagnostic log only on the interactive path, but before
    // `run_tui` so coach/judge failures and startup panics (config load, the
    // runtime build, App::new) leave a trail. `--log-file off` or
    // `WHETSTONE_LOG_FILE=off` disables it.
    whetstone_tui::log::init(cli.log_file.as_deref(), cli.log_level.as_deref());
    install_panic_logger();
    run_tui(file)
}

/// Record panics (with a backtrace) in the diagnostic log, then delegate to the
/// previous hook. Installed in `main` — before `run_tui`'s config load, runtime
/// build, and `App::new` — so a startup crash is captured, not just panics from
/// the event loop. `run_tui` layers a terminal-restore hook on top of this one.
fn install_panic_logger() {
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Print to stderr FIRST, before the (synchronous, un-timed) log write.
        // On a slow/unreachable log mount (e.g. a hard-mounted NFS state dir)
        // `write_all`+`flush` inside `log::error` can block indefinitely — if it
        // ran first, the stderr message would never appear and the process would
        // hang with no diagnostic. Surfacing the panic on stderr immediately is
        // the load-bearing behavior; the log is best-effort after that.
        original(info);
        // Only pay the capture cost when something will actually record it.
        // `capture()` (not `force_capture()`) honors RUST_BACKTRACE=0.
        if whetstone_tui::log::has_sink() {
            let bt = std::backtrace::Backtrace::capture();
            whetstone_tui::log::error(&format!("panic: {info}\n{bt}"));
        }
    }));
}

/// Launch the interactive editor on `file`.
fn run_tui(file: PathBuf) -> Result<()> {
    // Undo the SIG_DFL reset above: that disposition is process-wide, so it
    // applies to every socket too, and a coach request on a pooled connection
    // the server just closed would kill the editor mid-sentence — leaving the
    // terminal in raw mode, since neither the teardown in `run` nor the panic
    // hook would run. Ignoring SIGPIPE turns that back into the EPIPE the HTTP
    // client reports as an ordinary error.
    ignore_sigpipe();
    // A *missing* file is the intended trigger for "open an empty buffer", but
    // a readable file that fails to decode as UTF-8 or hits a permission error
    // must not be silently blanked — the user would see an empty editor with no
    // clue why. Surface those as an initial status-bar message instead.
    let (text, read_error) = if file.as_os_str().is_empty() {
        (String::new(), None)
    } else {
        match std::fs::read_to_string(&file) {
            Ok(t) => (t, None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), None),
            Err(e) => (
                String::new(),
                Some(format!("Could not read {}: {e}", file.display())),
            ),
        }
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let coach_config = CoachConfig::load();
    let mut app = App::new(text, file, coach_config, rt.handle().clone());
    if let Some(msg) = read_error {
        // The document failed to load; surface the reason prominently instead
        // of opening on an empty buffer gated behind the claim modal (which
        // would make the failure look like a fresh empty document).
        app.set_open_error(msg);
    }
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
    // This hook wraps the panic logger installed in `main`: restore() runs
    // FIRST, before the logger's backtrace capture and — critically — before
    // its synchronous log flush. A slow log write (e.g. an NFS-mounted state
    // dir) must not leave the terminal stuck in raw mode, so the shell stays
    // usable regardless of how long the logging takes.
    //
    // But only on the *main* thread: the hook is process-global, so a panic on
    // a worker thread (a tokio coach task, the spawn_write log thread) would
    // otherwise fire restore() against the shared terminal while the main event
    // loop is still alive — disabling raw mode and leaving the alternate screen
    // mid-flight, freezing the editor with no in-app message. Worker-thread
    // panics still get logged by the wrapped logger below; the worker task ends
    // and the main loop carries on untouched.
    let panic_logger = std::panic::take_hook();
    let main_thread = std::thread::current().id();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().id() == main_thread {
            let _ = restore();
        }
        panic_logger(info);
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
        app.drain_io_events();
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

/// Restore SIGPIPE to the OS default so piped output (`cmd | head`) terminates
/// cleanly instead of panicking with a broken-pipe error. No-op on non-Unix.
#[cfg(unix)]
fn reset_sigpipe_to_default() {
    const SIG_DFL: usize = 0;
    set_sigpipe(SIG_DFL);
}

/// Restore Rust's startup disposition (SIGPIPE ignored) so a write to a closed
/// socket surfaces as EPIPE instead of killing the process. No-op on non-Unix.
#[cfg(unix)]
fn ignore_sigpipe() {
    const SIG_IGN: usize = 1;
    set_sigpipe(SIG_IGN);
}

#[cfg(unix)]
fn set_sigpipe(handler: usize) {
    unsafe extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
    }
    const SIGPIPE: i32 = 13;
    // SAFETY: `signal` with SIG_DFL / SIG_IGN is a documented disposition and
    // has no UB; we ignore the previous handler (we never want to restore it).
    // Both calls run at startup before any threads exist, so they are race-free.
    unsafe {
        signal(SIGPIPE, handler);
    }
}

#[cfg(not(unix))]
fn reset_sigpipe_to_default() {}

#[cfg(not(unix))]
fn ignore_sigpipe() {}
