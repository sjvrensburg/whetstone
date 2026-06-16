//! Persisted UI preferences: the chosen theme and friction level.
//!
//! Stored as `$XDG_CONFIG_HOME/whetstone/ui.json` (falling back to
//! `$HOME/.config/...`). Environment variables (`WHETSTONE_THEME`,
//! `WHETSTONE_FRICTION`) still take precedence at startup, so an explicit env
//! wins over the saved file. Absent file → built-in defaults.

use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Theme name (matched case-insensitively against the built-ins).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// Friction preset (0–3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub friction: Option<u8>,
}

impl Settings {
    /// Load the saved preferences, or defaults if absent/unreadable.
    pub fn load() -> Self {
        config_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persist the preferences (creating the config dir as needed).
    pub fn save(&self) -> io::Result<()> {
        let path = config_path()
            .ok_or_else(|| io::Error::other("no config dir (set HOME or XDG_CONFIG_HOME)"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        std::fs::write(&path, json)
    }
}

fn config_path() -> Option<PathBuf> {
    Some(crate::config_dir()?.join("whetstone").join("ui.json"))
}
