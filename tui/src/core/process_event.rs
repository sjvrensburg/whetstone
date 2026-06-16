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

impl Default for FrictionPolicy {
    /// v1 default: no institutional floor, writer preset `1` (Coach).
    fn default() -> Self {
        Self {
            floor: 0,
            preset: 1,
        }
    }
}

impl FrictionPolicy {
    pub fn new(floor: u8, preset: u8) -> Self {
        Self {
            floor: floor.min(3),
            preset: preset.min(3),
        }
    }

    /// The effective friction level: the higher of the institutional floor and
    /// the writer's preset, clamped to `0..=3`.
    pub fn level(&self) -> u8 {
        self.floor.max(self.preset).min(3)
    }

    /// Quarantine trigger: pastes at or above this many chars are tracked.
    /// Higher friction quarantines smaller pastes.
    pub fn paste_threshold(&self) -> usize {
        match self.level() {
            0 => 120,
            1 => 40,
            2 => 24,
            _ => 12,
        }
    }

    /// Claim-to-own survival floor: the mark clears when fewer than this
    /// fraction of the original's trigrams survive. Higher friction tightens
    /// the gate (demands more rewriting).
    pub fn claim_survival_threshold(&self) -> f64 {
        match self.level() {
            0 => 0.7,
            1 => 0.5,
            2 => 0.4,
            _ => 0.3,
        }
    }

    /// Teach-back cadence: fire a checkpoint every N new paragraphs. `None`
    /// disables the instrument (level 0, Quiet).
    pub fn teachback_interval(&self) -> Option<usize> {
        match self.level() {
            0 => None,
            1 => Some(3),
            2 => Some(2),
            _ => Some(1),
        }
    }

    /// Push-cadence (proactive) coaching: run a structured coaching pass every
    /// N new paragraphs. Off below "Engaged" — proactive model calls are opt-in
    /// via a higher friction level.
    pub fn push_interval(&self) -> Option<usize> {
        match self.level() {
            0 | 1 => None,
            2 => Some(4),
            _ => Some(3),
        }
    }
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
    fn friction_intervals_scale_with_level() {
        // Teach-back tightens with level; push-cadence is off until "Engaged".
        assert_eq!(FrictionPolicy::new(0, 0).teachback_interval(), None);
        assert_eq!(FrictionPolicy::new(0, 1).teachback_interval(), Some(3));
        assert_eq!(FrictionPolicy::new(0, 1).push_interval(), None);
        assert_eq!(FrictionPolicy::new(0, 2).push_interval(), Some(4));
        assert_eq!(FrictionPolicy::new(0, 3).push_interval(), Some(3));
        // The floor raises the effective level.
        assert_eq!(FrictionPolicy::new(2, 0).level(), 2);
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
