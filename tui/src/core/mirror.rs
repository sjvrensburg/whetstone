//! Live process self-mirror.
//!
//! Ported from `composer/src/core/mirror.ts`. Surfaces the writer's own
//! process back to them, live. Framing invariant (ADR-008 honest-claim
//! constraint): no label implies a "human score" or proof of personhood;
//! metadata only; the mirror reflects, never grades.

use crate::core::disclosure::{Composition, compute_composition};
#[cfg(test)]
use crate::core::labels::has_no_forbidden_labels;
use crate::core::process_event::{ProcessEvent, ProcessEventType, meta_bool};

#[derive(Debug, Clone, PartialEq)]
pub struct MirrorSnapshot {
    pub composition: Composition,
    /// Coaching consults that returned observations.
    pub coach_consults: u32,
    /// Consults the guard or provider refused (still disclosed activity).
    pub coach_refused: u32,
}

pub fn compute_mirror(events: &[ProcessEvent]) -> MirrorSnapshot {
    let mut coach_consults = 0u32;
    let mut coach_refused = 0u32;
    for e in events {
        if e.kind != ProcessEventType::CoachConsult {
            continue;
        }
        if meta_bool(e.meta.as_ref(), "refused") == Some(true) {
            coach_refused += 1;
        } else {
            coach_consults += 1;
        }
    }
    MirrorSnapshot {
        composition: compute_composition(events),
        coach_consults,
        coach_refused,
    }
}

/// Mirror labels — descriptive and non-judgmental; they describe what
/// happened, not whether the writer was "good". The forbidden-label guard is
/// run over every value here in the tests below.
pub struct MirrorLabels {
    pub typed: &'static str,
    pub pasted: &'static str,
    pub unresolved: &'static str,
    pub coached: &'static str,
    pub scoping_note: &'static str,
}

pub const MIRROR_LABELS: MirrorLabels = MirrorLabels {
    typed: "Typed by you",
    pasted: "Pasted from outside",
    unresolved: "Pastes still marked",
    coached: "Coaching consults",
    scoping_note: "This reflects your writing process — it is not a score.",
};

fn pct(ratio: f64) -> String {
    format!("{}%", (ratio * 100.0).round() as i64)
}

/// One-line summary for the mirror panel.
pub fn format_mirror_summary(snapshot: &MirrorSnapshot) -> String {
    let c = &snapshot.composition;
    let mut parts = vec![
        format!("{}: {}", MIRROR_LABELS.typed, pct(c.typed_ratio)),
        format!("{}: {}", MIRROR_LABELS.pasted, pct(1.0 - c.typed_ratio)),
    ];
    if c.pastes_unclaimed > 0 {
        parts.push(format!(
            "{}: {}",
            MIRROR_LABELS.unresolved, c.pastes_unclaimed
        ));
    }
    if snapshot.coach_consults + snapshot.coach_refused > 0 {
        parts.push(format!(
            "{}: {}",
            MIRROR_LABELS.coached,
            snapshot.coach_consults + snapshot.coach_refused
        ));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process_event::MetaValue;

    #[test]
    fn mirror_summary_reports_typed_ratio() {
        let events = vec![
            test_event(ProcessEventType::TypingBurst, Some(750), vec![]),
            test_event(ProcessEventType::PasteDetected, Some(250), vec![]),
            test_event(
                ProcessEventType::PasteQuarantined,
                Some(250),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            test_event(
                ProcessEventType::PasteClaimed,
                None,
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
        ];
        let snap = compute_mirror(&events);
        let summary = format_mirror_summary(&snap);
        assert!(summary.contains("Typed by you: 75%"));
        assert!(summary.contains("Pasted from outside: 25%"));
        assert!(!summary.contains("Pastes still marked")); // resolved
    }

    #[test]
    fn mirror_includes_unresolved_when_mark_remains() {
        let events = vec![
            test_event(ProcessEventType::TypingBurst, Some(100), vec![]),
            test_event(ProcessEventType::PasteDetected, Some(100), vec![]),
            test_event(
                ProcessEventType::PasteQuarantined,
                Some(100),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            // no paste_claimed → unresolved
        ];
        let snap = compute_mirror(&events);
        let summary = format_mirror_summary(&snap);
        assert!(summary.contains("Pastes still marked: 1"));
    }

    #[test]
    fn all_mirror_labels_are_clean_of_forbidden_language() {
        assert!(has_no_forbidden_labels(MIRROR_LABELS.typed));
        assert!(has_no_forbidden_labels(MIRROR_LABELS.pasted));
        assert!(has_no_forbidden_labels(MIRROR_LABELS.unresolved));
        assert!(has_no_forbidden_labels(MIRROR_LABELS.coached));
        assert!(has_no_forbidden_labels(MIRROR_LABELS.scoping_note));
    }

    fn test_event(
        kind: ProcessEventType,
        size: Option<u32>,
        meta: Vec<(&str, MetaValue)>,
    ) -> ProcessEvent {
        let mut m = crate::core::process_event::Meta::new();
        for (k, v) in meta {
            m.insert(k.into(), v);
        }
        ProcessEvent {
            id: "x".into(),
            ts: "2026-06-16T10:00:00Z".into(),
            kind,
            size,
            location: None,
            meta: if m.is_empty() { None } else { Some(m) },
        }
    }
}
