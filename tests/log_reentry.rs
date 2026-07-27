//! `log::init` is process-global and first-call-wins. This binary verifies the
//! re-entry guard blocks a *second* call even when the first took an early
//! return (here `--log-level off`): a later `init` with a real path must not
//! open a sink or advertise a path — otherwise the UI would point at a log that
//! is never written. Lives in its own binary because `init`'s `OnceLock`s can't
//! be torn down.

use whetstone_tui::log;

#[test]
fn second_init_after_off_is_ignored() {
    let log_path =
        std::env::temp_dir().join(format!("whetstone-log-reentry-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&log_path);

    // First call wins: level=off suppresses logging entirely (no sink, no path).
    log::init(log_path.to_str(), Some("off"));
    assert!(!log::has_sink());
    assert_eq!(log::path(), None);

    // A second call — even with a real path and level=info — must be ignored.
    // Before the fix the guard keyed on SINK, which the Off path never sets, so
    // this reopened a sink while LEVEL stayed Off: has_sink() became true (so the
    // status bar said "see log") yet path() was None and nothing was written.
    log::init(log_path.to_str(), Some("info"));
    assert!(
        !log::has_sink(),
        "second init opened a sink despite level=off"
    );
    assert_eq!(log::path(), None, "second init advertised a log path");
    assert!(!log_path.exists(), "second init created a log file");
}
