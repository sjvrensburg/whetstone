//! Coach endpoint configuration.
//!
//! Resolved at startup by [`CoachConfig::load`]: a saved config file (written
//! by the in-app AI settings dialog) is read first, then any `WHETSTONE_*`
//! environment variables overlay it (so an explicit env still wins per run).
//! With neither a file nor an endpoint, the coach is disabled and the editor
//! works fully offline until the user fills in the settings dialog.
//!
//! Two providers are supported so the user is not locked to one vendor:
//! OpenAI-compatible (Ollama, LM Studio, OpenAI, OpenRouter, …) and Anthropic.
//! The provider can be set explicitly or left to auto-detect from the base URL.
//! The coach and the optional LLM judge each resolve to their own [`Endpoint`]
//! (own model, and optionally own provider/endpoint/key), so a writer can run
//! a big local coach and a small remote judge, or vice versa.
//!
//! Settings entered in the TUI are persisted with [`CoachConfig::save`] to
//! `$XDG_CONFIG_HOME/whetstone/coach.json` (falling back to
//! `$HOME/.config/...`), `0600` on Unix since it may hold an API key.

use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The default model used when none is configured.
pub const DEFAULT_MODEL: &str = "gpt-oss:latest";

/// The `anthropic-version` header value sent with Anthropic Messages requests.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// `max_tokens` for Anthropic requests (required by their API). Coach/judge
/// replies are short — the chat guard caps user-facing replies at 900 chars.
pub const ANTHROPIC_MAX_TOKENS: u32 = 1024;

/// Which wire protocol an endpoint speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// OpenAI-compatible Chat Completions (`POST {base}/chat/completions`).
    #[default]
    #[serde(
        alias = "openai-compatible",
        alias = "openai_compatible",
        alias = "oai"
    )]
    OpenAi,
    /// Anthropic Messages (`POST {base}/messages`).
    Anthropic,
}

impl Provider {
    /// Best-effort guess from a base URL when no provider is set explicitly.
    /// Anything that looks like Anthropic (the canonical host, or a gateway
    /// path mentioning it) maps to [`Provider::Anthropic`]; everything else is
    /// treated as OpenAI-compatible.
    pub fn detect(base_url: &str) -> Self {
        if base_url.to_ascii_lowercase().contains("anthropic") {
            Provider::Anthropic
        } else {
            Provider::OpenAi
        }
    }

    /// Parse a free-form string (env var / config) into a provider.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Some(Provider::Anthropic),
            "openai" | "openai-compatible" | "openai_compatible" | "oai" | "compatible" => {
                Some(Provider::OpenAi)
            }
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::OpenAi => "OpenAI-compatible",
            Provider::Anthropic => "Anthropic",
        }
    }
}

/// Tidy a base URL: trim whitespace and any trailing slash.
fn tidy_base(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// A fully-resolved endpoint for one role (coach or judge): the concrete
/// values the client actually sends, with `env:NAME` references already
/// expanded and the provider decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub provider: Provider,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Endpoint {
    /// The full chat URL for this endpoint's provider.
    pub fn url(&self) -> String {
        match self.provider {
            Provider::OpenAi => format!("{}/chat/completions", self.base_url),
            Provider::Anthropic => format!("{}/messages", self.base_url),
        }
    }

    /// The model-list URL (OpenAI-compatible only; used by the connection test).
    pub fn models_url(&self) -> String {
        format!("{}/models", self.base_url)
    }
}

/// The optional LLM-judge configuration. When [`JudgeSettings::enabled`] is
/// false the judge is off and only the deterministic guard runs. Blank
/// connection fields inherit the coach's, so the common case ("same endpoint,
/// a smaller model") needs only `enabled` + `model`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JudgeSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Judge model; blank inherits the coach model.
    #[serde(default)]
    pub model: String,
    /// Blank inherits the coach provider / auto-detects from `base_url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    /// Blank inherits the coach base URL.
    #[serde(default)]
    pub base_url: String,
    /// Blank inherits the coach API key.
    #[serde(default)]
    pub api_key: String,
}

