//! Ratatui application shell.

pub mod app;
pub mod menu;
pub mod settings;
#[cfg(any(test, feature = "harness"))]
pub mod testkit;
pub mod theme;

pub use app::{App, draw};
pub use theme::Theme;
