//! Claim-to-own — has the writer meaningfully rewritten a quarantined paste?
//!
//! Ported from `composer/src/core/ownership.ts`. Uses the AUDIT-CORRECTED
//! containment direction (walking-skeleton spec §5): measure *how much of
//! the ORIGINAL survives in the CURRENT text* — i.e. the fraction of the
//! original's n-grams still present in the current text.
//!
//! The V1 bug measured the reverse (how much of the current came from the
//! original), which let padding defeat the gate: append enough new prose
//! around an untouched paste and the current text's n-gram profile dilutes
//! below threshold while every word of the original survives verbatim.

use crate::core::ngram::{extract_ngrams, ngram_overlap};

/// N-gram size for the survival check. Trigrams (n=3) match the V1 guard
/// heuristic: bigrams are too noisy, 4-grams miss structural similarity.
pub const CLAIM_NGRAM_SIZE: usize = 3;

/// Survival threshold: the mark clears when fewer than 50% of the original
/// paste's trigrams survive in the current text.
pub const CLAIM_SURVIVAL_THRESHOLD: f64 = 0.5;

/// Minimum words in the ORIGINAL paste to produce meaningful trigrams. Below
/// this the original can't be measured; such tiny pastes shouldn't have been
/// quarantined in the first place (threshold is 40 chars), but if one is,
/// treat it as claimable.
pub const MIN_WORDS_FOR_OVERLAP: usize = 3;

/// Fraction of the original paste's trigrams that survive in `current_text`.
/// `1.0` = the original is fully present; `0.0` = nothing of it survives.
pub fn survival_ratio(current_text: &str, original_text: &str) -> f64 {
    let original_ngrams = extract_ngrams(original_text, CLAIM_NGRAM_SIZE);
    if original_ngrams.is_empty() {
        return 0.0;
    }
    let current_ngrams = extract_ngrams(current_text, CLAIM_NGRAM_SIZE);
    ngram_overlap(&original_ngrams, &current_ngrams)
}

/// Whether the region is claimed-to-own: little of the original survives in
/// the current text. Padding cannot defeat this — adding text around an
/// untouched paste leaves the original's n-grams fully present (survival 1.0).
pub fn is_claimed_to_own(current_text: &str, original_text: &str) -> bool {
    is_claimed_to_own_thresholded(current_text, original_text, CLAIM_SURVIVAL_THRESHOLD)
}

/// Same as [`is_claimed_to_own`] but with a caller-supplied threshold. Used
/// by the friction dial (ADR-008) when a higher floor tightens the gate.
pub fn is_claimed_to_own_thresholded(
    current_text: &str,
    original_text: &str,
    threshold: f64,
) -> bool {
    let original_words = original_text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .count();
    if original_words < MIN_WORDS_FOR_OVERLAP {
        return true;
    }
    survival_ratio(current_text, original_text) < threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASTE: &str = "The mitochondrion is the powerhouse of the cell because it generates ATP";

    #[test]
    fn untouched_paste_is_not_claimed() {
        // The verbatim original survives in full → survival 1.0 → NOT claimed.
        assert!(!is_claimed_to_own(PASTE, PASTE));
    }

    #[test]
    fn padding_around_untouched_paste_does_not_claim_it() {
        // The V1 padding-attack regression: dilute with new prose around an
        // untouched paste. The original's trigrams are still 100% present, so
        // the region must remain NOT claimed.
        let padded = format!("Introduction. {PASTE} In summary we agree.");
        assert!(
            !is_claimed_to_own(&padded, PASTE),
            "padding must not defeat claim-to-own (the V1 bug)"
        );
    }

    #[test]
    fn full_rewrite_is_claimed() {
        // Every word changed → none of the original's trigrams survive.
        let rewritten =
            "This tiny organelle makes the energy currency that powers each living unit";
        assert!(is_claimed_to_own(rewritten, PASTE));
    }

    #[test]
    fn partial_rewrite_below_threshold_is_claimed() {
        // Rewrite enough that <50% of original trigrams survive.
        let rewritten = "This small organelle produces the energy currency powering every living biological unit here";
        assert!(is_claimed_to_own(rewritten, PASTE));
    }

    #[test]
    fn tiny_originals_are_auto_claimed() {
        // < MIN_WORDS_FOR_OVERLAP words → can't measure → claimable.
        assert!(is_claimed_to_own("anything", "hi there"));
    }

    #[test]
    fn reverse_direction_is_the_padding_bug() {
        // The WRONG direction (treating the diluted CURRENT as the candidate)
        // returns the wrong answer once enough padding is added: the untouched
        // paste's trigrams are still 100% present, yet the current text's
        // profile is diluted below threshold → it would WRONGLY mark the
        // region claimed. This test documents why we must NOT use it.
        let padding = "Lakes form where water collects in basins over geological time. \
                       Birds migrate across continents following seasonal warmth and food. \
                       The history of trade routes shaped languages along their winding paths.";
        let padded = format!("{PASTE} {padding}");

        let original_ngrams = extract_ngrams(PASTE, CLAIM_NGRAM_SIZE);
        let padded_ngrams = extract_ngrams(&padded, CLAIM_NGRAM_SIZE);

        // Wrong direction: how much of the PADDED text looks like the original.
        // Lots of padding → diluted below 0.5 → would WRONGLY claim the paste.
        let wrong = ngram_overlap(&padded_ngrams, &original_ngrams);
        assert!(
            wrong < CLAIM_SURVIVAL_THRESHOLD,
            "reverse direction ({wrong:.2}) dilutes below threshold → would WRONGLY claim the untouched paste (the bug)"
        );

        // Correct direction stays high → correctly NOT claimed, and the public
        // API agrees (padding must not defeat claim-to-own).
        let right = ngram_overlap(&original_ngrams, &padded_ngrams);
        assert!(
            right > 0.99,
            "correct direction ({right:.2}) must stay high — original survives verbatim"
        );
        assert!(
            !is_claimed_to_own(&padded, PASTE),
            "public API must NOT be defeated by padding"
        );
    }
}
