//! Find/replace across every file in a folder (ROADMAP.md v0.5 Track S),
//! built as a dry-run scan + selective execute two-phase flow: the frontend
//! calls [`scan_replace_in_folder`] first (nothing on disk changes), the
//! user checks off which reported files to touch, then
//! [`execute_replace_in_folder`] rewrites only that subset.
//!
//! Search semantics mirror `search.rs`: a match never spans two lines,
//! `use_regex: false` treats `query` as a literal substring, and
//! `case_sensitive: false` folds case (Unicode-aware, matching
//! `regex::RegexBuilder::case_insensitive`, exactly as `search.rs`'s own
//! `Matcher` already does). **v1 scope, by design**: `replacement` is
//! always inserted as a literal string, even in regex mode — a literal
//! `"$1"` in `replacement` is never expanded to a captured group. Every
//! match (scan's count, execute's replacement) is produced by the same
//! [`build_matcher`] + `regex::Regex::find_iter`/`replace_all(...,
//! regex::NoExpand(replacement))` pair, so scan and execute can never
//! silently disagree about what counts as a match.
//!
//! One line-splitting rule is shared by *every* encoding, matched or not:
//! lines are found with `linebreak::scan_line_breaks` (LF, CRLF, or lone
//! CR — the same three-way split `lineindex.rs`/`chunk.rs` use, not Rust's
//! `str::lines()`, which does not recognize a lone CR as a terminator at
//! all). Using the shared byte-level splitter — rather than
//! `search.rs`-style `.lines()` — for scan's own match counting, not only
//! execute's rewrite, is a deliberate correctness choice beyond a literal
//! reading of "follow search.rs's line scan": it guarantees a dry-run's
//! `matchCount` can never disagree with what execute actually replaces on
//! a Classic-Mac (lone-CR) file. See this module's own tests for the
//! agreement lock.
//!
//! ## Encoding-dependent rewrite strategy
//!
//! [`execute_replace_in_folder`] forks on `encoding.is_ascii_compatible()`
//! (`encoding_rs`'s own predicate — see its source: `true` for everything
//! except UTF-16BE, UTF-16LE, ISO-2022-JP, and the never-auto-detected
//! `replacement` encoding). This is the exact encoding set
//! `linebreak.rs`'s module doc already assumes ("a literal 0x0A/0x0D byte
//! can never appear as part of a multi-byte sequence") — binding the
//! routing decision to the crate's own predicate, rather than a
//! hand-maintained list, means the two can never drift apart; this
//! module's own `ascii_compatible_encodings_never_place_0x0a_0x0d_inside_a_multibyte_sequence`
//! test empirically locks the predicate against that invariant for every
//! encoding `encoding_rs` ships.
//!
//! - **ASCII-compatible ([`line_level_replace`])**: raw file bytes are
//!   split into line segments; a segment with no match is copied to the
//!   output *byte-for-byte, terminator included, without ever being
//!   decoded* — so a non-canonical-but-valid legacy byte sequence on an
//!   untouched line (e.g. Big5's duplicate mapping `8E 69` for "箸", which
//!   `encoding::encode` would otherwise canonicalize to `BA E6` — see
//!   `encoding.rs`'s "Round-trip contract" doc and issue #96) survives
//!   completely untouched. Only a matched segment's *content* bytes are
//!   decoded, replaced, and re-encoded; its terminator bytes are still
//!   copied verbatim, never touched.
//! - **Fallback, whole-file re-encode ([`whole_file_replace`])**: for the
//!   two excluded families, for two different reasons:
//!   - **UTF-16LE/BE**: `0x0A`/`0x0D` can legally appear as half of an
//!     unrelated code unit, so byte-level line splitting on the *raw*
//!     bytes is unsound (this is the same reason `chunk.rs` rejects UTF-16
//!     paging). The encoding's mapping is 1:1 (no issue #96 canonicalizing
//!     drift), so a whole-file decode -> replace -> encode loses nothing a
//!     line-level pass would have preserved.
//!   - **ISO-2022-JP**: the one *stateful* encoder/decoder in
//!     `encoding_rs` (shift-mode escape sequences) — reachable here via
//!     chardetng auto-detection even though the encoding picker never
//!     offers it manually. Its shift state is **not** reset at a line
//!     terminator (confirmed against `encoding_rs`'s own decoder: in
//!     `Roman` state, byte `0x0A` still takes the plain
//!     `destination_handle.write_ascii` branch, leaving `decoder_state`
//!     unchanged) — so decoding a later line's raw bytes in isolation, as
//!     if it started fresh in ASCII state, can silently reinterpret a
//!     content byte (e.g. `0x5C`, "\\" in ASCII/JIS mode but "¥" in Roman
//!     mode). This is exactly the R1a lesson recorded in
//!     `.claude/judgment-overlay.md` §4 (`streamreplace.rs`'s chunk
//!     passthrough hazard) applied to line granularity instead of chunk
//!     granularity: re-encoding the *whole* decoded text in one pass is
//!     shift-state self-consistent end to end, so the fallback is safe by
//!     construction, with no special-casing beyond the routing predicate
//!     above (which is `encoding_rs`'s own realization of the same
//!     `enc == ISO_2022_JP` singleton-identity check `streamreplace.rs`
//!     uses explicitly).
//!
//!   Both reconstruct line-by-line (via the same `split_line_segments` +
//!   `split_terminator` helpers `line_level_replace` uses, applied to the
//!   already-decoded UTF-8 text instead of the file's raw bytes — always
//!   safe, since decoded text is UTF-8, itself trivially ASCII-compatible)
//!   so a Mixed on-disk line-ending style still keeps each line's own
//!   terminator character even though, unlike the line-level path, every
//!   line here is re-encoded regardless of match status.
//!
//! [`scan_one_file`]'s counting and lossy-prediction logic is
//! encoding-route-*independent*: it always works from the fully decoded
//! text (`encoding::decode_auto_with_extension` — issue #178: honoring the
//! same per-extension preference `open_document` does, looked up per file
//! from the table via `prefs::extension_encoding_for` since one scan call
//! can walk files of many different extensions), never raw bytes, because
//! a dry run writes nothing and has no byte-preservation obligation to
//! honor.
//!
//! ## Trust mechanisms (this is the highest-risk domain in the app: a
//! folder-wide destructive rewrite over user files)
//!
//! - **Per-file fsguard fingerprint, single handle** ([`fsguard`]):
//!   [`execute_one`] opens each target once and captures its
//!   [`Fingerprint`] from that same handle's metadata before reading any
//!   content (issue #117's TOCTOU-avoidance pattern — the size cap and the
//!   fingerprint always describe the exact bytes about to be read).
//! - **Dry-run -> execute continuity**: [`ReplaceScanEntry::fingerprint`]
//!   (captured at scan time) is round-tripped by the frontend and sent
//!   back as [`ReplaceExecuteTarget::expected_fingerprint`]. `execute_one`
//!   compares its own freshly-opened fingerprint against that baseline
//!   *before* doing any decode/replace work — a mismatch reports
//!   `changed_since_scan` and touches nothing (mirrors issue #113's
//!   `open_document` -> `save_document` `expected_fingerprint` contract,
//!   just with `scan_replace_in_folder` standing in for `open_document`).
//! - **Re-verify immediately before the commit** (issue #114's
//!   `commit_conversion` pattern): the destination is resolved past any
//!   symlink exactly once (`lib.rs::resolve_write_destination`), then the
//!   fingerprint captured at open time is re-checked against a *fresh*
//!   stat of that same resolved path — catching a change that happened
//!   *during* this call's own decode/replace work, a narrower and later
//!   window than the scan-to-execute check above. Resolving once and
//!   reusing it for both this check and the commit below (rather than
//!   resolving independently for each) is what stops a symlink repoint
//!   from redirecting validated content onto an unchecked file (issue
//!   #301 review, round 5 — see `resolve_write_destination`'s doc
//!   comment). One file failing either check never blocks the rest of the
//!   batch; each gets its own [`ReplaceExecuteEntry`].
//! - **Atomic commit**: `crate::atomic_write` on that same resolved path
//!   (temp file + rename — see `lib.rs`'s doc comment), the same
//!   atomic-commit machinery every other write path in this app shares.
//! - **Lossy two-phase gate**: since only `replacement`'s own characters
//!   can newly become unmappable (everything else in a line already
//!   round-tripped through this file's own encoding once via decode), scan
//!   predicts loss cheaply by probing `replacement` alone
//!   (`encoding::encode`'s own `unmappable` flag — the same probing
//!   primitive `normalize::UnmappableScanner` is built on, just without
//!   its position-tracking, which a per-file boolean has no use for).
//!   Execute never trusts that prediction: it always builds the real
//!   output bytes first and gates on the `unmappable` flag those *actual*
//!   encode calls report, exactly like `save_document`/`commit_conversion`
//!   already do. `allow_lossy: false` (the first call) leaves the file
//!   completely untouched on a lossy verdict; `allow_lossy: true` (after
//!   explicit user confirmation) writes it.
//! - **Malformed files never get written to**: a file whose bytes don't
//!   decode cleanly (`decoded.malformed`) is reported `skipped_reason` at
//!   scan time and `decode_error` at execute time — matching
//!   ARCHITECTURE.md's hard constraint that a decode error must surface to
//!   the user, never be silently treated as fine.
//! - **5 MiB cap**: matches `search.rs::MAX_FILE_SIZE`. Unlike
//!   `search.rs::collect_files`, which silently drops an oversized file
//!   from its walk, [`collect_files`] here is a twin implementation (same
//!   `SKIP_DIRS`/dotdir/symlink rules, reusing `search::ScanError` as-is)
//!   that does *not* filter by size at walk time — this module's own size
//!   check happens per file, after opening, specifically so an oversized
//!   file can be *reported* `skipped_reason` rather than silently vanish
//!   from consideration (this module's requirement goes beyond
//!   `search.rs`'s own, so the walk can't be reused unmodified — same
//!   "twin, not shared" precedent `batch.rs::collect_files` already
//!   established for its own, differently-shaped needs).

