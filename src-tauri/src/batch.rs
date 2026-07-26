//! Batch encoding *and* line-ending conversion: scan a folder for a
//! dry-run report, then convert selected files to a target
//! encoding/line-ending, one atomic write per file. Track A of the v0.3
//! roadmap (ROADMAP.md).
//!
//! Two independent axes, each accepting a "keep" sentinel meaning "don't
//! touch this axis":
//!
//! - `target_encoding`: a canonical `encoding_rs` name, or the literal
//!   string `"keep"` — re-encode each file with its own detected encoding
//!   and detected BOM state (ignoring `target_with_bom`) instead of a
//!   caller-chosen target. This is what makes an encoding-preserving,
//!   line-ending-only conversion possible.
//! - `line_ending`: `"LF"`, `"CRLF"`, or `"keep"` — leave every line
//!   ending exactly as found on disk.
//!
//! `"keep"` + `"keep"` classifies every file `alreadyTarget` (nothing on
//! either axis is *asked* to change). Converting such a file is usually a
//! no-op: `convert_one`'s byte-identical skip (`out_bytes == bytes`)
//! detects when re-encoding reproduced the file's own bytes exactly and
//! leaves it untouched. That skip is a detection, not a guarantee, though
//! — for the legacy non-injective encodings documented on
//! `encoding::encode` (Big5, Shift_JIS, GBK; see issue #96), a file that
//! already contains non-canonical bytes fails that identity check and
//! gets silently rewritten with canonicalized bytes even under
//! `"keep"` + `"keep"`. Issue #96 (3/3) closes the "nothing in the report
//! distinguishing that from a real conversion" half of this: every
//! `alreadyTarget` `BatchEntry` now carries a `byte_drift` flag, computed by
//! rebuilding the same pipeline `convert_one` would run (`rebuild_output_bytes`,
//! shared by both) against the scan's own decoded bytes and comparing to the
//! original — see `BatchEntry::byte_drift`'s doc comment for the exact
//! no-op/skip rules. This is scan-time visibility only; `convert_one`'s own
//! behavior (silently canonicalize, still succeed) is unchanged.
//!
//! Issue #96 (3/3) only covered the `alreadyTarget` (both axes untouched)
//! half of this risk, though — issue #176 closes the other half it left
//! documented but unimplemented: a `convertible` file whose *encoding*
//! axis is untouched but whose *line-ending* axis was asked to change
//! (`target_encoding: "keep"`, or an explicit target equal to the file's
//! own encoding, with `line_ending` set to something the file isn't
//! already) still re-encodes that file, and re-encoding is exactly what
//! silently canonicalizes non-canonical legacy bytes — a user who asked
//! only "unify my line endings" gets an uninvited encoding
//! canonicalization bundled in, with nothing in the report distinguishing
//! it from the line-ending change they actually asked for. `byte_drift`
//! now covers both cases; see `BatchEntry::byte_drift`'s doc comment.
//!
//! Folder walking mirrors `search.rs`'s find-in-files traversal (same
//! `SKIP_DIRS`, same dotdir/symlink skip rules) so batch conversion never
//! descends into VCS metadata or dependency trees either.
//!
//! Data-integrity invariant this module exists to protect (see
//! `convert_one`): a converted file's *line endings* are never touched
//! unless `line_ending` explicitly asks for it. Classification and
//! conversion both work on the raw decode of a file's own bytes — never
//! run through `encoding::normalize_to_lf` the way `lib.rs::open_document`
//! normalizes for the editor buffer — *unless* `line_ending != "keep"`, in
//! which case `convert_one` normalizes to LF and re-applies the requested
//! ending before re-encoding. With `line_ending: "keep"`, a CRLF file
//! stays CRLF and an LF file stays LF; only the byte-level encoding is
//! meant to change (or nothing at all, with `target_encoding: "keep"` too
//! — modulo the non-canonical-byte caveat above).
//!
//! Deviation from the original task sketch: `scan_batch_conversion` takes
//! an explicit `target_with_bom: bool` parameter (mirroring
//! `execute_batch_conversion`'s existing one), even though the initial
//! signature sketch omitted it. The spec's own classification rule —
//! "already target: encoding name *and* BOM state both match" — cannot be
//! implemented without knowing the target's desired BOM state, so this is
//! treated as a required correction rather than a deviation to avoid.
//! `target_with_bom` is meaningless (and ignored) whenever
//! `target_encoding == "keep"`.

use crate::encoding;
use crate::fsguard::Fingerprint;
use encoding_rs::Encoding;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Directory names never descended into — matches `search.rs::SKIP_DIRS`.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
];

/// Files above this size are reported as `tooLarge` and skipped, matching
/// the editor's own large-file threshold: a batch tool has no business
/// fully reading a file the editor itself refuses to fully load.
const MAX_FILE_SIZE: u64 = crate::LARGE_FILE_THRESHOLD;

/// A scan aborts outright above this many matched files rather than
/// silently truncating the report — guards against pointing the tool at,
/// say, a home directory by mistake.
const MAX_FILES: usize = 2000;

pub const STATUS_CONVERTIBLE: &str = "convertible";
pub const STATUS_ALREADY_TARGET: &str = "alreadyTarget";
pub const STATUS_LOSSY: &str = "lossy";
pub const STATUS_UNDECODABLE: &str = "undecodable";
pub const STATUS_TOO_LARGE: &str = "tooLarge";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntry {
    pub path: String,
    /// Detected source encoding name, e.g. "Big5". Empty when the file was
    /// never read (`tooLarge`).
    pub detected: String,
    /// One of the `STATUS_*` constants above.
    pub status: String,
    /// The file's own detected line ending: "LF" | "CRLF" | "Mixed" (see
    /// `encoding::detect_line_ending`). Empty when the file was never read
    /// (`tooLarge`) or its bytes couldn't be read at all (permission
    /// error, vanished mid-scan) — but still populated for `undecodable`
    /// entries, since a malformed multi-byte sequence elsewhere in the
    /// file doesn't prevent detecting `\r`/`\n` bytes.
    pub line_ending: String,
    /// True when the *encoding* axis specifically is unchanged from this
    /// file's own on-disk encoding (`target_encoding: "keep"`, or an
    /// explicit target that already equals the file's own detected
    /// encoding and BOM state) yet re-encoding would nonetheless change
    /// these bytes, because it canonicalizes a non-injective legacy byte
    /// sequence (Big5, Shift_JIS, GBK — see `encoding.rs`'s "Round-trip
    /// contract" module doc). Two scenarios trigger it, both computed by
    /// rebuilding the exact `commit_conversion` pipeline against the
    /// scan's already-decoded bytes and comparing to the original (see
    /// [`rebuild_output_bytes`]):
    ///
    /// - Issue #96 (3/3): `status` is `alreadyTarget` — the line-ending
    ///   axis is *also* unchanged, so this is a full no-op the user never
    ///   asked to touch at all (the "keep" + "keep" caveat from this
    ///   module's own doc comment made visible in the report).
    /// - Issue #176 (#96 3/3's other half): `status` is `convertible` and
    ///   the *only* reason it isn't `alreadyTarget` is that the
    ///   line-ending axis was asked to change — a "just unify my line
    ///   endings" request that still bundles in an uninvited encoding
    ///   canonicalization. The verdict here isolates the encoding step
    ///   from the requested line-ending change (rebuilds with
    ///   `line_ending: "keep"`, not the requested target, before
    ///   comparing) so it flags only the canonicalization, never the
    ///   line-ending bytes the user did ask to change.
    ///
    /// Deliberately narrower than "any file whose bytes might drift":
    /// `false` whenever the *encoding* axis itself was asked to change (a
    /// different target encoding, or the same encoding with a different
    /// BOM state) — the user explicitly asked for that byte change, so a
    /// drift verdict there would carry no signal (batch's semantics differ
    /// from `bytedrift.rs`'s save-path check here: that check's target is
    /// always the *unchanged* save pipeline, so any drift it finds is
    /// inherently unrequested; batch's target is whatever the user picked,
    /// so only an encoding-axis-unchanged request is). Also `false`
    /// (skipped, not computed) when the file's own on-disk line ending is
    /// `"Mixed"` — same precedent as `bytedrift.rs`'s
    /// `SKIP_MIXED_LINE_ENDING`, kept consistent across both scenarios
    /// above even though the `convertible` scenario's `"keep"`-based
    /// rebuild could technically reproduce a mixed file (it hands
    /// `decoded.content` through untouched either way): a mixed source is
    /// what makes this file `convertible` at all against a concrete
    /// LF/CRLF target, and a verdict on it would still conflate
    /// line-ending unification with encoding canonicalization the same
    /// way it would for `alreadyTarget`. `undecodable`/`tooLarge` entries
    /// never reach a decode at all, so it's always `false` for those too.
    pub byte_drift: bool,
}

