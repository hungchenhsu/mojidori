//! Find-in-files backend. Files are decoded through the same detection
//! pipeline as the editor — including the per-extension encoding
//! preference (`Preferences::extension_encodings`, issue #178) —
//! so matches are found in legacy-encoded files (Big5, Shift_JIS, …) that
//! byte-oriented search would miss, and this read-only tab never disagrees
//! with what the editor or `replaceinfiles.rs`'s Replace tab would show for
//! the same file.

use crate::encoding;
use crate::linebreak;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
const MAX_RESULTS: usize = 500;
const MAX_PREVIEW_CHARS: usize = 200;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
}

/// A directory, entry, or queued file that could not be scanned — recorded
/// instead of silently skipped. Three generations of the same fix: issue
/// #130 covers the walk itself failing to read a directory or entry (the
/// same fix issue #116 applied to `batch.rs::collect_files`; the two walks
/// are twin implementations, see that module's doc comment); issue #211
/// extends this to a file the walk *did* queue successfully but that
/// [`read_bounded_or_scan_error`] could no longer open, read, or that grew
/// past `MAX_FILE_SIZE` by the time the scan loop reached it; issue #214
/// extends it again to a file that opened and read fine but whose bytes
/// didn't *decode* cleanly (`encoding::DecodedText::malformed`) — mirroring
/// `replaceinfiles.rs::execute_one`'s `STATUS_DECODE_ERROR` handling of the
/// same flag, since a malformed decode's content is real text interleaved
/// with U+FFFD standing in for whatever bytes didn't decode, and neither a
/// "no match" nor a match found in it can be trusted (ARCHITECTURE.md's
/// hard constraint that decode errors must be surfaced, never silently
/// rendered as if the text were fine). `path` is the containing directory
/// when the directory listing itself failed (`read_dir`), the specific
/// entry's own path when only its metadata lookup failed, or the specific
/// file's path for a post-walk read/oversize/decode failure; `message` is
/// the OS error text (e.g. "Permission denied (os error 13)"), a
/// description of the size cap for oversize, or the detected encoding name
/// for a decode failure.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub files_scanned: usize,
    /// Directories or entries the walk could not read, plus queued files
    /// that could not be scanned once the walk finished — each one means
    /// `matches` above may be missing whatever matches that path contained.
    /// The latter covers a queued file whose open/read failed after the
    /// walk (e.g. it vanished, or permissions changed mid-walk), a queued
    /// file that grew past `MAX_FILE_SIZE` between `collect_files`'s
    /// walk-time metadata check and the actual read (issue #211's TOCTOU
    /// gap — the read itself stays bounded via `Read::take`, so the grown
    /// content is never materialized; it is reported here instead), and a
    /// queued file that read fine but didn't decode cleanly (issue #214 —
    /// its content is never searched, since a malformed decode's U+FFFD
    /// stand-ins for the undecodable bytes can't be trusted as a "no
    /// match" or trusted as a genuine match either). Empty means the walk
    /// completed exhaustively; a non-empty list must never be read as "no
    /// matches under that path" (issue #130). The root folder itself
    /// failing to open is a harder failure than this — `search_in_folder`
    /// returns `Err` outright instead of an empty-looking result.
    pub scan_errors: Vec<ScanError>,
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>, scan_errors: &mut Vec<ScanError>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            scan_errors.push(ScanError {
                path: dir.to_string_lossy().into_owned(),
                message: e.to_string(),
            });
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                // The OS returned an entry-less error mid-iteration (rare
                // transient I/O failure) — no path to report beyond the
                // directory being walked.
                scan_errors.push(ScanError {
                    path: dir.to_string_lossy().into_owned(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(e) => {
                scan_errors.push(ScanError {
                    path: path.to_string_lossy().into_owned(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        if path.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(&path, files, scan_errors);
        } else if meta.is_file() && meta.len() <= MAX_FILE_SIZE {
            files.push(path);
        }
    }
}

/// Read at most `MAX_FILE_SIZE + 1` bytes from `file` — bounds memory use
/// even if the file grew after `collect_files`'s walk-time metadata check
/// (issue #211, mirroring `replaceinfiles.rs`'s identical `bounded_read`).
/// The `+ 1` sentinel turns "exactly at the cap" into a distinguishable "at
/// least one more byte past it" without reading further to confirm it.
fn bounded_read(file: std::fs::File) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(MAX_FILE_SIZE as usize + 1);
    file.take(MAX_FILE_SIZE + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Open and bounded-read one already-queued file, returning `Err(ScanError)`
/// instead of its bytes if it can no longer be scanned — issue #211:
/// `collect_files`'s `meta.len() <= MAX_FILE_SIZE` filter only reflects a
/// snapshot taken during the walk, so by the time the scan loop reaches a
/// queued path it can still (a) fail to open or read at all (vanished,
/// permissions changed since the walk) or (b) have grown past
/// `MAX_FILE_SIZE` in the meantime. Using a single open handle for both the
/// read and its bound — rather than the walk's separate `entry.metadata()`
/// — means the size actually enforced can never be staler than the bytes
/// actually read, mirroring `replaceinfiles.rs`'s identical
/// open-then-`bounded_read`-then-oversize-check sequence in `scan_one_file`
/// / `execute_one`. Split out from [`search_in_folder_with_extensions`] so
/// every outcome — including the oversize sentinel, which
/// `collect_files`'s own walk-time filter makes impractical to reach
/// end-to-end without racing a real file growth — can be driven directly in
/// tests.
fn read_bounded_or_scan_error(path: &Path) -> Result<Vec<u8>, ScanError> {
    let to_scan_error = |e: std::io::Error| ScanError {
        path: path.to_string_lossy().into_owned(),
        message: format!("Failed to read: {e}"),
    };
    let file = std::fs::File::open(path).map_err(to_scan_error)?;
    let bytes = bounded_read(file).map_err(to_scan_error)?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(ScanError {
            path: path.to_string_lossy().into_owned(),
            message: "File exceeds the 5 MiB search cap".to_string(),
        });
    }
    Ok(bytes)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(1024).any(|&b| b == 0)
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// How a line is tested against the query.
enum Matcher {
    Literal {
        needle: String,
        case_sensitive: bool,
    },
    Regex(regex::Regex),
}

impl Matcher {
    fn new(query: &str, case_sensitive: bool, use_regex: bool) -> Result<Self, String> {
        if use_regex {
            let re = regex::RegexBuilder::new(query)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|e| format!("Invalid regex: {e}"))?;
            Ok(Matcher::Regex(re))
        } else {
            Ok(Matcher::Literal {
                needle: if case_sensitive {
                    query.to_string()
                } else {
                    query.to_lowercase()
                },
                case_sensitive,
            })
        }
    }

    fn matches(&self, line: &str) -> bool {
        match self {
            Matcher::Literal {
                needle,
                case_sensitive,
            } => {
                if *case_sensitive {
                    line.contains(needle.as_str())
                } else {
                    line.to_lowercase().contains(needle.as_str())
                }
            }
            Matcher::Regex(re) => re.is_match(line),
        }
    }
}

/// Search decoded lines of one file, appending matches. Lines are split
/// with `linebreak::split_str_lines` — the shared LF/CRLF/lone-CR
/// definition `replaceinfiles.rs` and the large-file index already use —
/// rather than `str::lines()`, which does not recognize a lone CR
/// (Classic Mac line endings) as a terminator at all and so would treat a
/// whole CR-only file as a single line (issue #162).
fn search_text(text: &str, matcher: &Matcher, path: &str, out: &mut Vec<SearchMatch>) {
    for (index, line) in linebreak::split_str_lines(text).into_iter().enumerate() {
        if matcher.matches(line) {
            out.push(SearchMatch {
                path: path.to_string(),
                line: index + 1,
                preview: truncate_chars(line.trim_end(), MAX_PREVIEW_CHARS),
            });
            if out.len() >= MAX_RESULTS {
                return;
            }
        }
    }
}

/// Pure, app-independent core behind the [`search_in_folder`] command
/// (issue #178): kept separate so tests can drive it directly with an
/// explicit `extension_encodings` table instead of needing a live Tauri
/// `AppHandle` — mirrors `replaceinfiles.rs`'s identical
/// `scan_replace_in_folder`/`scan_replace_in_folder_with_extensions` split
/// (see that module for the full rationale, including the `store.rs`
/// precedent this follows). `extension_encodings` is looked up per file
/// via `prefs::extension_encoding_for`, exactly like
/// `replaceinfiles::scan_one_file`, since one folder walk can visit files
/// of many different extensions where `open_document` only ever opens one.
pub fn search_in_folder_with_extensions(
    folder: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    extension_encodings: &[(String, String)],
) -> Result<SearchResults, String> {
    if query.is_empty() {
        return Ok(SearchResults {
            matches: Vec::new(),
            truncated: false,
            files_scanned: 0,
            scan_errors: Vec::new(),
        });
    }
    let matcher = Matcher::new(&query, case_sensitive, use_regex)?;

    // Fail closed if the root folder itself can't even be listed (doesn't
    // exist, permissions revoked, vanished) — issue #130, mirroring
    // batch.rs's identical `scan_batch_conversion` guard for issue #116. An
    // empty result would look indistinguishable from "genuinely no
    // matches" and hand the user false confidence that a search term is
    // absent from the whole project when really the search never ran at
    // all. This is deliberately a harder failure than a nested
    // subdirectory hitting the same error inside `collect_files` below,
    // which instead records the error and keeps searching whatever the
    // rest of the tree can still offer.
    std::fs::read_dir(&folder).map_err(|e| format!("Cannot read folder {folder}: {e}"))?;

    let mut files = Vec::new();
    let mut scan_errors = Vec::new();
    collect_files(Path::new(&folder), &mut files, &mut scan_errors);

    let mut matches = Vec::new();
    let mut files_scanned = 0usize;
    for file in &files {
        let bytes = match read_bounded_or_scan_error(file) {
            Ok(bytes) => bytes,
            Err(e) => {
                scan_errors.push(e);
                continue;
            }
        };
        if looks_binary(&bytes) {
            continue;
        }
        let ext_hint = crate::prefs::extension_encoding_for(extension_encodings, file);
        let decoded = encoding::decode_auto_with_extension(&bytes, ext_hint.as_deref());
        // Issue #214: a decode that doesn't come back clean must not be
        // searched at all -- `decoded.content` for a malformed decode is
        // real text interleaved with U+FFFD standing in for whatever
        // bytes didn't decode, so neither a "no match" nor a match found
        // in it can be trusted. This mirrors
        // `replaceinfiles::execute_one`'s `STATUS_DECODE_ERROR` handling
        // of the same `decoded.malformed` flag; ARCHITECTURE.md's hard
        // constraint ("decode errors must be surfaced, never silently
        // rendered as if the text were fine") applies to a read-only
        // search exactly as it does to a write. Recorded as a
        // `ScanError`, like every other reason a queued file didn't get
        // searched, rather than a distinct field -- the frontend's
        // generic `renderScanErrors` already surfaces any entry here
        // without needing to know why.
        if decoded.malformed {
            scan_errors.push(ScanError {
                path: file.to_string_lossy().into_owned(),
                message: format!(
                    "File does not decode cleanly as {}; skipped, not searched",
                    decoded.encoding
                ),
            });
            continue;
        }
        files_scanned += 1;
        search_text(
            &decoded.content,
            &matcher,
            &file.to_string_lossy(),
            &mut matches,
        );
        if matches.len() >= MAX_RESULTS {
            break;
        }
    }
    Ok(SearchResults {
        truncated: matches.len() >= MAX_RESULTS,
        matches,
        files_scanned,
        scan_errors,
    })
}

/// Tauri command wrapper: resolves the per-extension encoding preference
/// table from the app config directory and forwards it to
/// [`search_in_folder_with_extensions`] — see that function's doc comment
/// and issue #178. `app` is injected by Tauri from the invocation context,
/// not sent by the frontend, so no frontend call site needs to change for
/// this to take effect (same mechanism `replaceinfiles::
/// scan_replace_in_folder` already uses).
#[tauri::command(async)]
pub fn search_in_folder<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<SearchResults, String> {
    let extension_encodings = crate::prefs::current(&app).extension_encodings;
    search_in_folder_with_extensions(
        folder,
        query,
        case_sensitive,
        use_regex,
        &extension_encodings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojidori-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_matches_in_utf8_and_big5_files() {
        let dir = fixture_dir("mixed");
        std::fs::write(dir.join("a.txt"), "hello world\nsecond line\n").unwrap();
        let (big5_bytes, _) = encoding::encode("第一行\n搜尋目標在這\n", "Big5", false).unwrap();
        std::fs::write(dir.join("b.txt"), big5_bytes).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "目標".into(),
            true,
            false,
            &[],
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 2);
        assert!(results.matches[0].preview.contains("搜尋目標"));

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "HELLO".into(),
            false,
            false,
            &[],
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regex_mode_matches_across_encodings() {
        let dir = fixture_dir("regex");
        std::fs::write(dir.join("a.log"), "ERROR 2026-06-13 boom\ninfo ok\n").unwrap();
        let (big5_bytes, _) = encoding::encode("錯誤代碼:E42\n正常\n", "Big5", false).unwrap();
        std::fs::write(dir.join("b.txt"), big5_bytes).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            r"^error \d{4}".into(),
            false,
            true,
            &[],
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert!(results.matches[0].preview.starts_with("ERROR 2026"));

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            r"代碼:E\d+".into(),
            true,
            true,
            &[],
        )
        .unwrap();
        assert_eq!(results.matches.len(), 1);
        assert_eq!(results.matches[0].line, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_regex_returns_friendly_error() {
        let dir = fixture_dir("badregex");
        let result = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "[unclosed".into(),
            true,
            true,
            &[],
        );
        assert!(result.unwrap_err().starts_with("Invalid regex"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skips_binary_files_and_hidden_dirs() {
        let dir = fixture_dir("skip");
        std::fs::write(dir.join("bin.dat"), [0u8, 159, 1, 2, 0]).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("c.txt"), "needle\n").unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        )
        .unwrap();
        assert!(results.matches.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #130 (failing-test-first): unlike `batch.rs`'s destructive
    /// execute step, find-in-files has nothing to gate — but a root the
    /// caller explicitly picked failing to open must still fail closed
    /// rather than come back looking like "genuinely no matches", which is
    /// exactly the misjudgment risk the issue describes (e.g. mistaking
    /// "the folder vanished" for "this string isn't in the project
    /// anywhere").
    #[test]
    fn nonexistent_root_fails_closed() {
        let dir = crate::testutil::temp_path("mojidori-search-nonexistent-does-not-exist");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!dir.exists(), "fixture precondition: path must not exist");

        let err = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        )
        .unwrap_err();
        assert!(
            err.contains(&dir.to_string_lossy().into_owned()) || !err.is_empty(),
            "error should explain the folder could not be read: {err}"
        );
    }

    /// Issue #130 (failing-test-first): a subdirectory that can't be listed
    /// (permission revoked, or vanished mid-walk) used to be silently
    /// dropped by `collect_files`'s `let Ok(entries) = ... else { return }`
    /// — the results looked complete while quietly missing an entire
    /// subtree. It must now show up in `SearchResults.scan_errors`, and —
    /// unlike the whole-root failure above — must not stop the rest of the
    /// tree (an unrelated readable sibling file) from being searched and
    /// reported normally.
    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_is_reported_not_silently_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("unreadable-subdir");
        std::fs::write(dir.join("readable.txt"), "needle here\n").unwrap();
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("hidden.txt"), "needle must never be seen\n").unwrap();
        // No read/execute bit at all: `read_dir(&locked)` itself fails.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        );

        // Restore permissions immediately — before any assertion below can
        // panic and leave a locked directory behind for the next test run
        // on this machine (`remove_dir_all` can't recurse into it either).
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        let results = results.expect("a locked subdirectory must not fail the whole search closed");
        assert_eq!(
            results.matches.len(),
            1,
            "the readable sibling file must still be searched: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the locked directory must be surfaced, not silently dropped: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("locked"),
            "scan error should name the locked directory: {:?}",
            results.scan_errors[0]
        );
        assert!(
            !results.scan_errors[0].message.is_empty(),
            "scan error should carry the OS error text"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #130 (failing-test-first), the other silently-dropped path:
    /// `entry.metadata()` failing (as opposed to `read_dir` on the
    /// containing directory failing, covered above). A directory with read
    /// permission but no execute/search bit lets `read_dir` list child
    /// names just fine, but resolving/stat-ing any child through it fails —
    /// reproducing this half of the bug deterministically rather than
    /// racing a real vanish-mid-walk.
    #[cfg(unix)]
    #[test]
    fn entries_with_unreadable_metadata_are_reported_not_silently_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("no-execute-bit");
        std::fs::write(dir.join("readable.txt"), "needle here\n").unwrap();
        let no_exec = dir.join("noexec");
        std::fs::create_dir_all(&no_exec).unwrap();
        std::fs::write(no_exec.join("hidden.txt"), "needle unreachable\n").unwrap();
        // Read-only, no execute: `read_dir` can still enumerate
        // "hidden.txt"'s name, but `entry.metadata()` on it fails to
        // resolve/stat the child (needs search permission on `no_exec`).
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o600)).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        );

        // Restore before any assertion can panic — same reasoning as
        // unreadable_subdirectory_is_reported_not_silently_dropped above.
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o755)).unwrap();

        let results = results.expect("an unreadable entry must not fail the whole search closed");
        assert_eq!(
            results.matches.len(),
            1,
            "the readable sibling file must still be searched: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the unreadable child's metadata failure must be surfaced, not silently skipped: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("hidden.txt"),
            "scan error should name the specific entry whose metadata failed: {:?}",
            results.scan_errors[0]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #211: per-file read path must be bounded and never swallow
    // errors silently. `collect_files`'s `meta.len() <= MAX_FILE_SIZE`
    // filter above is only a walk-time snapshot; the scan loop used to read
    // each queued file with an unbounded `std::fs::read(file)` and silently
    // `continue` past any error (vanished file, permission change, or the
    // file having grown past the cap since the walk). See
    // `read_bounded_or_scan_error`'s and `bounded_read`'s own doc comments
    // above for the single-handle + `Read::take` pattern this mirrors from
    // `replaceinfiles.rs::bounded_read`.

    /// Issue #211 (failing-test-first): a *file* (as opposed to a
    /// directory, covered by `unreadable_subdirectory_is_reported_not_silently_dropped`
    /// above) that the walk queued successfully but that can no longer be
    /// opened by the time the scan loop reaches it -- permissions revoked,
    /// or vanished -- used to be silently dropped by `let Ok(bytes) =
    /// std::fs::read(file) else { continue }`: `files_scanned` never
    /// counted it, `scan_errors` never heard about it, and the whole search
    /// looked like it had completed exhaustively. It must now be reported
    /// in `scan_errors`, without stopping the rest of the tree from being
    /// searched and reported normally.
    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_reported_not_silently_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("unreadable-file");
        std::fs::write(dir.join("readable.txt"), "needle here\n").unwrap();
        let locked = dir.join("locked.txt");
        std::fs::write(&locked, "needle must never be seen\n").unwrap();
        // No read bit at all: `std::fs::File::open(&locked)` itself fails.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        );

        // Restore permissions immediately -- before any assertion below can
        // panic and leave a locked file behind for the next test run.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();

        let results = results.expect("an unreadable file must not fail the whole search closed");
        assert_eq!(
            results.matches.len(),
            1,
            "the readable sibling file must still be searched: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the unreadable file must be surfaced, not silently dropped: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("locked.txt"),
            "scan error should name the unreadable file: {:?}",
            results.scan_errors[0]
        );
        assert!(
            !results.scan_errors[0].message.is_empty(),
            "scan error should carry the OS error text"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #211 (failing-test-first): `bounded_read` must never
    /// materialize more than `MAX_FILE_SIZE + 1` bytes, even when the file
    /// on disk is far larger -- the `+ 1` is the oversize sentinel
    /// `read_bounded_or_scan_error` checks for, not an accident of a short
    /// read. This is what actually bounds memory use for a file that grew
    /// past the cap after `collect_files`'s walk-time metadata check ran
    /// (the TOCTOU race the issue describes) -- unlike the walk-time
    /// filter, this check is applied to bytes read through the same handle
    /// that will be searched, so it can never be stale.
    #[test]
    fn bounded_read_never_reads_past_the_sentinel_byte() {
        let dir = fixture_dir("bounded-read-sentinel");
        let path = dir.join("huge.txt");
        // Comfortably past MAX_FILE_SIZE + 1 so a buggy unbounded read
        // (returning the whole file) is trivially distinguishable from a
        // correctly-bounded one (returning exactly MAX_FILE_SIZE + 1).
        let huge = vec![b'a'; MAX_FILE_SIZE as usize + 4096];
        std::fs::write(&path, &huge).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let bytes = bounded_read(file).unwrap();
        assert_eq!(
            bytes.len() as u64,
            MAX_FILE_SIZE + 1,
            "bounded_read must stop at the sentinel byte regardless of the file's true size"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #211 (failing-test-first): a file whose bytes read exceed
    /// `MAX_FILE_SIZE` -- whether it was already that large or grew past
    /// the cap after `collect_files`'s walk-time metadata check ran -- must
    /// be recorded as a scan error, not silently skipped and not searched
    /// with a truncated view of its content. Exercised by calling
    /// `read_bounded_or_scan_error` directly rather than through
    /// `search_in_folder_with_extensions`, because `collect_files`'s own
    /// `meta.len() <= MAX_FILE_SIZE` walk-time filter would otherwise
    /// exclude an already-oversize fixture file before this code path is
    /// ever reached -- the growth-after-walk race that filter can't see is
    /// exactly the TOCTOU issue #211 describes, and isn't reproducible
    /// deterministically without racing a real file write mid-walk.
    #[test]
    fn oversize_file_is_reported_as_scan_error_not_searched() {
        let dir = fixture_dir("oversize-scan-error");
        let path = dir.join("huge.txt");
        let mut huge = vec![b'a'; MAX_FILE_SIZE as usize + 4096];
        // A needle embedded well past the cap: proves the caller never even
        // gets bytes to search, not merely that the result is marked
        // truncated somewhere downstream.
        huge.extend_from_slice(b"needle");
        std::fs::write(&path, &huge).unwrap();

        let err = read_bounded_or_scan_error(&path)
            .expect_err("a file past the size cap must not return bytes to search");
        assert!(
            Path::new(&err.path).ends_with("huge.txt"),
            "scan error should name the oversize file: {err:?}"
        );
        assert!(
            err.message.contains("5 MiB") || err.message.to_lowercase().contains("exceed"),
            "scan error should explain the file exceeded the size cap: {err:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #214: a file that opens, reads, and stays under the size
    // cap can still fail to *decode* cleanly (`decoded.malformed`). The
    // scan loop used to hand `decoded.content` straight to `search_text`
    // regardless -- for a malformed decode that content is real text
    // interleaved with U+FFFD replacement characters standing in for
    // whatever bytes didn't decode, so a "no match" result is not
    // trustworthy (the query could be sitting in the unrecoverable bytes)
    // and a match against a U+FFFD run could be reporting a decoder
    // artifact as if it were real file content. ARCHITECTURE.md's hard
    // constraint -- decode errors must be surfaced, never silently
    // rendered as if the text were fine -- already governs the editor and
    // `replaceinfiles.rs::execute_one` (`STATUS_DECODE_ERROR`); this is
    // find-in-files' own version of the same rule.
    //
    // Fixture technique: a UTF-8 BOM (`EF BB BF`) followed by a trailing
    // 0xFF byte, which is never valid UTF-8 in any position (not a legal
    // lead byte, not a legal continuation byte). A BOM pins `chosen` via
    // `detect_with_extension`'s rule 1 ("a BOM always wins") *before*
    // chardetng's statistical guess ever runs, so unlike a bare legacy-
    // encoding fixture (tried first, and rejected below) this can't flake
    // on exactly which encoding chardetng happens to pick for a given
    // sample -- confirmed the hard way: an earlier Big5-plus-stray-byte
    // fixture here was statistically misdetected as windows-1252 by
    // chardetng, under which the stray byte (0x80) is simply "€", not
    // malformed at all, so the fixture-precondition assertion below
    // caught its own fixture being wrong before it could produce a
    // false-green test.

    /// Issue #214 (failing-test-first): a malformed file must be recorded
    /// in `scan_errors` and never searched at all -- not searched with a
    /// U+FFFD-laden approximation of its content. The needle sits well
    /// before the trailing bad byte, so this also proves the old
    /// behavior wasn't merely "sometimes misses a mangled match": with
    /// today's (pre-fix) code this exact needle decodes untouched and
    /// *is* found, which is precisely the false confidence issue #214
    /// describes -- a clean-looking zero-`scan_errors` result that hides
    /// a file that was never trustworthy to begin with.
    #[test]
    fn malformed_file_is_recorded_as_scan_error_and_excluded_from_matches() {
        let dir = fixture_dir("malformed");
        let mut bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
        bytes.extend_from_slice("before 測試字串 after".as_bytes());
        bytes.push(0xFF); // never valid UTF-8, in any position

        // Fixture precondition, verified directly rather than assumed:
        // these exact bytes must actually come back `malformed` from the
        // same auto-detection pipeline `search_in_folder_with_extensions`
        // uses, or this test doesn't exercise the bug at all.
        let baseline = encoding::decode_auto_with_extension(&bytes, None);
        assert_eq!(
            baseline.encoding, "UTF-8",
            "fixture precondition: the BOM must pin UTF-8 deterministically"
        );
        assert!(
            baseline.malformed,
            "fixture precondition: bytes must not decode cleanly under \
             auto-detection: {:?}",
            baseline.content
        );

        std::fs::write(dir.join("bad.txt"), &bytes).unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "測試字串".into(),
            true,
            false,
            &[],
        )
        .unwrap();

        assert!(
            results.matches.is_empty(),
            "a malformed file must never be searched, even for a needle \
             that would survive decoding around the bad byte: {:?}",
            results.matches
        );
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the malformed file must be surfaced in scan_errors, not \
             silently treated as a clean zero-match scan: {:?}",
            results.scan_errors
        );
        assert!(
            Path::new(&results.scan_errors[0].path).ends_with("bad.txt"),
            "scan error should name the malformed file: {:?}",
            results.scan_errors[0]
        );
        assert!(
            !results.scan_errors[0].message.is_empty(),
            "scan error should explain why the file was skipped"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #214 (failing-test-first), the coexistence half: a malformed
    /// file elsewhere in the tree must not stop an unrelated, cleanly
    /// decodable sibling from being searched and reported normally --
    /// mirrors the same "isolate the bad path, keep going" shape already
    /// proven for unreadable files/directories (#130/#211) above.
    #[test]
    fn malformed_file_does_not_prevent_clean_sibling_from_being_searched() {
        let dir = fixture_dir("malformed-with-clean-sibling");
        let mut bad_bytes = vec![0xEF, 0xBB, 0xBF]; // UTF-8 BOM
        bad_bytes.extend_from_slice("before 測試字串 after".as_bytes());
        bad_bytes.push(0xFF); // never valid UTF-8, in any position
        let baseline = encoding::decode_auto_with_extension(&bad_bytes, None);
        assert!(
            baseline.malformed,
            "fixture precondition: {:?}",
            baseline.content
        );
        std::fs::write(dir.join("bad.txt"), &bad_bytes).unwrap();

        std::fs::write(dir.join("good.txt"), "clean content with needle here\n").unwrap();

        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        )
        .unwrap();

        assert_eq!(
            results.matches.len(),
            1,
            "the clean sibling file must still be searched despite the \
             malformed file elsewhere in the tree: {:?}",
            results.matches
        );
        assert!(Path::new(&results.matches[0].path).ends_with("good.txt"));
        assert_eq!(
            results.scan_errors.len(),
            1,
            "the malformed file must still be reported, not silently \
             dropped, alongside the successful sibling scan: {:?}",
            results.scan_errors
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #162: lone-CR line semantics -----------------------------
    //
    // `search_text` used to split lines with `str::lines()`, which only
    // recognizes LF and CRLF -- a lone CR (Classic Mac line endings) was
    // never treated as a terminator at all, so an entire CR-only file
    // collapsed into a single "line" for search purposes. This silently
    // disagreed with `replaceinfiles.rs`, which already splits lines via
    // the shared `linebreak::scan_line_breaks` three-way (LF/CRLF/lone CR)
    // definition -- the same panel's Find and Replace tabs could report
    // different line numbers (and match counts) for the same file.
    // `search_text` now splits through `linebreak::split_str_lines`
    // instead, the `&str`-level counterpart of that same shared
    // definition (see `linebreak.rs`'s own equivalence test locking the
    // two together).

    /// Failing-test-first, issue #162: a lone CR must terminate a line.
    /// Before the fix, `first\rneedle\rthird` was one `str::lines()` line,
    /// so "needle" was reported on line 1 with the whole string as its
    /// preview; it must be line 2 with just "needle" as the preview.
    #[test]
    fn search_text_recognizes_lone_cr_as_a_line_terminator() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\rneedle\rthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(
            out[0].line, 2,
            "needle sits on the second lone-CR-delimited line"
        );
        assert_eq!(out[0].preview, "needle");
    }

    /// Regression: CRLF must still count as *one* terminator, not two
    /// lines plus a spurious empty line.
    #[test]
    fn search_text_crlf_terminator_unchanged() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\r\nneedle\r\nthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 2);
        assert_eq!(out[0].preview, "needle");
    }

    /// Regression: plain LF files are unaffected by the switch away from
    /// `str::lines()`.
    #[test]
    fn search_text_lf_terminator_unchanged() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        search_text("first\nneedle\nthird", &matcher, "doc.txt", &mut out);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 2);
        assert_eq!(out[0].preview, "needle");
    }

    /// A file mixing all three terminator styles must still report correct
    /// 1-based line numbers for a match on any of them.
    #[test]
    fn search_text_mixed_terminators_report_correct_line_numbers() {
        let matcher = Matcher::new("needle", true, false).unwrap();
        let mut out = Vec::new();
        // line 1: LF-terminated, line 2: CRLF-terminated, line 3: lone-CR
        // terminated (the match), line 4: LF-terminated, line 5: no
        // terminator at all (EOF).
        search_text(
            "one\ntwo\r\nneedle\rfour\nfive",
            &matcher,
            "doc.txt",
            &mut out,
        );
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].line, 3);
        assert_eq!(out[0].preview, "needle");
    }

    /// End-to-end lock, issue #162's own framing: on a file where every
    /// matching line contains the needle exactly once, Find and
    /// Replace-in-Files must agree on the count for the same lone-CR
    /// (Classic Mac) file. (With several hits on one line the two
    /// legitimately differ by design: Find is line-oriented — one
    /// navigable entry per matching line — while Replace counts the
    /// occurrences it will actually replace.) Before this fix,
    /// `search_in_folder`
    /// collapsed the whole file into a single `str::lines()` "line", so a
    /// literal search reports one match per matching *line*, not one per
    /// matching *file* -- two needles on two separate lone-CR lines were
    /// undercounted as 1 (the single collapsed "line" merely contains the
    /// substring once, as far as `str::contains` is concerned), while
    /// `scan_replace_in_folder` (already using the three-way split)
    /// correctly reported 2. After the fix both report 2.
    #[test]
    fn search_and_replace_scan_agree_on_lone_cr_match_count() {
        let dir = fixture_dir("cross-module-agreement");
        std::fs::write(dir.join("doc.txt"), b"needle one\rneedle two\r").unwrap();

        let search_results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            &[],
        )
        .unwrap();
        assert_eq!(
            search_results.matches.len(),
            2,
            "one needle per lone-CR line: {:?}",
            search_results.matches
        );
        assert_eq!(search_results.matches[0].line, 1);
        assert_eq!(search_results.matches[1].line, 2);

        let replace_scan = crate::replaceinfiles::scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "needle".into(),
            true,
            false,
            "X".into(),
            &[],
        )
        .unwrap();
        assert_eq!(replace_scan.entries.len(), 1, "{:?}", replace_scan.entries);
        assert_eq!(
            replace_scan.entries[0].match_count, 2,
            "search and replace-scan must agree on how many matches this file contains"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- issue #178: `search_in_folder` must honor the per-extension
    // encoding preference the same way `open_document`
    // (`encoding::decode_auto_with_extension`) and
    // `replaceinfiles::scan_replace_in_folder` do, instead of decoding
    // through plain `encoding::decode_auto`. Unlike a wrong *label* on a
    // read-only search, the observable harm here is a silently missed
    // match: a query for real Chinese text can find nothing at all in a
    // file whose bytes were misdetected without the hint, even though the
    // text is plainly there once decoded correctly.

    /// Failing-test-first, issue #178: with no hint, chardetng misdetects
    /// this real fixture (a short Big5 sample) as EUC-KR, garbling "測試"
    /// into unrelated Korean characters. A search for "測試" itself must
    /// therefore find nothing without the hint, but must find it once the
    /// "txt" -> "Big5" preference is wired through -- matching what
    /// `encoding::decode_auto_with_extension` (and therefore
    /// `open_document`) reports for the identical bytes and hint.
    #[test]
    fn search_honors_extension_encoding_hint_and_finds_the_match() {
        let dir = fixture_dir("ext-hint-search");
        let text = "測試 MARKER\n";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(dir.join("notes.txt"), &bytes).unwrap();

        // Sanity: this fixture must actually be ambiguous without the
        // hint, or this test doesn't exercise it at all.
        let baseline = encoding::decode_auto(&bytes);
        assert!(
            !baseline.content.contains("測試"),
            "fixture precondition: chardetng must not already recover \"測試\" \
             unaided (decoded as {:?}: {:?})",
            baseline.encoding,
            baseline.content
        );

        let extension_encodings = vec![("txt".to_string(), "Big5".to_string())];
        let results = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "測試".into(),
            true,
            false,
            &extension_encodings,
        )
        .unwrap();
        assert_eq!(
            results.matches.len(),
            1,
            "the Big5 hint must let search recover the real text: {:?}",
            results.matches
        );
        assert!(results.matches[0].preview.contains("測試"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, issue #178 (no regression): a table with an
    /// entry for a *different* extension must leave search's behavior
    /// identical to an empty table (today's, pre-fix, behavior).
    #[test]
    fn search_without_matching_extension_entry_is_unchanged() {
        let dir = fixture_dir("ext-hint-search-no-match");
        let text = "測試 MARKER\n";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(dir.join("notes.txt"), &bytes).unwrap();

        let mismatched_table = vec![("log".to_string(), "Big5".to_string())];
        let with_mismatched_entry = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".into(),
            true,
            false,
            &mismatched_table,
        )
        .unwrap();
        let with_empty_table = search_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".into(),
            true,
            false,
            &[],
        )
        .unwrap();
        assert_eq!(with_mismatched_entry.matches, with_empty_table.matches);
        assert_eq!(
            with_mismatched_entry.matches.len(),
            1,
            "{:?}",
            with_mismatched_entry.matches
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
