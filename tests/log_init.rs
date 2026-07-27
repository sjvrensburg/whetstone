//! `log::init` sets process-global `OnceLock`s that can't be torn down, so this
//! test lives in its own integration-test binary — separate from the lib unit
//! tests — to avoid leaking an open sink and a temp dir across them. One
//! `init` per binary (the first wins), so the `--log-level off` case has its
//! own binary in `tests/log_level_off.rs`.

use std::fs::File;
use std::io::Read;

use whetstone_tui::log;

#[test]
fn init_writes_header_and_scrubbed_collapsed_messages() {
    let dir = std::env::temp_dir().join(format!("whetstone-log-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let log_path = dir.join("whetstone.log");
    log::init(log_path.to_str(), Some("info"));
    assert_eq!(log::path(), Some(log_path.clone()));
    log::error("multi\nline\ncurrent key sk-abcdefghij1234567890XYZ body");
    let mut content = String::new();
    File::open(&log_path)
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    // Header line + one collapsed, scrubbed message line.
    assert!(content.contains("starting"));
    let err_line = content
        .lines()
        .find(|l| l.contains("ERROR"))
        .expect("an ERROR line was logged");
    assert!(!err_line.contains('\n'));
    assert!(err_line.contains("[redacted]"));
    assert!(!err_line.contains("sk-"));
    // The three source lines collapsed into one record.
    assert!(err_line.contains("multi line current"));
    // Best-effort cleanup; the file handle lives for the process, but this is a
    // dedicated binary so nothing else is affected.
    let _ = std::fs::remove_dir_all(&dir);
}
