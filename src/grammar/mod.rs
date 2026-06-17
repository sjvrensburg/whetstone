//! Local grammar checking via harper-core (zero external API calls).
//!
//! Wraps harper the way the web composer's `src/grammar/harper.ts` does:
//! markdown-aware lint → a list of diagnostics with char spans + messages +
//! suggestions, rendered as editor underlines.

pub mod harper;

pub use harper::{Diagnostic, Linter, Severity};
