//! Transaction change sets with inclusive-bias position mapping.
//!
//! Ports the editor-agnostic core of `composer/src/editor/quarantine.ts`:
//! CodeMirror's `mapPos(pos, assoc)`. An insertion exactly at `pos` with
//! `bias <= 0` maps to the left of the inserted text, `bias > 0` to the
//! right — so quarantine region boundaries are *inclusive*: an insertion
//! touching either edge of a region joins it, and deleting a whole region
//! collapses it to zero width (→ claimed).

/// A single atomic edit: replace the char range `[from, to)` with `insert`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

impl Change {
    /// Length of the inserted text, in chars.
    pub fn inserted_len(&self) -> usize {
        self.insert.chars().count()
    }
}

/// A set of changes applied in one transaction. `changes` must be sorted by
/// `from` and non-overlapping.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChangeSet {
    pub changes: Vec<Change>,
}

impl ChangeSet {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn single(change: Change) -> Self {
        Self {
            changes: vec![change],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.changes
            .iter()
            .all(|c| c.from == c.to && c.insert.is_empty())
    }

    /// Map `pos` through this change set. Mirrors CodeMirror's `mapPos`:
    /// an insertion exactly at `pos` with `bias <= 0` resolves to the left
    /// of the inserted text; `bias > 0` to the right. A point inside a
    /// deleted range resolves to the replacement's start (left) or end
    /// (right).
    pub fn map_pos(&self, pos: usize, bias: i32) -> usize {
        let mut pos = pos;
        for c in &self.changes {
            if c.from <= pos {
                if c.to >= pos {
                    // `pos` is within [from, to] (inclusive): either inside a
                    // replaced range or exactly at a pure-insertion boundary.
                    return if bias <= 0 {
                        c.from
                    } else {
                        c.from + c.inserted_len()
                    };
                }
                // `pos` is strictly after this change — shift by the net delta.
                pos = pos - (c.to - c.from) + c.inserted_len();
            }
            // This change (and all later, sorted ones) are strictly before/after.
        }
        pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insertion_at_region_start_joins_it() {
        // Insert "XY" exactly at the region start (offset 2). With left-bias
        // the region's `from` stays at 2; with right-bias the region's `to`
        // grows by 2 → the inserted text is inside the region.
        let cs = ChangeSet::single(Change {
            from: 2,
            to: 2,
            insert: "XY".into(),
        });
        assert_eq!(cs.map_pos(2, -1), 2); // region.from unchanged
        assert_eq!(cs.map_pos(5, 1), 7); // region.to grew by 2
    }

    #[test]
    fn deletion_collapses_region_to_zero_width() {
        // Replace the whole region [2,5) with nothing → both edges map to 2.
        let cs = ChangeSet::single(Change {
            from: 2,
            to: 5,
            insert: String::new(),
        });
        assert_eq!(cs.map_pos(2, -1), 2);
        assert_eq!(cs.map_pos(5, 1), 2); // zero-width → vanished (claimed)
    }

    #[test]
    fn edit_after_region_does_not_move_it() {
        let cs = ChangeSet::single(Change {
            from: 6,
            to: 6,
            insert: "Z".into(),
        });
        assert_eq!(cs.map_pos(2, -1), 2);
        assert_eq!(cs.map_pos(5, 1), 5);
    }

    #[test]
    fn typing_inside_region_shifts_trailing_edge() {
        // Typing at offset 3 (inside [2,5)) with a plain insertion.
        let cs = ChangeSet::single(Change {
            from: 3,
            to: 3,
            insert: "K".into(),
        });
        assert_eq!(cs.map_pos(2, -1), 2); // leading edge unaffected
        assert_eq!(cs.map_pos(5, 1), 6); // trailing edge shifts right by 1
    }

    #[test]
    fn multiple_changes_shift_cumulatively() {
        let cs = ChangeSet {
            changes: vec![
                Change {
                    from: 2,
                    to: 2,
                    insert: "X".into(),
                }, // +1 at 2
                Change {
                    from: 8,
                    to: 8,
                    insert: "Y".into(),
                }, // +1 at 8
            ],
        };
        // pos 5: after first change (shift +1 → 6), before second (unchanged).
        assert_eq!(cs.map_pos(5, 0), 6);
    }
}
