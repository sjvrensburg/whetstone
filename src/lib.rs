//! Whetstone TUI library root.
//!
//! Module dependency DAG (each module depends only on modules above it):
//! ```text
//! core -> coach -> instruments -> editor -> grammar -> markdown -> ui
//! ```
//! `core` is pure domain logic (ported from an earlier web composer that has
//! since been removed); it has no I/O and no UI/editor dependencies.

pub mod cli_args;
pub mod coach;
pub mod core;
pub mod editor;
pub mod fs_util;
pub mod grammar;
pub mod instruments;
pub mod log;
pub mod markdown;
#[cfg(feature = "screenshots")]
pub mod screenshot;
pub mod ui;

use std::path::PathBuf;

/// Probe an XDG-style directory: `$var` if set and absolute, else the Windows
/// `%win_var%` env (Roaming `APPDATA` for config, Local `LOCALAPPDATA` for
/// state), else `$HOME/$fallback`. `None` if none can be found. Shared by
/// [`config_dir`] and [`state_dir`] so the env-probe lives in one place.
#[cfg_attr(not(windows), allow(unused_variables))]
fn xdg_dir(var: &str, win_var: &str, fallback: &str) -> Option<PathBuf> {
    if let Some(x) = std::env::var_os(var) {
        let p = PathBuf::from(x);
        if p.is_absolute() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    if let Some(p) = std::env::var_os(win_var) {
        return Some(PathBuf::from(p));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(fallback))
}

/// The user config directory: `$XDG_CONFIG_HOME` if set (absolute), else
/// `%APPDATA%` (Roaming) on Windows, else `$HOME/.config`. `None` if none can be
/// found. Config is meant to follow the user across machines, so Roaming is
/// correct here.
pub fn config_dir() -> Option<PathBuf> {
    xdg_dir("XDG_CONFIG_HOME", "APPDATA", ".config")
}

/// The user state directory — the XDG-correct home for mutable, machine-local
/// per-user data like logs: `$XDG_STATE_HOME` if set (absolute), else
/// `$HOME/.local/state`, else `%LOCALAPPDATA%` (Local — NOT Roaming) on Windows.
/// `None` if none can be found. Diagnostic logs embed machine-local detail (a
/// scrubbed backtrace carries the edited file's path), so they must not roam
/// with the profile to every machine the user signs into.
pub fn state_dir() -> Option<PathBuf> {
    xdg_dir("XDG_STATE_HOME", "LOCALAPPDATA", ".local/state")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, MutexGuard};

    /// Env mutation must be serialized process-wide; this lock is held for the
    /// duration of each test that sets an XDG var, mirroring `coach/history.rs`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The XDG var (when absolute) takes precedence over the platform default
    /// on every platform — so config/state live where the user points them, and
    /// the Windows `%LOCALAPPDATA%` branch is only reached when XDG is unset.
    #[test]
    fn xdg_var_takes_precedence_when_absolute() {
        let _guard = lock_env();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("whetstone-lib-dir-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: ENV_LOCK serializes env mutation across these tests.
        unsafe {
            std::env::set_var("XDG_STATE_HOME", &dir);
        }
        assert_eq!(state_dir().as_deref(), Some(dir.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