/// A directory or entry the walk could not read at all — recorded instead
/// of silently skipped (issue #116). `path` is the containing directory
/// when the directory listing itself failed (`read_dir`), or the specific
/// entry's own path when only its metadata lookup failed; `message` is the
/// OS error text (e.g. "Permission denied (os error 13)").
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchScanReport {
    pub entries: Vec<BatchEntry>,
    /// Directories or entries the walk could not read — each one means
    /// `entries` above is missing whatever that path may have contained.
    /// Empty means the walk completed exhaustively. Callers (the batch UI)
    /// must never treat a non-empty `entries` list as a complete picture
    /// while this is non-empty: see issue #116 and this module's doc
    /// comment. The root folder itself failing to open is a harder
    /// failure than this — `scan_batch_conversion` returns `Err` outright
    /// rather than an empty report with nothing to explain why.
    pub scan_errors: Vec<ScanError>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchConvertResult {
    pub path: String,
    pub ok: bool,
    pub message: String,
}

/// True when `path`'s extension (lowercased) is in `extensions`; an empty
/// `extensions` matches every file. `extensions` is expected already
/// lowercased (see `scan_with_limit`) — this still lowercases the path's
/// own extension itself, so it is correct even if called with a
/// not-yet-lowercased list.
fn extension_matches(path: &Path, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    let Some(ext) = path.extension() else {
        return false;
    };
    let ext = ext.to_string_lossy().to_lowercase();
    extensions.contains(&ext)
}

/// Recursively collect files under `dir` matching `extensions`, skipping
/// dotdirs/`SKIP_DIRS`/symlinks exactly as `search.rs::collect_files`
/// does. Bails with `Err` the moment the running total would exceed
/// `limit` — before descending further — so pointing this at a huge tree
/// fails fast instead of enumerating it all first.
///
/// Issue #116: a subdirectory that can't be listed, or an entry whose
/// metadata can't be read, used to be silently skipped — the dry-run
/// report would look complete while quietly missing an entire subtree.
/// Both failures are now pushed onto `scan_errors` and the walk continues
/// with whatever it *can* read, rather than aborting the whole scan over
/// one bad subtree (that would throw away legitimate results from
/// unrelated siblings) or pretending nothing was missed. The root
/// directory itself failing this same `read_dir` call is handled
/// differently — see `scan_with_limit`, which checks the root before ever
/// calling this function and fails the whole command closed instead.
fn collect_files(
    dir: &Path,
    extensions: &[String],
    limit: usize,
    files: &mut Vec<PathBuf>,
    scan_errors: &mut Vec<ScanError>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            scan_errors.push(ScanError {
                path: dir.to_string_lossy().into_owned(),
                message: e.to_string(),
            });
            return Ok(());
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
            collect_files(&path, extensions, limit, files, scan_errors)?;
        } else if meta.is_file() && extension_matches(&path, extensions) {
            files.push(path);
            if files.len() > limit {
                return Err(format!(
                    "Too many files to scan (more than {limit}); choose a smaller or \
                     more specific folder."
                ));
            }
        }
    }
    Ok(())
}

/// Resolve a `target_encoding` argument to `None` (`"keep"`: use each
/// file's own detected encoding) or `Some` real encoding. `"keep"` is a
/// sentinel, not a real label — it deliberately isn't routed through
/// `Encoding::for_label` (which wouldn't resolve it anyway).
fn resolve_target_encoding(target_encoding: &str) -> Result<Option<&'static Encoding>, String> {
    if target_encoding == "keep" {
        return Ok(None);
    }
    Encoding::for_label(target_encoding.as_bytes())
        .map(Some)
        .ok_or_else(|| format!("Unknown target encoding: {target_encoding}"))
}

/// Validate a `line_ending` argument is one of the three values this
/// module understands. Checked up front so an unknown value fails the
/// whole scan/execute call rather than silently doing nothing per-file.
fn validate_line_ending(line_ending: &str) -> Result<(), String> {
    match line_ending {
        "keep" | "LF" | "CRLF" => Ok(()),
        other => Err(format!("Unknown line ending: {other}")),
    }
}

/// Open `path` once and run the fast metadata size check used by
/// `classify_file`'s scan-side guard, but read no bytes yet — the
/// scan-side counterpart to [`open_for_conversion`] (issue #117), except it
/// returns a terminal [`BatchEntry`] directly (`classify_file` never fails
/// the way `execute_batch_conversion` can) and captures no [`Fingerprint`]:
/// a dry-run scan has nothing to later commit against. Split out from
/// [`classify_file`] so a test can grow the file behind the returned
/// handle (through a second, independent handle to the same path) before
/// ever calling [`take_bounded`] on it, deterministically exercising the
/// metadata-check -> read TOCTOU (issue #128) instead of timing a real
/// race — the same seam-splitting technique
/// [`open_for_conversion`]/[`bounded_read`] already use for issue #117's
/// identical race on the execute side.
///
/// The size check here is a fast path only, *not* the guard: it lets an
/// already-oversized file fail before any read is attempted, but a file
/// that passes this check can still grow past `MAX_FILE_SIZE` before
/// [`take_bounded`] actually runs — that call, not this metadata, is what
/// bounds the real memory use (see `classify_file`).
fn open_for_classification(path: &Path) -> Result<std::fs::File, BatchEntry> {
    let path_str = path.to_string_lossy().into_owned();
    let file = std::fs::File::open(path).map_err(|_| BatchEntry {
        path: path_str.clone(),
        detected: String::new(),
        status: STATUS_UNDECODABLE.to_string(),
        line_ending: String::new(),
        byte_drift: false,
    })?;
    let meta = file.metadata().map_err(|_| BatchEntry {
        path: path_str.clone(),
        detected: String::new(),
        status: STATUS_UNDECODABLE.to_string(),
        line_ending: String::new(),
        byte_drift: false,
    })?;
    // Fast path only (see doc comment above): lets an already-oversized
    // file fail before attempting any read at all.
    if meta.len() > MAX_FILE_SIZE {
        return Err(BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_TOO_LARGE.to_string(),
            line_ending: String::new(),
            byte_drift: false,
        });
    }
    Ok(file)
}

/// Classify one file against the encoding axis (`target`/`target_with_bom`,
/// `target: None` meaning "keep this file's own encoding") and the
/// line-ending axis (`target_line_ending`, `"keep"` meaning "don't touch
/// it"). Never fails: an unreadable file (permission error, vanished
/// mid-scan) is reported as `undecodable` rather than aborting the whole
/// scan.
fn classify_file(
    path: &Path,
    target: Option<&'static Encoding>,
    target_with_bom: bool,
    target_line_ending: &str,
) -> BatchEntry {
    let path_str = path.to_string_lossy().into_owned();

    // Single handle carries both the fast-path size check
    // (`open_for_classification`) and the real bound (`take_bounded`) —
    // issue #128: the previous `std::fs::metadata(path)` then
    // `std::fs::read(path)` pair were two independent path resolutions, so
    // a file that grew past `MAX_FILE_SIZE` in the gap between them still
    // got read into memory in full by the second call. Scan is a dry run
    // (nothing is written), so this was never a data-integrity bug like
    // #114/#117 — but it let a file's own growth bypass the 10 MiB cap and
    // pull the whole thing into memory regardless. Same fix as issue
    // #117's `open_for_conversion`/`bounded_read` split on the execute
    // side.
    let file = match open_for_classification(path) {
        Ok(file) => file,
        Err(entry) => return entry,
    };

    // The real guard: caps the underlying reads themselves at
    // `MAX_FILE_SIZE + 1` bytes, so a file that keeps growing after the
    // fast-path check above still costs at most O(MAX_FILE_SIZE) here,
    // never O(file size).
    let Ok(bytes) = take_bounded(file) else {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: String::new(),
            byte_drift: false,
        };
    };
    // Grew past the cap between the fast-path check and this read: the
    // same outcome an already-oversized file gets from the fast path,
    // just discovered one step later.
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return BatchEntry {
            path: path_str,
            detected: String::new(),
            status: STATUS_TOO_LARGE.to_string(),
            line_ending: String::new(),
            byte_drift: false,
        };
    }

    // No per-extension hint: matches the task's "encoding::detect, no
    // hint" instruction and keeps scan/execute using the identical
    // detection path (`convert_one` also calls plain `decode_auto`).
    let decoded = encoding::decode_auto(&bytes);
    // Computed even when malformed: a malformed multi-byte sequence
    // elsewhere in the file doesn't affect the plain ASCII `\r`/`\n` bytes
    // that decide the line ending, so the report can still show a source
    // line ending for `undecodable` entries.
    let detected_line_ending = encoding::detect_line_ending(&decoded.content).to_string();
    if decoded.malformed {
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_UNDECODABLE.to_string(),
            line_ending: detected_line_ending,
            byte_drift: false,
        };
    }

    let source = Encoding::for_label(decoded.encoding.as_bytes());
    let encoding_axis_unchanged = match target {
        None => true,
        Some(t) => source == Some(t) && decoded.had_bom == target_with_bom,
    };
    // "keep" never counts as changed; otherwise the axis is unchanged only
    // when the file's own line ending already matches the target exactly
    // — a "Mixed" file never equals a concrete "LF"/"CRLF" target, so it
    // always counts as changed (convertible) against either, with no
    // special-case code needed for that rule.
    let line_ending_axis_unchanged =
        target_line_ending == "keep" || detected_line_ending == target_line_ending;

    if encoding_axis_unchanged && line_ending_axis_unchanged {
        // Issue #96 (3/3): this is the "keep" + "keep" no-op case — nothing
        // on either axis was asked to change — so a byte-drift verdict is
        // meaningful here (see `BatchEntry::byte_drift`'s doc comment).
        // Skipped (never `true`) for a Mixed on-disk line ending: same
        // precedent as `bytedrift.rs`'s `SKIP_MIXED_LINE_ENDING`, since
        // `rebuild_output_bytes` can only re-apply one pure style.
        let byte_drift = detected_line_ending != "Mixed"
            && rebuild_output_bytes(&decoded, target, target_with_bom, target_line_ending)
                .expect(
                    "a no-op target is always the file's own already-valid encoding, which \
                     always round-trips and never rejects its own decoded text as unmappable",
                )
                .0
                != bytes;
        return BatchEntry {
            path: path_str,
            detected: decoded.encoding,
            status: STATUS_ALREADY_TARGET.to_string(),
            line_ending: detected_line_ending,
            byte_drift,
        };
    }

    // Only the encoding axis can lose data; re-encoding to "keep" (the
    // same encoding the content was just decoded from) can never be
    // lossy, so a pure line-ending-only change is always `convertible`.
    let status = match target {
        None => STATUS_CONVERTIBLE,
        Some(t) => {
            // `target` was already validated as a real encoding by the
            // caller (`scan_with_limit`), and `t.name()` always
            // round-trips through `Encoding::for_label`, so this can
            // never hit the Err arm.
            let (_, unmappable) = encoding::encode(&decoded.content, t.name(), target_with_bom)
                .expect("target encoding validated by the caller");
            if unmappable {
                STATUS_LOSSY
            } else {
                STATUS_CONVERTIBLE
            }
        }
    };

    // Issue #176 (#96 3/3's other half): reaching here with
    // `encoding_axis_unchanged` true means the *only* reason this file
    // isn't `alreadyTarget` is that the line-ending axis was asked to
    // change (the branch above already returned when both axes agreed) —
    // a pure "keep the encoding, just unify line endings" request. That
    // still re-encodes the file, and re-encoding is exactly what
    // silently canonicalizes a non-injective legacy byte sequence (Big5,
    // Shift_JIS, GBK) — the same risk the `alreadyTarget` branch's
    // `byte_drift` above exists to surface, just reached from the other
    // side of the line-ending axis. `encoding_axis_unchanged` also proves
    // `status` above can only be `STATUS_CONVERTIBLE` here (re-encoding
    // into the exact encoding the content was just decoded from cannot be
    // lossy — see the doc comment right above `status`), so this never
    // races the lossy branch.
    //
    // Isolating the line-ending change from the drift verdict is the
    // whole trick: rebuild with `target`/`target_with_bom` (the requested,
    // encoding-axis-unchanged target) but `line_ending: "keep"` instead of
    // `target_line_ending` — `rebuild_output_bytes`'s "keep" path hands
    // `decoded.content` through completely untouched, bypassing
    // `normalize_to_lf`/`apply_line_ending` entirely rather than relying
    // on them round-tripping a pure style back to itself. Any mismatch
    // against the original `bytes` that remains after subtracting the
    // requested line-ending change out this way can only come from the
    // encoding step — precisely `bytedrift.rs`'s R1b question ("would an
    // encoding-preserving re-save reproduce these bytes?") asked here at
    // scan time instead of at save time.
    //
    // Skipped (stays `false`) for a Mixed on-disk line ending, same
    // precedent as the `alreadyTarget` branch's own skip: a Mixed file is
    // what pushed this file into `convertible` in the first place (it can
    // never equal a concrete "LF"/"CRLF" target), but a drift verdict
    // still isn't meaningful for it — not because the rebuild can't
    // reproduce it (the "keep" path above hands any content through
    // as-is, mixed or not) but to stay consistent with every other
    // byte_drift skip rule rather than carve out a special case that
    // treats Mixed differently here than everywhere else.
    //
    // Deliberately narrower than "any convertible entry": `false` whenever
    // `encoding_axis_unchanged` is false, i.e. whenever this file is
    // `convertible`/`lossy` because the *encoding* axis changed (or both
    // axes changed) — the user explicitly asked for that byte change, so
    // (matching the `alreadyTarget` branch's own doc comment) a drift
    // verdict there would carry no signal and must stay `false` (pinned by
    // `non_injective_pair_converting_to_a_different_encoding_is_not_flagged`).
    let byte_drift = encoding_axis_unchanged
        && detected_line_ending != "Mixed"
        && rebuild_output_bytes(&decoded, target, target_with_bom, "keep")
            .expect(
                "encoding axis unchanged means target is the file's own already-valid \
                 encoding, which always round-trips and never rejects its own decoded \
                 text as unmappable",
            )
            .0
            != bytes;

    BatchEntry {
        path: path_str,
        detected: decoded.encoding,
        status: status.to_string(),
        line_ending: detected_line_ending,
        byte_drift,
    }
}

