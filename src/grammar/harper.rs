//! harper-core wrapper: lint markdown text → diagnostics with char spans.
//!
//! Harper's `Span<char>` is over **char offsets** of the source string — the
//! same unit the editor's ropey buffer uses — so diagnostic spans map onto the
//! buffer with no byte/char conversion. Each diagnostic also carries any
//! Harper-supplied fixes ([`Fix`]), so the suggestions pane can apply them.
//!
//! The linter's dialect and which lint rules run are configurable (Harper
//! exposes `Dialect` + per-rule toggles); see [`GrammarSettings`].

use harper_core::linting::{LintGroup, Linter as _, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::{Deserialize, Serialize};

/// How strongly a diagnostic should be flagged in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Style,
}

/// What applying a [`Fix`] does to the diagnostic's `[start, end)` char span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixAction {
    /// Replace the span text with this string.
    Replace(String),
    /// Insert this string immediately after the span.
    InsertAfter(String),
    /// Delete the span text.
    Remove,
}

/// A single applicable correction Harper offers for a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fix {
    /// Short label for the suggestions list (e.g. the replacement word).
    pub label: String,
    pub action: FixAction,
}

/// A single grammar diagnostic over a char span `[start, end)`.
#[derive(Debug, Clone)]
pub struct Diagnostic {
    pub start: usize,
    pub end: usize,
    pub message: String,
    pub severity: Severity,
    /// Zero or more fixes Harper suggests (first is the primary suggestion).
    pub suggestions: Vec<Fix>,
}

/// The English dialect Harper checks against. Mirrors `harper_core::Dialect`
/// but is serializable for the persisted UI settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrammarDialect {
    #[default]
    American,
    British,
    Canadian,
    Australian,
    Indian,
}

impl GrammarDialect {
    pub const ALL: [GrammarDialect; 5] = [
        GrammarDialect::American,
        GrammarDialect::British,
        GrammarDialect::Canadian,
        GrammarDialect::Australian,
        GrammarDialect::Indian,
    ];

    pub fn label(self) -> &'static str {
        match self {
            GrammarDialect::American => "American",
            GrammarDialect::British => "British",
            GrammarDialect::Canadian => "Canadian",
            GrammarDialect::Australian => "Australian",
            GrammarDialect::Indian => "Indian",
        }
    }

    /// Parse a free-form string (env var / config) into a dialect.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "american" | "us" | "en-us" => Some(GrammarDialect::American),
            "british" | "uk" | "gb" | "en-gb" => Some(GrammarDialect::British),
            "canadian" | "ca" | "en-ca" => Some(GrammarDialect::Canadian),
            "australian" | "au" | "en-au" => Some(GrammarDialect::Australian),
            "indian" | "in" | "en-in" => Some(GrammarDialect::Indian),
            _ => None,
        }
    }

    fn to_harper(self) -> Dialect {
        match self {
            GrammarDialect::American => Dialect::American,
            GrammarDialect::British => Dialect::British,
            GrammarDialect::Canadian => Dialect::Canadian,
            GrammarDialect::Australian => Dialect::Australian,
            GrammarDialect::Indian => Dialect::Indian,
        }
    }
}

/// User-controllable grammar settings (persisted; see `crate::ui::settings`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrammarSettings {
    #[serde(default)]
    pub dialect: GrammarDialect,
    /// Lint-rule keys the writer has turned off (Harper rule names).
    #[serde(default)]
    pub disabled_rules: Vec<String>,
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
    /// A linter with Harper's defaults (American English, full curated lint set).
    pub fn new() -> Self {
        Self::with_settings(&GrammarSettings::default())
    }

    /// A linter configured from the user's [`GrammarSettings`]: chosen dialect,
    /// with any disabled rules turned off.
    pub fn with_settings(settings: &GrammarSettings) -> Self {
        let mut group =
            LintGroup::new_curated(FstDictionary::curated(), settings.dialect.to_harper());
        for key in &settings.disabled_rules {
            group.config.set_rule_enabled(key, false);
        }
        Self { group }
    }

    /// All available lint rules as `(key, description)`, sorted by key — the
    /// source of truth for the grammar settings toggle list.
    pub fn available_rules(&self) -> Vec<(String, String)> {
        let mut rules: Vec<(String, String)> = self
            .group
            .all_descriptions()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        rules.sort_by(|a, b| a.0.cmp(&b.0));
        rules
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
                suggestions: l.suggestions.iter().map(fix_of).collect(),
            })
            .collect();
        diags.sort_by_key(|d| d.start);
        diags
    }
}

/// Map a Harper [`Suggestion`] to an applicable [`Fix`] with a display label.
fn fix_of(s: &Suggestion) -> Fix {
    match s {
        Suggestion::ReplaceWith(chars) => {
            let text: String = chars.iter().collect();
            Fix {
                label: text.clone(),
                action: FixAction::Replace(text),
            }
        }
        Suggestion::InsertAfter(chars) => {
            let text: String = chars.iter().collect();
            Fix {
                label: format!("insert “{text}”"),
                action: FixAction::InsertAfter(text),
            }
        }
        Suggestion::Remove => Fix {
            label: "(remove)".to_string(),
            action: FixAction::Remove,
        },
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
    fn flags_a_spelling_error_with_suggestions() {
        let mut linter = Linter::new();
        let src = "This is a sentance with an eror.";
        let diags = linter.lint(src);
        assert!(!diags.is_empty(), "harper should flag the spelling errors");
        for d in &diags {
            assert!(d.end <= src.chars().count());
        }
        // At least one misspelling should carry a replacement fix.
        assert!(
            diags.iter().any(|d| d
                .suggestions
                .iter()
                .any(|f| matches!(f.action, FixAction::Replace(_)))),
            "expected a replacement suggestion for the misspelling"
        );
    }

    #[test]
    fn british_dialect_accepts_british_spelling() {
        let src = "The colour of the harbour.";
        let american = {
            let mut l = Linter::with_settings(&GrammarSettings {
                dialect: GrammarDialect::American,
                disabled_rules: vec![],
            });
            l.lint(src).len()
        };
        let british = {
            let mut l = Linter::with_settings(&GrammarSettings {
                dialect: GrammarDialect::British,
                disabled_rules: vec![],
            });
            l.lint(src).len()
        };
        // British spelling should not be flagged under the British dialect.
        assert!(
            british <= american,
            "British dialect flagged more than American ({british} vs {american})"
        );
    }

    #[test]
    fn available_rules_is_nonempty_and_sorted() {
        let rules = Linter::new().available_rules();
        assert!(!rules.is_empty());
        assert!(rules.windows(2).all(|w| w[0].0 <= w[1].0));
    }
}