impl JudgeSettings {
    /// Whether this is the all-default (judge-off) value — used to keep
    /// `coach.json` tidy by not serializing an empty judge block.
    fn is_unset(&self) -> bool {
        !self.enabled
            && self.model.is_empty()
            && self.provider.is_none()
            && self.base_url.is_empty()
            && self.api_key.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoachConfig {
    /// `None` = auto-detect from `base_url`. Set explicitly to override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    /// e.g. `http://localhost:11434/v1` (no trailing slash).
    pub base_url: String,
    /// Many local servers ignore this; real providers require it.
    pub api_key: String,
    /// The coach model, e.g. `llama3.1`, `gpt-oss:latest`, `claude-opus-4-8`.
    pub model: String,
    /// The optional LLM judge that screens coach replies (see [`JudgeSettings`]).
    #[serde(default, skip_serializing_if = "JudgeSettings::is_unset")]
    pub judge: JudgeSettings,
}

impl CoachConfig {
    /// Resolve the effective config: saved file first, then `WHETSTONE_*` env
    /// overlay. Returns `None` (coach disabled) when no endpoint is set.
    pub fn load() -> Option<Self> {
        let mut cfg = Self::from_file().unwrap_or(Self {
            provider: None,
            base_url: String::new(),
            api_key: String::new(),
            model: DEFAULT_MODEL.to_string(),
            judge: JudgeSettings::default(),
        });
        if let Ok(base) = std::env::var("WHETSTONE_BASE_URL") {
            let base = base.trim();
            if !base.is_empty() {
                cfg.base_url = tidy_base(base);
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
        if let Ok(p) = std::env::var("WHETSTONE_PROVIDER")
            && let Some(p) = Provider::parse(&p)
        {
            cfg.provider = Some(p);
        }
        // Judge env overlay.
        if let Ok(v) = std::env::var("WHETSTONE_JUDGE") {
            cfg.judge.enabled = is_truthy(&v);
        }
        if let Ok(m) = std::env::var("WHETSTONE_JUDGE_MODEL")
            && !m.trim().is_empty()
        {
            cfg.judge.model = m;
        }
        if let Ok(b) = std::env::var("WHETSTONE_JUDGE_BASE_URL") {
            cfg.judge.base_url = b;
        }
        if let Ok(k) = std::env::var("WHETSTONE_JUDGE_API_KEY") {
            cfg.judge.api_key = k;
        }
        if let Ok(p) = std::env::var("WHETSTONE_JUDGE_PROVIDER")
            && let Some(p) = Provider::parse(&p)
        {
            cfg.judge.provider = Some(p);
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

    /// The resolved coach endpoint: every field's `env:NAME` reference expanded,
    /// the base URL tidied, and the provider decided (explicit, else detected).
    pub fn coach_endpoint(&self) -> Endpoint {
        let base_url = tidy_base(&resolve_env_value(&self.base_url));
        let provider = self.provider.unwrap_or_else(|| Provider::detect(&base_url));
        Endpoint {
            provider,
            base_url,
            api_key: resolve_env_value(&self.api_key),
            model: resolve_env_value(&self.model),
        }
    }

    /// The resolved judge endpoint, or `None` when the judge is disabled. Blank
    /// judge fields inherit from the coach endpoint; the provider is explicit if
    /// set, else detected from the (possibly inherited) base URL, else the
    /// coach's provider.
    pub fn judge_endpoint(&self) -> Option<Endpoint> {
        if !self.judge.enabled {
            return None;
        }
        let coach = self.coach_endpoint();
        let own_base = resolve_env_value(&self.judge.base_url);
        let base_url = if own_base.trim().is_empty() {
            coach.base_url.clone()
        } else {
            tidy_base(&own_base)
        };
        let own_key = resolve_env_value(&self.judge.api_key);
        let api_key = if own_key.is_empty() {
            coach.api_key.clone()
        } else {
            own_key
        };
        let own_model = resolve_env_value(&self.judge.model);
        let model = if own_model.trim().is_empty() {
            coach.model.clone()
        } else {
            own_model
        };
        let provider = self.judge.provider.unwrap_or_else(|| {
            // Branch on the *resolved* own base URL: when the judge has no base
            // of its own (blank, or an `env:NAME` that resolves empty) it
            // inherits the coach's provider rather than re-detecting from the
            // inherited URL — so an explicit coach-provider override is honoured.
            if own_base.trim().is_empty() {
                coach.provider
            } else {
                Provider::detect(&base_url)
            }
        });
        Some(Endpoint {
            provider,
            base_url,
            api_key,
            model,
        })
    }
}

/// Whether an env-var string means "on" (`1`, `true`, `yes`, `on`).
fn is_truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
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

    fn cfg(base_url: &str, model: &str) -> CoachConfig {
        CoachConfig {
            provider: None,
            base_url: base_url.into(),
            api_key: String::new(),
            model: model.into(),
            judge: JudgeSettings::default(),
        }
    }

    #[test]
    fn openai_endpoint_joins_chat_completions() {
        let e = cfg("http://localhost:11434/v1", "x").coach_endpoint();
        assert_eq!(e.provider, Provider::OpenAi);
        assert_eq!(e.url(), "http://localhost:11434/v1/chat/completions");
    }

    #[test]
    fn provider_auto_detects_anthropic_from_base_url() {
        let e = cfg("https://api.anthropic.com/v1", "claude-opus-4-8").coach_endpoint();
        assert_eq!(e.provider, Provider::Anthropic);
        assert_eq!(e.url(), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn explicit_provider_overrides_detection() {
        let mut c = cfg("https://api.anthropic.com/v1", "m");
        c.provider = Some(Provider::OpenAi);
        assert_eq!(c.coach_endpoint().provider, Provider::OpenAi);
    }

    #[test]
    fn old_flat_config_deserializes_with_defaults() {
        // A pre-existing coach.json with no provider / judge fields must load.
        let json = r#"{"base_url":"http://localhost:11434/v1","api_key":"","model":"llama3.1"}"#;
        let c: CoachConfig = serde_json::from_str(json).unwrap();
        assert!(c.provider.is_none());
        assert!(!c.judge.enabled);
        assert_eq!(c.coach_endpoint().model, "llama3.1");
        assert!(c.judge_endpoint().is_none());
    }

    #[test]
    fn judge_inherits_blank_fields_from_coach() {
        let mut c = cfg("https://api.anthropic.com/v1", "big-model");
        c.api_key = "secret".into();
        c.judge.enabled = true; // model/base/key/provider all blank → inherit
        let j = c.judge_endpoint().unwrap();
        assert_eq!(j.base_url, "https://api.anthropic.com/v1");
        assert_eq!(j.api_key, "secret");
        assert_eq!(j.model, "big-model");
        assert_eq!(j.provider, Provider::Anthropic);
    }

    #[test]
    fn judge_uses_own_model_and_independent_endpoint() {
        let mut c = cfg("http://localhost:11434/v1", "big-model");
        c.judge = JudgeSettings {
            enabled: true,
            model: "small-judge".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            api_key: "k2".into(),
            provider: None, // detect from judge base_url
        };
        let j = c.judge_endpoint().unwrap();
        assert_eq!(j.model, "small-judge");
        assert_eq!(j.base_url, "https://api.anthropic.com/v1");
        assert_eq!(j.api_key, "k2");
        assert_eq!(j.provider, Provider::Anthropic);
    }

    #[test]
    fn judge_with_env_empty_base_inherits_coach_provider() {
        // Coach explicitly overrides the provider; the judge's own base is an
        // env ref that resolves empty, so it must inherit the coach provider
        // rather than re-detect from the inherited (anthropic-looking) URL.
        let mut c = cfg("https://api.anthropic.com/v1", "m");
        c.provider = Some(Provider::OpenAi);
        c.judge = JudgeSettings {
            enabled: true,
            base_url: "env:WHETSTONE_DEFINITELY_UNSET_JUDGE_BASE".into(),
            ..Default::default()
        };
        let j = c.judge_endpoint().unwrap();
        assert_eq!(j.provider, Provider::OpenAi);
        assert_eq!(j.base_url, "https://api.anthropic.com/v1");
    }

    #[test]
    fn plain_values_resolve_to_themselves() {
        assert_eq!(resolve_env_value("sk-abc123"), "sk-abc123");
        assert!(!is_env_ref("sk-abc123"));
    }

    #[test]
    fn env_references_resolve_against_the_environment() {
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
        assert_eq!(resolve_env_value("env:WHETSTONE_DEFINITELY_UNSET_VAR"), "");
        unsafe {
            std::env::remove_var(var);
        }
    }

    #[test]
    fn endpoint_resolves_env_refs_and_tidies_base_url() {
        let var = "WHETSTONE_TEST_BASE_XYZZY";
        // SAFETY: unique var name, set/cleared within this test.
        unsafe {
            std::env::set_var(var, "http://example.test/v1/");
        }
        let raw = CoachConfig {
            provider: None,
            base_url: "env:WHETSTONE_TEST_BASE_XYZZY".into(),
            api_key: "env:WHETSTONE_DEFINITELY_UNSET_VAR".into(),
            model: "llama3.1".into(),
            judge: JudgeSettings::default(),
        };
        let e = raw.coach_endpoint();
        assert_eq!(e.base_url, "http://example.test/v1"); // trailing slash trimmed
        assert_eq!(e.api_key, ""); // unset → empty
        assert_eq!(e.model, "llama3.1");
        // The raw config is untouched, so it persists as a reference.
        assert_eq!(raw.base_url, "env:WHETSTONE_TEST_BASE_XYZZY");
        unsafe {
            std::env::remove_var(var);
        }
    }

    #[test]
    fn config_path_is_under_config_dir() {
        if let Some(p) = config_path() {
            assert!(p.ends_with("whetstone/coach.json"));
        }
    }
}
