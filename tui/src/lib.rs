//! Whetstone TUI library root.
//!
//! Module dependency DAG (each module depends only on modules above it):
//! ```text
//! core -> service -> coach -> instruments -> editor -> markdown -> ui
//! ```
//! `core` is pure domain logic ported from the web composer
//! (`composer/src/core/`); it has no I/O and no UI/editor dependencies.

pub mod coach;
pub mod core;
pub mod editor;
pub mod grammar;
pub mod instruments;
pub mod markdown;
pub mod ui;

use std::path::PathBuf;

/// The user config directory: `$XDG_CONFIG_HOME` if set (absolute), else
/// `%APPDATA%` on Windows, else `$HOME/.config`. `None` if none can be found.
pub fn config_dir() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        let p = PathBuf::from(x);
        if p.is_absolute() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Some(PathBuf::from(appdata));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
}