use crate::encoding;
use crate::fsguard::Fingerprint;
use crate::linebreak;
use crate::normalize;
use crate::search::ScanError;
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

/// Directory names never descended into — matches `search.rs::SKIP_DIRS`
/// (and `batch.rs`'s own identical copy).
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// Matches `search.rs::MAX_FILE_SIZE`. See the module doc for why this
/// module's own walk can't reuse `search.rs::collect_files` unmodified to
/// enforce it.
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// Soft cap on how many entries `scan_replace_in_folder` returns before
/// setting `truncated: true` and stopping — mirrors `search.rs::MAX_RESULTS`
/// (same number, same "keep scanning but stop reporting" shape, applied to
/// files here instead of individual matches).
const MAX_ENTRIES: usize = 500;

pub const STATUS_OK: &str = "ok";
pub const STATUS_CHANGED_SINCE_SCAN: &str = "changed_since_scan";
pub const STATUS_LOSSY_BLOCKED: &str = "lossy_blocked";
pub const STATUS_IO_ERROR: &str = "io_error";
pub const STATUS_DECODE_ERROR: &str = "decode_error";
pub const STATUS_TOO_LARGE: &str = "too_large";

/// One file's dry-run result. `skipped_reason` set means this file was
/// never searched (too large, or its bytes don't decode cleanly under
/// detection) — `match_count`/`encoding`/`lossy` are all trivial (`0`,
/// `""`, `false`) in that case, never a guess. A successfully-scanned file
/// with zero matches is omitted from the report entirely (see
/// [`scan_one_file`]) rather than appearing here with `match_count: 0` —
/// there is nothing actionable to show for it and nothing hidden either,
/// unlike a skip.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceScanEntry {
    pub path: String,
    pub match_count: usize,
    /// Detected encoding name, e.g. "Big5". Empty when `skipped_reason` is
    /// set and the file was never even opened (too large).
    pub encoding: String,
    /// Metadata snapshot captured when this file was read for the scan,
    /// opaque to the frontend (see `fsguard.rs`). Round-trip this back as
    /// the matching `ReplaceExecuteTarget::expected_fingerprint` — a `None`
    /// here (capture failed, or the file was never opened) means execute
    /// has no verified baseline to check continuity against for this file.
    pub fingerprint: Option<Fingerprint>,
    /// True when `replacement` contains at least one character that can't
    /// be represented in `encoding` — see the module doc's "lossy
    /// two-phase gate" section. Always `false` when `match_count == 0` or
    /// `skipped_reason` is set (nothing would be written either way).
    pub lossy: bool,
    /// Human-readable reason this file was excluded from the search
    /// entirely (too large, or a decode error) — `None` for every entry
    /// that actually contributes to `match_count`.
    pub skipped_reason: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceScanReport {
    pub entries: Vec<ReplaceScanEntry>,
    /// Directories or entries the walk could not read — mirrors
    /// `search.rs::SearchResults::scan_errors` / `batch.rs`'s identical
    /// field exactly: a non-empty list means `entries` may be missing
    /// whatever those paths contained, never "no matches there". The root
    /// folder itself failing to open is a harder failure — this command
    /// rejects outright instead of returning an empty-looking report.
    pub scan_errors: Vec<ScanError>,
    /// True when the scan stopped after `MAX_ENTRIES` reportable entries;
    /// more of the folder may not have been examined at all.
    pub truncated: bool,
}

/// One file execute is asked to touch. `expected_fingerprint` should be the
/// exact value `scan_replace_in_folder` reported for this path — see the
/// module doc's fingerprint-continuity section.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceExecuteTarget {
    pub path: String,
    pub expected_fingerprint: Option<Fingerprint>,
}

/// One file's execute result. `status` is one of the `STATUS_*` constants
/// above; `replaced_count` is `0` for every status except `STATUS_OK`
/// (including the harmless case where a target genuinely had zero matches
/// by the time execute ran).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceExecuteEntry {
    pub path: String,
    pub replaced_count: usize,
    pub status: String,
    pub message: String,
}

/// Build the single match/replace primitive both scan and execute share:
/// `use_regex: false` escapes `query` into a literal pattern first (see
/// `regex::escape`), so both modes end up compiled through the exact same
/// `regex::Regex`, and the empty-query guard here is what protects
/// `execute_replace_in_folder` from ever compiling an always-matching
/// empty pattern (an empty regex matches at every position — silently
/// devastating over a whole folder). `scan_replace_in_folder` instead
/// short-circuits an empty query *before* ever calling this, returning a
/// trivial empty report — matching `search.rs::search_in_folder`'s own
/// empty-query convention, which is a friendlier "nothing to show" UX for
/// a read-only dry run than an error.
fn build_matcher(
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<regex::Regex, String> {
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {e}"))
}

/// Recursively collect every file under `dir`, skipping dotdirs,
/// `SKIP_DIRS`, and symlinks — identical traversal rules to
/// `search.rs::collect_files`, but *not* filtering by size (see the module
/// doc for why this module's `skipped_reason` requirement means it can't
/// reuse that function unmodified). `search::ScanError` is reused as-is: a
/// directory that can't be listed, or an entry whose metadata can't be
/// read, is recorded here and the walk continues with whatever the rest of
/// the tree can still offer — never silently dropped (issue #116/#130's
/// fix, carried over by construction).
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
        } else if meta.is_file() {
            files.push(path);
        }
    }
}

