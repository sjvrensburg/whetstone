//! The process-event taxonomy + journal record shapes.
//!
//! Ported from `composer/src/service/types.ts`. These are pure domain data —
//! they live in `core` (not `service`) so that `core::disclosure` and
//! `core::mirror` can consume an event stream without depending on the
//! service layer. `service` depends on `core`, never the reverse.
//!
//! Metadata-only by construction: `meta` values are scalars (string / number
//! / bool), so prose can never be expressed in a record. Only a coaching
//! request carries prose, and that is never journaled.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The eleven process-event types. Serialized `snake_case` to match the
/// composer wire format and journal schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessEventType {
    SessionStart,
    ClaimSet,
    TypingBurst,
    PasteDetected,
    PasteQuarantined,
    PasteClaimed,
    PasteAttributed,
    RegionRevised,
    CoachConsult,
    /// Instrument D (teach-back checkpoint).
    TeachBack,
    /// Instrument A (push-cadence coaching).
    PushCoaching,
}

/// A scalar metadata value. Prose cannot be expressed here — there is no
/// "document text" variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MetaValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

/// A metadata map. `BTreeMap` for deterministic iteration/serialization.
pub type Meta = BTreeMap<String, MetaValue>;

/// A byte/char span in the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    pub from: u32,
    pub to: u32,
}

/// A journaled process event. `id` and `ts` are assigned by the Service — the
/// client never stamps them (the v2 witness substitutes by swapping the
/// service impl, not by changing client code).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessEvent {
    pub id: String,
    /// ISO 8601 — assigned by the Service.
    pub ts: String,
    #[serde(rename = "type")]
    pub kind: ProcessEventType,
    /// Characters — METADATA ONLY, never the prose itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}

/// An event as submitted by the client — the Service assigns `id` and `ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessEventInput {
    #[serde(rename = "type")]
    pub kind: ProcessEventType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Meta>,
}

impl From<ProcessEvent> for ProcessEventInput {
    fn from(e: ProcessEvent) -> Self {
        Self {
            kind: e.kind,
            size: e.size,
            location: e.location,
            meta: e.meta,
        }
    }
}

/// The friction dial (ADR-008). `floor` is the institutional minimum (v1: 0);
/// `preset` is the writer's chosen level. Both in `0..=3`:
/// `0` Quiet, `1` Coach (default), `2` Engaged, `3` Deep Work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrictionPolicy {
    pub floor: u8,
    pub preset: u8,
}

// ---------------------------------------------------------------------------
// Meta accessors — typed reads over the scalar map.
// ---------------------------------------------------------------------------

pub fn meta_string<'a>(meta: Option<&'a Meta>, key: &str) -> Option<&'a str> {
    match meta?.get(key)? {
        MetaValue::Str(s) => Some(s),
        _ => None,
    }
}

pub fn meta_bool(meta: Option<&Meta>, key: &str) -> Option<bool> {
    match meta?.get(key)? {
        MetaValue::Bool(b) => Some(*b),
        _ => None,
    }
}

pub fn meta_f64(meta: Option<&Meta>, key: &str) -> Option<f64> {
    match meta?.get(key)? {
        MetaValue::Num(n) => Some(*n),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_type_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ProcessEventType::PasteQuarantined).unwrap(),
            "\"paste_quarantined\""
        );
        assert_eq!(
            serde_json::to_string(&ProcessEventType::PushCoaching).unwrap(),
            "\"push_coaching\""
        );
    }

    #[test]
    fn meta_round_trips_scalars() {
        let mut m = Meta::new();
        m.insert("regionId".into(), MetaValue::Str("r1".into()));
        m.insert("survival".into(), MetaValue::Num(0.3));
        m.insert("refused".into(), MetaValue::Bool(true));
        let j = serde_json::to_string(&m).unwrap();
        let back: Meta = serde_json::from_str(&j).unwrap();
        assert_eq!(meta_string(Some(&back), "regionId"), Some("r1"));
        assert_eq!(meta_f64(Some(&back), "survival"), Some(0.3));
        assert_eq!(meta_bool(Some(&back), "refused"), Some(true));
    }

    #[test]
    fn event_round_trips_with_optional_fields_skipped() {
        let e = ProcessEvent {
            id: "x".into(),
            ts: "2026-06-16T12:00:00Z".into(),
            kind: ProcessEventType::SessionStart,
            size: None,
            location: None,
            meta: None,
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("id"));
        assert!(obj.contains_key("ts"));
        assert!(obj.contains_key("type"));
        assert!(!obj.contains_key("size"));
    }
}
