//! Companion to `tests/log_init.rs`: `log::init` sets process-global `OnceLock`s
//! that can't be torn down, and the first `init` per binary wins, so the
//! `--log-level off` case gets its own binary.

use whetstone_tui::log;

#[test]
fn init_with_level_off_opens_no_sink_and_advertises_no_path() {
    // `--log-level off` must suppress logging entirely: no sink, no path for
    // the UI to point at, and no file created on disk.
    let dir = std::env::temp_dir().join(format!("whetstone-log-off-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let log_path = dir.join("off.log");
    log::init(log_path.to_str(), Some("off"));
    assert!(!log::has_sink());
    assert_eq!(log::path(), None);
    assert!(!log_path.exists(), "level=off still created a log file");
    let _ = std::fs::remove_dir_all(&dir);
}
