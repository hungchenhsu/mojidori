//! File watching for auto-reload. Watched paths that change on disk are
//! reported to the frontend via the `mojidori://file-changed` event; deciding
//! whether to reload (and prompting on dirty buffers) is frontend logic.
//!
//! The frontend matches event paths against each tab's path by exact string
//! comparison, but backends don't necessarily report the path that was
//! watched: macOS FSEvents reports the canonical path, so a file opened
//! through a symlink, `/tmp` (really `/private/tmp`), a different letter
//! case, or a decomposed (NFD) name would never match and silently stop
//! auto-reloading (issue #280 investigation). Each watched path is
//! therefore also recorded under its canonical form, and every event is
//! reported both as the backend's raw path and as every originally watched
//! path that canonicalizes to the same file.
//!
//! Scope: this maps whatever events the backend delivers. On Windows,
//! notify's own filter compares the watched path byte-for-byte with the
//! reported on-disk name, so a letter-case variant still drops events
//! before they reach this module. A path through a directory symlink stays
//! pinned to the target it resolved to when watched (as does notify's own
//! FSEvents registration).

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Canonical form of a path -> the path strings the frontend watched it as.
type Aliases = HashMap<PathBuf, Vec<String>>;

pub struct WatcherState {
    watcher: Mutex<RecommendedWatcher>,
    aliases: Arc<Mutex<Aliases>>,
}

/// The key a path is recorded and looked up under: the fully canonical
/// path when it exists; for one that doesn't (a Remove event, or a rename
/// away), the canonical parent joined with the final component, which is
/// what the existing file canonicalized to as long as the name's own
/// spelling matches; otherwise the path unchanged.
fn canonical_key(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = std::fs::canonicalize(parent) {
            return parent.join(name);
        }
    }
    path.to_path_buf()
}

/// Every path string to report for one backend event path: the raw path
/// itself first (the pre-existing behavior), then each watched alias of the
/// same canonical file, without duplicates.
fn report_paths(aliases: &Aliases, event_path: &Path, out: &mut Vec<String>) {
    let raw = event_path.to_string_lossy().into_owned();
    if !out.contains(&raw) {
        out.push(raw);
    }
    if let Some(watched) = aliases.get(&canonical_key(event_path)) {
        for path in watched {
            if !out.contains(path) {
                out.push(path.clone());
            }
        }
    }
}

fn add_alias(aliases: &mut Aliases, path: &str) {
    let entry = aliases.entry(canonical_key(Path::new(path))).or_default();
    if !entry.iter().any(|p| p == path) {
        entry.push(path.to_string());
    }
}

fn remove_alias(aliases: &mut Aliases, path: &str) {
    // Scan rather than recompute the key: the file may have been renamed or
    // deleted since it was watched, so its canonical form today can differ
    // from the one it was recorded under.
    aliases.retain(|_, watched| {
        watched.retain(|p| p != path);
        !watched.is_empty()
    });
}

pub fn init<R: Runtime>(app: AppHandle<R>) -> notify::Result<WatcherState> {
    let aliases: Arc<Mutex<Aliases>> = Arc::default();
    let callback_aliases = Arc::clone(&aliases);
    let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else { return };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let mut paths = Vec::new();
        {
            let aliases = callback_aliases.lock().unwrap();
            for path in &event.paths {
                report_paths(&aliases, path, &mut paths);
            }
        }
        if !paths.is_empty() {
            let _ = app.emit("mojidori://file-changed", paths);
        }
    })?;
    Ok(WatcherState {
        watcher: Mutex::new(watcher),
        aliases,
    })
}

#[tauri::command]
pub fn watch_file(state: State<WatcherState>, path: String) -> Result<(), String> {
    add_alias(&mut state.aliases.lock().unwrap(), &path);
    let result = state
        .watcher
        .lock()
        .unwrap()
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Cannot watch {path}: {e}"));
    if result.is_err() {
        remove_alias(&mut state.aliases.lock().unwrap(), &path);
    }
    result
}

