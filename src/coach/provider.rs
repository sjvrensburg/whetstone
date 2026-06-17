//! Per-provider request shaping and SSE delta extraction.
//!
//! Both providers stream Server-Sent Events; only the request body/headers and
//! the per-line JSON shape differ. The streaming loop in [`super::client`] is
//! shared — it hands each complete `data:` line here for extraction.
//!
//! - **OpenAI** — `POST {base}/chat/completions`, bearer auth, body carries the
//!   `messages` array verbatim (system role included). Deltas live at
//!   `choices[0].delta.content`.
//! - **Anthropic** — `POST {base}/messages`, `x-api-key` + `anthropic-version`
//!   headers. System messages are hoisted into a top-level `system` string and
//!   the rest are mapped to `user`/`assistant` turns. Deltas arrive as
//!   `content_block_delta` events with `delta.text`.

use reqwest::RequestBuilder;
use serde::Serialize;
use serde_json::{Value, json};

use crate::core::prompts::{ChatMessage, Role};

use super::config::{ANTHROPIC_MAX_TOKENS, ANTHROPIC_VERSION, Endpoint, Provider};

/// Build the (unsent) HTTP request for a streaming chat call against `endpoint`.
pub fn build_request(
    http: &reqwest::Client,
    endpoint: &Endpoint,
    messages: &[ChatMessage],
    json_mode: bool,
) -> RequestBuilder {
    match endpoint.provider {
        Provider::OpenAi => {
            #[derive(Serialize)]
            struct ResponseFormat {
                #[serde(rename = "type")]
                kind: &'static str,
            }
            #[derive(Serialize)]
            struct Req<'a> {
                model: &'a str,
                messages: &'a [ChatMessage],
                stream: bool,
                #[serde(skip_serializing_if = "Option::is_none")]
                response_format: Option<ResponseFormat>,
            }
            let body = Req {
                model: &endpoint.model,
                messages,
                stream: true,
                response_format: json_mode.then_some(ResponseFormat {
                    kind: "json_object",
                }),
            };
            http.post(endpoint.url())
                .bearer_auth(&endpoint.api_key)
                .json(&body)
        }
        Provider::Anthropic => {
            let (system, turns) = split_system(messages);
            let mut body = json!({
                "model": endpoint.model,
                "max_tokens": ANTHROPIC_MAX_TOKENS,
                "messages": turns,
                "stream": true,
            });
            if !system.is_empty() {
                body["system"] = Value::String(system);
            }
            http.post(endpoint.url())
                .header("x-api-key", &endpoint.api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&body)
        }
    }
}

/// Split chat messages into Anthropic's shape: a single top-level `system`
/// string (all system messages joined) and a list of `{role, content}` turns
/// where role is only `user`/`assistant`. Anthropic has no `system` role in the
/// turn list, so system content must be hoisted out.
fn split_system(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut system_parts: Vec<&str> = Vec::new();
    let mut turns: Vec<Value> = Vec::new();
    for m in messages {
        match m.role {
            Role::System => system_parts.push(&m.content),
            Role::User => turns.push(json!({"role": "user", "content": m.content})),
            Role::Assistant => turns.push(json!({"role": "assistant", "content": m.content})),
        }
    }
    (system_parts.join("\n\n"), turns)
}

/// Extract the text delta from a single SSE `data:` JSON payload for `provider`,
/// or `None` for events that carry no user-facing text (role-only starts, ping,
/// usage, stop). The payload is the already-parsed JSON value of one `data:`
/// line.
pub fn extract_delta(provider: Provider, v: &Value) -> Option<String> {
    match provider {
        Provider::OpenAi => v
            .pointer("/choices/0/delta/content")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        Provider::Anthropic => {
            // Only `content_block_delta` with a `text_delta` carries prose.
            if v.get("type").and_then(|t| t.as_str()) != Some("content_block_delta") {
                return None;
            }
            v.pointer("/delta/text")
                .and_then(|x| x.as_str())
                .map(str::to_string)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_system_hoists_system_and_maps_roles() {
        let msgs = vec![
            ChatMessage {
                role: Role::System,
                content: "be terse".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "hi".into(),
            },
            ChatMessage {
                role: Role::Assistant,
                content: "what is your claim?".into(),
            },
        ];
        let (system, turns) = split_system(&msgs);
        assert_eq!(system, "be terse");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["role"], "user");
        assert_eq!(turns[1]["role"], "assistant");
    }

    #[test]
    fn extract_openai_content_delta() {
        let v: Value =
            serde_json::from_str(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#).unwrap();
        assert_eq!(extract_delta(Provider::OpenAi, &v), Some("Hel".to_string()));
    }

    #[test]
    fn extract_anthropic_text_delta() {
        let v: Value = serde_json::from_str(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_delta(Provider::Anthropic, &v),
            Some("lo".to_string())
        );
    }

    #[test]
    fn anthropic_non_text_events_skipped() {
        for raw in [
            r#"{"type":"message_start","message":{"id":"x"}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"message_stop"}"#,
        ] {
            let v: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(extract_delta(Provider::Anthropic, &v), None);
        }
    }
}
