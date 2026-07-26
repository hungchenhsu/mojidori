//! Tiny JSON file store in the app config directory, shared by session,
//! preferences and recent-files persistence.

use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};

fn config_path<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir: {e}"))?;
    Ok(dir.join(file))
}

/// Read and parse JSON at `path`. Any failure — missing file, permission
/// error, or corrupt/truncated JSON (e.g. left behind by a crash mid-write
/// under the old non-atomic writer; see issue #62) — returns `None` rather
/// than an error, so callers can treat "no valid data" uniformly whether
/// the file never existed or exists but is unreadable.
pub fn read_json_from_path<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn read_json<T: DeserializeOwned, R: Runtime>(app: &AppHandle<R>, file: &str) -> Option<T> {
    let path = config_path(app, file).ok()?;
    read_json_from_path(&path)
}

/// Serialize `value` as pretty JSON and write it to `path` atomically
/// (temp file in the same directory, `fsync`, rename, then `fsync` the
/// parent directory too — see `crate::atomic_write`). A crash or power
/// loss mid-write can therefore never leave a half-written/corrupt file at
/// `path`: the rename either hasn't happened yet (old content, or no
/// file, survives) or has already completed (new content is fully on
/// disk) — and, since `atomic_write` also `fsync`s the parent directory
/// after renaming (issue #322), a crash immediately after a successful
/// write can no longer make that rename itself disappear either, which
/// mattered concretely for `session.json`: without it, a crash right
/// after a rename that update it could roll the index back to a stale
/// version, orphaning hot-exit backups the newer index would have
/// referenced. This replaces the previous direct `std::fs::write`, which
/// truncated the destination in place and could leave exactly that
/// half-written file behind on a mid-write crash (issue #62 — this
/// mattered most for `session.json`, since a corrupt index made every
/// hot-exit backup unreachable even though the backup files themselves
/// were intact).
pub fn write_json_to_path<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("Cannot serialize: {e}"))?;
    // Error surfaces name the file, not the full path — these strings can
    // reach dialogs/logs and the config dir location is the user's business.
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    // `atomic_write` now returns a `CommitOutcome` (issues #324/#328) that
    // this JSON store has no use for -- no caller here tracks a staleness
    // baseline for preferences/session/recent-files the way
    // `save_document` does for documents, and a durability warning for
    // these has no user-facing surface to reach either -- so both are
    // discarded.
    crate::atomic_write(path, &json)
        .map(|_outcome| ())
        .map_err(|e| format!("Failed to write {name}: {e}"))
}

pub fn write_json<T: Serialize, R: Runtime>(
    app: &AppHandle<R>,
    file: &str,
    value: &T,
) -> Result<(), String> {
    let path = config_path(app, file)?;
    write_json_to_path(&path, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        name: String,
        count: u32,
    }

    #[test]
    fn write_json_is_atomic_and_survives_reread() {
        let dir = std::env::temp_dir().join("mojidori-store-atomic-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");

        let value = Sample {
            name: "中文 session".into(),
            count: 3,
        };
        write_json_to_path(&path, &value).unwrap();
        let back: Sample = read_json_from_path(&path).unwrap();
        assert_eq!(back, value);

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("mojidori-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files may remain");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #62's failure mode: a truncated, non-JSON file at `path`
    /// (what a mid-write crash under the old `std::fs::write` left behind)
    /// must read back as "no data", not a panic or error. The atomicity
    /// that stops such a file from being *produced* isn't separately
    /// asserted — a `std::fs::write` interruption can't be simulated
    /// deterministically in a unit test; `atomic_write`'s own tests cover
    /// the temp+rename mechanics.
    #[test]
    fn corrupt_json_reads_as_none() {
        let dir = std::env::temp_dir().join("mojidori-store-corrupt-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");

        let value = Sample {
            name: "will be truncated".into(),
            count: 7,
        };
        write_json_to_path(&path, &value).unwrap();

        let full = std::fs::read(&path).unwrap();
        let half = &full[..full.len() / 2];
        std::fs::write(&path, half).unwrap();

        let result: Option<Sample> = read_json_from_path(&path);
        assert!(result.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_json_from_path_missing_file_is_none() {
        let path = std::env::temp_dir().join("mojidori-store-missing-file-does-not-exist.json");
        let _ = std::fs::remove_file(&path);
        let result: Option<Sample> = read_json_from_path(&path);
        assert!(result.is_none());
    }

    /// Issue #252's failure mode: an unwritable config location must
    /// surface as `Err`, not vanish — recent.rs's commands propagate this
    /// to the frontend so a Clear/add that never reached disk is never
    /// reported as success. Simulated by parking a *file* where the
    /// parent directory should be, which fails `create_dir_all`
    /// deterministically on every platform (no chmod, works as root).
    #[test]
    fn write_json_to_path_unwritable_parent_is_err() {
        let blocker = std::env::temp_dir().join("mojidori-store-unwritable-parent-test");
        let _ = std::fs::remove_dir_all(&blocker);
        let _ = std::fs::remove_file(&blocker);
        std::fs::write(&blocker, b"not a directory").unwrap();

        let path = blocker.join("recent.json");
        let value = Sample {
            name: "never lands".into(),
            count: 1,
        };
        let result = write_json_to_path(&path, &value);
        assert!(result.is_err());

        std::fs::remove_file(&blocker).ok();
    }
}
