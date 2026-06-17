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
pub fn find_forbidden_labels(text: &str) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    FORBIDDEN_PHRASES
        .iter()
        .copied()
        .filter(|phrase| lower.contains(phrase))
        .collect()
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
}
