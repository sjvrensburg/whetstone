//! Rope-backed editor buffer + transaction change sets.
//!
//! The buffer owns the document text and cursor; `transaction` provides
//! position-mapping (`ChangeSet::map_pos`) with CodeMirror-style inclusive
//! boundaries — the foundation for M4's paste-quarantine region tracking.

pub mod buffer;
pub mod quarantine;
pub mod transaction;

pub use buffer::Buffer;
pub use quarantine::{Quarantine, Region};
pub use transaction::{Change, ChangeSet};
