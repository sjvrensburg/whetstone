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

    /// A copy with every field's environment-variable reference resolved (see
    /// [`resolve_env_value`]) and a tidy `base_url` (no trailing slash). The
    /// raw config keeps the `env:NAME` form for persistence; this is what the
    /// client actually sends, so a secret is read from the environment at
    /// request time and never written to `coach.json`.
    pub fn resolved(&self) -> Self {
        Self {
            base_url: resolve_env_value(&self.base_url)
                .trim()
                .trim_end_matches('/')
                .to_string(),
            api_key: resolve_env_value(&self.api_key),
            model: resolve_env_value(&self.model),
        }
    }
}

/// Whether `value` is an environment-variable reference (`env:NAME` or
/// `${NAME}`) rather than a literal value. The dialog uses this to keep such
/// references readable instead of masking them as a secret.
pub fn is_env_ref(value: &str) -> bool {
    env_ref_name(value).is_some()
}

/// Resolve an `env:NAME` / `${NAME}` reference to the current value of that
/// environment variable (empty string if unset). Any other string is returned
/// unchanged, so plain literals keep working exactly as before.
pub fn resolve_env_value(value: &str) -> String {
    match env_ref_name(value) {
        Some(name) => std::env::var(name).unwrap_or_default(),
        None => value.to_string(),
    }
}

/// Extract the variable name from an `env:NAME` or `${NAME}` reference.
fn env_ref_name(value: &str) -> Option<&str> {
    let t = value.trim();
    if let Some(rest) = t.strip_prefix("env:") {
        let name = rest.trim();
        return (!name.is_empty()).then_some(name);
    }
    if let Some(inner) = t.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
        let name = inner.trim();
        return (!name.is_empty()).then_some(name);
    }
    None
}

/// `…/whetstone/coach.json` under the user config dir.
fn config_path() -> Option<PathBuf> {
    Some(crate::config_dir()?.join("whetstone").join("coach.json"))
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
    fn plain_values_resolve_to_themselves() {
        assert_eq!(resolve_env_value("sk-abc123"), "sk-abc123");
        assert_eq!(
            resolve_env_value("http://localhost:11434/v1"),
            "http://localhost:11434/v1"
        );
        assert!(!is_env_ref("sk-abc123"));
    }

    #[test]
    fn env_references_resolve_against_the_environment() {
        // A uniquely named var so this can't collide with another test.
        let var = "WHETSTONE_TEST_KEY_XYZZY";
        // SAFETY: single-threaded within this test; the var name is unique.
        unsafe {
            std::env::set_var(var, "secret-value");
        }
        assert!(is_env_ref("env:WHETSTONE_TEST_KEY_XYZZY"));
        assert!(is_env_ref("${WHETSTONE_TEST_KEY_XYZZY}"));
        assert_eq!(
            resolve_env_value("env:WHETSTONE_TEST_KEY_XYZZY"),
            "secret-value"
        );
        assert_eq!(
            resolve_env_value("${WHETSTONE_TEST_KEY_XYZZY}"),
            "secret-value"
        );
        // An unset var resolves to empty rather than leaking the reference.
        assert_eq!(resolve_env_value("env:WHETSTONE_DEFINITELY_UNSET_VAR"), "");
        unsafe {
            std::env::remove_var(var);
        }
    }

    #[test]
    fn resolved_keeps_raw_form_intact_and_tidies_base_url() {
        let var = "WHETSTONE_TEST_BASE_XYZZY";
        // SAFETY: unique var name, set/cleared within this test.
        unsafe {
            std::env::set_var(var, "http://example.test/v1/");
        }
        let raw = CoachConfig {
            base_url: "env:WHETSTONE_TEST_BASE_XYZZY".into(),
            api_key: "env:WHETSTONE_DEFINITELY_UNSET_VAR".into(),
            model: "llama3.1".into(),
        };
        let r = raw.resolved();
        assert_eq!(r.base_url, "http://example.test/v1"); // trailing slash trimmed
        assert_eq!(r.api_key, ""); // unset → empty
        assert_eq!(r.model, "llama3.1");
        // The raw config is untouched, so it persists as a reference.
        assert_eq!(raw.base_url, "env:WHETSTONE_TEST_BASE_XYZZY");
        unsafe {
            std::env::remove_var(var);
        }
    }

    #[test]
    fn config_path_is_under_config_dir() {
        // Whatever the environment, the path ends with the expected suffix.
        if let Some(p) = config_path() {
            assert!(p.ends_with("whetstone/coach.json"));
        }
    }
}
