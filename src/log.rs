//! A tiny append-only diagnostic log for events the TUI can't show in full.
//!
//! The status bar truncates coach/provider errors to one line and scrubs
//! secrets, leaving no way to see *why* a request failed — and a panic kills
//! the process before its message can be shown. This writes the full (still
//! secret-scrubbed) error, plus panics and a few lifecycle events, to a file
//! the user can read after the fact.
//!
//! Kept dependency-light on purpose: the volume is a handful of lines per
//! session, so a real logging framework isn't worth the weight. `chrono`
//! (already a dependency) timestamps each line, and a single `Mutex<File>`
//! serializes writes from the coach worker threads.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;

/// The sink, opened once at startup. `None` (the `OnceLock` being unset) means
/// logging is disabled — every write then becomes a cheap no-op.
static SINK: OnceLock<Mutex<File>> = OnceLock::new();
/// The path the sink was opened at, surfaced in the UI so the user can find it.
static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
/// Set by the very first `init` call, on *every* path. The re-entry guard below
/// keys off this, not `SINK`: the Off / unresolvable-path / dir-failure /
/// open-failure early returns never set `SINK`, so keying the guard on it would
/// let a second call bypass it while `LEVEL`/`RESOLVED` keep their first values
/// (pointing the UI at a log that doesn't exist). This lock can't fail to be
/// set, so it blocks re-entry on those paths too.
static INITIALIZED: OnceLock<()> = OnceLock::new();
/// The minimum level to record (default [`Level::Info`]).
static LEVEL: OnceLock<Level> = OnceLock::new();
/// Flips to `false` the first time a `write_all`/`flush` fails, and never set
/// back (the sink is opened once and lives for the process). The UI gates a
/// "(see log)" hint on [`healthy`] rather than just [`has_sink`]: a sink opened
/// at startup can still silently drop writes afterwards (disk full, the file
/// unlinked out from under the handle), and pointing the user at a log that
/// holds no record of the failure would mislead.
static WRITE_HEALTHY: AtomicBool = AtomicBool::new(true);

/// Verbosity threshold. Ordered so the comparison is a plain `<=`; `Off` is
/// the floor, so with `LEVEL == Off` no level passes the `enabled` gate.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Off,
    Error,
    Warn,
    Info,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Level::Off => "OFF",
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
        }
    }

    /// Parse a level name (case-insensitive). `off`/empty → [`Level::Off`];
    /// unknown → [`Level::Info`] (never silent by accident).
    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "off" | "none" => Level::Off,
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "info" => Level::Info,
            _ => Level::Info,
        }
    }
}

/// Where the log will be written. Precedence: an explicit `--log-file` value,
/// else the `WHETSTONE_LOG_FILE` env var, else the default state-dir location.
/// `off`/`none` from either source disables logging (returns `None`); `None` is
/// also returned when no state directory can be resolved (no `$HOME`). This is
/// the single source of truth for path precedence — `init` delegates to it.
pub fn resolve_path(explicit: Option<&str>) -> Option<PathBuf> {
    let raw = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("WHETSTONE_LOG_FILE")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    match raw.as_deref() {
        Some(s) if matches!(s.to_ascii_lowercase().as_str(), "off" | "none") => None,
        Some(s) => Some(PathBuf::from(s)),
        None => Some(crate::state_dir()?.join("whetstone").join("whetstone.log")),
    }
}

/// The resolved log file path, for display in the UI. `None` before [`init`],
/// when logging is disabled, or when the sink failed to open — so the UI never
/// points the user at a log that was never written.
pub fn path() -> Option<PathBuf> {
    RESOLVED.get().cloned().flatten()
}

/// Whether the sink is actually open and recording. The UI uses this to decide
/// whether a "(see log)" hint is truthful — distinct from [`path()`] because a
/// path can resolve yet fail to open.
pub fn has_sink() -> bool {
    SINK.get().is_some()
}

/// Whether the sink is open *and* writes have been landing. Strictly stronger
/// than [`has_sink`]: a write that failed after the sink was opened (disk full,
/// the file unlinked under the handle) leaves `has_sink()` true but this false,
/// so the UI stops advertising a log the failure didn't actually reach.
pub fn healthy() -> bool {
    SINK.get().is_some() && WRITE_HEALTHY.load(Ordering::Relaxed)
}