/// Core of `scan_batch_conversion`, parameterized by the file-count cap so
/// tests can exercise the cap cheaply (see `scan_aborts_over_the_limit`)
/// instead of creating thousands of fixture files.
fn scan_with_limit(
    dir: &str,
    extensions: &[String],
    target_encoding: &str,
    target_with_bom: bool,
    line_ending: &str,
    limit: usize,
) -> Result<BatchScanReport, String> {
    let target = resolve_target_encoding(target_encoding)?;
    validate_line_ending(line_ending)?;
    let lower_extensions: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let root = Path::new(dir);

    // Fail closed if the root folder itself can't even be listed (doesn't
    // exist, permissions revoked, vanished) — an empty report would look
    // identical to "genuinely no matching files" and hand the user false
    // confidence to proceed with a destructive convert over what's really
    // a scan that never ran (issue #116). This is deliberately a harder
    // failure than a nested subdirectory hitting the same error inside
    // `collect_files` below, which instead records the error and keeps
    // whatever the rest of the tree can still offer.
    std::fs::read_dir(root).map_err(|e| format!("Cannot read folder {dir}: {e}"))?;

    let mut files = Vec::new();
    let mut scan_errors = Vec::new();
    collect_files(root, &lower_extensions, limit, &mut files, &mut scan_errors)?;

    let entries = files
        .iter()
        .map(|path| classify_file(path, target, target_with_bom, line_ending))
        .collect();
    Ok(BatchScanReport {
        entries,
        scan_errors,
    })
}

/// Dry-run scan: classify every matching file under `dir` against the
/// encoding axis (`target_encoding`/`target_with_bom`) and the
/// line-ending axis (`line_ending`) without changing anything on disk.
/// `target_encoding` is a canonical encoding name or the sentinel
/// `"keep"` (leave each file's own encoding alone — `target_with_bom` is
/// then ignored). `line_ending` is one of `"keep"` | `"LF"` | `"CRLF"`.
/// `extensions` is a list of lowercase, dot-less extensions ("txt", not
/// ".txt" or "TXT" — matching is case-insensitive regardless); an empty
/// list matches every file. See `classify_file` for the per-file
/// decision: `tooLarge` (> 10 MiB) short-circuits before any read;
/// otherwise the file is auto-detected (no per-extension hint, matching
/// `encoding::decode_auto`) and classified `undecodable` / `alreadyTarget`
/// (both axes unchanged) / `lossy` / `convertible`.
///
/// Issue #116: this returns `Err` outright if `dir` itself can't be
/// listed (missing, permissions) rather than an empty-looking report.
/// Once the walk is underway, a subdirectory or entry that can't be read
/// no longer silently vanishes from the report either — it's recorded in
/// the returned `BatchScanReport.scan_errors`, which the frontend must
/// surface as an incomplete-scan warning rather than treating `entries`
/// alone as the full picture.
#[tauri::command]
pub fn scan_batch_conversion(
    dir: String,
    extensions: Vec<String>,
    target_encoding: String,
    target_with_bom: bool,
    line_ending: String,
) -> Result<BatchScanReport, String> {
    scan_with_limit(
        &dir,
        &extensions,
        &target_encoding,
        target_with_bom,
        &line_ending,
        MAX_FILES,
    )
}

/// Open `path` once, run the fast metadata size check, and capture the
/// [`Fingerprint`] tied to that same handle — but read no bytes yet.
/// Split out from [`read_for_conversion`] so a test can grow the file
/// behind the returned handle (through a second, independent handle to
/// the same path) before ever calling [`bounded_read`] on it,
/// deterministically exercising the metadata-check -> read TOCTOU (issue
/// #117) instead of timing a real race — the same seam-splitting
/// [`read_for_conversion`]/[`commit_conversion`] already use for issue
/// #114's race (see `external_write_after_read_is_not_clobbered`).
///
/// The size check here is a fast path only, *not* the guard: it lets an
/// already-oversized file fail before any read is attempted, but a file
/// that passes this check can still grow past `MAX_FILE_SIZE` before
/// [`bounded_read`] actually runs — that call, not this metadata, is what
/// bounds the real memory use.
fn open_for_conversion(path: &str) -> Result<(std::fs::File, Fingerprint), BatchConvertResult> {
    let file = std::fs::File::open(path).map_err(|e| BatchConvertResult {
        path: path.to_string(),
        ok: false,
        message: format!("Failed to read: {e}"),
    })?;
    let meta = file.metadata().map_err(|e| BatchConvertResult {
        path: path.to_string(),
        ok: false,
        message: format!("Failed to read: {e}"),
    })?;
    // Fast path only (see doc comment above): lets an already-oversized
    // file fail before attempting any read at all.
    if meta.len() > MAX_FILE_SIZE {
        return Err(BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File is now too large; skipped.".to_string(),
        });
    }
    let fingerprint = Fingerprint::from_metadata(&meta).map_err(|e| BatchConvertResult {
        path: path.to_string(),
        ok: false,
        message: format!("Failed to read: {e}"),
    })?;
    Ok((file, fingerprint))
}

/// Read at most `MAX_FILE_SIZE + 1` bytes from `file` — the real size
/// guard for batch conversion (issue #117). Unlike the metadata check in
/// [`open_for_conversion`], this bounds the bytes actually pulled into
/// memory no matter how much the file has grown since that check,
/// including growth that happens entirely within the gap between the
/// check and this call: `Read::take` caps the underlying reads
/// themselves, so a file that keeps growing indefinitely still costs at
/// most `O(MAX_FILE_SIZE)` here, never `O(file size)`. The `+ 1` sentinel
/// turns "read exactly `MAX_FILE_SIZE` bytes, file fits" (fine) into a
/// distinguishable "there was at least one more byte past the cap" (too
/// large) without ever reading further to confirm it — same technique as
/// `open_document`'s bounded preview read (issue #59/#69).
fn take_bounded(file: std::fs::File) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(MAX_FILE_SIZE as usize + 1);
    file.take(MAX_FILE_SIZE + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// [`take_bounded`] wrapped with the `BatchConvertResult` failure this
/// module reports through: a file whose bounded read comes back longer
/// than `MAX_FILE_SIZE` grew past the cap since [`open_for_conversion`]'s
/// metadata check, and must fail here exactly as if it had already been
/// too large at open time (issue #117).
fn bounded_read(file: std::fs::File, path: &str) -> Result<Vec<u8>, BatchConvertResult> {
    let bytes = take_bounded(file).map_err(|e| BatchConvertResult {
        path: path.to_string(),
        ok: false,
        message: format!("Failed to read: {e}"),
    })?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File grew past the size limit during read; skipped.".to_string(),
        });
    }
    Ok(bytes)
}

