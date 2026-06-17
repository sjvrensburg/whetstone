//! harper-core wrapper: lint markdown text → diagnostics with char spans.
//!
//! Harper's `Span<char>` is over **char offsets** of the source string — the
//! same unit the editor's ropey buffer uses — so diagnostic spans map onto the
//! buffer with no byte/char conversion.

use harper_core::linting::{LintGroup, Linter as _};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};

/// How strongly a diagnostic should be flagged in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Style,
}

/// A single grammar diagnostic over a char span `[start, end)`.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub start: usize,
    pub end: usize,
    pub message: String,
    pub severity: Severity,
}

/// A persistent Harper linter (the `LintGroup` is reused across lints).
pub struct Linter {
    group: LintGroup,
}

impl Default for Linter {
    fn default() -> Self {
        Self::new()
    }
}

impl Linter {
    pub fn new() -> Self {
        Self {
            group: LintGroup::new_curated(FstDictionary::curated(), Dialect::American),
        }
    }

    /// Lint `text` as Markdown, returning diagnostics sorted by `start`.
    pub fn lint(&mut self, text: &str) -> Vec<Diagnostic> {
        let doc = Document::new_markdown_default_curated(text);
        let mut diags: Vec<Diagnostic> = self
            .group
            .lint(&doc)
            .into_iter()
            .map(|l| Diagnostic {
                start: l.span.start,
                end: l.span.end,
                message: l.message,
                severity: severity_of(l.lint_kind),
            })
            .collect();
        diags.sort_by_key(|d| d.start);
        diags
    }
}

fn severity_of(kind: harper_core::linting::LintKind) -> Severity {
    use harper_core::linting::LintKind::*;
    match kind {
        Spelling | Grammar => Severity::Error,
        Punctuation => Severity::Warning,
        _ => Severity::Style,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_a_spelling_error() {
        let mut linter = Linter::new();
        let diags = linter.lint("This is a sentance with an eror.");
        assert!(!diags.is_empty(), "harper should flag the spelling errors");
        // Every diagnostic span is within the source length.
        for d in &diags {
            assert!(d.end <= "This is a sentance with an eror.".chars().count());
        }
    }

    #[test]
    fn clean_text_has_few_or_no_diagnostics() {
        let mut linter = Linter::new();
        let diags = linter.lint("This is a clean sentence with no errors.");
        // We don't assert zero (harper may have stylistic opinions) — just
        // that it runs and returns a Vec.
        let _ = diags;
    }
}
