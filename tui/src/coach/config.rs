//! Coach endpoint configuration.
//!
//! Resolved at startup by [`CoachConfig::load`]: a saved config file (written
//! by the in-app AI settings dialog) is read first, then any `WHETSTONE_*`
//! environment variables overlay it (so an explicit env still wins per run).
//! With neither a file nor an endpoint, the coach is disabled and the editor
//! works fully offline until the user fills in the settings dialog.
//!
//! Settings entered in the TUI are persisted with [`CoachConfig::save`] to
//! `$XDG_CONFIG_HOME/whetstone/coach.json` (falling back to
//! `$HOME/.config/...`), `0600` on Unix since it may hold an API key.

use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The default model used when none is configured.
pub const DEFAULT_MODEL: &str = "gpt-oss:latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoachConfig {
    /// e.g. `http://localhost:11434/v1` (no trailing slash).
    pub base_url: String,
    /// Many local servers ignore this; real providers require it.
    pub api_key: String,
    /// e.g. `llama3.1`, `gpt-oss:latest`, `qwen2.5`.
    pub model: String,
}

impl CoachConfig {
    /// Resolve the effective config: saved file first, then `WHETSTONE_*` env
    /// overlay. Returns `None` (coach disabled) when no endpoint is set.
    pub fn load() -> Option<Self> {
        let mut cfg = Self::from_file().unwrap_or(Self {
            base_url: String::new(),
            api_key: String::new(),
            model: DEFAULT_MODEL.to_string(),
        });
        if let Ok(base) = std::env::var("WHETSTONE_BASE_URL") {
            let base = base.trim();
            if !base.is_empty() {
                cfg.base_url = base.trim_end_matches('/').to_string();
            }
        }
        if let Ok(key) = std::env::var("WHETSTONE_API_KEY") {
            cfg.api_key = key;
        }
        if let Ok(model) = std::env::var("WHETSTONE_MODEL")
            && !model.trim().is_empty()
        {
            cfg.model = model;
        }
        if cfg.base_url.trim().is_empty() {
            return None;
        }
        Some(cfg)
    }

    /// Load purely from the saved config file (no env overlay).
    fn from_file() -> Option<Self> {
        let data = std::fs::read_to_string(config_path()?).ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Persist this config to the user config file (creating dirs as needed),
    /// restricting it to the owner on Unix. Returns the path written.
    pub fn save(&self) -> io::Result<PathBuf> {
        let path = config_path()
            .ok_or_else(|| io::Error::other("no config dir (set HOME or XDG_CONFIG_HOME)"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        std::fs::write(&path, json)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(path)
    }

    /// The full Chat Completions URL.
    pub fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }
}

/// `…/whetstone/coach.json` under `$XDG_CONFIG_HOME` or `$HOME/.config`.
fn config_path() -> Option<PathBuf> {
    let dir = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(x) if PathBuf::from(&x).is_absolute() => PathBuf::from(x),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    Some(dir.join("whetstone").join("coach.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_joins_path() {
        let c = CoachConfig {
            base_url: "http://localhost:11434/v1".into(),
            api_key: String::new(),
            model: "x".into(),
        };
        assert_eq!(c.endpoint(), "http://localhost:11434/v1/chat/completions");
    }

    #[test]
    fn config_path_is_under_config_dir() {
        // Whatever the environment, the path ends with the expected suffix.
        if let Some(p) = config_path() {
            assert!(p.ends_with("whetstone/coach.json"));
        }
    }
}
