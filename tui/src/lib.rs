//! Whetstone TUI library root.
//!
//! Module dependency DAG (each module depends only on modules above it):
//! ```text
//! core -> service -> coach -> instruments -> editor -> markdown -> ui
//! ```
//! `core` is pure domain logic ported from the web composer
//! (`composer/src/core/`); it has no I/O and no UI/editor dependencies.

pub mod coach;
pub mod core;
pub mod editor;
pub mod grammar;
pub mod instruments;
pub mod markdown;
pub mod ui;
