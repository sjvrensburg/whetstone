//! Coach endpoint configuration.
//!
//! M3 cut: loaded from environment so the editor stays zero-config-file. Set
//! `WHETSTONE_BASE_URL` (e.g. `http://localhost:11434/v1`), and optionally
//! `WHETSTONE_API_KEY` + `WHETSTONE_MODEL`, to enable the coach. Absent → the
//! coach is disabled and the editor works fully offline.

use serde::{Deserialize, Serialize};

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
    /// Load from environment. Returns `None` when the endpoint is unconfigured.
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("WHETSTONE_BASE_URL").ok()?;
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return None;
        }
        Some(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: std::env::var("WHETSTONE_API_KEY").unwrap_or_default(),
            model: std::env::var("WHETSTONE_MODEL")
                .unwrap_or_else(|_| "gpt-oss:latest".to_string()),
        })
    }

    /// The full Chat Completions URL.
    pub fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }
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
}
