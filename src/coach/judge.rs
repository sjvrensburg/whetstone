//! The optional LLM judge: a second, model-backed screening layer over coach
//! replies, on top of the deterministic guard (`crate::core::guard`).
//!
//! The deterministic guard is the load-bearing enforcement and always runs
//! first. When the writer enables a judge, this asks a (possibly different,
//! often smaller/cheaper) model to classify the already-deterministically-clean
//! reply as allow/withhold against the friction-not-proof rules. It can only
//! ever *withhold* a reply — it never rewrites or augments one.

use serde::Deserialize;

use crate::core::prompts::build_judge_messages;

use super::client::CoachClient;
use super::config::Endpoint;

/// The judge's decision about a candidate reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub allow: bool,
    pub reason: String,
}

#[derive(Deserialize)]
struct RawVerdict {
    allow: bool,
    #[serde(default)]
    reason: String,
}

/// Ask the judge model whether `reply` may reach the writer. `draft_excerpt`
/// gives the judge the current draft for overlap reasoning. Returns the parsed
/// [`Verdict`]; an `Err` means the judge could not be consulted (network or
/// unparseable output) — the caller decides the failure policy.
pub async fn screen_with_judge(
    client: &CoachClient,
    endpoint: &Endpoint,
    reply: &str,
    draft_excerpt: Option<&str>,
) -> Result<Verdict, String> {
    let messages = build_judge_messages(reply, draft_excerpt);
    let raw = client
        .chat(endpoint, &messages, true, |_| {})
        .await
        .map_err(|e| e.to_string())?;
    parse_verdict(&raw)
}

/// Parse a judge verdict from raw model output, tolerating prose or a
/// markdown code fence around the JSON object.
fn parse_verdict(raw: &str) -> Result<Verdict, String> {
    let json = extract_json_object(raw).ok_or_else(|| format!("no JSON object in: {raw:?}"))?;
    let v: RawVerdict =
        serde_json::from_str(json).map_err(|e| format!("unparseable verdict: {e}"))?;
    Ok(Verdict {
        allow: v.allow,
        reason: v.reason,
    })
}

/// Return the first balanced `{...}` slice of `s`, ignoring braces inside
/// strings. Lets a verdict survive a model that wraps it in prose or a fence.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let bytes = s.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_verdict() {
        let v = parse_verdict(r#"{"allow": true, "reason": "asks a question"}"#).unwrap();
        assert!(v.allow);
        assert_eq!(v.reason, "asks a question");
    }

    #[test]
    fn parses_verdict_wrapped_in_prose_and_fence() {
        let raw = "Here is my decision:\n```json\n{\"allow\": false, \"reason\": \"contains a rewrite\"}\n```\n";
        let v = parse_verdict(raw).unwrap();
        assert!(!v.allow);
        assert_eq!(v.reason, "contains a rewrite");
    }

    #[test]
    fn reason_defaults_when_missing() {
        let v = parse_verdict(r#"{"allow": true}"#).unwrap();
        assert!(v.allow);
        assert_eq!(v.reason, "");
    }

    #[test]
    fn unparseable_is_error() {
        assert!(parse_verdict("I think it is fine").is_err());
        assert!(parse_verdict(r#"{"allow": "maybe"}"#).is_err());
    }

    #[test]
    fn ignores_braces_inside_strings() {
        let v = parse_verdict(r#"{"allow": false, "reason": "has a { brace"}"#).unwrap();
        assert!(!v.allow);
        assert_eq!(v.reason, "has a { brace");
    }
}
