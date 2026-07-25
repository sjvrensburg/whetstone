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
pub fn find_forbidden_labels(text: &str) -> Vec<&'static str> {
    let normalized = normalize_for_forbidden_match(text);
    let lower = normalized.to_lowercase();
    FORBIDDEN_PHRASES
        .iter()
        .copied()
        .filter(|phrase| lower.contains(phrase))
        .collect()
}

/// Strip zero-width / control characters and a set of joiner punctuation so a
/// phrase can't be hidden by inserting invisible or soft separators between its
/// words. Zero-width characters and joiner punctuation collapse to a single
/// space so "verified\u{200b}human" and "verified-human" both match
/// "verified human"; whitespace runs collapse too so "verified  human" matches.
fn normalize_for_forbidden_match(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_was_space = false;
    for c in text.chars() {
        // Zero-width / formatting characters and soft separators become a space
        // (NOT dropped) so a phrase split by them still matches. Dropping them
        // would concatenate "verified"+"human" into "verifiedhuman".
        let to_space = c.is_whitespace()
            || matches!(
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
                | '.' | ',' | ';' | ':' // sentence/clause punctuation
            );
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
    fn clean_text_with_normal_punctuation_still_passes() {
        // Normal prose with these characters isn't flagged as a false positive.
        assert!(has_no_forbidden_labels(
            "The user's name, verified locally, was Anne."
        ));
        assert!(has_no_forbidden_labels("well-known, self-aware writing"));
    }
}
