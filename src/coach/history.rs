//! Cross-session persistence of the coach conversation.
//!
//! The in-memory chat (`Vec<ChatTurn>`) for a document is mirrored to
//! `…/whetstone/coach-history/<name>-<hash>.json`, keyed by the document's
//! absolute path, so reopening a file restores its coaching thread. The store
//! is per-document: a different file gets a different key and its own history.
//!
//! Scope: this holds the coach dialogue only — the same turns that already live
//! in memory and are sent to the model — not the journal (process events stay
//! metadata-only) and not the draft, except for excerpts the writer themselves
//! quote in their own messages. Files are `0600` on Unix since those messages
//! may carry the writer's prose.

use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

use crate::core::prompts::ChatTurn;

/// The on-disk location for a document's coach history, or `None` when there's
/// no stable key (an empty/new-buffer path) or no resolvable config dir.
fn history_path(doc: &Path) -> Option<PathBuf> {
    if doc.as_os_str().is_empty() {
        return None;
    }
    // `absolute` (unlike `canonicalize`) doesn't require the file to exist yet —
    // whetstone creates the document on first save.
    let abs = std::path::absolute(doc).unwrap_or_else(|_| doc.to_path_buf());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    abs.hash(&mut hasher);
    let key = hasher.finish();
    // A readable stem makes the cache dir browsable; the hash keeps it unique
    // (and collision-free across directories with same-named files).
    let stem = abs.file_name().and_then(|n| n.to_str()).unwrap_or("doc");
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    Some(
        crate::config_dir()?
            .join("whetstone")
            .join("coach-history")
            .join(format!("{safe}-{key:016x}.json")),
    )
}

/// Load the saved conversation for `doc`, or an empty vec if there's none or it
/// can't be read/parsed (a corrupt or stale file must never block opening).
pub fn load(doc: &Path) -> Vec<ChatTurn> {
    history_path(doc)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Mirror `turns` to disk for `doc`. An empty conversation removes the file so
/// a reset leaves nothing behind. No-op (Ok) when there's no stable key.
pub fn save(doc: &Path, turns: &[ChatTurn]) -> io::Result<()> {
    let Some(path) = history_path(doc) else {
        return Ok(());
    };
    if turns.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(turns).map_err(io::Error::other)?;
    std::fs::write(&path, &json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::prompts::ChatTurnRole;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Mutex, MutexGuard, PoisonError};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    /// `XDG_CONFIG_HOME` is process-global; serialize the tests that point it at
    /// a temp dir so they don't observe each other's value.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// A unique temp dir for a test, pointed at by `XDG_CONFIG_HOME` so
    /// `config_dir()` resolves into it. Hold the returned guard for the test's
    /// duration; the dir is returned for cleanup.
    fn temp_config_dir() -> (PathBuf, MutexGuard<'static, ()>) {
        let guard = ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("whetstone-history-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY: the ENV_LOCK guard serializes every env-mutating test in this
        // module, so no other thread here reads the var while we set it.
        unsafe { std::env::set_var("XDG_CONFIG_HOME", &dir) };
        (dir, guard)
    }

    fn turn(role: ChatTurnRole, text: &str) -> ChatTurn {
        ChatTurn {
            role,
            text: text.into(),
        }
    }

    #[test]
    fn turns_round_trip_through_serde() {
        let turns = vec![
            turn(ChatTurnRole::Writer, "is my thesis clear?"),
            turn(ChatTurnRole::Coach, "what is the thesis in one sentence?"),
        ];
        let json = serde_json::to_string(&turns).unwrap();
        assert!(json.contains("\"writer\"") && json.contains("\"coach\""));
        let back: Vec<ChatTurn> = serde_json::from_str(&json).unwrap();
        assert_eq!(turns, back);
    }

    #[test]
    fn empty_path_has_no_history_location() {
        assert!(history_path(Path::new("")).is_none());
    }

    #[test]
    fn distinct_documents_get_distinct_keys() {
        let (dir, _guard) = temp_config_dir();
        let a = history_path(Path::new("essay.qmd")).unwrap();
        let b = history_path(Path::new("notes.qmd")).unwrap();
        assert_ne!(a, b);
        // The same path resolves stably.
        assert_eq!(a, history_path(Path::new("essay.qmd")).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_then_load_restores_conversation() {
        let (dir, _guard) = temp_config_dir();
        let doc = dir.join("paper.qmd");
        let turns = vec![
            turn(ChatTurnRole::Writer, "first message"),
            turn(ChatTurnRole::Coach, "a question back"),
        ];
        save(&doc, &turns).unwrap();
        assert_eq!(load(&doc), turns);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_empty_removes_the_file() {
        let (dir, _guard) = temp_config_dir();
        let doc = dir.join("paper.qmd");
        save(&doc, &[turn(ChatTurnRole::Writer, "hi")]).unwrap();
        assert!(!load(&doc).is_empty());
        // Resetting the conversation clears the on-disk copy too.
        save(&doc, &[]).unwrap();
        assert!(load(&doc).is_empty());
        // Removing an already-absent history is not an error.
        save(&doc, &[]).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_history_loads_empty() {
        let (dir, _guard) = temp_config_dir();
        assert!(load(&dir.join("never-saved.qmd")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
