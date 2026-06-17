//! AI coaching: config, streaming client, the optional LLM judge, and the
//! deterministic guard that every coach/chat response must pass before the UI.
//!
//! Speaks two protocols so the writer is not locked to one vendor: an
//! OpenAI-compatible Chat Completions endpoint (Ollama, LM Studio, OpenAI,
//! OpenRouter, …) and Anthropic Messages. The provider is set explicitly or
//! auto-detected from the base URL (see [`config::Provider`]).

pub mod client;
pub mod config;
pub mod history;
pub mod judge;
pub mod provider;

pub use client::{CoachClient, parse_sse_chunk};
pub use config::{
    CoachConfig, DEFAULT_MODEL, Endpoint, JudgeSettings, Provider, is_env_ref, resolve_env_value,
};
pub use judge::{Verdict, screen_with_judge};