#[tauri::command]
pub fn unwatch_file(state: State<WatcherState>, path: String) {
    remove_alias(&mut state.aliases.lock().unwrap(), &path);
    // Tolerant by design: unwatching a path that is not watched is a no-op.
    let _ = state.watcher.lock().unwrap().unwatch(Path::new(&path));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::temp_path;

    fn reported(aliases: &Aliases, event_path: &Path) -> Vec<String> {
        let mut out = Vec::new();
        report_paths(aliases, event_path, &mut out);
        out
    }

    #[test]
    fn unrelated_event_reports_only_the_raw_path() {
        let aliases = Aliases::new();
        let path = Path::new("/nowhere/at/all.txt");
        assert_eq!(reported(&aliases, path), vec!["/nowhere/at/all.txt"]);
    }

    #[test]
    fn canonical_event_path_maps_back_to_the_watched_spelling() {
        let dir = temp_path("watcher-alias-dir");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Notes.txt");
        std::fs::write(&file, "x").unwrap();
        // A non-canonical spelling of the same file: `dir/./Notes.txt`
        // (plus, on macOS, temp_dir's /var -> /private/var symlink).
        let watched = dir.join(".").join("Notes.txt");
        let watched = watched.to_string_lossy().into_owned();
        let mut aliases = Aliases::new();
        add_alias(&mut aliases, &watched);

        let canonical = std::fs::canonicalize(&file).unwrap();
        let out = reported(&aliases, &canonical);
        assert_eq!(out[0], canonical.to_string_lossy());
        assert!(out.contains(&watched), "{out:?}");

        // Still mapped after the file is deleted (a Remove event).
        std::fs::remove_file(&file).unwrap();
        assert!(reported(&aliases, &canonical).contains(&watched));

        remove_alias(&mut aliases, &watched);
        assert!(aliases.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_watch_receives_events_for_the_target() {
        let dir = temp_path("watcher-alias-link");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real.txt");
        std::fs::write(&target, "x").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let link_str = link.to_string_lossy().into_owned();
        let target_str = target.to_string_lossy().into_owned();
        let mut aliases = Aliases::new();
        add_alias(&mut aliases, &link_str);
        add_alias(&mut aliases, &target_str);
        add_alias(&mut aliases, &link_str); // idempotent

        let canonical = std::fs::canonicalize(&target).unwrap();
        let out = reported(&aliases, &canonical);
        assert!(
            out.contains(&link_str) && out.contains(&target_str),
            "{out:?}"
        );
        assert_eq!(out.iter().filter(|p| **p == link_str).count(), 1);

        // Unwatching one spelling keeps the other.
        remove_alias(&mut aliases, &link_str);
        let out = reported(&aliases, &canonical);
        assert!(
            !out.contains(&link_str) && out.contains(&target_str),
            "{out:?}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn case_variant_watch_maps_on_case_insensitive_volumes() {
        let dir = temp_path("watcher-alias-case");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ReadMe.md");
        std::fs::write(&file, "x").unwrap();
        let variant = dir.join("readme.MD");
        if !variant.exists() {
            // Case-sensitive volume: nothing to map.
            std::fs::remove_dir_all(&dir).unwrap();
            return;
        }
        let variant_str = variant.to_string_lossy().into_owned();
        let mut aliases = Aliases::new();
        add_alias(&mut aliases, &variant_str);
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert!(reported(&aliases, &canonical).contains(&variant_str));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// End to end against the real backend: the frontend watches a file
    /// through a symlink, the target changes, and the reported paths must
    /// include the symlink spelling the frontend compares against. FSEvents
    /// reports the canonical path, so this failed before the alias map.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_watcher_event_through_symlink_reports_the_watched_path() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let dir = temp_path("watcher-alias-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real.txt");
        std::fs::write(&target, "one").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let link_str = link.to_string_lossy().into_owned();

        let mut aliases = Aliases::new();
        add_alias(&mut aliases, &link_str);
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                let _ = tx.send(event.paths);
            }
        })
        .unwrap();
        watcher.watch(&link, RecursiveMode::NonRecursive).unwrap();
        // FSEvents can drop changes made immediately after the stream starts.
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(&target, "two").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        let mut matched = false;
        while Instant::now() < deadline && !matched {
            if let Ok(paths) = rx.recv_timeout(Duration::from_millis(200)) {
                for path in &paths {
                    let mut out = Vec::new();
                    report_paths(&aliases, path, &mut out);
                    matched |= out.contains(&link_str);
                    seen.push(path.clone());
                }
            }
        }
        drop(watcher);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            matched,
            "no event mapped to {link_str}; raw event paths: {seen:?}"
        );
    }

    #[test]
    fn removal_survives_a_file_that_moved_since_it_was_watched() {
        let dir = temp_path("watcher-alias-moved");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let file_str = file.to_string_lossy().into_owned();
        let mut aliases = Aliases::new();
        add_alias(&mut aliases, &file_str);
        std::fs::rename(&file, dir.join("b.txt")).unwrap();
        remove_alias(&mut aliases, &file_str);
        assert!(aliases.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
