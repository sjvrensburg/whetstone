//! Forbidden-label guard.
//!
//! Ported from `composer/src/core/labels.ts` and promoted to a shared concern
//! (ADR-009): applied to every user-facing artifact so no string implies
//! "verified human" / proof-of-personhood. The product claim is *friction,
//! not proof*.

/// Words/phrases that MUST NOT appear in any user-facing artifact.
pub const FORBIDDEN_PHRASES: &[&str] = &[
    "human score",
    "proof of personhood",
    "proof of human",
    "verified human",
    "humanness",
    "humanity score",
    "ai score",
    "authenticity score",
    "authorship score",
];

/// `true` if `text` is clean of proof-of-personhood language.
pub fn has_no_forbidden_labels(text: &str) -> bool {
    find_forbidden_labels(text).is_empty()
}

/// The forbidden phrases present in `text` (empty when clean). Returned in the
/// order they are declared in [`FORBIDDEN_PHRASES`], with no duplicates.
///
/// The matcher first normalizes away characters a writer could use to split a
/// phrase: zero-width joiners/spaces, soft hyphens, and most punctuation that
/// would otherwise let "verified, human" or "verified\u{200b}human" slip past a
/// plain substring check. This mirrors the ownership tokenizer's hardening
/// (commit e6f1890) and closes the one gap where a writer-controlled string
/// (the exported draft) reaches the guard.
///
/// Matches are whole-word (see [`contains_phrase`]) because the guard now runs
/// over the writer's own draft on export: a false positive doesn't just soften
/// a label, it refuses to write the student's essay.
pub fn find_forbidden_labels(text: &str) -> Vec<&'static str> {
    let normalized = normalize_for_forbidden_match(text);
    let lower = normalized.to_lowercase();
    FORBIDDEN_PHRASES
        .iter()
        .copied()
        .filter(|phrase| contains_phrase(&lower, phrase))
        .collect()
}

/// `true` if `haystack` (already normalized and lowercased) contains `phrase`
/// as whole words. A bare substring test flags ordinary prose, because the
/// normalizer turns joiners into spaces: "AI-scored" becomes "ai scored", which
/// *contains* "ai score". A trailing plural "s" still counts — "AI scores" is
/// the same claim as "AI score".
fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    haystack.match_indices(phrase).any(|(i, m)| {
        if haystack[..i]
            .chars()
            .next_back()
            .is_some_and(char::is_alphanumeric)
        {
            return false;
        }
        let mut after = haystack[i + m.len()..].chars();
        let mut next = after.next();
        if next == Some('s') {
            next = after.next();
        }
        next.is_none_or(|c| !c.is_alphanumeric())
    })
}

/// Strip zero-width / control characters and a set of joiner punctuation so a
/// phrase can't be hidden by inserting invisible or soft separators between its
/// words. Zero-width characters and joiner punctuation collapse to a single
/// space so "verified\u{200b}human" and "verified-human" both match
/// "verified human"; whitespace runs collapse too so "verified  human" matches.
///
/// Sentence-ending punctuation is the exception: `.`, `;` and `:` only collapse
/// when they sit *inside* a word ("ai.score"). Folding them unconditionally
/// manufactures phrases across a sentence break — "applied by AI. Scores were
/// normalised" would read as "ai scores" — and that blocks the writer's own
/// export over ordinary prose.
fn normalize_for_forbidden_match(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut prev_was_space = false;
    for (i, &c) in chars.iter().enumerate() {
        // Zero-width / formatting characters and soft separators become a space
        // (NOT dropped) so a phrase split by them still matches. Dropping them
        // would concatenate "verified"+"human" into "verifiedhuman".
        let separator = matches!(
            c,
            '\u{200b}' // zero-width space
            | '\u{200c}' // zero-width non-joiner
            | '\u{200d}' // zero-width joiner
            | '\u{feff}' // zero-width no-break space (BOM)
            | '\u{00ad}' // soft hyphen
            | '\u{2060}' // word joiner
            | '\u{180e}' // mongolian vowel separator
            | '\u{200e}' | '\u{200f}' // LTR / RTL marks
            | '-' | '–' | '—' | '_' // hyphens / dashes / underscores
            | ',' // clause comma ("verified, human")
        );
        // A word-internal `.`/`;`/`:` is a split ("ai.score"); the same
        // character followed by a space is prose, and must stay a boundary.
        let intra_word_stop = matches!(c, '.' | ';' | ':')
            && i > 0
            && !chars[i - 1].is_whitespace()
            && chars.get(i + 1).is_some_and(|n| !n.is_whitespace());
        let to_space = c.is_whitespace() || separator || intra_word_stop;
        if to_space {
            if !prev_was_space {
                out.push(' ');
            }
            prev_was_space = true;
        } else {
            out.push(c);
            prev_was_space = false;
        }
    }
    out
}

