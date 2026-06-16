//! OpenAI-compatible Chat Completions client with hand-rolled SSE streaming.
//!
//! No `eventsource-stream` dependency: the streaming loop buffers raw bytes and
//! hands complete `data:` lines to [`parse_sse_chunk`], which extracts the
//! `choices[0].delta.content` tokens.

use std::time::Duration;

use anyhow::Result;
use futures::StreamExt;
use serde::Serialize;

use crate::core::prompts::ChatMessage;

use super::config::CoachConfig;

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

    /// Stream a chat completion, calling `on_delta` with each text fragment as
    /// it arrives. Returns the fully assembled text.
    pub async fn chat<F: FnMut(&str)>(
        &self,
        messages: &[ChatMessage],
        mut on_delta: F,
    ) -> Result<String> {
        #[derive(Serialize)]
        struct Req<'a> {
            model: &'a str,
            messages: &'a [ChatMessage],
            stream: bool,
        }
        let body = Req {
            model: &self.config.model,
            messages,
            stream: true,
        };

        let resp = self
            .http
            .post(self.config.endpoint())
            .bearer_auth(&self.config.api_key)
            .json(&body)
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
            // Move only complete lines (through the last newline) into the text
            // buffer. Partial trailing bytes — possibly a multibyte char split
            // across this network chunk and the next — stay in `bytes`, so a
            // split codepoint never aborts the stream. A line delimited by '\n'
            // is always a whole codepoint sequence, so the conversion is exact.
            if let Some(last_nl) = bytes.iter().rposition(|&b| b == b'\n') {
                let complete: Vec<u8> = bytes.drain(..=last_nl).collect();
                buf.push_str(&String::from_utf8_lossy(&complete));
                for delta in parse_sse_chunk(&mut buf) {
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
            for delta in parse_sse_chunk(&mut buf) {
                on_delta(&delta);
                full.push_str(&delta);
            }
        }
        Ok(full)
    }
}

/// Parse complete SSE `data:` lines out of `buf`, returning the content deltas
/// and leaving any incomplete trailing line in `buf`.
///
/// Lines that aren't valid JSON or lack a `choices[0].delta.content` field
/// (e.g. role-only `content_block_start` events) are silently skipped — only
/// real text tokens are emitted.
pub fn parse_sse_chunk(buf: &mut String) -> Vec<String> {
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
        if let Some(delta) = v
            .pointer("/choices/0/delta/content")
            .and_then(|x| x.as_str())
        {
            out.push(delta.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_deltas_and_consumes_complete_lines() {
        let mut buf = String::from(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\
             data: [DONE]\n",
        );
        let out = parse_sse_chunk(&mut buf);
        assert_eq!(out, vec!["Hel".to_string(), "lo".to_string()]);
        assert!(
            buf.is_empty(),
            "complete lines consumed; got leftover: {buf:?}"
        );
    }

    #[test]
    fn keeps_incomplete_trailing_line_in_buffer() {
        let mut buf = String::from(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"par",
        );
        let out = parse_sse_chunk(&mut buf);
        assert_eq!(out, vec!["Hi".to_string()]);
        assert!(
            buf.contains("\"par"),
            "incomplete line stays buffered: {buf:?}"
        );
    }

    #[test]
    fn skips_non_content_events() {
        // role-only start event has no content → skipped, not an error.
        let mut buf = String::from("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n");
        let out = parse_sse_chunk(&mut buf);
        assert!(out.is_empty());
    }
}
