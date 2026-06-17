//! Streaming chat client for both providers, with hand-rolled SSE parsing.
//!
//! No `eventsource-stream` dependency: the streaming loop buffers raw bytes and
//! hands complete `data:` lines to [`parse_sse_chunk`], which delegates to the
//! per-provider [`super::provider::extract_delta`] to pull out text tokens. The
//! request shaping (OpenAI vs Anthropic) lives in [`super::provider`].

use std::time::Duration;

use anyhow::Result;
use futures::StreamExt;
use serde::Deserialize;

use crate::core::prompts::ChatMessage;

use super::config::{CoachConfig, Endpoint, Provider};
use super::provider::{build_request, extract_delta};

#[derive(Clone)]
pub struct CoachClient {
    http: reqwest::Client,
    config: CoachConfig,
}

impl CoachClient {
    pub fn new(config: CoachConfig) -> Self {
        // Bound the connect and per-read time so a stalled provider surfaces as
        // an error (clearing the busy state) instead of hanging the coach
        // forever. `read_timeout` fires only on a gap with no bytes, so it does
        // not cut off a slow-but-progressing stream.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http, config }
    }

    pub fn config(&self) -> &CoachConfig {
        &self.config
    }

    /// The resolved coach endpoint for this client's config.
    pub fn coach_endpoint(&self) -> Endpoint {
        self.config.coach_endpoint()
    }

    /// The resolved judge endpoint, or `None` when the judge is disabled.
    pub fn judge_endpoint(&self) -> Option<Endpoint> {
        self.config.judge_endpoint()
    }

    /// Probe the endpoint by fetching its OpenAI-compatible model list
    /// (`GET {base_url}/models`). Used by the settings dialog's connection test:
    /// success confirms the endpoint is reachable and the key (if any) is
    /// accepted, and returns the model ids so the writer can pick one. Ids are
    /// sorted for stable display. Anthropic exposes no such list, so this is a
    /// no-op (empty) there — the dialog falls back to a curated model list.
    pub async fn list_models(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Model {
            id: String,
        }
        #[derive(Deserialize)]
        struct Resp {
            data: Vec<Model>,
        }
        let endpoint = self.coach_endpoint();
        if endpoint.provider == Provider::Anthropic {
            return Ok(Vec::new());
        }
        let resp = self
            .http
            .get(endpoint.models_url())
            .bearer_auth(&endpoint.api_key)
            .send()
            .await?;
        let resp = resp.error_for_status()?;
        let parsed: Resp = resp.json().await?;
        let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
        ids.sort();
        Ok(ids)
    }

    /// Stream a chat completion against `endpoint`, calling `on_delta` with each
    /// text fragment as it arrives. Returns the fully assembled text. When
    /// `json_mode` is set, the request asks for a JSON object response
    /// (structured coaching / judge verdict) — best-effort on backends (incl.
    /// Anthropic) that ignore the hint and rely on the prompt instead.
    pub async fn chat<F: FnMut(&str)>(
        &self,
        endpoint: &Endpoint,
        messages: &[ChatMessage],
        json_mode: bool,
        mut on_delta: F,
    ) -> Result<String> {
        let provider = endpoint.provider;
        let resp = build_request(&self.http, endpoint, messages, json_mode)
            .send()
            .await?;
        let resp = resp.error_for_status()?;

        let mut stream = resp.bytes_stream();
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            bytes.extend_from_slice(&chunk);
            // Move only complete lines into the text buffer; a partial trailing
            // line (possibly a multibyte char split across network chunks) stays
            // in `bytes` so a split codepoint never aborts the stream.
            if drain_complete_lines(&mut bytes, &mut buf) {
                for delta in parse_sse_chunk(&mut buf, provider) {
                    on_delta(&delta);
                    full.push_str(&delta);
                }
            }
        }
        // Flush a final `data:` line that arrived without a trailing newline.
        if !bytes.is_empty() {
            buf.push_str(&String::from_utf8_lossy(&bytes));
        }
        if !buf.trim().is_empty() {
            buf.push('\n');
            for delta in parse_sse_chunk(&mut buf, provider) {
                on_delta(&delta);
                full.push_str(&delta);
            }
        }
        Ok(full)
    }
}

/// Move all complete lines (through the last `\n`) from the raw byte buffer
/// into the text buffer, decoding them as UTF-8 (lossily for any truly invalid
/// bytes). Bytes after the last newline — which may be a multibyte char split
/// across network reads — stay in `bytes`. Returns whether anything moved.
///
/// A line delimited by `\n` is always a whole sequence of codepoints (`\n` is
/// never a continuation byte), so complete lines decode exactly.
fn drain_complete_lines(bytes: &mut Vec<u8>, buf: &mut String) -> bool {
    let Some(last_nl) = bytes.iter().rposition(|&b| b == b'\n') else {
        return false;
    };
    let complete: Vec<u8> = bytes.drain(..=last_nl).collect();
    buf.push_str(&String::from_utf8_lossy(&complete));
    true
}

