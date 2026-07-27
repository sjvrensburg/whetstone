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

/// Probe an XDG-style directory: `$var` if set and absolute, else `%APPDATA%`
/// on Windows, else `$HOME/$fallback`. `None` if none can be found. Shared by
/// [`config_dir`] and [`state_dir`] so the env-probe lives in one place.
fn xdg_dir(var: &str, fallback: &str) -> Option<PathBuf> {
    if let Some(x) = std::env::var_os(var) {
        let p = PathBuf::from(x);
        if p.is_absolute() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Some(PathBuf::from(appdata));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(fallback))
}

/// The user config directory: `$XDG_CONFIG_HOME` if set (absolute), else
/// `%APPDATA%` on Windows, else `$HOME/.config`. `None` if none can be found.
pub fn config_dir() -> Option<PathBuf> {
    xdg_dir("XDG_CONFIG_HOME", ".config")
}

/// The user state directory — the XDG-correct home for mutable per-user data
/// like logs: `$XDG_STATE_HOME` if set (absolute), else `$HOME/.local/state`
/// (or `%APPDATA%` on Windows). `None` if none can be found.
pub fn state_dir() -> Option<PathBuf> {
    xdg_dir("XDG_STATE_HOME", ".local/state")
}