/// Read `path`'s current bytes together with a [`Fingerprint`] tied to the
/// exact handle they were read through: `path` is opened once
/// ([`open_for_conversion`]), and the size check, fingerprint capture, and
/// read ([`bounded_read`]) all go through that same `File`, so the
/// fingerprint is guaranteed to describe precisely the bytes this call
/// returns — not merely whatever the path happened to resolve to at a
/// separate, independent `stat` (mirroring `streamreplace.rs`'s
/// `capture_fingerprint`, both via `fsguard.rs`). Tighter than
/// re-`stat`ing the path is worth it here even though this call is a
/// single one-shot read rather than a long streaming run: it also
/// collapses the size-check-then-read into one held-open file descriptor
/// instead of two independent path resolutions.
///
/// Split into [`open_for_conversion`] and [`bounded_read`] so tests get
/// two independent injectable seams: a test can call this whole function,
/// replace the file out from under the returned fingerprint, then call
/// `commit_conversion` directly to exercise the read -> commit race
/// deterministically (issue #114, see
/// `external_write_after_read_is_not_clobbered`); or call just
/// `open_for_conversion`, grow the file behind its handle, then call
/// `bounded_read` directly to exercise the metadata-check -> read race
/// (issue #117, see
/// `file_grown_past_the_limit_after_the_metadata_check_fails_the_bounded_read`).
fn read_for_conversion(path: &str) -> Result<(Vec<u8>, Fingerprint), BatchConvertResult> {
    let (file, fingerprint) = open_for_conversion(path)?;
    let bytes = bounded_read(file, path)?;
    Ok((bytes, fingerprint))
}

/// Rebuild the exact output bytes the batch pipeline would write for a file
/// already decoded via [`encoding::decode_auto`]: selects the line-ending
/// axis (`line_ending`, `"keep"` leaves `decoded.content` exactly as
/// decoded — *not* passed through `encoding::normalize_to_lf` the way
/// `lib.rs::open_document` does for the editor buffer) then encodes to the
/// resolved target axis (`target`/`with_bom`, `target: None` keeps the
/// file's own detected encoding and BOM state, mirroring `classify_file`'s
/// own resolution). Shared by [`commit_conversion`] (the real execute path)
/// and `classify_file`'s two byte-drift probes — the `alreadyTarget`
/// no-op case (issue #96 3/3) and the `convertible`,
/// encoding-axis-unchanged-but-line-ending-changed case (issue #176),
/// which deliberately calls this with `line_ending: "keep"` rather than
/// its own requested target so the rebuild isolates the encoding step
/// from the line-ending change being asked for — so a scan-time drift
/// verdict can never quietly diverge from what execute actually writes —
/// all call sites decode independently (scan and execute never trust each
/// other's snapshot) but funnel through this one transform.
fn rebuild_output_bytes(
    decoded: &encoding::DecodedText,
    target: Option<&'static Encoding>,
    with_bom: bool,
    line_ending: &str,
) -> Result<(Vec<u8>, bool), String> {
    let content = if line_ending == "keep" {
        std::borrow::Cow::Borrowed(decoded.content.as_str())
    } else {
        std::borrow::Cow::Owned(encoding::apply_line_ending(
            &encoding::normalize_to_lf(&decoded.content),
            line_ending,
        ))
    };

    let (target_encoding, target_with_bom) = match target {
        Some(t) => (t, with_bom),
        None => (
            // `decoded.encoding` is the name of the encoding that just
            // successfully decoded these bytes, which always round-trips
            // through `Encoding::for_label` (same guarantee
            // `classify_file` relies on for its own target).
            Encoding::for_label(decoded.encoding.as_bytes())
                .expect("decode_auto's reported encoding always round-trips"),
            decoded.had_bom,
        ),
    };

    encoding::encode(&content, target_encoding.name(), target_with_bom)
}

/// Decode `bytes` (already read from `path` — see [`read_for_conversion`]),
/// re-encode to `target`/`with_bom` (`target: None` keeps the file's own
/// detected encoding and BOM state), optionally unifying line endings to
/// `line_ending` first (`"keep"` leaves them exactly as decoded), then
/// atomically writes the result. Never partially writes: a decode or
/// encode failure returns `ok: false` with the original file left
/// untouched. Re-encoding is not guaranteed to reproduce the original
/// bytes even when the conversion request should change nothing — see the
/// module doc's `"keep"` + `"keep"` caveat and `encoding::encode`'s
/// round-trip contract note.
///
/// Issue #114: immediately before the commit (`atomic_write`), the
/// resolved destination (see below) is re-fingerprinted and compared
/// against `fingerprint` — the snapshot [`read_for_conversion`] captured
/// when it read `bytes`. A mismatch (including the file no longer
/// existing at all) means some other process atomically replaced the file
/// after this conversion read it but before it wrote back; this fails
/// closed, reporting the file `ok: false` without ever touching its
/// now-external content — the same discipline `streamreplace.rs`'s
/// `verify_unchanged` and `save_document`'s `expected_fingerprint` check
/// already apply (both share `fsguard.rs`). One file failing this check
/// never stops the rest of the batch: see `execute_batch_conversion`.
///
/// `path` is resolved past any destination symlink exactly once
/// (`lib.rs::resolve_write_destination`), and that same resolved path is
/// what both the fingerprint check above and the eventual `atomic_write`
/// use — never two independent resolves for the two steps (issue #301
/// review, round 5; see `resolve_write_destination`'s doc comment for why
/// that would reopen the exact redirection issue #301 itself was about).
fn commit_conversion(
    path: &str,
    bytes: &[u8],
    fingerprint: &Fingerprint,
    target: Option<&'static Encoding>,
    with_bom: bool,
    line_ending: &str,
) -> BatchConvertResult {
    // `decoded.content` here is the *raw* decode of the file's own bytes
    // (CR/CRLF/LF exactly as they are on disk) — deliberately not passed
    // through `encoding::normalize_to_lf` the way `lib.rs::open_document`
    // does for the editor buffer, *unless* `line_ending` asks for a
    // line-ending change below. With `line_ending: "keep"`, re-encoding it
    // straight back changes only the byte-level encoding; every line
    // ending is preserved.
    let decoded = encoding::decode_auto(bytes);
    if decoded.malformed {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File no longer decodes cleanly; skipped.".to_string(),
        };
    }

    let (out_bytes, unmappable) =
        match rebuild_output_bytes(&decoded, target, with_bom, line_ending) {
            Ok(result) => result,
            Err(e) => {
                return BatchConvertResult {
                    path: path.to_string(),
                    ok: false,
                    message: e,
                }
            }
        };
    if unmappable {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "Some characters can't be represented in the target encoding; skipped."
                .to_string(),
        };
    }

    // Byte-identical output means there is nothing to convert (a pure
    // ASCII file "converting" to UTF-8, say, or any file under
    // "keep"+"keep"): skip the write entirely so the file's mtime is
    // untouched and no watcher reload fires for a no-op (adversarial-review
    // finding).
    if out_bytes == bytes {
        return BatchConvertResult {
            path: path.to_string(),
            ok: true,
            message: "Already byte-identical; not rewritten.".to_string(),
        };
    }

    // Resolve the destination once, then use the SAME resolved path for
    // both the re-verify check below and the write itself (issue #301
    // review, round 5): resolving independently for each -- a fresh
    // resolve inside a "follow symlinks" writer, decoupled from whatever
    // path the check above validated -- would let a symlink repoint
    // landing between the two resolves redirect content validated against
    // the OLD target onto a completely different, never-checked file. See
    // `lib.rs::resolve_write_destination`'s doc comment for the full
    // rationale. `path` is always a file the user selected for batch
    // conversion, never an internal app-state path, so following a
    // destination symlink at all is correct in the first place.
    let write_target = match crate::resolve_write_destination(Path::new(path)) {
        Ok((target, _, _)) => target,
        Err(e) => {
            return BatchConvertResult {
                path: path.to_string(),
                ok: false,
                message: format!("Failed to resolve destination: {e}"),
            }
        }
    };

    // Re-verify right before the write: fail closed if `write_target` no
    // longer matches the fingerprint `read_for_conversion` captured when
    // it read `bytes` -- some other process atomically replaced the file
    // in between (issue #114). Never write over content this call never
    // actually saw.
    if !fingerprint.matches_path(&write_target) {
        return BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: "File changed on disk during conversion; skipped, not written.".to_string(),
        };
    }

    match crate::atomic_write(&write_target, &out_bytes) {
        // `atomic_write` now returns a `CommitOutcome` (issues #324/#328).
        // Neither `fingerprint` nor `durability_warning` has anywhere
        // meaningful to land in `BatchConvertResult`: batch conversion
        // doesn't track a per-file staleness baseline the way
        // `save_document` does, and `batchconvert.ts`'s own renderResults
        // never displays `message` for an `ok: true` entry at all (only
        // the failed-entries list reads it), so putting the warning there
        // would be exactly as silent as dropping it outright while looking
        // like it wasn't. Out of this round's explicit scope (only
        // `save_document` and the two streaming commit paths were asked to
        // surface this) -- discarded here for the same reason
        // `store.rs`/`backup.rs`/`migrate.rs::write_marker` already do.
        Ok(_outcome) => BatchConvertResult {
            path: path.to_string(),
            ok: true,
            message: String::new(),
        },
        Err(e) => BatchConvertResult {
            path: path.to_string(),
            ok: false,
            message: format!("Failed to write: {e}"),
        },
    }
}