/// Parse complete SSE `data:` lines out of `buf` for `provider`, returning the
/// text deltas and leaving any incomplete trailing line in `buf`.
///
/// Lines that aren't valid JSON or that carry no user-facing text (role-only
/// starts, Anthropic `ping`/`message_stop`, etc.) are silently skipped — only
/// real text tokens are emitted.
pub fn parse_sse_chunk(buf: &mut String, provider: Provider) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let Some(nl) = buf.find('\n') else {
            return out;
        };
        let line = buf[..nl].trim().to_string();
        buf.drain(..=nl);
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" || data.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        if let Some(delta) = extract_delta(provider, &v) {
            out.push(delta);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coach::config::JudgeSettings;

    fn test_config(base_url: String) -> CoachConfig {
        CoachConfig {
            provider: None,
            base_url,
            api_key: String::new(),
            model: "m".into(),
            judge: JudgeSettings::default(),
        }
    }

    #[test]
    fn parses_content_deltas_and_consumes_complete_lines() {
        let mut buf = String::from(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\
             data: [DONE]\n",
        );
        let out = parse_sse_chunk(&mut buf, Provider::OpenAi);
        assert_eq!(out, vec!["Hel".to_string(), "lo".to_string()]);
        assert!(
            buf.is_empty(),
            "complete lines consumed; got leftover: {buf:?}"
        );
    }

    #[test]
    fn parses_anthropic_text_deltas() {
        let mut buf = String::from(
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\
             data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\
             data: {\"type\":\"message_stop\"}\n",
        );
        let out = parse_sse_chunk(&mut buf, Provider::Anthropic);
        assert_eq!(out, vec!["Hel".to_string(), "lo".to_string()]);
    }

    #[test]
    fn keeps_incomplete_trailing_line_in_buffer() {
        let mut buf = String::from(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"par",
        );
        let out = parse_sse_chunk(&mut buf, Provider::OpenAi);
        assert_eq!(out, vec!["Hi".to_string()]);
        assert!(
            buf.contains("\"par"),
            "incomplete line stays buffered: {buf:?}"
        );
    }

    #[test]
    fn reassembles_multibyte_char_split_across_chunks() {
        // "café" — the 'é' (0xC3 0xA9) is split across two network chunks. The
        // partial byte must be held back, not decoded (which would corrupt or,
        // in the old code, abort the stream).
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = String::new();

        let line = b"data: {\"choices\":[{\"delta\":{\"content\":\"caf\xC3";
        bytes.extend_from_slice(line); // ends mid-codepoint, no newline
        assert!(!drain_complete_lines(&mut bytes, &mut buf));
        assert!(parse_sse_chunk(&mut buf, Provider::OpenAi).is_empty());

        bytes.extend_from_slice(b"\xA9\"}}]}\n"); // rest of 'é' + close + newline
        assert!(drain_complete_lines(&mut bytes, &mut buf));
        let out = parse_sse_chunk(&mut buf, Provider::OpenAi);
        assert_eq!(out, vec!["café".to_string()]);
        assert!(bytes.is_empty());
    }

    #[test]
    fn chat_assembles_streamed_sse_over_http() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf); // consume the request headers
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\
                        data: [DONE]\n";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let client = CoachClient::new(test_config(format!("http://{addr}")));
        let endpoint = client.coach_endpoint();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let out = rt
            .block_on(client.chat(&endpoint, &[], false, |_| {}))
            .unwrap();
        server.join().unwrap();
        assert_eq!(out, "Hello");
    }

    #[test]
    fn chat_sends_anthropic_shape_and_parses_text_deltas() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\
                        data: {\"type\":\"message_stop\"}\n";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
            req
        });

        let mut cfg = test_config(format!("http://{addr}/v1"));
        cfg.provider = Some(Provider::Anthropic);
        let client = CoachClient::new(cfg);
        let endpoint = client.coach_endpoint();
        let msgs = vec![
            ChatMessage {
                role: crate::core::prompts::Role::System,
                content: "sys".into(),
            },
            ChatMessage {
                role: crate::core::prompts::Role::User,
                content: "hello".into(),
            },
        ];
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let out = rt
            .block_on(client.chat(&endpoint, &msgs, false, |_| {}))
            .unwrap();
        let req = server.join().unwrap();
        assert_eq!(out, "Hi");
        // The request must hit /messages and carry the Anthropic headers/shape.
        assert!(req.contains("POST /v1/messages"), "req: {req}");
        assert!(req.to_lowercase().contains("anthropic-version"));
        assert!(req.to_lowercase().contains("x-api-key"));
        assert!(req.contains("\"system\":\"sys\""));
        assert!(req.contains("\"max_tokens\""));
    }

    #[test]
    fn list_models_parses_and_sorts_ids_over_http() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf); // consume the request headers
            let body = r#"{"object":"list","data":[{"id":"qwen2.5"},{"id":"llama3.1"}]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let client = CoachClient::new(test_config(format!("http://{addr}")));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let models = rt.block_on(client.list_models()).unwrap();
        server.join().unwrap();
        assert_eq!(models, vec!["llama3.1".to_string(), "qwen2.5".to_string()]);
    }

    #[test]
    fn list_models_surfaces_http_error_status() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let resp =
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let mut cfg = test_config(format!("http://{addr}"));
        cfg.api_key = "bad".into();
        let client = CoachClient::new(cfg);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(client.list_models());
        server.join().unwrap();
        assert!(err.is_err(), "401 must surface as an error");
    }

    #[test]
    fn skips_non_content_events() {
        // role-only start event has no content → skipped, not an error.
        let mut buf = String::from("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n");
        let out = parse_sse_chunk(&mut buf, Provider::OpenAi);
        assert!(out.is_empty());
    }
}
