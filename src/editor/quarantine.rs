//! Paste-quarantine region store — instrument B (walking-skeleton spec §5).
//!
//! Ports the editor-agnostic core of `composer/src/editor/quarantine.ts` onto
//! our rope-backed transactions. A paste of ≥ [`PASTE_THRESHOLD`] chars is
//! recorded as a tracked [`Region`]; every subsequent transaction remaps the
//! region (leading edge via [`ChangeSet::map_pos`], trailing edge via
//! [`ChangeSet::map_region_end`], so text inserted right at a boundary stays
//! outside the region) and, when little of the original survives, auto-clears
//! it (`is_claimed_to_own`). The UI layer journals the returned [`Outcome`]s as
//! metadata-only events.

use crate::core::ownership::{
    CLAIM_SURVIVAL_THRESHOLD, is_claimed_to_own_thresholded, survival_ratio,
};
use crate::editor::transaction::ChangeSet;

/// Pastes at or above this many chars are quarantined (friction level 1
/// default; the friction dial overrides this per-instance).
pub const PASTE_THRESHOLD: usize = 40;

/// A tracked quarantined span. Positions are char offsets in the live document.
#[derive(Debug, Clone)]
pub struct Region {
    pub id: String,
    pub from: usize,
    pub to: usize,
    /// The original pasted text, kept for the survival comparison only.
    pub original: String,
    /// Last computed survival ratio (how much of the original remains).
    pub survival: f64,
}

/// What a transaction did to a region — the UI maps these to journal events.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Region cleared: rewritten until owned (or deleted outright).
    Claimed {
        id: String,
        survival: f64,
        deleted: bool,
    },
    /// Region still marked, but its survival ratio changed.
    Revised { id: String, survival: f64 },
}

#[derive(Debug)]
pub struct Quarantine {
    regions: Vec<Region>,
    next_id: u64,
    /// Friction-dial trigger: pastes at or above this many chars are tracked.
    paste_threshold: usize,
    /// Friction-dial claim-to-own survival floor (see `ownership`).
    claim_threshold: f64,
}

impl Default for Quarantine {
    fn default() -> Self {
        Self {
            regions: Vec::new(),
            next_id: 0,
            paste_threshold: PASTE_THRESHOLD,
            claim_threshold: CLAIM_SURVIVAL_THRESHOLD,
        }
    }
}

