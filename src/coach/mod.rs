//! OpenAI-compatible coaching: config, streaming client, and the guard that
//! every coach/chat response must pass before it reaches the UI.
//!
//! Speaks the Chat Completions API (`POST {base_url}/chat/completions`,
//! `stream:true`, SSE `choices[0].delta.content`) against any endpoint —
//! Ollama, LM Studio, OpenAI, OpenRouter. No Anthropic-specific code.

pub mod client;
pub mod config;
pub mod history;

pub use client::{CoachClient, parse_sse_chunk};
pub use config::{CoachConfig, DEFAULT_MODEL, is_env_ref, resolve_env_value};
