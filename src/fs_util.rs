//! Crash-safe file writes, shared by the TUI's save/autosave/export paths
//! (`ui::app`) and the headless CLI's journal/export writes (`cli.rs`, in the
//! binary crate). Depends on nothing else in the DAG so both ends can use it.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// Write `bytes` to `path` atomically (a randomly-named temp file in the same
/// directory, then an atomic rename), so a crash mid-write can't truncate the
/// document. The temp file is created with `O_CREAT|O_EXCL` under a random name
/// (via `tempfile::NamedTempFile`), which closes two hazards the old fixed-name
/// `whetstone-tmp` approach had on shared or attacker-writable directories:
///
/// - **Symlink following (CWE-377/59):** a pre-placed `<doc>.whetstone-tmp ->
///   <victim>` symlink would route the document content into `<victim>`. A
///   random, exclusively-created temp name can't be pre-placed.
/// - **Clobbering under overlapping writes:** two concurrent saves/autosaves
///   shared one temp path and could clobber each other's bytes. Random names
///   don't collide, so each write is independent.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use tempfile::NamedTempFile;
    // Create missing parent directories so "Save as notes/draft.qmd" works even
    // when `notes/` doesn't exist yet. Use the parent, or "." for a bare name.
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => {
            std::fs::create_dir_all(p)?;
            p
        }
        _ => Path::new("."),
    };
    // The temp file is created 0600 and `persist` renames it *over* the target,
    // so the temp file's mode becomes the document's mode. Carry the existing
    // permissions across, or a 0644 draft silently turns owner-only on the first
    // save — invisible to the writer, but not to a collaborator, a group-shared
    // submission directory, or a web server. Best-effort: a filesystem that
    // rejects the chmod shouldn't fail the save.
    let existing_perms = std::fs::metadata(path).ok().map(|m| m.permissions());
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    if let Some(perms) = existing_perms {
        let _ = tmp.as_file().set_permissions(perms);
    }
    tmp.as_file().sync_all()?; // durability before the rename
    persist_with_retry(tmp, path)?;
    // fsync the parent directory so the rename (a directory-entry update) is
    // durable too. Without this, a power loss after `persist` returns can roll
    // back the rename on some filesystems, leaving the document at its pre-save
    // content despite the file-data fsync above. Best-effort: a few filesystems
    // (and non-Unix) don't support opening a directory for fsync, and that's
    // fine — the data fsync already did the load-bearing work for the common
    // crash case (process killed mid-write).
    let _ = fsync_dir(parent);
    Ok(())
}

/// Rename the temp file over `path`, retrying briefly on Windows.
///
/// A POSIX rename replaces the target atomically and never fails transiently.
/// Windows has no such guarantee: the replace is refused while anything else
/// holds the target open — another writer mid-rename, an antivirus scanner, the
/// search indexer — so a single attempt turns a routine save into "Save
/// failed". A short bounded retry covers those windows without hiding a real
/// error (a read-only volume still fails, ~200ms later).
fn persist_with_retry(tmp: tempfile::NamedTempFile, path: &Path) -> std::io::Result<()> {
    let attempts = if cfg!(windows) { 10 } else { 1 };
    let mut tmp = tmp;
    for attempt in 1.. {
        match tmp.persist(path) {
            Ok(_) => return Ok(()),
            Err(e) if attempt < attempts => {
                tmp = e.file;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e.error),
        }
    }
    unreachable!("the loop returns on the last attempt")
}

/// Best-effort directory fsync for crash-safe atomic renames (Unix only).
#[cfg(unix)]
fn fsync_dir(path: &Path) -> std::io::Result<()> {
    let f = std::fs::File::open(path)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn fsync_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_concurrent_writes_dont_lose_data() {
        // Regression: the old fixed-name temp (whetstone-tmp) let two
        // overlapping writes clobber each other's temp file, losing ~half the
        // writes and potentially keeping an older snapshot. Random temp names
        // make each write independent — the last rename to land wins, and every
        // write either fully lands or is dropped (no corruption).
        let dir = std::env::temp_dir();
        let path = dir.join("whetstone_atomic_concurrent_test.txt");
        let _ = std::fs::remove_file(&path);
        // Spawn N concurrent writes of distinct payloads; all must report Ok
        // (no temp-clobbering failures), and the final content must be exactly
        // one of the payloads (atomic rename → no corruption).
        let path_clone = path.clone();
        let handles: Vec<_> = (0..20)
            .map(move |i| {
                let p = path_clone.clone();
                std::thread::spawn(move || {
                    let payload = format!("payload-{i}");
                    atomic_write(&p, payload.as_bytes())
                })
            })
            .collect();
        let mut oks = 0;
        for h in handles {
            if h.join().unwrap().is_ok() {
                oks += 1;
            }
        }
        // With random temp names, every write should succeed (no clobbering).
        assert_eq!(oks, 20, "some concurrent writes failed: {oks}/20");
        let final_content = std::fs::read_to_string(&path).unwrap();
        assert!(
            final_content.starts_with("payload-"),
            "final content corrupted: {final_content}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_the_documents_permissions() {
        use std::os::unix::fs::PermissionsExt;
        // The temp file is created 0600 and renamed over the target, so without
        // carrying the mode across, every save quietly makes the document
        // owner-only — invisible until a collaborator can't read it.
        let path = std::env::temp_dir().join("whetstone_atomic_perms_test.txt");
        std::fs::write(&path, "before").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        atomic_write(&path, b"after").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "save changed the document's mode");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn atomic_write_does_not_follow_preplaced_symlink() {
        // Regression (CWE-377/59): the old fixed-name temp meant a pre-placed
        // `<doc>.whetstone-tmp -> <victim>` symlink would route the document
        // content into <victim>. The random, exclusively-created temp name
        // can't be pre-placed, so a victim file at the old temp path is never
        // touched.
        let dir = std::env::temp_dir();
        let doc = dir.join("whetstone_symlink_doc.txt");
        let victim = dir.join("whetstone_symlink_victim.txt");
        let old_temp = dir.join("whetstone_symlink_doc.whetstone-tmp");
        let _ = std::fs::remove_file(&doc);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_file(&old_temp);
        std::fs::write(&victim, "VICTIM-ORIGINAL").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &old_temp).unwrap();
        atomic_write(&doc, b"DOCUMENT-CONTENT").unwrap();
        // The document got its content...
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "DOCUMENT-CONTENT");
        // ...and the victim (and the stale symlink) were NOT touched.
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "VICTIM-ORIGINAL",
            "symlink attack routed document content into the victim"
        );
        let _ = std::fs::remove_file(&doc);
        let _ = std::fs::remove_file(&victim);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&old_temp);
    }
}