impl Quarantine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply friction-dial thresholds (ADR-008): the paste-quarantine trigger
    /// and the claim-to-own survival floor.
    pub fn set_thresholds(&mut self, paste_threshold: usize, claim_threshold: f64) {
        self.paste_threshold = paste_threshold;
        self.claim_threshold = claim_threshold;
    }

    pub fn regions(&self) -> &[Region] {
        &self.regions
    }

    /// Replace the tracked regions wholesale (used to restore an undo snapshot).
    pub fn restore_regions(&mut self, regions: Vec<Region>) {
        self.regions = regions;
    }

    /// The region containing `pos` (inclusive of the trailing edge).
    pub fn region_at(&self, pos: usize) -> Option<&Region> {
        self.regions
            .iter()
            .find(|r| pos >= r.from && pos < r.to)
            .or_else(|| self.regions.iter().find(|r| r.to > r.from && pos == r.to))
    }

    /// Record a freshly-pasted span. Returns its region id if it met the
    /// threshold (else `None` — the paste was too small to quarantine).
    pub fn record_paste(&mut self, from: usize, to: usize, text: &str) -> Option<String> {
        if text.chars().count() < self.paste_threshold {
            return None;
        }
        self.next_id += 1;
        let id = format!("q{}", self.next_id);
        self.regions.push(Region {
            id: id.clone(),
            from,
            to,
            original: text.to_string(),
            survival: 1.0,
        });
        Some(id)
    }

    /// Remap all regions through `cs` against the post-edit `current` text,
    /// auto-clearing any that are now claimed-to-own (or fully deleted).
    pub fn apply(&mut self, cs: &ChangeSet, current: &str) -> Vec<Outcome> {
        let mut outcomes = Vec::new();
        let mut keep = Vec::new();
        for mut r in self.regions.drain(..) {
            // The leading edge stays left of any boundary insertion; the
            // trailing edge uses region-end mapping, so text pasted or typed
            // exactly after the block neither extends it nor double-marks it
            // (a paste-after-paste yields two independent regions), while a
            // replacement/deletion spanning the edge is still tracked.
            let new_from = cs.map_pos(r.from, -1);
            let new_to = cs.map_region_end(r.to);
            if new_from >= new_to {
                outcomes.push(Outcome::Claimed {
                    id: r.id,
                    survival: 0.0,
                    deleted: true,
                });
                continue;
            }
            r.from = new_from;
            r.to = new_to;
            let slice: String = current.chars().skip(r.from).take(r.to - r.from).collect();
            let surv = survival_ratio(&slice, &r.original);
            if is_claimed_to_own_thresholded(&slice, &r.original, self.claim_threshold) {
                outcomes.push(Outcome::Claimed {
                    id: r.id,
                    survival: surv,
                    deleted: false,
                });
                continue;
            }
            if (surv - r.survival).abs() > 1e-6 {
                outcomes.push(Outcome::Revised {
                    id: r.id.clone(),
                    survival: surv,
                });
                r.survival = surv;
            }
            keep.push(r);
        }
        self.regions = keep;
        outcomes
    }

    /// Drop a region by id (e.g. after attribution as a quotation).
    pub fn remove(&mut self, id: &str) {
        self.regions.retain(|r| r.id != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::transaction::Change;

    const PASTE: &str = "The mitochondrion is the powerhouse of the cell because it makes ATP";

    #[test]
    fn records_and_remaps_a_quarantined_paste() {
        let mut q = Quarantine::new();
        let id = q.record_paste(0, PASTE.chars().count(), PASTE).unwrap();
        assert_eq!(q.regions().len(), 1);

        // Insert "Introduction. " before the paste (offset 0) — inclusive map
        // grows the region to cover it; survival stays ~1.0 → not claimed.
        let cs = ChangeSet::single(Change {
            from: 0,
            to: 0,
            insert: "Introduction. ".into(),
        });
        let text = format!("Introduction. {PASTE}");
        let out = q.apply(&cs, &text);
        assert!(out.is_empty() || out.iter().all(|o| matches!(o, Outcome::Revised { .. })));
        let r = q.regions().first().unwrap();
        assert_eq!(r.id, id);
        assert!(r.from == 0); // inclusive: the prefix joined
    }

    #[test]
    fn full_rewrite_auto_clears_the_region() {
        let mut q = Quarantine::new();
        q.record_paste(0, PASTE.chars().count(), PASTE).unwrap();
        // Replace the whole region with unrelated text.
        let cs = ChangeSet::single(Change {
            from: 0,
            to: PASTE.chars().count(),
            insert: "A completely different sentence about unrelated topics here.".into(),
        });
        let out = q.apply(
            &cs,
            "A completely different sentence about unrelated topics here.",
        );
        assert!(
            out.iter()
                .any(|o| matches!(o, Outcome::Claimed { deleted: false, .. }))
        );
        assert!(q.regions().is_empty(), "claimed region should be removed");
    }

    #[test]
    fn deleting_the_whole_region_is_claimed() {
        let mut q = Quarantine::new();
        q.record_paste(0, PASTE.chars().count(), PASTE).unwrap();
        let cs = ChangeSet::single(Change {
            from: 0,
            to: PASTE.chars().count(),
            insert: String::new(),
        });
        let out = q.apply(&cs, "");
        assert!(
            out.iter()
                .any(|o| matches!(o, Outcome::Claimed { deleted: true, .. }))
        );
        assert!(q.regions().is_empty());
    }

    #[test]
    fn paste_at_trailing_edge_does_not_merge_regions() {
        // Regression: pasting right at an existing region's trailing edge must
        // not absorb the new text into the old region (which would tie it to the
        // wrong original and let it escape when the old block is rewritten).
        let mut q = Quarantine::new();
        let len = PASTE.chars().count();
        q.record_paste(0, len, PASTE).unwrap();
        // Insert a second block exactly at the first region's end.
        let cs = ChangeSet::single(Change {
            from: len,
            to: len,
            insert: PASTE.into(),
        });
        let combined = format!("{PASTE}{PASTE}");
        q.apply(&cs, &combined);
        // First region's trailing edge stayed put (did not swallow the paste).
        let r = q.regions().first().unwrap();
        assert_eq!((r.from, r.to), (0, len));
    }

    #[test]
    fn small_paste_is_not_quarantined() {
        let mut q = Quarantine::new();
        assert!(q.record_paste(0, 5, "short").is_none());
        assert!(q.regions().is_empty());
    }
}