/// Read at most `MAX_FILE_SIZE + 1` bytes from `file` — bounds memory use
/// even if the file grew after an earlier metadata check (issue #117's
/// pattern, shared by scan and execute alike here). The `+ 1` sentinel
/// turns "exactly at the cap" into a distinguishable "at least one more
/// byte past it" without reading further to confirm it.
fn bounded_read(file: std::fs::File) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(MAX_FILE_SIZE as usize + 1);
    file.take(MAX_FILE_SIZE + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Split `bytes` into consecutive segments, each one full line *including*
/// its own terminator bytes (LF, CRLF, or lone CR) — the final segment has
/// none when `bytes` doesn't end on a terminator. Built on
/// `linebreak::scan_line_breaks`, the shared LF/CRLF/lone-CR definition, so
/// line boundaries here can never disagree with the rest of the app.
///
/// Byte-level splitting is only sound when `0x0A`/`0x0D` can never appear
/// inside a multi-byte sequence of `bytes`'s own encoding — true for every
/// caller of this function: raw file bytes from an
/// `encoding.is_ascii_compatible()` file, or an already-decoded `String`'s
/// UTF-8 bytes (always ASCII-compatible, regardless of the file's original
/// on-disk encoding). See this module's own whitelist invariant test.
fn split_line_segments(bytes: &[u8]) -> Vec<&[u8]> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut breaks: Vec<usize> = Vec::new();
    let mut pending_cr = false;
    linebreak::scan_line_breaks(bytes, 0, &mut pending_cr, |next_line_start, _kind| {
        breaks.push(next_line_start as usize);
    });
    if pending_cr {
        // The buffer's very last byte was an unresolved CR -- there is no
        // next chunk (this is the whole buffer), so it's a lone-CR
        // terminator right at EOF, mirroring `lineindex.rs`'s identical
        // post-loop resolution.
        breaks.push(bytes.len());
    }
    let mut segments = Vec::with_capacity(breaks.len() + 1);
    let mut start = 0usize;
    for end in breaks {
        segments.push(&bytes[start..end]);
        start = end;
    }
    if start < bytes.len() {
        segments.push(&bytes[start..]);
    }
    segments
}

/// Split one line segment (as returned by [`split_line_segments`]) into its
/// content and terminator bytes.
fn split_terminator(segment: &[u8]) -> (&[u8], &[u8]) {
    if let Some(content) = segment.strip_suffix(b"\r\n") {
        (content, &segment[content.len()..])
    } else if let Some(content) = segment.strip_suffix(b"\n") {
        (content, &segment[content.len()..])
    } else if let Some(content) = segment.strip_suffix(b"\r") {
        (content, &segment[content.len()..])
    } else {
        (segment, &segment[segment.len()..])
    }
}

/// Whether `replacement` would be lossy if written into a file detected as
/// `encoding_name` — see the module doc's "lossy two-phase gate" section
/// for why probing `replacement` alone (rather than reconstructing a whole
/// matched line) is sufficient. Unknown encoding names never occur here in
/// practice (`encoding_name` always comes from
/// `encoding::decode_auto_with_extension`'s own report, which always
/// round-trips), but returns `false` rather than
/// panicking if one ever did — a scan-time prediction has no user-facing
/// way to surface an error mid-report.
fn replacement_is_lossy(encoding_name: &str, replacement: &str) -> bool {
    let Some(encoding) = Encoding::for_label(encoding_name.as_bytes()) else {
        return false;
    };
    if normalize::is_always_representable(encoding) {
        return false;
    }
    matches!(
        encoding::encode(replacement, encoding_name, false),
        Ok((_, true))
    )
}

fn skipped_entry(path: String, reason: String) -> ReplaceScanEntry {
    ReplaceScanEntry {
        path,
        match_count: 0,
        encoding: String::new(),
        fingerprint: None,
        lossy: false,
        skipped_reason: Some(reason),
    }
}

/// Scan one file: `None` means it was successfully searched and had zero
/// matches (omitted from the report — see [`ReplaceScanEntry`]'s doc
/// comment); `Some` covers both an actual match and a skip.
///
/// `extension_encodings` is the same per-extension preference table
/// `open_document` honors via `extension_encoding` (issue #178) — this
/// module looks each file's own extension up in it directly
/// (`prefs::extension_encoding_for`) rather than receiving one
/// already-resolved hint per call, because a single folder walk can visit
/// files with many different extensions where `open_document` only ever
/// opens one.
fn scan_one_file(
    path: &Path,
    matcher: &regex::Regex,
    replacement: &str,
    lossy_cache: &mut HashMap<String, bool>,
    extension_encodings: &[(String, String)],
) -> Option<ReplaceScanEntry> {
    let path_str = path.to_string_lossy().into_owned();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return Some(skipped_entry(path_str, format!("Failed to read: {e}"))),
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(e) => return Some(skipped_entry(path_str, format!("Failed to read: {e}"))),
    };
    if meta.len() > MAX_FILE_SIZE {
        return Some(skipped_entry(
            path_str,
            "File exceeds the 5 MiB search cap".to_string(),
        ));
    }
    let fingerprint = Fingerprint::from_metadata(&meta).ok();
    let bytes = match bounded_read(file) {
        Ok(b) => b,
        Err(e) => return Some(skipped_entry(path_str, format!("Failed to read: {e}"))),
    };
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Some(skipped_entry(
            path_str,
            "File exceeds the 5 MiB search cap".to_string(),
        ));
    }

    let ext_hint = crate::prefs::extension_encoding_for(extension_encodings, path);
    let decoded = encoding::decode_auto_with_extension(&bytes, ext_hint.as_deref());
    if decoded.malformed {
        return Some(ReplaceScanEntry {
            path: path_str,
            match_count: 0,
            encoding: decoded.encoding,
            fingerprint,
            lossy: false,
            skipped_reason: Some(
                "File does not decode cleanly under detection; skipped, not searched".to_string(),
            ),
        });
    }

    let match_count: usize = split_line_segments(decoded.content.as_bytes())
        .into_iter()
        .map(|segment| {
            let (content, _) = split_terminator(segment);
            let content =
                std::str::from_utf8(content).expect("decoded text splits to valid UTF-8 lines");
            matcher.find_iter(content).count()
        })
        .sum();
    if match_count == 0 {
        return None;
    }

    let lossy = *lossy_cache
        .entry(decoded.encoding.clone())
        .or_insert_with(|| replacement_is_lossy(&decoded.encoding, replacement));

    Some(ReplaceScanEntry {
        path: path_str,
        match_count,
        encoding: decoded.encoding,
        fingerprint,
        lossy,
        skipped_reason: None,
    })
}

