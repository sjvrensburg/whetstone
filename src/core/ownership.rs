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

use crate::core::ngram::{extract_ngrams, ngram_overlap, word_count};

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

/// How much of the original paste survives in `current_text`. `1.0` = the
/// original is fully present; `0.0` = nothing of it survives.
///
/// Combines two views and takes the **larger** (most conservative — the one
/// least likely to grant "owned"):
/// - trigram survival: catches genuine rewriting (word *adjacency* is gone);
/// - unigram survival: catches adjacency attacks that leave the paste readable
///   — interleaving filler words between the original's words, or reordering
///   them — which zero the trigram score while the writer changed nothing.
///
/// A real rewrite lowers both; an evasion lowers only the trigram view, so the
/// max stays high and the gate is not fooled.
pub fn survival_ratio(current_text: &str, original_text: &str) -> f64 {
    let original_trigrams = extract_ngrams(original_text, CLAIM_NGRAM_SIZE);
    if original_trigrams.is_empty() {
        return 0.0;
    }
    let current_trigrams = extract_ngrams(current_text, CLAIM_NGRAM_SIZE);
    let trigram_survival = ngram_overlap(&original_trigrams, &current_trigrams);

    let unigram_survival = ngram_overlap(
        &extract_ngrams(original_text, 1),
        &extract_ngrams(current_text, 1),
    );
    trigram_survival.max(unigram_survival)
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
    if word_count(original_text) < MIN_WORDS_FOR_OVERLAP {
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
    fn interleaving_filler_words_does_not_claim() {
        // Inserting a filler word between every original word zeroes the
        // trigrams while the paste is read verbatim. The unigram view keeps
        // survival high, so the gate must NOT grant ownership — even at the
        // strictest friction floor.
        let interleaved = PASTE.split_whitespace().collect::<Vec<_>>().join(" and ");
        assert!(
            !is_claimed_to_own_thresholded(&interleaved, PASTE, 0.9),
            "interleaving filler words must not fake ownership"
        );
    }

    #[test]
    fn reordering_original_words_does_not_claim() {
        // The original's words, reversed: adjacency gone, words all present.
        let reversed = PASTE.split_whitespace().rev().collect::<Vec<_>>().join(" ");
        assert!(!is_claimed_to_own(&reversed, PASTE));
    }

    #[test]
    fn homoglyph_substitution_does_not_claim() {
        // Disguise the paste by swapping Latin letters for identical-looking
        // Cyrillic ones. After confusable folding it measures as the original,
        // so ownership is not granted (even at the strictest floor).
        let disguised: String = PASTE
            .chars()
            .map(|c| match c {
                'o' => 'о', // Cyrillic U+043E
                'e' => 'е', // Cyrillic U+0435
                'a' => 'а', // Cyrillic U+0430
                'c' => 'с', // Cyrillic U+0441
                'p' => 'р', // Cyrillic U+0440
                other => other,
            })
            .collect();
        assert_ne!(disguised, PASTE, "the disguise must change the bytes");
        assert!(
            !is_claimed_to_own_thresholded(&disguised, PASTE, 0.9),
            "homoglyph substitution must not fake ownership"
        );
    }

    #[test]
    fn non_ascii_paste_is_measured_not_auto_claimed() {
        // An all-Cyrillic paste must tokenize into real words rather than read
        // as wordless (the old ASCII-only split auto-claimed it). Verbatim
        // survival → NOT claimed; a genuine rewrite → claimed.
        let original = "Москва столица России и крупнейший город страны сегодня";
        assert!(
            !is_claimed_to_own(original, original),
            "a verbatim non-ASCII paste survives → not claimed"
        );
        let rewritten = "совершенно другой текст про погоду весной в горах";
        assert!(
            is_claimed_to_own(rewritten, original),
            "a genuine non-ASCII rewrite → claimed"
        );
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