/// Resolve the effective level: the explicit `--log-level` value, else
/// `WHETSTONE_LOG_LEVEL`, else [`Level::Info`]. `off`/`none` → [`Level::Off`].
/// An *empty* value (from either source) is treated as unset and falls back to
/// the next source — symmetric with [`resolve_path`], where an empty
/// `--log-file`/`WHETSTONE_LOG_FILE` falls back to the default path rather than
/// disabling. Otherwise `WHETSTONE_LOG_LEVEL=` would silently turn logging off.
fn resolve_level(explicit: Option<&str>) -> Level {
    if let Some(l) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return Level::parse(l);
    }
    if let Ok(raw) = std::env::var("WHETSTONE_LOG_LEVEL") {
        let raw = raw.trim();
        if !raw.is_empty() {
            return Level::parse(raw);
        }
    }
    Level::Info
}

/// Open the log file and record a session header. Safe to call once at startup;
/// later calls are ignored (the first wins, so a subcommand re-entering `main`
/// can't reopen mid-session). Errors opening the file are reported to stderr
/// rather than panicking — a missing log must never stop the editor.
///
/// `explicit` is the raw `--log-file` value: a path, or `"off"`/`"none"` to
/// disable logging entirely. Precedence for the path itself is the explicit
/// value, then `WHETSTONE_LOG_FILE`, then the default state-dir location.
pub fn init(explicit: Option<&str>, level: Option<&str>) {
    // The first call wins, period — including on the early-return paths below.
    // `set` succeeds only once, so a second call (a subcommand re-entering
    // `main`, or a library embedder) returns here without disturbing the first
    // call's LEVEL/RESOLVED/SINK.
    if INITIALIZED.set(()).is_err() {
        return;
    }
    let level = resolve_level(level);
    let _ = LEVEL.set(level);
    // `--log-level off` suppresses logging entirely: don't even open a sink,
    // and leave no path for the UI to advertise.
    if level == Level::Off {
        let _ = RESOLVED.set(None);
        return;
    }

    let Some(path) = resolve_path(explicit) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "whetstone: could not create log dir {}: {e}",
                parent.display()
            );
            return;
        }
    }
    // Bound growth: rotate the previous run aside so the file stays scannable.
    rotate_if_large(&path);
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("whetstone: could not open log {}: {e}", path.display());
            return;
        }
    };
    let _ = SINK.set(Mutex::new(file));
    // Advertise the path only once the sink is genuinely open, so the UI never
    // points at a file that was never created (e.g. an unwritable --log-file).
    let _ = RESOLVED.set(Some(path));
    info(&format!(
        "--- whetstone {} starting (pid {}) ---",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
}

/// Copy an existing log aside if it has grown past the cap, keeping one
/// generation of history at `<path>.old`, then truncate the live file in place.
/// Best-effort: a failure here just means we keep appending to the large file.
const ROTATE_CAP_BYTES: u64 = 256 * 1024;
fn rotate_if_large(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= ROTATE_CAP_BYTES {
        return;
    }
    // Copy-and-truncate rather than rename. Renaming moves the inode aside, so a
    // *second* concurrently-running whetstone keeps its already-open file
    // descriptor on the renamed file — its later writes (including a panic
    // backtrace) would land in the backup, not the path `path()` advertises.
    // Truncating in place keeps the live inode every open handle already points
    // at, so all concurrent writers keep appending to the file the UI points at.
    //
    // The backup name appends `.old` to the full path (`diary.txt` →
    // `diary.txt.old`) rather than `with_extension`, which would *replace* the
    // extension (`diary.txt` → `diary.log.old`) and orphan the backup under a
    // name nothing looks for.
    let backup = {
        let mut b = path.as_os_str().to_owned();
        b.push(".old");
        PathBuf::from(b)
    };
    if let Ok(contents) = std::fs::read(path) {
        let _ = std::fs::write(&backup, contents);
        // `File::create` truncates the live file in place — the inode is
        // preserved, so every already-open fd stays valid and points at the
        // (now empty) file subsequent appends extend.
        let _ = File::create(path);
    }
}

/// Record a line at `level` (no-op when disabled or below threshold). The
/// message is secret-scrubbed first — the log outlives the session and may be
/// shared in a bug report, so it must not retain an echoed API key.
pub fn write(level: Level, msg: &str) {
    if !enabled(level) {
        return;
    }
    let Some(sink) = SINK.get() else {
        return;
    };
    let ts = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    // One logical line per event: collapse embedded newlines so a multi-line
    // error or backtrace stays on a single, grep-friendly record.
    let collapsed = scrub_secrets(msg).replace(['\n', '\r'], " ");
    let line = format!("[{ts} {label}] {collapsed}\n", label = level.label());
    if let Ok(mut f) = sink.lock() {
        // A failed write or flush flips the process-wide health flag so
        // `healthy()` (and thus the UI's "(see log)" cue) stops advertising a
        // log this write never reached. Once unhealthy, stays unhealthy — the
        // sink is opened once and a transient cause usually persists.
        if f.write_all(line.as_bytes()).is_err() || f.flush().is_err() {
            WRITE_HEALTHY.store(false, Ordering::Relaxed);
        }
    }
}

fn enabled(level: Level) -> bool {
    match LEVEL.get() {
        Some(min) => level <= *min,
        None => level <= Level::Info,
    }
}

pub fn error(msg: &str) {
    write(Level::Error, msg);
}
pub fn warn(msg: &str) {
    write(Level::Warn, msg);
}
pub fn info(msg: &str) {
    write(Level::Info, msg);
}

/// Strip anything that looks like an API key or bearer token from a string
/// before it is written to the log or shown in the status bar. reqwest errors
/// normally carry only the URL, not the `Authorization` header — but a
/// misbehaving proxy or gateway that echoes the request back in an error body
/// would otherwise persist a key in full. Defense-in-depth, not a guarantee.
pub fn scrub_secrets(s: &str) -> String {
    use regex::Regex;
    static TOKENS: std::sync::LazyLock<Vec<Regex>> = std::sync::LazyLock::new(|| {
        [
            // OpenAI-style keys: `sk-...` (20+ word chars), case-insensitive.
            r#"(?i)\bsk-[a-z0-9_-]{20,}\b"#,
            // An explicit Authorization header, with or without the scheme.
            r#"(?i)\bauthorization\s*:\s*(?:bearer\s+)?[a-z0-9._\-]{20,}"#,
            // A bare `Bearer <token>` value.
            r#"(?i)\bbearer\s+[a-z0-9._\-]{20,}"#,
        ]
        .iter()
        .copied()
        .map(|p| Regex::new(p).expect("valid secret-scrub regex"))
        .collect()
    });
    let mut out = s.to_string();
    for re in TOKENS.iter() {
        out = re.replace_all(&out, "[redacted]").to_string();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_path_prefers_explicit_and_respects_off() {
        assert_eq!(
            resolve_path(Some("/tmp/custom.log")).as_deref(),
            Some(std::path::Path::new("/tmp/custom.log"))
        );
        // `off`/`none` disables, regardless of source.
        assert_eq!(resolve_path(Some("off")), None);
        assert_eq!(resolve_path(Some("  NONE  ")), None);
    }

    #[test]
    fn level_parse_known_names() {
        assert_eq!(Level::parse("ERROR"), Level::Error);
        assert_eq!(Level::parse("warning"), Level::Warn);
        assert_eq!(Level::parse("off"), Level::Off);
        assert_eq!(Level::parse(""), Level::Off);
        assert_eq!(Level::parse("nonsense"), Level::Info);
    }

    #[test]
    fn resolve_level_treats_empty_explicit_as_default() {
        // An empty/whitespace --log-level must NOT disable logging (symmetric
        // with an empty --log-file falling back to the default path); it falls
        // through to the default. `off`/`none` still disable.
        assert_eq!(resolve_level(Some("")), Level::Info);
        assert_eq!(resolve_level(Some("   ")), Level::Info);
        assert_eq!(resolve_level(Some("off")), Level::Off);
        assert_eq!(resolve_level(Some("error")), Level::Error);
    }

    /// A unique, freshly-emptied temp dir for a rotation test. Each test passes
    /// its own `name` so parallel tests in one process don't collide.
    fn rotate_test_dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("whetstone-rotate-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotate_leaves_small_file_untouched() {
        let dir = rotate_test_dir("small");
        let log = dir.join("small.log");
        std::fs::write(&log, "x".repeat(64)).unwrap();
        rotate_if_large(&log);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "x".repeat(64));
        assert!(!dir.join("small.log.old").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_copytruncates_in_place() {
        // A large file's contents move to `.old`, and the live file is emptied
        // in place (its inode preserved, so concurrent open fds stay valid).
        let dir = rotate_test_dir("copytruncate");
        let log = dir.join("big.log");
        let body = "y".repeat(ROTATE_CAP_BYTES as usize + 1);
        std::fs::write(&log, &body).unwrap();
        rotate_if_large(&log);
        // History preserved in the backup, live file emptied in place. (The
        // copytruncate property — the live inode is preserved so a running
        // instance's open fd stays valid — isn't asserted portably; the
        // observable contract is "history in .old, live file empty".)
        assert_eq!(
            std::fs::read_to_string(dir.join("big.log.old")).unwrap(),
            body
        );
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_backup_appends_old_preserving_extension() {
        // `diary.txt` → `diary.txt.old`, NOT `diary.log.old` (with_extension
        // would replace the extension and orphan the backup).
        let dir = rotate_test_dir("extension");
        let log = dir.join("diary.txt");
        std::fs::write(&log, "z".repeat(ROTATE_CAP_BYTES as usize + 1)).unwrap();
        rotate_if_large(&log);
        assert!(
            dir.join("diary.txt.old").exists(),
            "backup should append .old"
        );
        assert!(
            !dir.join("diary.log.old").exists(),
            "backup must not replace the extension"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn healthy_is_false_without_a_sink() {
        // No init() has run in the lib unit-test process, so there is no sink —
        // `healthy()` is strictly stronger than `has_sink()` and must be false
        // here. (The open-but-write-failing case isn't exercised portably: an
        // already-open fd keeps succeeding across later chmod/unlink on Unix, so
        // forcing a write failure needs a full disk, which CI can't stage.)
        assert!(!has_sink());
        assert!(!healthy());
    }

    #[test]
    fn enabled_respects_threshold() {
        assert!(Level::Error <= Level::Info);
        assert!(!(Level::Info <= Level::Error));
        // Off is the floor: nothing records at or above it but itself.
        assert!(Level::Off <= Level::Info);
        assert!(!(Level::Error <= Level::Off));
    }

    #[test]
    fn scrub_secrets_strips_known_token_shapes() {
        let out = scrub_secrets("error: key sk-abcdefghij1234567890XYZ is invalid");
        assert!(!out.contains("sk-"));
        let out = scrub_secrets("echoed: Authorization: Bearer abcdefghij1234567890XYZ");
        // Two independent checks (not one substring): a future regression that
        // narrows the regex to redact only the token tail would leave the
        // literal `Bearer ` scheme prefix in the output. A single
        // `!contains("Bearer abcdef")` would still pass (the pair is gone), so
        // assert neither the scheme nor the token body survives.
        assert!(!out.contains("Bearer"));
        assert!(!out.contains("abcdefghij"));
        assert!(out.contains("[redacted]"));
        // A bare `Bearer <token>` value (no header name) is also scrubbed — the
        // third regex. A misbehaving proxy echoing the request line would leak
        // the key here, so keep this case covered.
        let out = scrub_secrets("sent bearer abcdefghij1234567890XYZ over the wire");
        assert!(!out.contains("abcdefghij"));
        assert!(out.contains("[redacted]"));
        assert_eq!(scrub_secrets("connection refused"), "connection refused");
        // A too-short token is left alone (avoid false positives on prose).
        assert_eq!(
            scrub_secrets("the token sk-short failed"),
            "the token sk-short failed"
        );
    }
}