/// Dry-run scan of `folder` for `query` (see [`build_matcher`] for
/// `case_sensitive`/`use_regex` semantics) with `replacement` used only to
/// predict `ReplaceScanEntry::lossy` — nothing on disk changes. Rejects
/// outright if `folder` itself can't be listed, matching
/// `search.rs::search_in_folder`/`batch.rs::scan_batch_conversion`'s
/// identical fail-closed convention; once the walk is underway, a
/// subdirectory or entry that can't be read is recorded in
/// `ReplaceScanReport::scan_errors` instead of silently vanishing.
///
/// Pure, app-independent core behind the [`scan_replace_in_folder`] command
/// (issue #178): kept separate so tests can drive it directly with an
/// explicit `extension_encodings` table instead of needing a live Tauri
/// `AppHandle` — mirrors `store.rs`'s `write_json_to_path`/`write_json`
/// split (a path- or table-taking pure function, tested directly; a thin
/// `AppHandle`-resolving command wrapper, not separately unit-tested).
pub fn scan_replace_in_folder_with_extensions(
    folder: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    replacement: String,
    extension_encodings: &[(String, String)],
) -> Result<ReplaceScanReport, String> {
    if query.is_empty() {
        return Ok(ReplaceScanReport {
            entries: Vec::new(),
            scan_errors: Vec::new(),
            truncated: false,
        });
    }
    let matcher = build_matcher(&query, case_sensitive, use_regex)?;

    std::fs::read_dir(&folder).map_err(|e| format!("Cannot read folder {folder}: {e}"))?;

    let mut files = Vec::new();
    let mut scan_errors = Vec::new();
    collect_files(Path::new(&folder), &mut files, &mut scan_errors);

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut lossy_cache: HashMap<String, bool> = HashMap::new();
    for path in &files {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(entry) = scan_one_file(
            path,
            &matcher,
            &replacement,
            &mut lossy_cache,
            extension_encodings,
        ) {
            entries.push(entry);
        }
    }
    Ok(ReplaceScanReport {
        entries,
        scan_errors,
        truncated,
    })
}

/// Tauri command wrapper: resolves the per-extension encoding preference
/// table (`Preferences::extension_encodings`, `prefs::current`) from the
/// app config directory and forwards it to
/// [`scan_replace_in_folder_with_extensions`] — see that function's doc
/// comment and issue #178. `app` is injected by Tauri from the invocation
/// context, not sent by the frontend (same mechanism `prefs::
/// load_preferences`/`recent::load_recent_files` already rely on), so no
/// frontend call site needs to change for this to take effect.
#[tauri::command(async)]
pub fn scan_replace_in_folder<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    replacement: String,
) -> Result<ReplaceScanReport, String> {
    let extension_encodings = crate::prefs::current(&app).extension_encodings;
    scan_replace_in_folder_with_extensions(
        folder,
        query,
        case_sensitive,
        use_regex,
        replacement,
        &extension_encodings,
    )
}

/// ASCII-compatible stateless encodings: raw file bytes are split into line
/// segments; an unmatched segment is copied to the output byte-for-byte
/// (content and terminator both), never decoded at all. A matched
/// segment's content bytes are decoded, replaced, and re-encoded — its
/// terminator bytes are still copied verbatim, untouched. See the module
/// doc for the full rationale. Returns `(output bytes, replaced count,
/// whether any replacement was unmappable in `encoding`)`.
fn line_level_replace(
    bytes: &[u8],
    had_bom: bool,
    encoding: &'static Encoding,
    matcher: &regex::Regex,
    replacement: &str,
) -> (Vec<u8>, usize, bool) {
    // The only ASCII-compatible encoding with a BOM this app recognizes is
    // UTF-8 (`Encoding::for_bom`'s other two hits, UTF-16LE/BE, are never
    // ascii-compatible and never reach this function) -- `had_bom: true`
    // here unambiguously means a 3-byte `EF BB BF` prefix.
    let bom_len = if had_bom { 3 } else { 0 };
    let (bom, rest) = bytes.split_at(bom_len);

    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(bom);
    let mut replaced_count = 0usize;
    let mut unmappable_any = false;

    for segment in split_line_segments(rest) {
        let (content_bytes, terminator_bytes) = split_terminator(segment);
        let (content, had_errors) = encoding.decode_without_bom_handling(content_bytes);
        let count = if had_errors {
            0
        } else {
            matcher.find_iter(&content).count()
        };
        if count == 0 {
            // Covers both the ordinary no-match case and the defensive
            // `had_errors` branch: the whole-file decode already proved
            // this file has no malformed sequences (callers only reach
            // this function after that check), so `had_errors` here should
            // be unreachable given this module's own invariant test -- but
            // never silently trust that over what's actually on disk.
            // Falling back to verbatim passthrough is always safe, exactly
            // like a genuine no-match line.
            out.extend_from_slice(segment);
            continue;
        }
        replaced_count += count;
        let new_content = matcher.replace_all(&content, regex::NoExpand(replacement));
        let (new_bytes, _, unmappable) = encoding.encode(&new_content);
        unmappable_any |= unmappable;
        out.extend_from_slice(&new_bytes);
        out.extend_from_slice(terminator_bytes);
    }
    (out, replaced_count, unmappable_any)
}

/// UTF-16LE/BE and ISO-2022-JP fallback: `decoded.content` (already fully
/// decoded to UTF-8 text, terminators intact as literal characters) is
/// re-split by `split_line_segments` on its own UTF-8 bytes, matched and
/// replaced as text per line so a Mixed on-disk line-ending style still
/// keeps each line's own terminator, then the *entire* reconstructed text
/// is re-encoded in one shot. Unlike `line_level_replace`, every line is
/// re-encoded here regardless of match status — see the module doc for why
/// that's unavoidable (and safe) for these two encoding families.
fn whole_file_replace(
    decoded: &encoding::DecodedText,
    encoding: &'static Encoding,
    matcher: &regex::Regex,
    replacement: &str,
) -> (Vec<u8>, usize, bool) {
    let mut out_text = String::with_capacity(decoded.content.len());
    let mut replaced_count = 0usize;
    for segment in split_line_segments(decoded.content.as_bytes()) {
        let (content_bytes, terminator_bytes) = split_terminator(segment);
        let content = std::str::from_utf8(content_bytes)
            .expect("split_line_segments splits UTF-8 text only at ASCII terminator bytes");
        let terminator = std::str::from_utf8(terminator_bytes).expect("terminator is pure ASCII");
        let count = matcher.find_iter(content).count();
        if count == 0 {
            out_text.push_str(content);
        } else {
            replaced_count += count;
            out_text.push_str(&matcher.replace_all(content, regex::NoExpand(replacement)));
        }
        out_text.push_str(terminator);
    }
    let (out_bytes, unmappable) = encoding::encode(&out_text, encoding.name(), decoded.had_bom)
        .expect(
            "decode_auto_with_extension's reported encoding always round-trips \
             through Encoding::for_label",
        );
    (out_bytes, replaced_count, unmappable)
}

fn err_entry(path: String, status: &str, message: String) -> ReplaceExecuteEntry {
    ReplaceExecuteEntry {
        path,
        replaced_count: 0,
        status: status.to_string(),
        message,
    }
}