/// Guard a user-facing artifact: returns an error naming the context if the
/// text contains forbidden language. Used at generation boundaries (e.g.
/// disclosure export) so an over-claiming string can never reach the user.
pub fn assert_no_forbidden_labels(text: &str, context: &str) -> Result<(), String> {
    let found = find_forbidden_labels(text);
    if found.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Forbidden label(s) in {context}: {}",
            found.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_passes() {
        assert!(has_no_forbidden_labels(
            "Typed by you: 87%. Pasted from outside: 13%."
        ));
        assert!(assert_no_forbidden_labels("clean", "ctx").is_ok());
    }

    #[test]
    fn detects_each_forbidden_phrase_case_insensitively() {
        for phrase in FORBIDDEN_PHRASES {
            let upper = phrase.to_uppercase();
            assert!(
                find_forbidden_labels(&upper).contains(phrase),
                "failed to detect {phrase}"
            );
        }
    }

    #[test]
    fn assert_reports_context_and_phrases() {
        let err = assert_no_forbidden_labels("this is a verified human score", "disclosure export")
            .unwrap_err();
        assert!(err.starts_with("Forbidden label(s) in disclosure export"));
        assert!(err.contains("verified human"));
        assert!(err.contains("human score"));
    }

    #[test]
    fn detects_phrase_split_by_zero_width_space() {
        // "verified\u{200b}human" must still trip the guard.
        assert!(
            find_forbidden_labels("a verified\u{200b}human wrote this").contains(&"verified human")
        );
    }

    #[test]
    fn detects_phrase_split_by_punctuation() {
        // "verified, human" and "verified-human" must both match.
        assert!(find_forbidden_labels("a verified, human author").contains(&"verified human"));
        assert!(find_forbidden_labels("a verified-human author").contains(&"verified human"));
    }

    #[test]
    fn detects_phrase_split_by_soft_hyphen_and_double_space() {
        assert!(find_forbidden_labels("verified\u{00ad} human").contains(&"verified human"));
        assert!(find_forbidden_labels("verified  human").contains(&"verified human"));
    }

    #[test]
    fn detects_phrase_split_inside_a_word() {
        // A stop with no space around it is a split, not prose.
        assert!(find_forbidden_labels("the ai.score was 87").contains(&"ai score"));
        assert!(find_forbidden_labels("a verified:human author").contains(&"verified human"));
    }

    #[test]
    fn sentence_boundary_is_not_a_phrase() {
        // Regression: folding sentence punctuation to a space manufactured
        // "ai score" here and refused the writer's own HTML/text export.
        assert!(has_no_forbidden_labels(
            "The rubric was applied by AI. Scores were normalised."
        ));
        assert!(has_no_forbidden_labels(
            "We discussed the AI; scores came later."
        ));
    }

    #[test]
    fn hyphenated_prose_is_not_a_phrase() {
        // "AI-scored" normalizes to "ai scored", which merely *contains*
        // "ai score" — whole-word matching keeps it out. The plural, which is
        // the same claim, still trips the guard.
        assert!(has_no_forbidden_labels("an AI-scored rubric"));
        assert!(find_forbidden_labels("the AI scores shown").contains(&"ai score"));
    }

    #[test]
    fn clean_text_with_normal_punctuation_still_passes() {
        // Normal prose with these characters isn't flagged as a false positive.
        assert!(has_no_forbidden_labels(
            "The user's name, verified locally, was Anne."
        ));
        assert!(has_no_forbidden_labels("well-known, self-aware writing"));
    }
}
