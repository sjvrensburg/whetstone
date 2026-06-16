//! Friction instruments: paragraph detection + teach-back classification.
//!
//! Ports the editor-agnostic helpers from `composer/src/instruments/`
//! (`teachBack.ts`, `pushCadence.ts`): how to count paragraphs and decide
//! whether a teach-back summary is a genuine attempt or a disconnect.

/// Split text into non-empty paragraphs (separated by blank lines), trimmed.
pub fn extract_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Number of non-empty paragraphs in `text`.
pub fn paragraph_count(text: &str) -> usize {
    extract_paragraphs(text).len()
}

/// Placeholders that read as a refusal / non-answer in a teach-back summary.
const DISCONNECT_PATTERNS: &[&str] = &[
    "i don't know",
    "i dont know",
    "idk",
    "i'm not sure",
    "im not sure",
    "no idea",
    "dunno",
    "nothing",
    "n/a",
    "na",
    "skip",
    "pass",
    "none",
];

/// A teach-back response that reads as a disconnect: empty, too short, or a
/// placeholder refusal. (Ports `teachBack.isDisconnect`.)
pub fn is_disconnect(response: &str) -> bool {
    let t = response.trim();
    if t.is_empty() {
        return true;
    }
    if t.split_whitespace().count() < 5 {
        return true;
    }
    let lower = t.to_lowercase();
    DISCONNECT_PATTERNS
        .iter()
        .any(|p| lower == *p || lower.starts_with(p))
}

/// Classify a teach-back summary.
pub fn classify_teach_back(response: &str) -> TeachBackOutcome {
    if is_disconnect(response) {
        TeachBackOutcome::Disconnect
    } else {
        TeachBackOutcome::Given
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeachBackOutcome {
    Given,
    Disconnect,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_paragraphs() {
        assert_eq!(paragraph_count("one"), 1);
        assert_eq!(paragraph_count("one\n\ntwo\n\nthree"), 3);
        assert_eq!(paragraph_count("one\n\ntwo\n\n\n  \n\nthree"), 3);
        assert_eq!(paragraph_count(""), 0);
    }

    #[test]
    fn flags_disconnects() {
        assert!(is_disconnect(""));
        assert!(is_disconnect("   "));
        assert!(is_disconnect("yes")); // too short
        assert!(is_disconnect("I don't know what to say here"));
        assert!(is_disconnect("skip"));
    }

    #[test]
    fn accepts_genuine_summaries() {
        assert!(!is_disconnect(
            "I argue that friction in the writing process aids honest authorship."
        ));
        assert!(!is_disconnect(
            "The cell makes energy through oxidative metabolism daily."
        ));
    }

    #[test]
    fn classify_matches_disconnect() {
        assert_eq!(classify_teach_back("skip"), TeachBackOutcome::Disconnect);
        assert_eq!(
            classify_teach_back("The argument is that friction aids honest writing."),
            TeachBackOutcome::Given
        );
    }
}
