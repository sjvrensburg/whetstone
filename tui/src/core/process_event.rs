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

/// The dial-able friction instruments (ADR-008) that the TUI realizes. Each can
/// carry a per-instrument override (see [`InstrumentOverrides`]) that pins it to
/// its own level instead of the global preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Instrument {
    /// (B) paste flag→quarantine: the quarantine size threshold.
    Paste,
    /// (C) claim-to-own: the survival floor that clears a paste mark.
    Claim,
    /// (D) teach-back cadence.
    Teachback,
    /// (A) push-cadence (proactive) coaching.
    Push,
}

impl Instrument {
    /// Every instrument, in dial order (A–F subset realized here).
    pub const ALL: [Instrument; 4] = [
        Instrument::Paste,
        Instrument::Claim,
        Instrument::Teachback,
        Instrument::Push,
    ];

    /// Stable key used in config files and env vars (`paste`, `claim`, …).
    pub fn key(self) -> &'static str {
        match self {
            Instrument::Paste => "paste",
            Instrument::Claim => "claim",
            Instrument::Teachback => "teachback",
            Instrument::Push => "push",
        }
    }

    /// Short human label for the control surface.
    pub fn label(self) -> &'static str {
        match self {
            Instrument::Paste => "Paste quarantine",
            Instrument::Claim => "Claim-to-own",
            Instrument::Teachback => "Teach-back",
            Instrument::Push => "Push cadence",
        }
    }
}

/// Per-instrument friction overrides (ADR-008). Each `Some(level)` pins that
/// instrument to its own level in place of the global preset; `None` follows
/// the preset. The institutional floor still applies to every instrument, so an
/// override can raise an instrument above the preset or lower it — but never
/// below the floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct InstrumentOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teachback: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<u8>,
}

impl InstrumentOverrides {
    /// True when no instrument is overridden (every field `None`).
    pub fn is_empty(&self) -> bool {
        Instrument::ALL.iter().all(|&i| self.get(i).is_none())
    }

    /// The override level for `instrument`, if one is set.
    pub fn get(&self, instrument: Instrument) -> Option<u8> {
        match instrument {
            Instrument::Paste => self.paste,
            Instrument::Claim => self.claim,
            Instrument::Teachback => self.teachback,
            Instrument::Push => self.push,
        }
    }

    /// Set (`Some`) or clear (`None`) the override for `instrument`. Levels are
    /// clamped to `0..=3`.
    pub fn set(&mut self, instrument: Instrument, level: Option<u8>) {
        let level = level.map(|l| l.min(3));
        match instrument {
            Instrument::Paste => self.paste = level,
            Instrument::Claim => self.claim = level,
            Instrument::Teachback => self.teachback = level,
            Instrument::Push => self.push = level,
        }
    }
}

/// The friction dial (ADR-008). `floor` is the institutional minimum (v1: 0);
/// `preset` is the writer's chosen level; `overrides` pin individual
/// instruments. All levels in `0..=3`:
/// `0` Quiet, `1` Coach (default), `2` Engaged, `3` Deep Work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrictionPolicy {
    pub floor: u8,
    pub preset: u8,
    #[serde(default, skip_serializing_if = "InstrumentOverrides::is_empty")]
    pub overrides: InstrumentOverrides,
}

impl Default for FrictionPolicy {
    /// v1 default: no institutional floor, writer preset `1` (Coach), no
    /// per-instrument overrides.
    fn default() -> Self {
        Self {
            floor: 0,
            preset: 1,
            overrides: InstrumentOverrides::default(),
        }
    }
}

impl FrictionPolicy {
    pub fn new(floor: u8, preset: u8) -> Self {
        Self {
            floor: floor.min(3),
            preset: preset.min(3),
            overrides: InstrumentOverrides::default(),
        }
    }

    /// Attach per-instrument overrides (builder).
    pub fn with_overrides(mut self, overrides: InstrumentOverrides) -> Self {
        self.overrides = overrides;
        self
    }

