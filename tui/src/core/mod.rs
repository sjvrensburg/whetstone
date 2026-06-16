//! Pure domain logic ported from the web composer (`composer/src/core/`).
//!
//! No I/O, no editor, no UI — just strings, numbers, and plain data
//! structures. These are the load-bearing pieces of Whetstone's value and
//! port ~1:1 from TypeScript.

pub mod coaching;
pub mod disclosure;
pub mod guard;
pub mod labels;
pub mod mirror;
pub mod ngram;
pub mod ownership;
pub mod process_event;
pub mod prompts;

pub use coaching::{Observation, ObservationKind, StructuredCoaching};
pub use guard::{GuardError, GuardLayer, GuardResult};
pub use labels::{find_forbidden_labels, has_no_forbidden_labels};
pub use ngram::{extract_ngrams, ngram_overlap};
pub use ownership::is_claimed_to_own;
pub use process_event::{ProcessEvent, ProcessEventType};

/// A check that either passes or fails with a human-readable reason.
/// Mirrors the composer's `CheckResult = { ok: true } | { ok: false; reason }`.
pub type CheckResult = Result<(), String>;
