//! Ratatui application shell.

pub mod app;
pub mod menu;
pub mod settings;
pub mod theme;

pub use app::{App, draw};
pub use theme::Theme;