    /// The global effective friction level: the higher of the institutional
    /// floor and the writer's preset, clamped to `0..=3`. Drives the status bar
    /// and the preset menu — individual instruments may differ via overrides.
    pub fn level(&self) -> u8 {
        self.floor.max(self.preset).min(3)
    }

    /// The effective level for one instrument: its override (if set) replaces
    /// the preset, but the institutional floor always applies. Clamped to
    /// `0..=3`.
    pub fn instrument_level(&self, instrument: Instrument) -> u8 {
        let base = self.overrides.get(instrument).unwrap_or(self.preset);
        self.floor.max(base).min(3)
    }

    /// Quarantine trigger: pastes at or above this many chars are tracked.
    /// Higher friction quarantines smaller pastes.
    pub fn paste_threshold(&self) -> usize {
        match self.instrument_level(Instrument::Paste) {
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
        match self.instrument_level(Instrument::Claim) {
            0 => 0.7,
            1 => 0.5,
            2 => 0.4,
            _ => 0.3,
        }
    }

    /// Teach-back cadence: fire a checkpoint every N new paragraphs. `None`
    /// disables the instrument (level 0, Quiet).
    pub fn teachback_interval(&self) -> Option<usize> {
        match self.instrument_level(Instrument::Teachback) {
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
        match self.instrument_level(Instrument::Push) {
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
    fn per_instrument_overrides_replace_the_preset() {
        // Preset 1 (Coach), but pin the paste instrument to 3 (Deep Work) and
        // teach-back to 0 (Quiet); the others keep following the preset.
        let mut ov = InstrumentOverrides::default();
        ov.set(Instrument::Paste, Some(3));
        ov.set(Instrument::Teachback, Some(0));
        let p = FrictionPolicy::new(0, 1).with_overrides(ov);

        // Global level + un-overridden instruments still read the preset.
        assert_eq!(p.level(), 1);
        assert_eq!(p.instrument_level(Instrument::Claim), 1);
        assert_eq!(p.claim_survival_threshold(), 0.5);
        assert_eq!(p.push_interval(), None); // push follows preset 1 → off

        // The overridden instruments use their own level.
        assert_eq!(p.instrument_level(Instrument::Paste), 3);
        assert_eq!(p.paste_threshold(), 12);
        assert_eq!(p.teachback_interval(), None); // pinned to Quiet
    }

    #[test]
    fn institutional_floor_clamps_overrides_from_below() {
        // A floor of 2 cannot be dropped by a lower per-instrument override.
        let mut ov = InstrumentOverrides::default();
        ov.set(Instrument::Push, Some(0));
        let p = FrictionPolicy::new(2, 1).with_overrides(ov);
        assert_eq!(p.instrument_level(Instrument::Push), 2);
        assert_eq!(p.push_interval(), Some(4)); // floored to Engaged, not off
    }

    #[test]
    fn overrides_set_clear_and_clamp() {
        let mut ov = InstrumentOverrides::default();
        assert!(ov.is_empty());
        ov.set(Instrument::Claim, Some(9)); // clamps to 3
        assert_eq!(ov.get(Instrument::Claim), Some(3));
        assert!(!ov.is_empty());
        ov.set(Instrument::Claim, None); // clears
        assert!(ov.is_empty());
    }

    #[test]
    fn empty_overrides_are_skipped_in_serialization() {
        // The default policy round-trips without an `overrides` key, and a
        // policy with overrides preserves them.
        let bare = serde_json::to_string(&FrictionPolicy::new(0, 1)).unwrap();
        assert!(!bare.contains("overrides"));

        let mut ov = InstrumentOverrides::default();
        ov.set(Instrument::Push, Some(3));
        let p = FrictionPolicy::new(0, 1).with_overrides(ov);
        let back: FrictionPolicy =
            serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
        // A legacy file with no `overrides` key still deserializes.
        let legacy: FrictionPolicy = serde_json::from_str(r#"{"floor":0,"preset":2}"#).unwrap();
        assert!(legacy.overrides.is_empty());
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
