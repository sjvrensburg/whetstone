//! Disclosure export — render a human-readable "how this was written" record
//! from the process-event stream.
//!
//! Ported from `composer/src/core/disclosure.ts`. Metadata-only by
//! construction: the input stream never contains prose, so neither can the
//! output. The forbidden-label guard runs over the rendered document before it
//! is returned.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use chrono::DateTime;

use crate::core::labels::assert_no_forbidden_labels;
use crate::core::process_event::{ProcessEvent, ProcessEventType, meta_bool, meta_string};

/// The honest scoping note — friction, not proof (ADR-009).
pub const SCOPING_NOTE: &str = "This is a record of how the piece was written in Whetstone — evidence of process, not proof of authorship. The record is local and self-reported.";

/// Composition breakdown derivable from the metadata-only event stream.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Composition {
    /// Characters typed in the composer (sum of typing_burst sizes).
    pub typed_chars: u32,
    /// Characters pasted at-or-above the quarantine threshold.
    pub pasted_chars: u32,
    /// Of the quarantined pastes: how many were rewritten until owned.
    pub pastes_claimed: u32,
    /// Of the quarantined pastes: how many were attributed as quotations.
    pub pastes_attributed: u32,
    /// Quarantined pastes whose mark was never cleared.
    pub pastes_unclaimed: u32,
    /// Total quarantined paste count.
    pub paste_count: u32,
    /// Fraction of (typed + pasted) chars that were typed. 1.0 when nothing entered.
    pub typed_ratio: f64,
}

/// Compute the composition breakdown from a document's event stream.
pub fn compute_composition(events: &[ProcessEvent]) -> Composition {
    let mut typed_chars = 0u32;
    let mut pasted_chars = 0u32;
    // `quarantined` is the set of pastes currently present in the document;
    // `resolved` maps each to its outcome (true = claimed, false = attributed).
    // A paste removed via undo is dropped from both, so it stops counting.
    let mut resolved: BTreeMap<String, bool> = BTreeMap::new();
    let mut quarantined: HashSet<String> = HashSet::new();

    for e in events {
        let region_id = meta_string(e.meta.as_ref(), "regionId").map(|s| s.to_string());
        match e.kind {
            ProcessEventType::TypingBurst => {
                typed_chars += e.size.unwrap_or(0);
            }
            // Every paste is counted once here (including sub-threshold pastes
            // that are never quarantined), so the typed/pasted split is honest.
            ProcessEventType::PasteDetected => {
                pasted_chars += e.size.unwrap_or(0);
            }
            ProcessEventType::PasteQuarantined => {
                if let Some(id) = region_id {
                    // A re-instated paste (redo, or undo of its deletion) starts
                    // unclaimed again — clear any stale resolution.
                    resolved.remove(&id);
                    quarantined.insert(id);
                }
            }
            ProcessEventType::PasteClaimed => {
                if let Some(id) = region_id {
                    resolved.insert(id, true);
                }
            }
            ProcessEventType::PasteAttributed => {
                if let Some(id) = region_id {
                    resolved.insert(id, false);
                }
            }
            ProcessEventType::PasteRemoved => {
                if let Some(id) = region_id {
                    quarantined.remove(&id);
                    resolved.remove(&id);
                }
            }
            _ => {}
        }
    }

    let paste_count = quarantined.len() as u32;
    let mut pastes_claimed = 0u32;
    let mut pastes_attributed = 0u32;
    for (id, &claimed) in &resolved {
        // A resolution for a paste no longer present doesn't count.
        if !quarantined.contains(id) {
            continue;
        }
        if claimed {
            pastes_claimed += 1;
        } else {
            pastes_attributed += 1;
        }
    }
    let pastes_unclaimed = paste_count
        .saturating_sub(pastes_claimed)
        .saturating_sub(pastes_attributed);

    let total = typed_chars + pasted_chars;
    let typed_ratio = if total == 0 {
        1.0
    } else {
        typed_chars as f64 / total as f64
    };

    Composition {
        typed_chars,
        pasted_chars,
        pastes_claimed,
        pastes_attributed,
        pastes_unclaimed,
        paste_count,
        typed_ratio,
    }
}

/// The stated claim, from the most recent `claim_set` event (if any).
pub fn extract_claim(events: &[ProcessEvent]) -> Option<String> {
    events.iter().rev().find_map(|e| {
        if e.kind == ProcessEventType::ClaimSet {
            meta_string(e.meta.as_ref(), "claim").map(|s| s.to_string())
        } else {
            None
        }
    })
}

/// Session span (first event → last event).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionSpan {
    pub start: Option<String>,
    pub end: Option<String>,
    pub minutes: i64,
}

