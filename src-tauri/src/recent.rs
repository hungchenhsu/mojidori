//! Recently opened files, most recent first, persisted as JSON.

use tauri::{AppHandle, Runtime};

const MAX_RECENT: usize = 20;
const FILE: &str = "recent.json";

/// Move (or insert) `path` to the front, dropping duplicates and clamping
/// the list length.
fn push_recent(mut list: Vec<String>, path: String) -> Vec<String> {
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
    list
}

#[tauri::command]
pub fn load_recent_files<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    crate::store::read_json(&app, FILE).unwrap_or_default()
}

/// Push `path` onto the recent list and persist it. Returns the updated
/// list only if the write landed on disk — a swallowed write error here
/// would hand the frontend a list that evaporates on the next launch
/// (issue #252), so the error propagates and the frontend keeps its last
/// disk-confirmed cache instead.
#[tauri::command]
pub fn add_recent_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Vec<String>, String> {
    let list: Vec<String> = crate::store::read_json(&app, FILE).unwrap_or_default();
    let list = push_recent(list, path);
    crate::store::write_json(&app, FILE, &list)?;
    Ok(list)
}

/// The list `clear_recent_files` persists and returns — always empty,
/// independent of what was there before (unlike `push_recent`, clearing
/// needs no prior content, so `clear_recent_files` never reads the file
/// first). Split out into its own named function purely so "what a clear
/// produces" is unit-testable without an `AppHandle`, the same reason
/// `push_recent` is split out of `add_recent_file`.
fn cleared_list() -> Vec<String> {
    Vec::new()
}

/// Empty the recent list (ROADMAP.md v0.6 C4: File > Clear Recently
/// Opened). Same shape as `add_recent_file`: writes `recent.json` via
/// `store::write_json` and returns the resulting list so the frontend can
/// replace its cached `recentFiles` with the exact value now on disk.
/// The write error propagates rather than being swallowed: a clear the
/// user explicitly asked for that silently didn't reach disk resurrects
/// the whole list on the next launch (issue #252), which the frontend
/// must be able to tell the user about.
#[tauri::command]
pub fn clear_recent_files<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    let list = cleared_list();
    crate::store::write_json(&app, FILE, &list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_existing_entry_to_front() {
        let list = vec!["a".into(), "b".into(), "c".into()];
        let list = push_recent(list, "c".into());
        assert_eq!(list, vec!["c", "a", "b"]);
    }

    #[test]
    fn clamps_to_max_length() {
        let list: Vec<String> = (0..MAX_RECENT).map(|i| i.to_string()).collect();
        let list = push_recent(list, "new".into());
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], "new");
        assert!(!list.contains(&(MAX_RECENT - 1).to_string()));
    }

    #[test]
    fn cleared_list_is_empty() {
        assert!(cleared_list().is_empty());
    }

    /// "Clear then reload": clear_recent_files persists `cleared_list()` via
    /// `store::write_json`; load_recent_files reads it back via
    /// `store::read_json`'s `unwrap_or_default()` fallback. Both are
    /// `AppHandle`-based commands, and this crate has no mock-`AppHandle`
    /// test harness (no `tauri::test` feature enabled — confirmed by
    /// grepping the crate; load_recent_files/add_recent_file are likewise
    /// never called directly in tests, only push_recent is), so this
    /// exercises the exact path-based primitives (`write_json_to_path`/
    /// `read_json_from_path`) those AppHandle wrappers delegate to —
    /// seeded the way add_recent_file's push_recent would have left the
    /// file, same as store.rs's own round-trip test does for its `Sample`
    /// shape.
    #[test]
    fn clear_then_reload_round_trip_is_empty() {
        let dir = crate::testutil::temp_path("mojidori-recent-clear-roundtrip-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);

        let seeded = push_recent(push_recent(Vec::new(), "a.txt".into()), "b.txt".into());
        crate::store::write_json_to_path(&path, &seeded).unwrap();
        assert_eq!(
            crate::store::read_json_from_path::<Vec<String>>(&path).unwrap(),
            seeded
        );

        crate::store::write_json_to_path(&path, &cleared_list()).unwrap();

        let reloaded: Vec<String> = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert!(reloaded.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// "Behavior for a nonexistent file": recent.json (and its parent
    /// directory) has never been created — a fresh install, or a launch
    /// before the first add_recent_file. clear_recent_files's write must
    /// still succeed (write_json_to_path creates the parent dir), and the
    /// subsequent load must see an empty list rather than erroring.
    #[test]
    fn clear_when_recent_json_never_existed_still_reloads_empty() {
        let dir = crate::testutil::temp_path("mojidori-recent-clear-missing-dir-test");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(FILE);

        crate::store::write_json_to_path(&path, &cleared_list())
            .expect("clear must succeed even when recent.json's directory doesn't exist yet");

        let reloaded: Vec<String> = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert!(reloaded.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Per-module corruption regression (ROADMAP.md v0.7 Track V) --------
    //
    // Same rationale as session.rs / prefs.rs's blocks of the same name:
    // `load_recent_files` takes an `AppHandle<R>` this crate cannot mock
    // (no `tauri::test` feature -- see `clear_then_reload_round_trip_is_empty`
    // above), but its entire body is
    // `crate::store::read_json(&app, FILE).unwrap_or_default()`, so
    // `store::read_json_from_path::<Vec<String>>(&path).unwrap_or_default()`
    // against a file named by the real `FILE` const is the deepest testable
    // stand-in for `load_recent_files` itself.

    fn corruption_fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojidori-recent-corrupt-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Scenario 1: a valid recent.json truncated mid-write (issue #62's
    /// failure mode, pinned here against the real `FILE` filename rather
    /// than store.rs's throwaway `Sample`).
    #[test]
    fn truncated_recent_json_loads_as_empty() {
        let dir = corruption_fixture_dir("truncated");
        let path = dir.join(FILE);

        let list = push_recent(push_recent(Vec::new(), "a.txt".into()), "b.txt".into());
        crate::store::write_json_to_path(&path, &list).unwrap();
        let full = std::fs::read(&path).unwrap();
        let half = &full[..full.len() / 2];
        std::fs::write(&path, half).unwrap();

        let loaded: Vec<String> = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert!(loaded.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Scenario 2: syntactically valid JSON array, but of numbers rather
    /// than the path strings `Vec<String>` expects.
    #[test]
    fn wrong_schema_recent_json_loads_as_empty() {
        let dir = corruption_fixture_dir("wrong-schema");
        let path = dir.join(FILE);
        std::fs::write(&path, b"[1, 2, 3]").unwrap();

        let loaded: Vec<String> = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert!(loaded.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Scenario 3: a zero-byte recent.json.
    #[test]
    fn empty_recent_json_loads_as_empty() {
        let dir = corruption_fixture_dir("empty");
        let path = dir.join(FILE);
        std::fs::write(&path, b"").unwrap();

        let loaded: Vec<String> = crate::store::read_json_from_path(&path).unwrap_or_default();
        assert!(loaded.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
