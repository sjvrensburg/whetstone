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
    // Match a placeholder only when it is the WHOLE answer (modulo trailing
    // punctuation), never as a prefix: "None of the prior work…" or a name
    // like "Nathan argues…" must not be flagged just because they start with
    // "none"/"na".
    let lower = t.to_lowercase();
    let normalized = lower.trim_end_matches(|c: char| !c.is_alphanumeric());
    DISCONNECT_PATTERNS.contains(&normalized)
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
        assert!(is_disconnect("I don't know.")); // exact placeholder (+ punctuation)
        assert!(is_disconnect("skip"));
        assert!(is_disconnect("None.")); // exact placeholder, trimmed
        // A genuine summary that merely STARTS with a placeholder word is NOT a
        // disconnect (regression: prefix-matching false-positives).
        assert!(!is_disconnect(
            "None of the prior work addresses this gap, so I argue otherwise."
        ));
        assert!(!is_disconnect(
            "Passive constructions weaken my central claim throughout."
        ));
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