/// Convert one file end to end: read + fingerprint (never trust the scan's
/// snapshot — the file may have changed since the dry run), then decode,
/// re-encode, and commit — see [`read_for_conversion`] and
/// [`commit_conversion`] for the two halves and issue #114's read -> commit
/// guard.
fn convert_one(
    path: &str,
    target: Option<&'static Encoding>,
    with_bom: bool,
    line_ending: &str,
) -> BatchConvertResult {
    let (bytes, fingerprint) = match read_for_conversion(path) {
        Ok(pair) => pair,
        Err(failure) => return failure,
    };
    commit_conversion(path, &bytes, &fingerprint, target, with_bom, line_ending)
}

/// Convert every path in `paths` to `target_encoding`/`with_bom` (or leave
/// each file's own encoding alone with `target_encoding: "keep"`),
/// unifying line endings per `line_ending` (`"keep"` | `"LF"` | `"CRLF"`).
/// One file's failure never stops the batch — every path gets its own
/// `BatchConvertResult`. `paths` is normally the `convertible` subset of a
/// prior `scan_batch_conversion` report, but this never trusts that: each
/// file is independently re-detected and re-encoded (see `convert_one`).
#[tauri::command]
pub fn execute_batch_conversion(
    paths: Vec<String>,
    target_encoding: String,
    with_bom: bool,
    line_ending: String,
) -> Result<Vec<BatchConvertResult>, String> {
    let target = resolve_target_encoding(&target_encoding)?;
    validate_line_ending(&line_ending)?;
    Ok(paths
        .iter()
        .map(|path| convert_one(path, target, with_bom, &line_ending))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojidori-batch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Find the entry (or converted-result) whose path's file name matches
    /// `file_name`, comparing by `Path::file_name` (not a raw string
    /// suffix) so this works regardless of the platform's path separator.
    fn entry_for<'a>(entries: &'a [BatchEntry], file_name: &str) -> &'a BatchEntry {
        entries
            .iter()
            .find(|e| {
                Path::new(&e.path)
                    .file_name()
                    .is_some_and(|n| n == file_name)
            })
            .unwrap_or_else(|| panic!("missing entry for {file_name} in {entries:?}"))
    }

    // Proven-reliable fixtures for statistical (non-BOM) detection — long
    // enough for chardetng to reach a confident verdict; short CJK samples
    // are genuinely ambiguous across legacy encodings (see encoding.rs's
    // own `detects_big5_from_realistic_sample` comment).
    const BIG5_TEXT_A: &str =
        "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。\nFile A.\n";
    const BIG5_TEXT_B: &str = "今天天氣非常晴朗，適合出門散步與閱讀書籍，心情也跟著愉快起來，\
         這是另一份用來測試批次轉換的繁體中文文件。\nFile B.\n";
    const SHIFT_JIS_TEXT: &str = "日本語文字エンコーディングの検出テストです。これは自動検出機能を検証するための文章であり、句読点や一般的な語彙も含まれています。\n";
    /// Same content as `BIG5_TEXT_A`, split across CRLF line endings, to
    /// lock that conversion never touches line endings.
    const BIG5_CRLF_TEXT: &str = "中文編碼偵測測試。\r\n這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。\r\n";

    #[test]
    fn round_trip_classifies_and_converts_a_mixed_tree() {
        let dir = fixture_dir("roundtrip");

        let (big5_a, u) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("a.txt"), &big5_a).unwrap();

        let (big5_b, u) = encoding::encode(BIG5_TEXT_B, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("b.txt"), &big5_b).unwrap();

        let utf8_text = "已經是 UTF-8 內容，測試 alreadyTarget 分類。";
        std::fs::write(dir.join("c.txt"), utf8_text.as_bytes()).unwrap();

        let emoji_text = "emoji 測試 🚀 已經是 UTF-8。";
        std::fs::write(dir.join("emoji.txt"), emoji_text.as_bytes()).unwrap();

        let (crlf_bytes, u) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(dir.join("crlf.txt"), &crlf_bytes).unwrap();

        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let (sjis_bytes, u) = encoding::encode(SHIFT_JIS_TEXT, "Shift_JIS", false).unwrap();
        assert!(!u);
        std::fs::write(sub.join("d.txt"), &sjis_bytes).unwrap();

        // Fake binary with a mismatched extension on purpose: the
        // extension filter below (["txt"]) is what keeps it out of scope,
        // not `malformed` detection (arbitrary bytes very often decode
        // "cleanly" under some single-byte fallback encoding — see the
        // module doc comment).
        std::fs::write(
            dir.join("e.png"),
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 1, 2, 3],
        )
        .unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec!["txt".to_string()],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();

        assert_eq!(
            report.entries.len(),
            6,
            "6 .txt files (a, b, c, emoji, crlf, sub/d) — the .png must be excluded \
             by the extension filter: {:?}",
            report.entries
        );
        assert_eq!(
            entry_for(&report.entries, "a.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "a.txt").detected, "Big5");
        assert_eq!(
            entry_for(&report.entries, "b.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "b.txt").detected, "Big5");
        assert_eq!(
            entry_for(&report.entries, "c.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(entry_for(&report.entries, "c.txt").detected, "UTF-8");
        assert_eq!(
            entry_for(&report.entries, "emoji.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(
            entry_for(&report.entries, "d.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "d.txt").detected, "Shift_JIS");
        assert_eq!(
            entry_for(&report.entries, "crlf.txt").status,
            STATUS_CONVERTIBLE
        );
        assert_eq!(entry_for(&report.entries, "crlf.txt").detected, "Big5");

        // Every entry's detected source line ending is reported (all these
        // fixtures are single-style: LF-only or CRLF-only).
        assert_eq!(entry_for(&report.entries, "a.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "b.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "c.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "emoji.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "d.txt").line_ending, "LF");
        assert_eq!(entry_for(&report.entries, "crlf.txt").line_ending, "CRLF");

        // Convert the convertible subset (alreadyTarget files excluded).
        let paths = vec![
            dir.join("a.txt").to_string_lossy().into_owned(),
            dir.join("b.txt").to_string_lossy().into_owned(),
            sub.join("d.txt").to_string_lossy().into_owned(),
            dir.join("crlf.txt").to_string_lossy().into_owned(),
        ];
        let results = execute_batch_conversion(
            paths.clone(),
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 4);
        for result in &results {
            assert!(result.ok, "{result:?}");
        }

        // Re-read every converted file: content matches the original
        // decoded text exactly, encoding is now UTF-8 with no BOM.
        for (path, expected) in [
            (dir.join("a.txt"), BIG5_TEXT_A),
            (dir.join("b.txt"), BIG5_TEXT_B),
            (sub.join("d.txt"), SHIFT_JIS_TEXT),
            (dir.join("crlf.txt"), BIG5_CRLF_TEXT),
        ] {
            let bytes = std::fs::read(&path).unwrap();
            assert_ne!(
                &bytes[..bytes.len().min(3)],
                [0xEF, 0xBB, 0xBF],
                "no BOM was requested"
            );
            let decoded = encoding::decode_auto(&bytes);
            assert_eq!(decoded.encoding, "UTF-8");
            assert!(!decoded.malformed);
            assert_eq!(decoded.content, expected, "content mismatch for {path:?}");
        }

        // The CRLF fixture specifically: line endings must survive
        // byte-for-byte, never collapsed to LF.
        let crlf_bytes = std::fs::read(dir.join("crlf.txt")).unwrap();
        let crlf_text = String::from_utf8(crlf_bytes).unwrap();
        assert_eq!(
            crlf_text.matches("\r\n").count(),
            BIG5_CRLF_TEXT.matches("\r\n").count(),
            "every CRLF must survive the conversion"
        );
        assert_eq!(crlf_text, BIG5_CRLF_TEXT);

        // Untouched files: alreadyTarget and the extension-filtered .png.
        assert_eq!(
            std::fs::read(dir.join("c.txt")).unwrap(),
            utf8_text.as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.join("emoji.txt")).unwrap(),
            emoji_text.as_bytes()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn execute_refuses_lossy_conversion_and_leaves_bytes_untouched() {
        let dir = fixture_dir("lossy");
        let original = "rocket emoji not representable in Big5: 🚀"
            .as_bytes()
            .to_vec();
        let file = dir.join("emoji.txt");
        std::fs::write(&file, &original).unwrap();
        let path = file.to_string_lossy().into_owned();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "Big5".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_LOSSY);

        // Force execute on the flagged path anyway: the real safety net
        // must be here, not merely in the UI's respect for the scan's
        // advice.
        let results = execute_batch_conversion(
            vec![path.clone()],
            "Big5".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].ok);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            original,
            "a refused conversion must never touch the file's bytes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_aborts_over_the_limit() {
        let dir = fixture_dir("limit");
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), "hello").unwrap();
        }

        let err = scan_with_limit(
            dir.to_string_lossy().as_ref(),
            &[],
            "UTF-8",
            false,
            "keep",
            3,
        )
        .unwrap_err();
        assert!(
            err.contains('3'),
            "error message should mention the limit: {err}"
        );

        let ok = scan_with_limit(
            dir.to_string_lossy().as_ref(),
            &[],
            "UTF-8",
            false,
            "keep",
            10,
        )
        .unwrap();
        assert_eq!(ok.entries.len(), 5);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn too_large_files_are_skipped_without_reading() {
        let dir = fixture_dir("toolarge");
        let file = dir.join("big.bin");
        let data = vec![b'a'; (MAX_FILE_SIZE + 1) as usize];
        std::fs::write(&file, &data).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].status, STATUS_TOO_LARGE);
        assert_eq!(report.entries[0].detected, "");
        assert_eq!(report.entries[0].line_ending, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn already_target_requires_matching_bom_state_not_just_encoding_name() {
        let dir = fixture_dir("bom-mismatch");
        let (bytes, _) = encoding::encode("hello world", "UTF-8", true).unwrap();
        std::fs::write(dir.join("bom.txt"), &bytes).unwrap();

        // Same encoding name, but the target wants no BOM: must not be
        // treated as already-converted.
        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries[0].status, STATUS_CONVERTIBLE);

        // Target matching the BOM too: genuinely already-target.
        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            true,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries[0].status, STATUS_ALREADY_TARGET);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extension_filter_is_case_insensitive_and_dot_less() {
        let lower = vec!["txt".to_string(), "md".to_string()];
        assert!(extension_matches(Path::new("/a/b/file.TXT"), &lower));
        assert!(extension_matches(Path::new("/a/b/file.md"), &lower));
        assert!(!extension_matches(Path::new("/a/b/file.rs"), &lower));
        assert!(!extension_matches(Path::new("/a/b/file"), &lower));
        assert!(extension_matches(Path::new("/a/b/anything"), &[]));
    }

    /// Adversarial-review follow-up: a pure ASCII file detects as
    /// windows-1252, classifies as convertible toward UTF-8, and would be
    /// rewritten byte-for-byte identical — pointlessly churning mtime and
    /// firing watcher reloads. Byte-identical output must skip the write.
    #[test]
    fn byte_identical_conversion_skips_the_write() {
        let dir = fixture_dir("noop");
        let file = dir.join("ascii.txt");
        std::fs::write(&file, b"plain ascii, nothing to convert\n").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();

        let results = execute_batch_conversion(
            vec![file.to_string_lossy().into_owned()],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok);
        assert!(
            results[0].message.contains("byte-identical"),
            "no-op must be reported as such, got: {}",
            results[0].message
        );
        let after = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(before, after, "file must not be rewritten");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Core red-to-green case for this PR: line endings unify while the
    /// encoding axis is left alone (`target_encoding: "keep"`).
    #[test]
    fn converts_crlf_to_lf_keeping_encoding() {
        let dir = fixture_dir("crlf-to-lf-keep-encoding");
        let (bytes, unmappable) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(decoded.encoding, "Big5", "encoding axis was kept");
        assert_eq!(encoding::detect_line_ending(&decoded.content), "LF");
        assert_eq!(decoded.content, encoding::normalize_to_lf(BIG5_CRLF_TEXT));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Both axes change together: encoding and line ending in one pass.
    #[test]
    fn converts_lf_to_crlf_with_encoding_change() {
        let dir = fixture_dir("lf-to-crlf-with-encoding-change");
        let file = dir.join("a.txt");
        std::fs::write(&file, BIG5_TEXT_A.as_bytes()).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "Big5".to_string(),
            false,
            "CRLF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(decoded.encoding, "Big5");
        assert_eq!(encoding::detect_line_ending(&decoded.content), "CRLF");
        assert_eq!(decoded.content, BIG5_TEXT_A.replace('\n', "\r\n"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A Mixed-line-ending source file collapses entirely to the requested
    /// target, not just its majority style.
    #[test]
    fn mixed_line_endings_unify() {
        let dir = fixture_dir("mixed-unify");
        let text = "第一行結尾是 CRLF。\r\n第二行結尾是 LF。\n第三行結尾是 CRLF。\r\n";
        assert_eq!(
            encoding::detect_line_ending(text),
            "Mixed",
            "fixture must actually mix CRLF and LF"
        );
        let file = dir.join("a.txt");
        std::fs::write(&file, text.as_bytes()).unwrap();
        let path = file.to_string_lossy().into_owned();

        let results = execute_batch_conversion(
            vec![path.clone()],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(encoding::detect_line_ending(&decoded.content), "LF");
        assert_eq!(decoded.content, encoding::normalize_to_lf(text));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `keep` + `keep`: neither axis changes, so every file — regardless
    /// of its own encoding or line ending — classifies `alreadyTarget`.
    #[test]
    fn keep_keep_classifies_already_target() {
        let dir = fixture_dir("keep-keep");
        std::fs::write(
            dir.join("utf8-mixed.txt"),
            "已經是 UTF-8。\r\n混合行尾。\n第三行。\r\n".as_bytes(),
        )
        .unwrap();
        let (big5_bytes, unmappable) = encoding::encode(BIG5_CRLF_TEXT, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(dir.join("big5-crlf.txt"), &big5_bytes).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "keep".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 2);
        for entry in &report.entries {
            assert_eq!(entry.status, STATUS_ALREADY_TARGET, "{entry:?}");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #96 (3/3), failing-test-first: `BatchEntry::byte_drift`.
    // Same non-injective Big5 pair as `encoding.rs`'s
    // `big5_non_canonical_bytes_are_canonicalized_on_encode` and
    // `bytedrift.rs`'s own tests (0x8E 0x69 decodes cleanly to "箸", but
    // re-encoding "箸" always produces its canonical form BA E6). Appended
    // to a long, chardetng-reliable Big5 sample (`BIG5_TEXT_A`) at a clean
    // character boundary (right after its own trailing `\n`) so detection
    // stays confidently "Big5" — a bare 2-byte fixture has no statistical
    // signal for auto-detection to key off (this module's own comment on
    // `BIG5_TEXT_A` explains why short CJK samples are ambiguous).

    /// (1) Core case: Big5 -> Big5, line ending "keep" — nothing on either
    /// axis is asked to change, so this is the no-op `alreadyTarget` case
    /// `byte_drift` exists to catch. Red before `classify_file`'s
    /// `alreadyTarget` branch called `rebuild_output_bytes` (it returned
    /// the stub `byte_drift: false` unconditionally).
    #[test]
    fn same_encoding_no_op_with_non_injective_pair_reports_byte_drift() {
        let dir = fixture_dir("byte-drift-non-injective");
        let (mut bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&[0x8E, 0x69]);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"Big5"),
            false,
            "keep",
        );
        assert_eq!(result.status, STATUS_ALREADY_TARGET, "{result:?}");
        assert!(result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (2) An ordinary, canonical Big5 file (no non-injective bytes) must
    /// not false-positive: the no-op case is real, but there is nothing to
    /// drift.
    #[test]
    fn same_encoding_no_op_with_clean_bytes_reports_no_byte_drift() {
        let dir = fixture_dir("byte-drift-clean");
        let (bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"Big5"),
            false,
            "keep",
        );
        assert_eq!(result.status, STATUS_ALREADY_TARGET, "{result:?}");
        assert!(!result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (3) Big5 -> UTF-8: the encoding axis is explicitly asked to change,
    /// so this is `convertible`, not `alreadyTarget` — any byte change
    /// (including this same non-injective pair's canonicalization) is
    /// requested, not drift, and must stay unflagged.
    #[test]
    fn non_injective_pair_converting_to_a_different_encoding_is_not_flagged() {
        let dir = fixture_dir("byte-drift-cross-encoding");
        let (mut bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&[0x8E, 0x69]);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"UTF-8"),
            false,
            "keep",
        );
        assert_eq!(result.status, STATUS_CONVERTIBLE, "{result:?}");
        assert!(!result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (4) Issue #176 (#96 3/3's other half): Big5 -> Big5 (encoding axis
    /// unchanged) but LF -> CRLF (line ending explicitly asked to change).
    /// This *is* the requested-line-ending-change case, but the encoding
    /// axis is untouched, so it's exactly as much a candidate for silent
    /// canonicalization as the `alreadyTarget` no-op case above — the user
    /// asked only for line endings to change, not for these legacy bytes to
    /// be normalized. `byte_drift` must therefore be `true`: before issue
    /// #176's fix this asserted `false` (green), which is why this test
    /// case is the failing-test-first pin for that fix (was named
    /// `..._is_not_flagged`; flipped to `..._is_flagged` here).
    #[test]
    fn non_injective_pair_with_a_requested_line_ending_change_is_flagged() {
        let dir = fixture_dir("byte-drift-line-ending-change");
        let (mut bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&[0x8E, 0x69]);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"Big5"),
            false,
            "CRLF",
        );
        assert_eq!(result.status, STATUS_CONVERTIBLE, "{result:?}");
        assert!(result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (4b) Issue #176 twin of (4): an ordinary, canonical Big5 file (no
    /// non-injective bytes) going through the exact same requested
    /// LF -> CRLF conversion must *not* false-positive — the line-ending
    /// bytes changing is expected (that's what was asked for), and there is
    /// no non-canonical sequence for the encoding step to silently
    /// canonicalize. Same "no false alarm on the common case" role as (2)
    /// plays for the `alreadyTarget` branch.
    #[test]
    fn clean_bytes_with_a_requested_line_ending_change_reports_no_byte_drift() {
        let dir = fixture_dir("byte-drift-line-ending-change-clean");
        let (bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"Big5"),
            false,
            "CRLF",
        );
        assert_eq!(result.status, STATUS_CONVERTIBLE, "{result:?}");
        assert!(!result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (4c) Issue #176: a Mixed on-disk line ending forces `convertible`
    /// against any concrete LF/CRLF target (it can never equal "Mixed"),
    /// with the encoding axis otherwise unchanged — the same shape as (4)
    /// but with a source line ending `rebuild_output_bytes` can't
    /// reproduce. Must skip (`byte_drift: false`) exactly like the
    /// `alreadyTarget` branch's own Mixed skip (5) above, even though the
    /// fixture embeds the same non-injective pair (4) proves would
    /// otherwise be flagged — proving the Mixed skip takes precedence
    /// rather than this being a coincidental false.
    #[test]
    fn mixed_source_with_a_requested_line_ending_change_skips_byte_drift() {
        let dir = fixture_dir("byte-drift-line-ending-change-mixed");
        let (mut bytes, unmappable) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&[0x8E, 0x69]);
        let (tail, unmappable) =
            encoding::encode("second line ends CRLF\r\n", "Big5", false).unwrap();
        assert!(!unmappable);
        bytes.extend_from_slice(&tail);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(Path::new(&path), Encoding::for_label(b"Big5"), false, "LF");
        assert_eq!(
            result.line_ending, "Mixed",
            "fixture must actually mix line-ending styles"
        );
        assert_eq!(result.status, STATUS_CONVERTIBLE, "{result:?}");
        assert!(!result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// (5) A Mixed on-disk line ending with `line_ending: "keep"` still
    /// classifies `alreadyTarget` ("keep" never disagrees with any
    /// detected style), but `rebuild_output_bytes` can only re-apply one
    /// pure style, so it can never reproduce a mixed file — same
    /// unreproducible-pipeline precedent as `bytedrift.rs`'s
    /// `SKIP_MIXED_LINE_ENDING`. `byte_drift` must stay `false` (skipped,
    /// not computed) rather than attempt a meaningless verdict.
    #[test]
    fn mixed_line_ending_no_op_skips_byte_drift() {
        let dir = fixture_dir("byte-drift-mixed");
        let text = format!("{}second line ends CRLF\r\n", BIG5_TEXT_A);
        assert_eq!(
            encoding::detect_line_ending(&text),
            "Mixed",
            "fixture must actually mix line-ending styles"
        );
        let (bytes, unmappable) = encoding::encode(&text, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = dir.join("a.txt");
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let result = classify_file(
            Path::new(&path),
            Encoding::for_label(b"Big5"),
            false,
            "keep",
        );
        assert_eq!(result.status, STATUS_ALREADY_TARGET, "{result:?}");
        assert_eq!(result.line_ending, "Mixed");
        assert!(!result.byte_drift, "{result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression lock for issue #82: `detect_line_ending` was blind to
    /// lone CR (Classic Mac line endings), so a CR-only file classified
    /// `alreadyTarget` against an "LF" target — misreported as already
    /// "LF" — and batch conversion silently skipped it, leaving CR bytes
    /// on disk despite the user asking to convert everything to LF.
    #[test]
    fn cr_only_file_classifies_convertible_and_converts_to_lf() {
        let dir = fixture_dir("cr-only");
        let text = "第一行\r第二行\r第三行\r";
        let file = dir.join("a.txt");
        // Written as raw bytes directly, independent of any encoding/
        // line-ending helper this test is meant to exercise.
        std::fs::write(&file, text.as_bytes()).unwrap();
        let path = file.to_string_lossy().into_owned();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(report.entries.len(), 1);
        assert_eq!(
            report.entries[0].line_ending, "CR",
            "lone CR must be detected and reported, not misreported as LF"
        );
        assert_eq!(
            report.entries[0].status, STATUS_CONVERTIBLE,
            "a CR file must never classify alreadyTarget against an LF target"
        );

        let results = execute_batch_conversion(
            vec![path.clone()],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let out_bytes = std::fs::read(&file).unwrap();
        let decoded = encoding::decode_auto(&out_bytes);
        assert_eq!(encoding::detect_line_ending(&decoded.content), "LF");
        assert_eq!(decoded.content, encoding::normalize_to_lf(text));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The line-ending axis alone decides `alreadyTarget` vs `convertible`
    /// when the encoding axis is `keep` throughout.
    #[test]
    fn line_ending_axis_affects_classification() {
        let dir = fixture_dir("line-ending-axis");
        std::fs::write(dir.join("lf.txt"), "已經是 LF。\n第二行。\n".as_bytes()).unwrap();
        std::fs::write(
            dir.join("crlf.txt"),
            "目前是 CRLF。\r\n第二行。\r\n".as_bytes(),
        )
        .unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "keep".to_string(),
            false,
            "LF".to_string(),
        )
        .unwrap();
        assert_eq!(
            entry_for(&report.entries, "lf.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(
            entry_for(&report.entries, "crlf.txt").status,
            STATUS_CONVERTIBLE
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #114 (failing-test-first): `convert_one` used to read a file,
    /// decode/encode it, then commit via `atomic_write` with no check that
    /// the file on disk was still the version it read. An external atomic
    /// replace landing between the read and the commit — another process,
    /// another Mojidori window, a sync tool — got silently clobbered by the
    /// batch tool's stale conversion, which then reported success. Exercises
    /// the race deterministically, rather than trying to literally win a
    /// timing race against a background writer, by calling the same two
    /// halves `convert_one` composes — `read_for_conversion` then
    /// `commit_conversion` — with an external atomic replace injected in
    /// between: same style as `save_document`'s stale-fingerprint
    /// regression test in `lib.rs` (issue #113) and `fsguard.rs`'s own
    /// `from_file_detects_external_rename_over_same_path` test. A real
    /// rename (not an in-place overwrite) matches the issue's own
    /// reproduction ("另一個 process 以 atomic replace 寫入新版本") and also
    /// exercises the Unix inode-identity discriminator, not just size.
    #[test]
    fn external_write_after_read_is_not_clobbered() {
        let dir = fixture_dir("external-write-race");
        let file = dir.join("a.txt");
        let (original_bytes, u) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(&file, &original_bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        // Read exactly as `convert_one` would at the top of its run.
        let (bytes, fingerprint) =
            read_for_conversion(&path).expect("fixture file must read cleanly");

        // Simulate an external process atomically replacing the file after
        // the read but before this conversion commits — the exact race
        // issue #114 describes.
        let external_content = b"completely different content written by another process\n";
        let replacement = dir.join("replacement.txt");
        std::fs::write(&replacement, external_content).unwrap();
        std::fs::rename(&replacement, &file).unwrap();

        // Target UTF-8 explicitly (not `None`/"keep"): re-encoding the
        // already-canonical Big5 `bytes` back to Big5 under "keep" would
        // reproduce the same bytes and take the byte-identical no-op path
        // before ever reaching `atomic_write`, which would pass this test
        // for the wrong reason regardless of the guard. Converting to a
        // different encoding guarantees `out_bytes != bytes`, so the only
        // thing standing between this call and a real write is the
        // fingerprint check under test.
        let utf8 = Encoding::for_label(b"UTF-8").unwrap();
        let result = commit_conversion(&path, &bytes, &fingerprint, Some(utf8), false, "keep");
        assert!(!result.ok, "{result:?}");
        assert!(
            result.message.contains("changed on disk during conversion"),
            "message should explain why the file was skipped: {}",
            result.message
        );

        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, external_content,
            "external content must survive byte-for-byte; the stale conversion must never write"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The stale-fingerprint guard is per-file: one raced file must fail on
    /// its own without corrupting anything, and without preventing a
    /// separate, un-raced file from converting normally.
    #[test]
    fn one_stale_file_does_not_block_the_rest_of_the_batch() {
        let dir = fixture_dir("external-write-race-batch");

        let stale_file = dir.join("stale.txt");
        let (stale_bytes, u) = encoding::encode(BIG5_TEXT_A, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(&stale_file, &stale_bytes).unwrap();
        let stale_path = stale_file.to_string_lossy().into_owned();

        let ok_file = dir.join("ok.txt");
        let (ok_bytes, u) = encoding::encode(BIG5_TEXT_B, "Big5", false).unwrap();
        assert!(!u);
        std::fs::write(&ok_file, &ok_bytes).unwrap();
        let ok_path = ok_file.to_string_lossy().into_owned();

        // Race only the first file: read it, then replace it externally
        // before committing directly (bypassing `execute_batch_conversion`
        // so the race can be injected deterministically instead of relying
        // on timing).
        let (bytes, fingerprint) = read_for_conversion(&stale_path).unwrap();
        let external_content = b"raced externally\n";
        let replacement = dir.join("replacement.txt");
        std::fs::write(&replacement, external_content).unwrap();
        std::fs::rename(&replacement, &stale_file).unwrap();

        // Target UTF-8 explicitly — see the comment in
        // `external_write_after_read_is_not_clobbered` for why `None`/"keep"
        // would take the byte-identical shortcut before ever reaching
        // `atomic_write`, making the guard irrelevant to the outcome.
        let utf8 = Encoding::for_label(b"UTF-8").unwrap();
        let stale_result =
            commit_conversion(&stale_path, &bytes, &fingerprint, Some(utf8), false, "keep");
        assert!(!stale_result.ok, "{stale_result:?}");
        assert_eq!(
            std::fs::read(&stale_file).unwrap(),
            external_content,
            "raced file's external content must survive"
        );

        // The un-raced file must still convert normally through the public
        // entry point, in the same kind of call the frontend would make.
        let results = execute_batch_conversion(
            vec![ok_path.clone()],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0]);

        let converted = std::fs::read(&ok_file).unwrap();
        let decoded = encoding::decode_auto(&converted);
        assert_eq!(decoded.encoding, "UTF-8");
        assert_eq!(decoded.content, BIG5_TEXT_B);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #117 (failing-test-first): `read_for_conversion` used to trust
    /// `file.metadata()`'s reported size as the size guard, then read the
    /// whole file regardless of how large it had grown to by the time the
    /// read actually ran — a TOCTOU between the metadata check and the
    /// read itself, distinct from #114's read -> commit race. Exercised
    /// deterministically by driving the same two steps
    /// `read_for_conversion` composes — `open_for_conversion` then
    /// `bounded_read`/`take_bounded` — with a *second*, independent handle
    /// growing the file past `MAX_FILE_SIZE` in between, instead of timing
    /// a real race (same style as `external_write_after_read_is_not_clobbered`).
    #[test]
    fn file_grown_past_the_limit_after_the_metadata_check_fails_the_bounded_read() {
        let dir = fixture_dir("grows-after-metadata-check");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"small enough to pass the metadata check\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        // Exactly what `read_for_conversion` does before the bounded read:
        // open once, run the fast metadata check (passes — the file is
        // small), capture the fingerprint.
        let (handle, _fingerprint) =
            open_for_conversion(&path).expect("small file must pass the metadata check");

        // Simulate an external writer appending after that check but
        // before the read: a *different* handle to the same path, growing
        // the file well past MAX_FILE_SIZE. `handle` itself is untouched —
        // still positioned at 0 — so the next read through it sees the
        // file's current (grown) contents, exactly like a real concurrent
        // append would.
        {
            use std::io::Write;
            let mut writer = std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap();
            let filler = vec![b'x'; (MAX_FILE_SIZE + 1) as usize];
            writer.write_all(&filler).unwrap();
            writer.flush().unwrap();
        }
        let grown_size = std::fs::metadata(&file).unwrap().len();
        assert!(
            grown_size > MAX_FILE_SIZE + 1,
            "fixture must actually grow past the take limit: {grown_size}"
        );

        // The raw bounded read itself must never materialize more than
        // MAX_FILE_SIZE + 1 bytes — the take-limit sentinel — regardless
        // of how much larger the file has actually grown (`grown_size`
        // above). This is the real guard: it must hold *during* the read,
        // not merely as a length check applied after an unbounded read
        // already happened.
        let bytes = take_bounded(handle).expect("take-bounded read itself never errors on I/O");
        assert_eq!(
            bytes.len() as u64,
            MAX_FILE_SIZE + 1,
            "the read must stop at the take limit's sentinel byte, never at the file's full \
             grown size ({grown_size})"
        );

        // And the public-facing guard reports this file as failed rather
        // than silently succeeding with a truncated (still oversized)
        // buffer.
        let handle2 = std::fs::File::open(&file).unwrap();
        let err = bounded_read(handle2, &path).expect_err("grown file must fail the bounded read");
        assert!(!err.ok);
        assert!(
            err.message.to_lowercase().contains("too large") || err.message.contains("grew"),
            "message should explain the file grew past the limit: {}",
            err.message
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #128 (failing-test-first): `classify_file` ran its size guard
    /// as two independent path resolutions — `std::fs::metadata(path)`
    /// then `std::fs::read(path)` — so a file that grew past
    /// `MAX_FILE_SIZE` in the gap between them still got read into memory
    /// in full by the second call. Scan is a dry run (nothing is
    /// written), so this was never a data-integrity bug like #114/#117 —
    /// but it let a file's own growth bypass the 10 MiB cap and pull the
    /// whole thing into memory regardless, an OOM risk on a "just
    /// looking" dry-run scan. Same fix as #117's
    /// `open_for_conversion`/`bounded_read` split on the execute side,
    /// exercised the identical deterministic way: grow the file through a
    /// *second*, independent handle after `classify_file`'s own fast-path
    /// metadata check (`open_for_classification`) has already passed,
    /// instead of timing a real race.
    #[test]
    fn classify_file_bounds_the_read_when_the_file_grows_after_the_metadata_check() {
        let dir = fixture_dir("classify-grows-after-metadata-check");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"small enough to pass the metadata check\n").unwrap();
        let path = file.to_string_lossy().into_owned();

        // Exactly what `classify_file` does before the bounded read: open
        // once and run the fast metadata check (passes — the file is
        // small).
        let handle = open_for_classification(Path::new(&path))
            .expect("small file must pass the metadata check");

        // Simulate an external writer appending after that check but
        // before the read: a *different* handle to the same path, growing
        // the file well past MAX_FILE_SIZE. `handle` itself is untouched —
        // still positioned at 0 — so the next read through it sees the
        // file's current (grown) contents, exactly like a real concurrent
        // append would.
        {
            use std::io::Write;
            let mut writer = std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap();
            let filler = vec![b'x'; (MAX_FILE_SIZE + 1) as usize];
            writer.write_all(&filler).unwrap();
            writer.flush().unwrap();
        }
        let grown_size = std::fs::metadata(&file).unwrap().len();
        assert!(
            grown_size > MAX_FILE_SIZE + 1,
            "fixture must actually grow past the take limit: {grown_size}"
        );

        // The real guard: reading through the already-open handle must
        // never materialize more than MAX_FILE_SIZE + 1 bytes — the
        // take-limit sentinel — regardless of how much larger the file has
        // actually grown (`grown_size` above). This is what the pre-fix
        // `std::fs::read(path)` got wrong: it had no cap and would have
        // read all `grown_size` bytes.
        let bytes = take_bounded(handle).expect("take-bounded read itself never errors on I/O");
        assert_eq!(
            bytes.len() as u64,
            MAX_FILE_SIZE + 1,
            "the read must stop at the take limit's sentinel byte, never at the file's full \
             grown size ({grown_size})"
        );

        // And the public-facing `classify_file` still reports this file as
        // `tooLarge` — the same status an already-oversized file gets from
        // the fast path — with classification semantics unchanged: only
        // the guard mechanism (bounded read vs. trusted metadata) changed
        // underneath it.
        let entry = classify_file(Path::new(&path), None, false, "keep");
        assert_eq!(entry.status, STATUS_TOO_LARGE, "{entry:?}");
        assert_eq!(entry.detected, "");
        assert_eq!(entry.line_ending, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #116 (failing-test-first): a folder that doesn't exist (or
    /// whose permissions were just revoked) used to come back as an empty
    /// `Ok` report — indistinguishable from "this folder genuinely has no
    /// matching files" — handing the user false confidence to skip
    /// straight to a destructive convert. The root directory failing to
    /// even open must fail the whole command closed instead.
    #[test]
    fn scan_fails_closed_when_root_directory_does_not_exist() {
        let dir = std::env::temp_dir().join("mojidori-batch-does-not-exist-at-all");
        std::fs::remove_dir_all(&dir).ok();
        assert!(!dir.exists(), "fixture precondition: path must not exist");

        let err = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        )
        .unwrap_err();
        assert!(
            err.contains(&dir.to_string_lossy().into_owned()) || !err.is_empty(),
            "error should explain the folder could not be read: {err}"
        );
    }

    /// Issue #116 (failing-test-first): a subdirectory that can't be
    /// listed (permission revoked, or vanished mid-walk) used to be
    /// silently dropped by `collect_files`'s `let Ok(entries) = ... else
    /// { return Ok(()) }` — the report looked complete while quietly
    /// missing an entire subtree. It must now show up in
    /// `BatchScanReport.scan_errors`, and — unlike the whole-root failure
    /// above — must not stop the rest of the tree (an unrelated readable
    /// sibling file) from being scanned and reported normally.
    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_is_reported_not_silently_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("unreadable-subdir");
        std::fs::write(dir.join("readable.txt"), "hello world\n").unwrap();
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("hidden.txt"), "must never be seen\n").unwrap();
        // No read/execute bit at all: `read_dir(&locked)` itself fails.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        );

        // Restore permissions immediately — before any assertion below can
        // panic and leave a locked directory behind for the next test run
        // on this machine (`remove_dir_all` can't recurse into it either).
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        let report = report.expect("a locked subdirectory must not fail the whole scan closed");
        assert_eq!(
            report.entries.len(),
            1,
            "the readable sibling file must still be scanned: {:?}",
            report.entries
        );
        assert_eq!(
            entry_for(&report.entries, "readable.txt").status,
            STATUS_ALREADY_TARGET
        );
        assert_eq!(
            report.scan_errors.len(),
            1,
            "the locked directory must be surfaced, not silently dropped: {:?}",
            report.scan_errors
        );
        assert!(
            Path::new(&report.scan_errors[0].path).ends_with("locked"),
            "scan error should name the locked directory: {:?}",
            report.scan_errors[0]
        );
        assert!(
            !report.scan_errors[0].message.is_empty(),
            "scan error should carry the OS error text"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #116 (failing-test-first), the other silently-dropped path
    /// named in the issue: `entry.metadata()` failing (as opposed to
    /// `read_dir` on the containing directory failing, covered above). A
    /// directory with read permission but no execute/search bit lets
    /// `read_dir` list child names just fine, but resolving/stat-ing any
    /// child through it fails — reproducing this half of the bug
    /// deterministically rather than racing a real vanish-mid-walk.
    #[cfg(unix)]
    #[test]
    fn entries_with_unreadable_metadata_are_reported_not_silently_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture_dir("no-execute-bit");
        std::fs::write(dir.join("readable.txt"), "hello world\n").unwrap();
        let no_exec = dir.join("noexec");
        std::fs::create_dir_all(&no_exec).unwrap();
        std::fs::write(no_exec.join("hidden.txt"), "unreachable\n").unwrap();
        // Read-only, no execute: `read_dir` can still enumerate
        // "hidden.txt"'s name, but `entry.metadata()` on it fails to
        // resolve/stat the child (needs search permission on `no_exec`).
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o600)).unwrap();

        let report = scan_batch_conversion(
            dir.to_string_lossy().into_owned(),
            vec![],
            "UTF-8".to_string(),
            false,
            "keep".to_string(),
        );

        // Restore before any assertion can panic — same reasoning as
        // unreadable_subdirectory_is_reported_not_silently_dropped above.
        std::fs::set_permissions(&no_exec, std::fs::Permissions::from_mode(0o755)).unwrap();

        let report = report.expect("an unreadable entry must not fail the whole scan closed");
        assert_eq!(
            report.entries.len(),
            1,
            "the readable sibling file must still be scanned: {:?}",
            report.entries
        );
        assert_eq!(
            report.scan_errors.len(),
            1,
            "the unreadable child's metadata failure must be surfaced, not silently skipped: {:?}",
            report.scan_errors
        );
        assert!(
            Path::new(&report.scan_errors[0].path).ends_with("hidden.txt"),
            "scan error should name the specific entry whose metadata failed: {:?}",
            report.scan_errors[0]
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
