//! Markdown rendering for the terminal.
//!
//! M1 build order here:
//! 1. [`math`] — the vendored `latex_to_unicode` (done).
//! 2. A minimal document model + `pulldown-cmark` parser (with `ENABLE_MATH`)
//!    that emits Unicode-rendered inline/display math.
//! 3. A renderer that turns the model into `ratatui` `Text`/`Line`/`Span`
//!    cells with word-wrap, headings, lists, code, and Quarto `.qmd` cells.

pub mod math;
pub mod render;

pub use math::latex_to_unicode;
pub use render::{frontmatter_claim, render_to_text};
