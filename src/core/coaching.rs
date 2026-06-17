//! Coaching schema & validator.
//!
//! Ported from `composer/src/core/coaching.ts`. The schema's only fields are
//! anchored coaching moves; `additionalProperties: false` (here:
//! `#[serde(deny_unknown_fields)]`) means there is no field a model could
//! place replacement prose into — ghostwriting is impossible at the
//! structural level. The validator independently enforces the caps the wire
//! schema cannot carry (length caps, interrogative rule), so the floor holds
//! regardless of provider behavior.

use serde::{Deserialize, Serialize};

use crate::core::CheckResult;

pub const REFLECTION_MAX_LENGTH: usize = 280;
pub const QUESTION_MAX_LENGTH: usize = 200;
pub const MAX_OBSERVATIONS: usize = 7;

/// The only kinds of structural observation coaching may surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    ImplicitClaim,
    IntendedMove,
    LogicFork,
}

pub const OBSERVATION_KINDS: &[ObservationKind] = &[
    ObservationKind::ImplicitClaim,
    ObservationKind::IntendedMove,
    ObservationKind::LogicFork,
];

/// Character offsets into the coached selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub anchor: Anchor,
    pub kind: ObservationKind,
    /// A short structural remark — never replacement prose.
    pub reflection: String,
    /// One genuine, interrogative unblocking question.
    pub question: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredCoaching {
    pub observations: Vec<Observation>,
}

/// True when `question` reads as a question: non-empty and ending in `?`.
pub fn is_interrogative(question: &str) -> bool {
    let trimmed = question.trim();
    trimmed.chars().count() > 1 && trimmed.ends_with('?')
}

/// Validate a parsed [`StructuredCoaching`] against the length caps and the
/// interrogative-question rule. Structural exactness (no extra/prose fields)
/// is enforced at deserialization via `deny_unknown_fields`.
pub fn validate_structured_coaching(value: &StructuredCoaching) -> CheckResult {
    if value.observations.len() > MAX_OBSERVATIONS {
        return Err(format!("observations exceeds {MAX_OBSERVATIONS} entries"));
    }
    for (i, obs) in value.observations.iter().enumerate() {
        let at = format!("observations[{i}]");
        if obs.reflection.chars().count() > REFLECTION_MAX_LENGTH {
            return Err(format!(
                "{at}.reflection exceeds {REFLECTION_MAX_LENGTH} characters"
            ));
        }
        if obs.question.chars().count() > QUESTION_MAX_LENGTH {
            return Err(format!(
                "{at}.question exceeds {QUESTION_MAX_LENGTH} characters"
            ));
        }
        if !is_interrogative(&obs.question) {
            return Err(format!("{at}.question must be interrogative"));
        }
    }
    Ok(())
}

/// Parse + validate a JSON value into [`StructuredCoaching`]. Extra fields,
/// wrong types, or bad enum values fail at the parse step; caps and the
/// interrogative rule fail at the validate step.
pub fn parse_structured_coaching(json: serde_json::Value) -> Result<StructuredCoaching, String> {
    let parsed: StructuredCoaching =
        serde_json::from_value(json).map_err(|e| format!("schema parse failed: {e}"))?;
    validate_structured_coaching(&parsed)?;
    Ok(parsed)
}

/// The forced-output JSON schema sent to providers. Kept to the subset every
/// structured-output implementation supports (no maxLength/maxItems — the
/// validator enforces those caps client-side as the deterministic layer).
/// Sending this is best-effort; the deterministic guard is the real
/// enforcement across arbitrary OpenAI-compatible backends.
pub fn coaching_json_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["observations"],
        "properties": {
            "observations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["anchor", "kind", "reflection", "question"],
                    "properties": {
                        "anchor": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["start", "end"],
                            "properties": {
                                "start": { "type": "integer" },
                                "end": { "type": "integer" }
                            }
                        },
                        "kind": { "type": "string", "enum": ["implicit_claim", "intended_move", "logic_fork"] },
                        "reflection": { "type": "string" },
                        "question": { "type": "string" }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_observation() -> Observation {
        Observation {
            anchor: Anchor { start: 0, end: 5 },
            kind: ObservationKind::ImplicitClaim,
            reflection: "The passage assumes a cause without evidence.".to_string(),
            question: "What evidence links these two steps?".to_string(),
        }
    }

    #[test]
    fn valid_coaching_passes() {
        let c = StructuredCoaching {
            observations: vec![valid_observation()],
        };
        assert!(validate_structured_coaching(&c).is_ok());
    }

    #[test]
    fn rejects_too_many_observations() {
        let c = StructuredCoaching {
            observations: vec![valid_obsimation_placeholder(); 8],
        };
        assert!(validate_structured_coaching(&c).is_err());
    }

    fn valid_obsimation_placeholder() -> Observation {
        valid_observation()
    }

    #[test]
    fn rejects_non_interrogative_question() {
        let mut o = valid_observation();
        o.question = "This should be a statement.".to_string();
        let c = StructuredCoaching {
            observations: vec![o],
        };
        let err = validate_structured_coaching(&c).unwrap_err();
        assert!(err.contains("interrogative"));
    }

    #[test]
    fn parse_rejects_extra_ghostwriting_field() {
        // A "suggested_rewrite" field has nowhere to land → parse fails.
        let json = serde_json::json!({
            "observations": [{
                "anchor": {"start": 0, "end": 5},
                "kind": "implicit_claim",
                "reflection": "assumes a cause",
                "question": "why?",
                "suggested_rewrite": "Here is a better version: ..."
            }]
        });
        assert!(parse_structured_coaching(json).is_err());
    }

    #[test]
    fn parse_rejects_bad_kind() {
        let json = serde_json::json!({
            "observations": [{
                "anchor": {"start": 0, "end": 5},
                "kind": "rewrite_for_me",
                "reflection": "x",
                "question": "why?"
            }]
        });
        assert!(parse_structured_coaching(json).is_err());
    }
}