pub fn session_span(events: &[ProcessEvent]) -> SessionSpan {
    if events.is_empty() {
        return SessionSpan::default();
    }
    let start = events.first().unwrap().ts.clone();
    let end = events.last().unwrap().ts.clone();
    let minutes = match (
        DateTime::parse_from_rfc3339(&start),
        DateTime::parse_from_rfc3339(&end),
    ) {
        (Ok(a), Ok(b)) => {
            let ms = (b - a).num_milliseconds();
            ((ms as f64 / 60000.0).round() as i64).max(0)
        }
        _ => 0,
    };
    SessionSpan {
        start: Some(start),
        end: Some(end),
        minutes,
    }
}

/// Summary of cloud-coaching usage, derived from `coach_consult` events.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CoachingSummary {
    pub total: u32,
    pub refused: u32,
    pub providers: Vec<String>,
}

pub fn summarize_coaching(events: &[ProcessEvent]) -> CoachingSummary {
    let mut total = 0u32;
    let mut refused = 0u32;
    let mut providers: BTreeSet<String> = BTreeSet::new();
    for e in events {
        if e.kind != ProcessEventType::CoachConsult {
            continue;
        }
        total += 1;
        if meta_bool(e.meta.as_ref(), "refused") == Some(true) {
            refused += 1;
        }
        if let (Some(provider), Some(model)) = (
            meta_string(e.meta.as_ref(), "provider"),
            meta_string(e.meta.as_ref(), "model"),
        ) {
            providers.insert(format!("{provider}: {model}"));
        }
    }
    CoachingSummary {
        total,
        refused,
        providers: providers.into_iter().collect(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisclosureDoc {
    pub markdown: String,
    pub scoping_note: String,
}

fn pct(ratio: f64) -> String {
    format!("{}%", (ratio * 100.0).round() as i64)
}

/// Render the disclosure document. Returns an error if the result would
/// contain proof-of-personhood language (forbidden-label guard).
pub fn render_disclosure(doc_id: &str, events: &[ProcessEvent]) -> Result<DisclosureDoc, String> {
    let claim = extract_claim(events);
    let comp = compute_composition(events);
    let span = session_span(events);

    let mut lines: Vec<String> = vec![
        "# How this was written".to_string(),
        String::new(),
        format!("Document: `{doc_id}`"),
    ];

    if let (Some(s), Some(e)) = (span.start.as_ref(), span.end.as_ref()) {
        lines.push(format!("Session: {s} → {e} (~{} min)", span.minutes));
    }

    lines.push(String::new());
    lines.push("## Stated claim".to_string());
    lines.push(String::new());
    lines.push(match &claim {
        Some(c) => format!("> {c}"),
        None => "_No claim was recorded._".to_string(),
    });

    lines.push(String::new());
    lines.push("## AI assistance".to_string());
    lines.push(String::new());
    let coaching = summarize_coaching(events);
    if coaching.total == 0 {
        lines.push("No AI assistance was used.".to_string());
    } else {
        let consult_phrase = if coaching.total == 1 {
            "1 coaching consult".to_string()
        } else {
            format!("{} coaching consults", coaching.total)
        };
        lines.push(format!(
            "- {consult_phrase} ({}). Coaching returns structural observations and questions only; the tool does not write or rewrite prose.",
            coaching.providers.join("; ")
        ));
        if coaching.refused > 0 {
            lines.push(format!(
                "- {} response(s) were withheld by the coaching guard.",
                coaching.refused
            ));
        }
    }

    lines.push(String::new());
    lines.push("## Composition".to_string());
    lines.push(String::new());
    lines.push(format!(
        "- Typed in the composer: **{}** characters ({})",
        comp.typed_chars,
        pct(comp.typed_ratio)
    ));
    lines.push(format!(
        "- Pasted from outside: **{}** characters ({})",
        comp.pasted_chars,
        pct(1.0 - comp.typed_ratio)
    ));
    if comp.paste_count > 0 {
        lines.push(format!(
            "  - Pastes rewritten until owned: {}",
            comp.pastes_claimed
        ));
        lines.push(format!(
            "  - Pastes attributed as quotations: {}",
            comp.pastes_attributed
        ));
        lines.push(format!(
            "  - Pastes still marked (unresolved): {}",
            comp.pastes_unclaimed
        ));
    }

    let teach_backs: Vec<&ProcessEvent> = events
        .iter()
        .filter(|e| e.kind == ProcessEventType::TeachBack)
        .collect();
    if !teach_backs.is_empty() {
        let disconnects = teach_backs
            .iter()
            .filter(|e| meta_bool(e.meta.as_ref(), "disconnect") == Some(true))
            .count() as u32;
        let extra = if disconnects > 0 {
            format!(" ({disconnects} marked as hard to summarize)")
        } else {
            String::new()
        };
        lines.push(format!(
            "- Teach-back checkpoints: **{}**{extra}",
            teach_backs.len()
        ));
    }

    lines.push(String::new());
    lines.push("## Scope of this record".to_string());
    lines.push(String::new());
    lines.push(SCOPING_NOTE.to_string());

    let markdown = lines.join("\n");
    assert_no_forbidden_labels(&markdown, "disclosure export")?;
    Ok(DisclosureDoc {
        markdown,
        scoping_note: SCOPING_NOTE.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process_event::{Location, MetaValue};

    fn ev(
        kind: ProcessEventType,
        ts: &str,
        size: Option<u32>,
        meta: Vec<(&str, MetaValue)>,
    ) -> ProcessEvent {
        let mut m = crate::core::process_event::Meta::new();
        for (k, v) in meta {
            m.insert(k.into(), v);
        }
        ProcessEvent {
            id: format!("e-{ts}"),
            ts: ts.to_string(),
            kind,
            size,
            location: None,
            meta: if m.is_empty() { None } else { Some(m) },
        }
    }

    #[test]
    fn composition_counts_typed_and_pasted() {
        let events = vec![
            ev(
                ProcessEventType::TypingBurst,
                "2026-06-16T10:00:00Z",
                Some(800),
                vec![],
            ),
            ev(
                ProcessEventType::PasteDetected,
                "2026-06-16T10:00:30Z",
                Some(200),
                vec![],
            ),
            ev(
                ProcessEventType::PasteQuarantined,
                "2026-06-16T10:01:00Z",
                Some(200),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            ev(
                ProcessEventType::PasteClaimed,
                "2026-06-16T10:02:00Z",
                None,
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
        ];
        let c = compute_composition(&events);
        assert_eq!(c.typed_chars, 800);
        assert_eq!(c.pasted_chars, 200);
        assert_eq!(c.paste_count, 1);
        assert_eq!(c.pastes_claimed, 1);
        assert_eq!(c.pastes_unclaimed, 0);
        assert!((c.typed_ratio - 0.8).abs() < 1e-9);
    }

    #[test]
    fn removed_paste_stops_counting() {
        // A quarantined paste that is later removed (e.g. undone) must drop out
        // of the composition entirely — not linger as an unclaimed mark.
        let events = vec![
            ev(
                ProcessEventType::PasteQuarantined,
                "2026-06-16T10:00:00Z",
                Some(120),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            ev(
                ProcessEventType::PasteRemoved,
                "2026-06-16T10:00:05Z",
                None,
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
        ];
        let c = compute_composition(&events);
        assert_eq!(c.paste_count, 0, "removed paste must not be counted");
        assert_eq!(c.pastes_unclaimed, 0, "removed paste is not unclaimed");
    }

    #[test]
    fn reinstated_paste_is_unclaimed_again() {
        // Quarantine → claim → remove → re-quarantine (redo / undo-of-deletion):
        // the paste is present and unclaimed again, with the stale claim cleared.
        let events = vec![
            ev(
                ProcessEventType::PasteQuarantined,
                "t0",
                Some(120),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            ev(
                ProcessEventType::PasteClaimed,
                "t1",
                None,
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            ev(
                ProcessEventType::PasteRemoved,
                "t2",
                None,
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
            ev(
                ProcessEventType::PasteQuarantined,
                "t3",
                Some(120),
                vec![("regionId", MetaValue::Str("r1".into()))],
            ),
        ];
        let c = compute_composition(&events);
        assert_eq!(c.paste_count, 1);
        assert_eq!(c.pastes_claimed, 0, "the stale claim must be cleared");
        assert_eq!(c.pastes_unclaimed, 1);
    }

    #[test]
    fn render_includes_claim_and_scoping_note() {
        let events = vec![ev(
            ProcessEventType::ClaimSet,
            "2026-06-16T10:00:00Z",
            None,
            vec![(
                "claim",
                MetaValue::Str("I argue that friction aids learning.".into()),
            )],
        )];
        let doc = render_disclosure("doc-1", &events).unwrap();
        assert!(
            doc.markdown
                .contains("I argue that friction aids learning.")
        );
        assert!(doc.markdown.contains("Scope of this record"));
        assert_eq!(doc.scoping_note, SCOPING_NOTE);
    }

    #[test]
    fn session_span_computes_minutes() {
        let events = vec![
            ev(
                ProcessEventType::SessionStart,
                "2026-06-16T10:00:00Z",
                None,
                vec![],
            ),
            ev(
                ProcessEventType::TypingBurst,
                "2026-06-16T10:12:30Z",
                Some(10),
                vec![],
            ),
        ];
        let span = session_span(&events);
        // 12.5 min rounds half-up to 13 (matches the composer's Math.round).
        assert_eq!(span.minutes, 13);
        assert!(span.minutes >= 12 && span.minutes <= 13);
    }

    #[test]
    fn location_field_is_available() {
        // Guards against accidental removal of the Location type from the API.
        let _loc = Location { from: 0, to: 5 };
    }
}