/// Execute one target end to end. Never trusts the scan's snapshot beyond
/// the explicit `expected_fingerprint` continuity check — content is always
/// freshly read and freshly decoded here. See the module doc's "trust
/// mechanisms" section for the full sequence. `extension_encodings` is the
/// same per-extension preference table `scan_one_file` consults (issue
/// #178) — looked up again here, independently, from this call's own
/// freshly-read bytes and path, so scan and execute can never disagree
/// about which encoding a given file's extension hint resolves to.
fn execute_one(
    target: &ReplaceExecuteTarget,
    matcher: &regex::Regex,
    replacement: &str,
    allow_lossy: bool,
    extension_encodings: &[(String, String)],
) -> ReplaceExecuteEntry {
    let path = Path::new(&target.path);
    let path_str = target.path.clone();

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return err_entry(path_str, STATUS_IO_ERROR, format!("Failed to read: {e}")),
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(e) => return err_entry(path_str, STATUS_IO_ERROR, format!("Failed to read: {e}")),
    };
    if meta.len() > MAX_FILE_SIZE {
        return err_entry(
            path_str,
            STATUS_TOO_LARGE,
            "File exceeds the 5 MiB search cap".to_string(),
        );
    }
    let current_fingerprint = match Fingerprint::from_metadata(&meta) {
        Ok(fp) => fp,
        Err(e) => return err_entry(path_str, STATUS_IO_ERROR, format!("Failed to read: {e}")),
    };
    // Dry-run -> execute continuity (issue #113's `expected_fingerprint`
    // pattern): a mismatch means the file changed since the scan that
    // produced this target, however long ago that was -- the stale match
    // count/lossy verdict this call was given must never be trusted.
    if let Some(expected) = &target.expected_fingerprint {
        if current_fingerprint != *expected {
            return err_entry(
                path_str,
                STATUS_CHANGED_SINCE_SCAN,
                "File changed on disk since the dry-run scan; skipped, not written".to_string(),
            );
        }
    }

    let bytes = match bounded_read(file) {
        Ok(b) => b,
        Err(e) => return err_entry(path_str, STATUS_IO_ERROR, format!("Failed to read: {e}")),
    };
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return err_entry(
            path_str,
            STATUS_TOO_LARGE,
            "File grew past the size limit during read; skipped".to_string(),
        );
    }

    let ext_hint = crate::prefs::extension_encoding_for(extension_encodings, path);
    let decoded = encoding::decode_auto_with_extension(&bytes, ext_hint.as_deref());
    if decoded.malformed {
        return err_entry(
            path_str,
            STATUS_DECODE_ERROR,
            format!(
                "File does not decode cleanly as {}; skipped, not written",
                decoded.encoding
            ),
        );
    }
    let encoding = Encoding::for_label(decoded.encoding.as_bytes())
        .expect("decode_auto_with_extension's reported encoding always round-trips");

    let (out_bytes, replaced_count, unmappable) = if encoding.is_ascii_compatible() {
        line_level_replace(&bytes, decoded.had_bom, encoding, matcher, replacement)
    } else {
        whole_file_replace(&decoded, encoding, matcher, replacement)
    };

    if replaced_count == 0 {
        return ReplaceExecuteEntry {
            path: path_str,
            replaced_count: 0,
            status: STATUS_OK.to_string(),
            message: "No matches found; file left untouched".to_string(),
        };
    }

    if unmappable && !allow_lossy {
        return err_entry(
            path_str,
            STATUS_LOSSY_BLOCKED,
            "Some replacement characters can't be represented in this file's encoding; skipped"
                .to_string(),
        );
    }

    // Resolve the destination once, then use the SAME resolved path for
    // both the re-verify check below and the write itself (issue #301
    // review, round 5): resolving independently for each -- a fresh
    // resolve inside a "follow symlinks" writer, decoupled from whatever
    // path the check below validated -- would let a symlink repoint
    // landing between the two resolves redirect content validated against
    // the OLD target onto a completely different, never-checked file. See
    // `lib.rs::resolve_write_destination`'s doc comment for the full
    // rationale. `path` is always a file the user selected for
    // search-and-replace, never an internal app-state path, so following a
    // destination symlink at all is correct in the first place.
    let write_target = match crate::resolve_write_destination(path) {
        Ok((target, _, _)) => target,
        Err(e) => {
            return err_entry(
                path_str,
                STATUS_IO_ERROR,
                format!("Failed to resolve destination: {e}"),
            )
        }
    };

    // Re-verify immediately before the commit (issue #114's pattern): has
    // anything replaced `write_target` since this call opened `path`
    // above? A different, later, and narrower window than the continuity
    // check.
    if !current_fingerprint.matches_path(&write_target) {
        return err_entry(
            path_str,
            STATUS_CHANGED_SINCE_SCAN,
            "File changed on disk during replace; skipped, not written".to_string(),
        );
    }

    match crate::atomic_write(&write_target, &out_bytes) {
        Ok(()) => ReplaceExecuteEntry {
            path: path_str,
            replaced_count,
            status: STATUS_OK.to_string(),
            message: String::new(),
        },
        Err(e) => err_entry(path_str, STATUS_IO_ERROR, format!("Failed to write: {e}")),
    }
}

/// Execute a replace over exactly `files` (normally the checked subset of a
/// prior [`scan_replace_in_folder`] report) for the same `query`/
/// `case_sensitive`/`use_regex`/`replacement` used to produce it.
/// `allow_lossy: false` (the first call) leaves every file whose
/// replacement would be unmappable in its own encoding completely
/// untouched (`STATUS_LOSSY_BLOCKED`); re-invoke with `allow_lossy: true`,
/// after explicit user confirmation, to write those too. One file's
/// failure never stops the rest of the batch. Unlike
/// `scan_replace_in_folder`, an empty `query` is rejected outright rather
/// than silently doing nothing — see [`build_matcher`].
///
/// Pure, app-independent core behind the [`execute_replace_in_folder`]
/// command (issue #178) — see [`scan_replace_in_folder_with_extensions`]'s
/// doc comment for why this split exists. `extension_encodings` is the
/// same table `scan_replace_in_folder_with_extensions` was given; passing
/// it through again here (rather than trusting anything cached from the
/// scan) keeps `execute_one`'s own fresh read-and-decode honest end to
/// end, the same way `expected_fingerprint` is checked again instead of
/// trusted from the scan.
pub fn execute_replace_in_folder_with_extensions(
    files: Vec<ReplaceExecuteTarget>,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    replacement: String,
    allow_lossy: bool,
    extension_encodings: &[(String, String)],
) -> Result<Vec<ReplaceExecuteEntry>, String> {
    let matcher = build_matcher(&query, case_sensitive, use_regex)?;
    Ok(files
        .iter()
        .map(|target| {
            execute_one(
                target,
                &matcher,
                &replacement,
                allow_lossy,
                extension_encodings,
            )
        })
        .collect())
}

/// Tauri command wrapper: resolves the per-extension encoding preference
/// table the same way [`scan_replace_in_folder`] does and forwards it to
/// [`execute_replace_in_folder_with_extensions`] — see that function's doc
/// comment and issue #178.
#[tauri::command(async)]
pub fn execute_replace_in_folder<R: Runtime>(
    app: AppHandle<R>,
    files: Vec<ReplaceExecuteTarget>,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    replacement: String,
    allow_lossy: bool,
) -> Result<Vec<ReplaceExecuteEntry>, String> {
    let extension_encodings = crate::prefs::current(&app).extension_encodings;
    execute_replace_in_folder_with_extensions(
        files,
        query,
        case_sensitive,
        use_regex,
        replacement,
        allow_lossy,
        &extension_encodings,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojidori-replaceinfiles-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn target(path: &Path, expected_fingerprint: Option<Fingerprint>) -> ReplaceExecuteTarget {
        ReplaceExecuteTarget {
            path: path.to_string_lossy().into_owned(),
            expected_fingerprint,
        }
    }

    /// Failing-test-first, requirement 1: an *untouched* line's bytes must
    /// survive execute completely unchanged -- including a legacy
    /// non-canonical byte sequence that `encoding::encode` would otherwise
    /// silently canonicalize (issue #96). `0x8E 0x69` is Big5's duplicate
    /// mapping for "箸": it decodes cleanly, but re-encoding the decoded
    /// text always emits the canonical pair `0xBA 0xE6` instead (see
    /// `encoding.rs`'s `big5_non_canonical_bytes_are_canonicalized_on_encode`,
    /// whose fixture this test reuses). Since this line never matches the
    /// query, a naive whole-file decode -> replace -> encode (or any bug
    /// that decodes an unmatched line instead of passing its bytes through)
    /// would silently corrupt it -- this is the concept this whole feature
    /// exists to prevent.
    #[test]
    fn untouched_line_with_non_canonical_big5_pair_is_byte_identical_after_execute() {
        let dir = fixture_dir("big5-96-pair");
        let file = dir.join("doc.txt");

        let (mut bytes, unmappable) =
            encoding::encode("這是一段中文內容 MARKER 用來偵測編碼\n", "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&[0x8Eu8, 0x69u8]);
        bytes.push(b'\n');
        std::fs::write(&file, &bytes).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        // Search for the exact byte run rather than a fixed offset: the
        // matched line above shrinks by one byte ("MARKER" -> "TOKEN"),
        // which shifts everything after it -- the untouched line's
        // *content* must be unaffected by that shift, which this
        // presence check verifies independent of exactly where it now
        // sits.
        let on_disk = std::fs::read(&file).unwrap();
        assert!(
            on_disk.windows(3).any(|w| w == [0x8Eu8, 0x69u8, b'\n']),
            "the untouched line's non-canonical Big5 pair and terminator must survive \
             byte-for-byte, never canonicalized to 0xBA 0xE6: {on_disk:02X?}"
        );
        assert!(
            !on_disk.windows(2).any(|w| w == [0xBAu8, 0xE6u8]),
            "the non-canonical pair must not have been canonicalized: {on_disk:02X?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 2 (CRLF half): a matched line's
    /// *content* is replaced but its CRLF terminator bytes are copied
    /// verbatim, never round-tripped through `normalize_to_lf`/
    /// `apply_line_ending`.
    #[test]
    fn execute_replaces_matched_line_content_and_preserves_crlf_terminator() {
        let dir = fixture_dir("crlf-terminator");
        let file = dir.join("doc.txt");
        let original = "unmatched café line\r\nMARKER replace me\r\nlast unmatched\r\n";
        std::fs::write(&file, original.as_bytes()).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "REPLACED".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            on_disk, "unmatched café line\r\nREPLACED replace me\r\nlast unmatched\r\n",
            "CRLF terminators must survive on every line, matched or not"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 2 (lone-CR half): a Classic Mac
    /// (`\r`-only) file's matched line keeps its lone-CR terminator.
    #[test]
    fn execute_replaces_matched_line_content_and_preserves_lone_cr_terminator() {
        let dir = fixture_dir("lone-cr-terminator");
        let file = dir.join("doc.txt");
        let original = "unmatched café line\rMARKER replace me\rlast unmatched\r";
        std::fs::write(&file, original.as_bytes()).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "REPLACED".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            on_disk, "unmatched café line\rREPLACED replace me\rlast unmatched\r",
            "lone CR terminators must survive on every line, matched or not"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 3: a *Mixed* line-ending file (LF,
    /// CRLF, and lone CR all present) still preserves every individual
    /// line's own terminator style after execute -- the line-level path's
    /// natural per-segment preservation, asserted against the whole
    /// reconstructed buffer at once (the strongest single assertion: it
    /// simultaneously locks content-replacement correctness, per-line
    /// terminator preservation, and untouched-line byte-identity).
    #[test]
    fn execute_preserves_each_lines_own_terminator_in_a_mixed_ending_file() {
        let dir = fixture_dir("mixed-terminators");
        let file = dir.join("doc.txt");
        let original =
            "unmatched LF café\nMARKER one\r\nunmatched CRLF\r\nMARKER two\runmatched CR\r";
        std::fs::write(&file, original.as_bytes()).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "X".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 2);

        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            on_disk, "unmatched LF café\nX one\r\nunmatched CRLF\r\nX two\runmatched CR\r",
            "every line's own terminator style must survive independently"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 4: UTF-16 always takes the
    /// whole-file fallback (its mapping is 1:1, so this loses nothing);
    /// replace must be correct and the BOM/encoding label must survive.
    #[test]
    fn utf16le_fallback_replaces_correctly_with_no_round_trip_drift() {
        let dir = fixture_dir("utf16le-fallback");
        let file = dir.join("doc.txt");
        let original_text = "line one with MARKER here\n第二行內容\n";
        let (bytes, unmappable) = encoding::encode(original_text, "UTF-16LE", true).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_with(&on_disk, "UTF-16LE").unwrap();
        assert!(!decoded.malformed);
        assert!(
            decoded.had_bom,
            "the UTF-16LE BOM must survive the fallback path"
        );
        assert_eq!(decoded.content, "line one with TOKEN here\n第二行內容\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 5: ISO-2022-JP's shift state is not
    /// reset at a line terminator (confirmed directly against
    /// `encoding_rs`'s decoder: in `Roman` state, byte `0x0A` still takes
    /// the plain ASCII-output branch, leaving the state unchanged), so a
    /// naive line-level implementation that decoded the second line's raw
    /// bytes in isolation -- assuming a fresh ASCII start state -- would
    /// misread `0x5C` as "\" instead of "¥", corrupting content the user
    /// never touched. This fixture is built to diverge under exactly that
    /// bug and pass under the required whole-file fallback (mirrors
    /// `streamreplace.rs`'s `iso_2022_jp_is_excluded_from_passthrough_keeping_content_correct`
    /// construction technique, without the chunk-boundary machinery this
    /// module doesn't have).
    #[test]
    fn iso_2022_jp_fallback_reencodes_whole_file_and_keeps_shift_state_correct() {
        let dir = fixture_dir("iso2022jp-fallback");
        let file = dir.join("doc.txt");

        let esc_roman: [u8; 3] = [0x1B, 0x28, 0x4A]; // ESC ( J -> Roman mode
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&esc_roman);
        bytes.push(b'a');
        bytes.push(b'\n'); // Roman state is NOT reset by this LF.
        bytes.extend_from_slice(b"MARKER");
        bytes.push(0x5Cu8); // "\" in ASCII mode, "¥" in the still-active Roman mode.
        bytes.push(b'\n');

        let (decoded_fixture, fixture_malformed) =
            encoding_rs::ISO_2022_JP.decode_without_bom_handling(&bytes);
        assert!(
            !fixture_malformed,
            "fixture must be well-formed ISO-2022-JP"
        );
        assert_eq!(
            decoded_fixture, "a\nMARKER¥\n",
            "fixture precondition: the raw 0x5C must decode as ¥ (Roman mode carried \
             over the line break), not \\ -- otherwise this fixture doesn't actually \
             exercise the shift-state hazard"
        );

        std::fs::write(&file, &bytes).unwrap();

        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &[],
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert_eq!(scan.entries[0].encoding, "ISO-2022-JP");
        assert_eq!(scan.entries[0].match_count, 1);

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read(&file).unwrap();
        let decoded_after = encoding::decode_with(&on_disk, "ISO-2022-JP").unwrap();
        assert!(!decoded_after.malformed);
        assert_eq!(
            decoded_after.content, "a\nTOKEN¥\n",
            "correct whole-file re-encode must keep the ¥ -- a buggy line-level path \
             would have decoded line 2 in isolation (fresh ASCII state) and produced \
             \"a\\nTOKEN\\\\\\n\" instead"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 6: `scan_replace_in_folder`'s
    /// fingerprint must be honored as the execute baseline -- a file
    /// changed on disk after the scan (however long ago) must be reported
    /// `changed_since_scan` and left completely untouched, never silently
    /// replaced against a stale match count. Mirrors `lib.rs`'s
    /// `save_document_rejects_stale_fingerprint_and_preserves_external_write`
    /// (issue #113), with `scan_replace_in_folder` standing in for
    /// `open_document`.
    #[test]
    fn execute_rejects_changed_since_scan_fingerprint_and_preserves_external_write() {
        let dir = fixture_dir("stale-fingerprint");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"MARKER original content\n").unwrap();

        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &[],
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        let expected_fingerprint = scan.entries[0].fingerprint;
        assert!(
            expected_fingerprint.is_some(),
            "scanning a real file must yield a verifiable fingerprint"
        );

        // Another process (or a second Mojidori window) replaces the file's
        // content while this scan report is still being reviewed.
        let external_content = b"externally written content, much longer than the original";
        std::fs::write(&file, external_content).unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, expected_fingerprint)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(
            report[0].status, STATUS_CHANGED_SINCE_SCAN,
            "{:?}",
            report[0]
        );
        assert_eq!(report[0].replaced_count, 0);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            external_content,
            "the externally-written content must survive completely untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 7: the lossy two-phase gate. A
    /// replacement containing a character Big5 can't represent must be
    /// flagged `lossy` at scan time, rejected at execute time without
    /// `allow_lossy`, and only written with it.
    #[test]
    fn lossy_replacement_is_flagged_blocked_then_allowed_with_consent() {
        let dir = fixture_dir("lossy-gate");
        let file = dir.join("doc.txt");
        let (bytes, unmappable) =
            encoding::encode("這是一段中文內容 MARKER 用來偵測編碼\n", "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        // U+1F389 PARTY POPPER has no Big5 mapping.
        let lossy_replacement = "TOKEN\u{1F389}";

        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            lossy_replacement.to_string(),
            &[],
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert!(scan.entries[0].lossy, "{:?}", scan.entries[0]);

        let blocked = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            lossy_replacement.to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(blocked[0].status, STATUS_LOSSY_BLOCKED, "{:?}", blocked[0]);
        assert_eq!(blocked[0].replaced_count, 0);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            bytes,
            "a blocked lossy execute must not touch the file at all"
        );

        let allowed = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            lossy_replacement.to_string(),
            true,
            &[],
        )
        .unwrap();
        assert_eq!(allowed[0].status, STATUS_OK, "{:?}", allowed[0]);
        assert_eq!(allowed[0].replaced_count, 1);
        assert_ne!(
            std::fs::read(&file).unwrap(),
            bytes,
            "allow_lossy: true must actually write the lossy bytes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 8: `replacement` is always a literal
    /// string, even in regex mode with capturing groups -- `"$1"` in
    /// `replacement` must appear in the output verbatim, never expanded to
    /// a captured group (v1 scope, no backreferences).
    #[test]
    fn regex_match_with_capture_group_still_replaces_literally() {
        let dir = fixture_dir("literal-replacement");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"before abc after\n").unwrap();

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "a(b)c".to_string(),
            true,
            true,
            "$1 literal".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            on_disk, "before $1 literal after\n",
            "\"$1\" must be inserted literally, never expanded to the captured \"b\""
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 9: a write failure (the containing
    /// directory has no write permission, so `atomic_write`'s temp file
    /// can't even be created) must report `io_error` for that file and
    /// leave its on-disk bytes completely untouched.
    #[cfg(unix)]
    #[test]
    fn write_failure_reports_io_error_and_preserves_original_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("write-failure");
        let file = dir.join("doc.txt");
        let original = b"MARKER content here\n";
        std::fs::write(&file, original).unwrap();

        // Read/execute only: the file itself stays readable (so open/
        // decode/match still succeed), but creating a new temp file in
        // this directory -- what `atomic_write` does first -- fails.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &[],
        );

        // Restore before any assertion can panic and leave a locked
        // directory behind for the next test run.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let report = result.unwrap();
        assert_eq!(report[0].status, STATUS_IO_ERROR, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 0);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            original,
            "a failed write must never alter the original bytes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, requirement 10 (whitelist invariant): every
    /// `encoding_rs`-supported encoding whose own `is_ascii_compatible()`
    /// is `true` -- exactly the set `line_level_replace`/`split_line_segments`
    /// route through byte-level splitting -- must actually satisfy
    /// `linebreak.rs`'s module-doc invariant that a literal `0x0A`/`0x0D`
    /// byte can never appear as part of a multi-byte sequence. Checked
    /// empirically (encoding a broad Unicode sweep, planes 0-1, and
    /// scanning the real output bytes) rather than asserted from table
    /// knowledge, so a future `encoding_rs` upgrade that ever changed this
    /// would fail loudly here instead of silently corrupting a real file.
    /// Binds this feature's supported-encoding routing decision directly to
    /// the invariant it depends on.
    #[test]
    fn ascii_compatible_encodings_never_place_0x0a_0x0d_inside_a_multibyte_sequence() {
        // Every `&'static Encoding` `encoding_rs` 0.8.35 exports (see its
        // `lib.rs`) -- deliberately exhaustive, not just this app's own
        // curated picker list (`src/encodings.ts`), since `decode_auto`'s
        // chardetng fallback can reach any of these, not only the curated
        // set.
        let all_encodings: &[&'static Encoding] = &[
            encoding_rs::BIG5,
            encoding_rs::EUC_JP,
            encoding_rs::EUC_KR,
            encoding_rs::GBK,
            encoding_rs::IBM866,
            encoding_rs::ISO_2022_JP,
            encoding_rs::ISO_8859_10,
            encoding_rs::ISO_8859_13,
            encoding_rs::ISO_8859_14,
            encoding_rs::ISO_8859_15,
            encoding_rs::ISO_8859_16,
            encoding_rs::ISO_8859_2,
            encoding_rs::ISO_8859_3,
            encoding_rs::ISO_8859_4,
            encoding_rs::ISO_8859_5,
            encoding_rs::ISO_8859_6,
            encoding_rs::ISO_8859_7,
            encoding_rs::ISO_8859_8,
            encoding_rs::ISO_8859_8_I,
            encoding_rs::KOI8_R,
            encoding_rs::KOI8_U,
            encoding_rs::SHIFT_JIS,
            encoding_rs::UTF_16BE,
            encoding_rs::UTF_16LE,
            encoding_rs::UTF_8,
            encoding_rs::GB18030,
            encoding_rs::MACINTOSH,
            encoding_rs::REPLACEMENT,
            encoding_rs::WINDOWS_1250,
            encoding_rs::WINDOWS_1251,
            encoding_rs::WINDOWS_1252,
            encoding_rs::WINDOWS_1253,
            encoding_rs::WINDOWS_1254,
            encoding_rs::WINDOWS_1255,
            encoding_rs::WINDOWS_1256,
            encoding_rs::WINDOWS_1257,
            encoding_rs::WINDOWS_1258,
            encoding_rs::WINDOWS_874,
            encoding_rs::X_MAC_CYRILLIC,
            encoding_rs::X_USER_DEFINED,
        ];
        assert_eq!(
            all_encodings.len(),
            40,
            "update this list if encoding_rs's exported encoding set changes"
        );

        // Every scalar value in planes 0-1 except surrogates and the two
        // terminator characters themselves (content, by construction, is
        // always terminator-stripped before reaching an encoder -- see
        // `split_terminator`).
        let mut sweep = String::new();
        for cp in 0u32..=0x1FFFF {
            if (0xD800..=0xDFFF).contains(&cp) || cp == 0x0A || cp == 0x0D {
                continue;
            }
            if let Some(ch) = char::from_u32(cp) {
                sweep.push(ch);
            }
        }

        let mut tested = 0usize;
        for enc in all_encodings {
            if !enc.is_ascii_compatible() {
                continue; // UTF-16LE/BE, ISO-2022-JP, replacement: excluded by design.
            }
            tested += 1;
            let (bulk_bytes, _, _) = enc.encode(&sweep);
            if !bulk_bytes.contains(&0x0Au8) && !bulk_bytes.contains(&0x0Du8) {
                continue;
            }
            // Bisect to name the offending character precisely.
            for ch in sweep.chars() {
                let mut buf = [0u8; 4];
                let s: &str = ch.encode_utf8(&mut buf);
                let (b, _, _) = enc.encode(s);
                assert!(
                    !b.contains(&0x0Au8) && !b.contains(&0x0Du8),
                    "{} encodes U+{:04X} to bytes containing a raw LF/CR byte: {:?} -- \
                     this breaks the byte-level line-splitting invariant replace-in-files' \
                     line-level path depends on",
                    enc.name(),
                    ch as u32,
                    b
                );
            }
        }
        assert_eq!(
            tested, 36,
            "expected exactly 36 ASCII-compatible encodings (40 total minus UTF-16LE/BE, \
             ISO-2022-JP, and replacement); update this count if encoding_rs's \
             is_ascii_compatible() classification changes"
        );
    }

    /// Scan and execute must never disagree on where lines are -- in
    /// particular, `scan`'s counting (`split_line_segments` over the
    /// *decoded* text) must recognize a lone CR as a line terminator
    /// exactly like `execute`'s rewrite does, unlike Rust's `str::lines()`
    /// (which only recognizes LF/CRLF). A file with two lone-CR-separated
    /// "MARKER" occurrences must scan as 2 matches, not 1 (which is what
    /// `.lines()`-based counting -- treating the whole lone-CR file as a
    /// single line -- would still often get right for a *literal* query,
    /// so this uses an anchored regex that only agrees with the correct,
    /// per-line count).
    #[test]
    fn scan_match_count_recognizes_lone_cr_terminators_like_execute_does() {
        let dir = fixture_dir("scan-lone-cr-agreement");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"MARKER first\rMARKER second\r").unwrap();

        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "^MARKER".to_string(),
            true,
            true,
            "X".to_string(),
            &[],
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert_eq!(
            scan.entries[0].match_count, 2,
            "a lone CR must be recognized as a line terminator so \"^MARKER\" matches \
             both lines, not just the first"
        );

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, None)],
            "^MARKER".to_string(),
            true,
            true,
            "X".to_string(),
            false,
            &[],
        )
        .unwrap();
        assert_eq!(
            report[0].replaced_count, 2,
            "execute must agree with the scan count"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- issue #178: scan/execute must honor the per-extension encoding
    // preference the same way `open_document` does
    // (`encoding::decode_auto_with_extension`), instead of decoding
    // through plain `encoding::decode_auto` -- a folder-wide walk has to
    // look each file's own extension up in the table itself, since unlike
    // `open_document` there is no single frontend-resolved hint to forward
    // for a whole folder of (potentially differently-extensioned) files.

    /// Failing-test-first, issue #178 requirement 1: with no hint,
    /// chardetng misdetects this real fixture (a short Big5 sample mixed
    /// with ASCII) as EUC-KR -- garbling "測試" while "MARKER" (pure ASCII)
    /// still reads fine and the scan still counts a match. With the
    /// "txt" -> "Big5" preference wired through, `scan_replace_in_folder`
    /// must report the same encoding `open_document`
    /// (`encoding::decode_auto_with_extension`) would for the identical
    /// bytes and hint.
    #[test]
    fn scan_honors_extension_encoding_hint_and_agrees_with_open_document() {
        let dir = fixture_dir("ext-hint-scan");
        let file = dir.join("notes.txt");
        let text = "測試 MARKER\n";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        // Sanity: this fixture must actually be the kind of short sample
        // that's ambiguous without the hint -- otherwise the test below
        // would pass even with today's bug.
        let baseline = encoding::decode_auto(&bytes);
        assert_ne!(
            baseline.encoding, "Big5",
            "fixture precondition: chardetng must not already guess Big5 \
             unaided, or this test doesn't exercise the hint at all"
        );

        let extension_encodings = vec![("txt".to_string(), "Big5".to_string())];
        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &extension_encodings,
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert_eq!(scan.entries[0].match_count, 1);
        assert_eq!(scan.entries[0].encoding, "Big5");

        let what_open_document_would_show =
            encoding::decode_auto_with_extension(&bytes, Some("Big5"));
        assert_eq!(
            scan.entries[0].encoding, what_open_document_would_show.encoding,
            "scan must agree with what open_document would choose for this file"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, issue #178 requirement 2 (no regression): a
    /// table with no entry for this file's extension -- or an empty table,
    /// what every other test in this module passes -- must leave scan's
    /// behavior exactly as it was before this fix, still plain
    /// `decode_auto`.
    #[test]
    fn scan_without_matching_extension_entry_is_unchanged() {
        let dir = fixture_dir("ext-hint-scan-no-match");
        let file = dir.join("notes.txt");
        let text = "測試 MARKER\n";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();
        let expected = encoding::decode_auto(&bytes);

        // Entry present, but for a different extension -- must not apply.
        let extension_encodings = vec![("log".to_string(), "Big5".to_string())];
        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &extension_encodings,
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert_eq!(scan.entries[0].encoding, expected.encoding);
        assert_eq!(scan.entries[0].match_count, 1);

        // Empty table, matching every pre-existing test in this module.
        let scan_empty = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &[],
        )
        .unwrap();
        assert_eq!(scan_empty.entries[0].encoding, expected.encoding);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first, issue #178 requirement 3: execute must honor the
    /// same hint scan did, and the two must never disagree. Without the
    /// hint, this fixture's matched line ("MARKER" survives, "測試" gets
    /// garbled) gets rewritten under the *wrong* detected encoding
    /// (EUC-KR), corrupting its own non-ASCII bytes on the very line that
    /// matched -- exactly the harm issue #178 describes. With the hint
    /// wired through both scan and execute, the file, reopened the way
    /// `open_document` would (with the same hint), must decode back to the
    /// correctly-replaced Chinese text.
    #[test]
    fn execute_honors_extension_encoding_hint_matching_scan_and_open_document() {
        let dir = fixture_dir("ext-hint-execute");
        let file = dir.join("notes.txt");
        let text = "測試 MARKER\n";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        let extension_encodings = vec![("txt".to_string(), "Big5".to_string())];

        let scan = scan_replace_in_folder_with_extensions(
            dir.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            &extension_encodings,
        )
        .unwrap();
        assert_eq!(scan.entries.len(), 1, "{:?}", scan.entries);
        assert_eq!(scan.entries[0].encoding, "Big5");

        let report = execute_replace_in_folder_with_extensions(
            vec![target(&file, scan.entries[0].fingerprint)],
            "MARKER".to_string(),
            true,
            false,
            "TOKEN".to_string(),
            false,
            &extension_encodings,
        )
        .unwrap();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].status, STATUS_OK, "{:?}", report[0]);
        assert_eq!(report[0].replaced_count, 1);

        let on_disk = std::fs::read(&file).unwrap();
        let reopened = encoding::decode_auto_with_extension(&on_disk, Some("Big5"));
        assert!(!reopened.malformed, "{on_disk:02X?}");
        assert_eq!(reopened.encoding, "Big5");
        assert_eq!(
            reopened.content, "測試 TOKEN\n",
            "execute must have used the Big5 hint to re-encode -- the same \
             encoding open_document would use to reopen this file -- so the \
             untouched Chinese text on the matched line survives correctly \
             instead of being corrupted under a misdetected encoding"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
