//! Backing data for the read-only Document Info dialog (File menu;
//! ROADMAP.md v0.6 E1) — a "file trust surface" that gathers facts the app
//! already knows or can cheaply re-derive about the active document into
//! one place: on-disk size/mtime here, plus line-ending distribution here
//! too; encoding + detection evidence reuses `explain_detection`'s own
//! building blocks (lib.rs); line/word/char counts reuse the frontend's own
//! `textStatsOf` and never cross IPC at all.
//!
//! Every field this module returns is a *fresh* read off disk, never a
//! frontend-cached value — the same "always re-verify" precedent
//! `explain_detection` itself already set. The dialog takes one snapshot
//! when it opens and does not live-refresh if the file changes underneath
//! it; closing and reopening it re-snapshots (issue #201's sibling
//! commands make the identical trade-off).
//!
//! [`document_info_snapshot`] is the dialog's actual entry point (issue
//! #254): one `File::open` and one `file.metadata()` call derive all three
//! sections at once, so they can never describe three different states of
//! a file that changes underneath the dialog while it loads. The three
//! original single-purpose commands below — [`document_metadata`],
//! [`line_ending_distribution`], and `explain_detection` (lib.rs) — stay
//! exported for their own sake: `explain_detection` is still used
//! independently by `detectcard.ts`'s "Why {encoding}?" popup, and
//! `document_metadata`/`line_ending_distribution` are kept rather than
//! deleted to keep this change's blast radius small, even though the
//! frontend's Document Info dialog no longer calls them directly (grepped:
//! no other TS caller either, as of this change). All three now share their
//! core logic with `document_info_snapshot` (`tally_line_endings`,
//! `read_explain_sample`/`build_detection_explanation` in lib.rs) instead
//! of carrying independent copies.

use serde::Serialize;

use crate::fsguard::Fingerprint;
use crate::linebreak::{is_utf16_label, reject_utf16, scan_line_breaks, LineBreakKind};
use crate::streamcodec::{read_chunk, CHUNK_BYTES};
use crate::{
    build_detection_explanation, read_explain_sample, DetectionExplanation, LARGE_FILE_THRESHOLD,
};

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub size: u64,
    /// Milliseconds since the Unix epoch; negative for a file with a
    /// pre-epoch mtime (e.g. one created via `touch -t 196001010000`) —
    /// computed by hand rather than deriving from `SystemTime`'s own serde
    /// impl, which rejects any pre-epoch instant outright. See
    /// `fsguard.rs`'s `EpochOffset` doc comment for the identical problem
    /// solved there for `Fingerprint` (judgment-overlay.md §4); this
    /// module solves it independently with a plain signed millisecond
    /// count instead of reusing `EpochOffset`'s own shape, since — unlike
    /// a fingerprint, which is round-tripped opaquely — this value is
    /// meant to be displayed, so the frontend needs a plain number it can
    /// feed straight into `Date`.
    pub modified_ms: i64,
}

/// Convert a `SystemTime` to milliseconds since the Unix epoch, negative for
/// a pre-epoch instant — see `DocumentMetadata::modified_ms`'s own doc
/// comment for why this is a hand-rolled conversion rather than reusing
/// `fsguard.rs`'s `EpochOffset`. Shared by the standalone
/// [`document_metadata`] command and [`document_info_snapshot`]'s own
/// metadata section, which derives the same value from a `file.metadata()`
/// fstat instead of a second, path-based `std::fs::metadata` call.
fn modified_ms_from(modified: std::time::SystemTime) -> i64 {
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// Fresh on-disk size and modification time for `path` (Document Info's
/// "Size" and "Modified" rows). Encoding-agnostic — unlike
/// `line_ending_distribution` below, there is no raw-byte scanning here at
/// all, so no UTF-16 exclusion applies.
#[tauri::command]
pub fn document_metadata(path: String) -> Result<DocumentMetadata, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let modified = meta
        .modified()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    Ok(DocumentMetadata {
        size: meta.len(),
        modified_ms: modified_ms_from(modified),
    })
}

/// Fresh on-disk `Fingerprint` for `path` (issue #302 review, Codex P2
/// finding #2) — a plain `std::fs::metadata` stat, no content read, the
/// same cost as [`document_metadata`] just above. `src/saveecho.ts`'s
/// watcher-echo suppression needs to compare a *live* disk snapshot
/// against the exact opaque `Fingerprint` `save_document` already returns
/// right after a write (`fsguard.rs`), not a separately-computed
/// size/mtime pair: `document_metadata`'s `modified_ms` is
/// millisecond-truncated (coarser still on some filesystems), so a fast
/// same-size external rewrite could alias onto an unrelated file version
/// under that comparison. `Fingerprint` carries full mtime precision plus,
/// on Unix, inode identity, so it can't.
#[tauri::command]
pub fn document_fingerprint(path: String) -> Result<Fingerprint, String> {
    Fingerprint::from_path(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to read {path}: {e}"))
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineEndingDistribution {
    pub lf: u64,
    pub crlf: u64,
    pub cr: u64,
    /// How many bytes were actually scanned — equal to `total_size` unless
    /// the file exceeds `LARGE_FILE_THRESHOLD`, in which case only the
    /// first `LARGE_FILE_THRESHOLD` bytes were scanned. The frontend must
    /// show an explicit "sampled" disclosure whenever this is less than
    /// `total_size` — never silently label a partial count as if it were
    /// exhaustive (ROADMAP.md v0.6 E1's own bounded-scan requirement).
    pub scanned_bytes: u64,
    pub total_size: u64,
}

/// Record one line-break `kind` into the matching running tally — the one
/// arm of [`tally_line_endings`]'s inner loop that would otherwise be
/// duplicated between its "seed from `initial`" scan and its "continue
/// reading from `file`" scan below.
fn record_line_break(kind: LineBreakKind, lf: &mut u64, crlf: &mut u64, cr: &mut u64) {
    match kind {
        LineBreakKind::Lf => *lf += 1,
        LineBreakKind::CrLf => *crlf += 1,
        LineBreakKind::Cr => *cr += 1,
    }
}

/// Tally LF/CRLF/lone-CR terminators across the first
/// `total_size.min(LARGE_FILE_THRESHOLD)` bytes of `file`'s stream, seeded
/// with `initial` — bytes already read from the very start of that stream
/// — before continuing to read further chunks from `file` as needed.
/// `file`'s read cursor must already sit exactly at `initial.len()` (i.e.
/// immediately past those bytes) when this is called; every current caller
/// satisfies this by construction (either `initial` is empty and `file` was
/// just opened, or `initial` is exactly the bytes
/// [`crate::read_explain_sample`] just read off the same handle).
///
/// This is [`line_ending_distribution`]'s own scan loop, generalized with
/// an `initial` seed so [`document_info_snapshot`] (issue #254) can hand it
/// the `EXPLAIN_SAMPLE_BYTES` prefix it already read for the detection
/// section, instead of re-reading those same leading bytes a second time.
/// `line_ending_distribution` itself calls this with an empty `initial` and
/// a freshly-opened `file` (cursor at 0) — exactly its old behavior.
/// `pending_cr` carries across the seam between `initial` and the first
/// chunk read from `file` exactly the same way it already carries across
/// every subsequent `read_chunk` boundary — a CRLF pair split right at the
/// end of `initial` is still one CRLF, never a lone CR plus a lone LF (see
/// `document_info_snapshot_carries_a_split_crlf_across_the_sample_seam`
/// below, that seam's own regression pin).
///
/// Byte-level scanning without decoding is unsound for UTF-16 (see
/// `linebreak.rs`'s module doc comment) — every caller rejects UTF-16
/// before reaching this function, mirroring `build_line_index`'s own
/// exclusion. ISO-2022-JP needs no such exclusion here: unlike `chunk.rs`'s
/// paging (which decodes each page and can lose JIS shift-state across a
/// cut), this never decodes anything, and ISO-2022-JP's JIS-mode byte pairs
/// always fall in 0x21-0x7E — never 0x0A/0x0D — so a literal LF/CR byte is
/// always a real terminator there too.
fn tally_line_endings(
    file: &mut std::fs::File,
    initial: &[u8],
    total_size: u64,
) -> std::io::Result<LineEndingDistribution> {
    // Known upfront from the caller's own fresh metadata read, not
    // inferred from read-loop short-reads — see the post-loop pending_cr
    // resolution below for why that distinction matters at the exact
    // boundary.
    let is_full_scan = total_size <= LARGE_FILE_THRESHOLD;
    let bound = total_size.min(LARGE_FILE_THRESHOLD);
    debug_assert!(
        initial.len() as u64 <= bound,
        "pre-read bytes must never exceed the scan bound"
    );

    let mut pending_cr = false;
    let mut lf: u64 = 0;
    let mut crlf: u64 = 0;
    let mut cr: u64 = 0;
    let mut offset: u64 = 0;

    let seed_len = (initial.len() as u64).min(bound) as usize;
    if seed_len > 0 {
        scan_line_breaks(
            &initial[..seed_len],
            offset,
            &mut pending_cr,
            |_pos, kind| record_line_break(kind, &mut lf, &mut crlf, &mut cr),
        );
        offset += seed_len as u64;
    }

    let mut buf = vec![0u8; CHUNK_BYTES];
    while offset < bound {
        let want = std::cmp::min(buf.len() as u64, bound - offset) as usize;
        let n = read_chunk(file, &mut buf[..want])?;
        if n == 0 {
            break;
        }
        scan_line_breaks(&buf[..n], offset, &mut pending_cr, |_pos, kind| {
            record_line_break(kind, &mut lf, &mut crlf, &mut cr)
        });
        offset += n as u64;
        if n < want {
            break; // short read == real EOF
        }
    }
    if pending_cr && is_full_scan {
        // The very last byte of the (whole) file was an unresolved CR: a
        // lone-CR terminator right at EOF, matching
        // `lineindex.rs::build_line_index`'s identical resolution. Left
        // unresolved when the scan was cut short by `bound` instead (a
        // large file) — that CR might yet turn out to be the first half of
        // a CRLF whose LF sits just past the sampled window, so counting
        // it now could misclassify it; the sampled window is already
        // disclosed as inexact (`scanned_bytes < total_size`), so this one
        // uncounted terminator at the very edge of the sample is an
        // accepted, documented trade-off rather than a correctness bug —
        // see `trailing_cr_exactly_at_the_bounded_cutoff_is_not_counted`.
        cr += 1;
    }

    Ok(LineEndingDistribution {
        lf,
        crlf,
        cr,
        scanned_bytes: offset,
        total_size,
    })
}

/// Stream `path`'s raw bytes — bounded at `LARGE_FILE_THRESHOLD` (exact for
/// anything at or under that size, a leading sample beyond it, always
/// disclosed via `scanned_bytes < total_size`) — and tally how many of each
/// of the three line-terminator styles `linebreak.rs` recognizes it
/// contains. See [`tally_line_endings`] for the actual scan; this command
/// is just that plus opening the file and rejecting UTF-16 up front.
#[tauri::command]
pub fn line_ending_distribution(
    path: String,
    encoding: String,
) -> Result<LineEndingDistribution, String> {
    reject_utf16(&encoding, "Line-ending distribution")?;

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    tally_line_endings(&mut file, &[], total_size)
        .map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Outcome of one section of a [`DocumentInfoSnapshot`]: independently
/// "ok" or "error" so a failure deriving one section never discards data
/// already derived for another. Mirrors `SaveResult`'s own structured-field
/// precedent (`lib.rs`) for surfacing a specific, named outcome rather than
/// folding everything into one opaque error string — and matches the
/// frontend's own `DocInfoFetch<T>` (`docinfo.ts`), so the two line up
/// structurally with no translation layer beyond picking a status. `#[serde
/// (tag = "status", rename_all = "camelCase")]` serializes this as
/// `{"status":"ok","data":...}` / `{"status":"error","message":...}` — see
/// `section_outcome_serializes_with_the_expected_status_tag` below for the
/// pinned wire shape.
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SectionOutcome<T> {
    Ok { data: T },
    Error { message: String },
}

/// [`SectionOutcome`]'s three-way counterpart, used only for the
/// line-ending section: it alone can also be "skipped" for a UTF-16
/// document (byte-level scanning is unsound there — `linebreak.rs`'s
/// module doc comment) — a deliberate non-attempt, not a failure, so it
/// gets its own status rather than reusing `Error`'s text for something
/// that was never actually attempted. Mirrors the frontend's existing
/// `DocInfoFetch`'s `"skipped"` variant.
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LineEndingOutcome {
    Ok { data: LineEndingDistribution },
    Error { message: String },
    Skipped { reason: &'static str },
}

/// Single-open, single-`metadata()` snapshot of everything the Document
/// Info dialog's three IPC-backed sections need (issue #254) — see
/// [`document_info_snapshot`]'s own doc comment for the full
/// failure-granularity contract.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfoSnapshot {
    pub metadata: SectionOutcome<DocumentMetadata>,
    pub detection: SectionOutcome<DetectionExplanation>,
    pub line_ending: LineEndingOutcome,
}

/// Derive all three of the Document Info dialog's IPC-backed sections — on-
/// disk size/mtime, encoding-detection evidence, and line-ending
/// distribution — from exactly one `File::open` and exactly one
/// `file.metadata()` call (an fstat on the resulting handle, not three
/// separate, independent path-based opens/stats), so they can never
/// describe three different states of a file that changes underneath the
/// dialog while it's loading. That race was issue #254's actual bug:
/// `document_metadata`, `explain_detection`, and `line_ending_distribution`
/// each independently open/stat the file, and the frontend fired all three
/// in parallel (`Promise.all`) with no shared version between them —
/// replaced here by `docinfo.ts`'s single call to this command.
///
/// Failure granularity, by construction:
/// - `path` not opening at all, or the fstat on the freshly-opened handle
///   itself failing, means not even `total_size` is known, so *nothing*
///   can be derived — the whole command errors (`Result::Err`), the same
///   "nothing could even be attempted" convention every other command in
///   this module already uses.
/// - Past that gate, every failure is scoped to just the section(s) that
///   actually needed the thing that failed:
///   - `metadata`'s only remaining failure mode is `Metadata::modified()`
///     itself erroring — some platforms/filesystems don't report an mtime
///     at all (see `OpenedDocument::fingerprint`'s doc comment in `lib.rs`
///     for the same caveat elsewhere in this codebase); `size` cannot fail
///     once `file.metadata()` already succeeded.
///   - `detection`, and the *scanning* half of `line_ending`, share one
///     bounded read ([`read_explain_sample`], the same `EXPLAIN_SAMPLE_
///     BYTES` prefix `explain_detection` reads standalone, reused here
///     instead of read a second time): if that read itself fails, both
///     sections report the error, but `metadata` is unaffected since it
///     never touches file content.
///   - `line_ending` alone has two further outcomes that never touch the
///     shared sample at all, resolved from `encoding` up front: `Skipped
///     { reason: "utf16" }` when `encoding` names UTF-16, or `Error` when
///     `encoding` isn't a recognized label at all — both are about the
///     label string itself, not anything read from disk.
#[tauri::command]
pub fn document_info_snapshot(
    path: String,
    extension_encoding: Option<String>,
    encoding: String,
) -> Result<DocumentInfoSnapshot, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();

    let metadata = match meta.modified() {
        Ok(modified) => SectionOutcome::Ok {
            data: DocumentMetadata {
                size: total_size,
                modified_ms: modified_ms_from(modified),
            },
        },
        Err(e) => SectionOutcome::Error {
            message: format!("Failed to read {path}: {e}"),
        },
    };

    // Shared by both `detection` and the scanning half of `line_ending`
    // below — read once from this single open handle rather than twice.
    let sample = read_explain_sample(&mut file, &path);

    let detection = match &sample {
        Ok(bytes) => SectionOutcome::Ok {
            data: build_detection_explanation(bytes, total_size, extension_encoding.as_deref()),
        },
        Err(message) => SectionOutcome::Error {
            message: message.clone(),
        },
    };

    let line_ending = if is_utf16_label(&encoding) {
        LineEndingOutcome::Skipped { reason: "utf16" }
    } else if let Err(message) = reject_utf16(&encoding, "Line-ending distribution") {
        LineEndingOutcome::Error { message }
    } else {
        match &sample {
            Err(message) => LineEndingOutcome::Error {
                message: message.clone(),
            },
            Ok(bytes) => match tally_line_endings(&mut file, bytes, total_size) {
                Ok(data) => LineEndingOutcome::Ok { data },
                Err(e) => LineEndingOutcome::Error {
                    message: format!("Failed to read {path}: {e}"),
                },
            },
        }
    };

    Ok(DocumentInfoSnapshot {
        metadata,
        detection,
        line_ending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the sample-seam test below needs this; kept out of the
    // module-level `use crate::{...}` above so the non-test build doesn't
    // carry an unused import (`EXPLAIN_SAMPLE_BYTES` has no non-test
    // caller in this file).
    use crate::EXPLAIN_SAMPLE_BYTES;

    fn write_temp(name: &str, content: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("mojidori-docinfo-{name}-{}", std::process::id()));
        std::fs::write(&path, content).unwrap();
        path
    }

    // --- document_metadata --------------------------------------------

    #[test]
    fn returns_size_and_a_known_modified_time() {
        let content = b"hello world";
        let path = write_temp("metadata-known-mtime.txt", content);
        let target = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(target)
            .unwrap();

        let report = document_metadata(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(report.size, content.len() as u64);
        assert_eq!(report.modified_ms, 1_700_000_000_000);
        std::fs::remove_file(&path).ok();
    }

    /// Judgment-overlay.md §4's `EpochOffset` lesson exists precisely
    /// because naive `SystemTime` handling breaks for a pre-epoch mtime —
    /// this pins that `document_metadata`'s own hand-rolled conversion
    /// (deliberately not reusing `EpochOffset` itself, see the struct doc
    /// comment) gets the sign right instead of panicking or silently
    /// clamping to the epoch.
    #[test]
    fn pre_epoch_modified_time_is_negative() {
        let path = write_temp("metadata-pre-epoch.txt", b"x");
        let target = std::time::UNIX_EPOCH - std::time::Duration::from_secs(3600);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(target)
            .unwrap();

        let report = document_metadata(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(report.modified_ms, -3_600_000);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn document_metadata_errors_on_a_missing_file() {
        let result = document_metadata("/mojidori-docinfo-does-not-exist/nope.txt".into());
        assert!(result.is_err());
    }

    // --- document_fingerprint --------------------------------------------

    #[test]
    fn document_fingerprint_errors_on_a_missing_file() {
        let result = document_fingerprint("/mojidori-docinfo-does-not-exist/nope.txt".into());
        assert!(result.is_err());
    }

    #[test]
    fn document_fingerprint_matches_for_an_untouched_file() {
        let path = write_temp("fingerprint-untouched.txt", b"hello");
        let path_str = path.to_string_lossy().into_owned();

        let first = document_fingerprint(path_str.clone()).unwrap();
        let second = document_fingerprint(path_str).unwrap();

        assert_eq!(first, second);
        std::fs::remove_file(&path).ok();
    }

    /// Mirrors fsguard.rs's own `matches_path_false_after_size_change`
    /// test — this is the command wrapper, not a re-test of `Fingerprint`
    /// itself, but pins that the wrapper actually surfaces a real,
    /// comparable change rather than e.g. always returning a fixed value.
    #[test]
    fn document_fingerprint_changes_after_a_rewrite() {
        let path = write_temp("fingerprint-rewrite.txt", b"hello");
        let path_str = path.to_string_lossy().into_owned();

        let before = document_fingerprint(path_str.clone()).unwrap();
        std::fs::write(&path, b"hello, world - now longer").unwrap();
        let after = document_fingerprint(path_str).unwrap();

        assert_ne!(before, after);
        std::fs::remove_file(&path).ok();
    }

    // --- line_ending_distribution ---------------------------------------

    #[test]
    fn lf_only_counts_correctly() {
        let content = b"a\nb\nc\n";
        let path = write_temp("lf-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 3);
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(report.scanned_bytes, content.len() as u64);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn crlf_only_counts_correctly_and_not_double() {
        let content = b"a\r\nb\r\nc\r\n";
        let path = write_temp("crlf-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(
            report.crlf, 3,
            "each CRLF pair must count once, not as a CR and an LF"
        );
        assert_eq!(report.cr, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lone_cr_only_counts_correctly() {
        let content = b"a\rb\rc\r";
        let path = write_temp("lone-cr-only.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(report.crlf, 0);
        assert_eq!(
            report.cr, 3,
            "trailing lone CR at true EOF must still be counted"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mixed_line_endings_counts_each_style_independently() {
        let content = b"a\nb\r\nc\rd\n";
        let path = write_temp("mixed.txt", content);
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 2);
        assert_eq!(report.crlf, 1);
        assert_eq!(report.cr, 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_file_has_zero_counts() {
        let path = write_temp("empty.txt", b"");
        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 0);
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, 0);
        assert_eq!(report.scanned_bytes, 0);
        std::fs::remove_file(&path).ok();
    }

    /// A CRLF pair split exactly across the 8 MiB `read_chunk` boundary
    /// (CR the very last byte of the first read, LF the very first byte of
    /// the second) must still count as exactly one CRLF — the classic
    /// streaming-scanner pitfall `pending_cr` exists to avoid, pinned here
    /// against the real chunked read loop rather than a direct
    /// `scan_line_breaks` unit call (linebreak.rs's own tests already cover
    /// that in isolation; this proves the plumbing in this module's loop
    /// carries `pending_cr` across `read_chunk` calls correctly too).
    #[test]
    fn crlf_split_across_the_8mib_chunk_boundary_counts_as_one() {
        let mut content = vec![b'a'; CHUNK_BYTES];
        content[CHUNK_BYTES - 1] = b'\r'; // last byte of the first read
        content.push(b'\n'); // first byte of the second read -> completes CRLF
        content.extend_from_slice(b"more content after\n");
        assert!(
            (content.len() as u64) < LARGE_FILE_THRESHOLD,
            "fixture must stay under the bounded-scan threshold so this is an exact, full scan"
        );
        let path = write_temp("crlf-chunk-boundary.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.lf, 1, "the trailing \"more content after\\n\"");
        assert_eq!(
            report.crlf, 1,
            "must not be double-counted as a lone CR plus a lone LF"
        );
        assert_eq!(report.cr, 0);
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(report.scanned_bytes, content.len() as u64);
        std::fs::remove_file(&path).ok();
    }

    /// A file over `LARGE_FILE_THRESHOLD` is scanned only up to that bound
    /// — a terminator placed just past it must never be counted, and the
    /// report must disclose exactly how much was actually scanned.
    #[test]
    fn bounded_scan_stops_at_large_file_threshold() {
        let threshold = LARGE_FILE_THRESHOLD as usize;
        let mut content = vec![b'a'; threshold + 1024];
        content[100] = b'\n'; // one LF well within the scanned bound
                              // Terminators placed strictly after the bound must be invisible to
                              // this scan.
        content[threshold] = b'\n';
        content[threshold + 1] = b'\n';
        let path = write_temp("bounded-large.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_size, content.len() as u64);
        assert_eq!(
            report.scanned_bytes, LARGE_FILE_THRESHOLD,
            "scan must be bounded at exactly LARGE_FILE_THRESHOLD, not the whole file"
        );
        assert_eq!(report.lf, 1, "only the LF within the scanned bound counts");
        assert_eq!(report.crlf, 0);
        assert_eq!(report.cr, 0);
        std::fs::remove_file(&path).ok();
    }

    /// An unresolved trailing CR landing *exactly* at the bounded cutoff is
    /// ambiguous — it might be the first half of a CRLF whose LF sits just
    /// past the sampled window — so it must be left uncounted rather than
    /// guessed as a lone CR, unlike the same situation at genuine EOF
    /// (`lone_cr_only_counts_correctly` above, where it is always safe to
    /// resolve).
    #[test]
    fn trailing_cr_exactly_at_the_bounded_cutoff_is_not_counted() {
        let threshold = LARGE_FILE_THRESHOLD as usize;
        let mut content = vec![b'a'; threshold]; // byte at index threshold-1 will be overwritten below
        content[threshold - 1] = b'\r'; // the scan's very last byte is an unresolved CR
        content.push(b'\n'); // just past the bound: would complete a CRLF, but must not be read
        content.extend_from_slice(b"tail\n");
        assert!(
            (content.len()) > threshold,
            "fixture must exceed the threshold"
        );
        let path = write_temp("bounded-trailing-cr.txt", &content);

        let report =
            line_ending_distribution(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.scanned_bytes, LARGE_FILE_THRESHOLD);
        assert_eq!(
            report.cr, 0,
            "the ambiguous trailing CR at the exact cutoff must not be guessed as a lone CR"
        );
        assert_eq!(
            report.crlf, 0,
            "the LF completing it sits past the scanned bound"
        );
        assert_eq!(report.lf, 0);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16() {
        let result = line_ending_distribution("/tmp/whatever.txt".into(), "UTF-16LE".into());
        assert!(result.is_err());
        let result = line_ending_distribution("/tmp/whatever.txt".into(), "UTF-16BE".into());
        assert!(result.is_err());
    }

    #[test]
    fn line_ending_distribution_errors_on_a_missing_file() {
        let result = line_ending_distribution(
            "/mojidori-docinfo-does-not-exist/nope.txt".into(),
            "UTF-8".into(),
        );
        assert!(result.is_err());
    }

    // --- document_info_snapshot (issue #254) ----------------------------

    fn expect_ok<T>(section: &SectionOutcome<T>) -> &T {
        match section {
            SectionOutcome::Ok { data } => data,
            SectionOutcome::Error { message } => {
                panic!("expected an ok section, got error: {message}")
            }
        }
    }

    fn expect_line_ending_ok(section: &LineEndingOutcome) -> &LineEndingDistribution {
        match section {
            LineEndingOutcome::Ok { data } => data,
            LineEndingOutcome::Error { message } => {
                panic!("expected line-ending ok, got error: {message}")
            }
            LineEndingOutcome::Skipped { reason } => {
                panic!("expected line-ending ok, got skipped: {reason}")
            }
        }
    }

    /// Golden path: every section succeeds, and — the actual point of a
    /// single `File::open` + single `file.metadata()` — every section's
    /// own notion of "how big is this file" is the literal same `u64`,
    /// not three independently re-derived values that merely happen to
    /// agree on an unchanging test fixture. Before this command existed,
    /// three separate commands each ran their own `open`/`stat`; nothing
    /// structurally guaranteed they saw the same size, only convention.
    #[test]
    fn document_info_snapshot_reports_consistent_total_size_across_all_three_sections() {
        let content = b"line one\r\nline two\nline three\r";
        let path = write_temp("snapshot-golden.txt", content);

        let snapshot =
            document_info_snapshot(path.to_string_lossy().into_owned(), None, "UTF-8".into())
                .unwrap();

        let metadata = expect_ok(&snapshot.metadata);
        assert_eq!(metadata.size, content.len() as u64);

        let detection = expect_ok(&snapshot.detection);
        assert_eq!(detection.total_size, content.len() as u64);
        assert_eq!(detection.sampled_bytes, content.len());
        assert!(!detection.large_file_preview);

        let line_ending = expect_line_ending_ok(&snapshot.line_ending);
        assert_eq!(line_ending.total_size, content.len() as u64);
        assert_eq!(line_ending.scanned_bytes, content.len() as u64);
        assert_eq!(line_ending.lf, 1);
        assert_eq!(line_ending.crlf, 1);
        assert_eq!(
            line_ending.cr, 1,
            "trailing lone CR at true EOF must still be counted"
        );

        assert_eq!(
            metadata.size, detection.total_size,
            "metadata and detection must report the identical size"
        );
        assert_eq!(
            detection.total_size, line_ending.total_size,
            "detection and line-ending must report the identical size"
        );

        std::fs::remove_file(&path).ok();
    }

    /// The seam unique to this command: `document_info_snapshot` seeds
    /// `tally_line_endings` with the `EXPLAIN_SAMPLE_BYTES` prefix it
    /// already read for the detection section, instead of a fresh read
    /// starting at offset 0 the way the standalone `line_ending_
    /// distribution` command does. A CRLF pair split exactly at that seam
    /// — CR the very last byte of the sample, LF the very first byte read
    /// afterward — must still be recognized as one CRLF, not a lone CR
    /// (from the seeded half) plus a lone LF (from the continued read).
    /// This is the classic streaming-scanner pitfall
    /// (`crlf_split_across_the_8mib_chunk_boundary_counts_as_one` above
    /// pins the same hazard at the `CHUNK_BYTES` boundary); a naive merge
    /// that started the continuation loop's `pending_cr` fresh instead of
    /// carrying it from the seed scan would fail this test by reporting
    /// `cr: 1, lf: 1` (from "\r" then completing "\n") instead of `crlf:
    /// 1`.
    #[test]
    fn document_info_snapshot_carries_a_split_crlf_across_the_sample_seam() {
        let mut content = vec![b'a'; EXPLAIN_SAMPLE_BYTES];
        content[EXPLAIN_SAMPLE_BYTES - 1] = b'\r'; // last byte of the sample read
        content.push(b'\n'); // first byte read afterward -> completes the CRLF
        content.extend_from_slice(b"more content after\n");
        assert!(
            (content.len() as u64) < LARGE_FILE_THRESHOLD,
            "fixture must stay under the bounded-scan threshold so this is an exact, full scan"
        );
        let path = write_temp("snapshot-sample-seam.txt", &content);

        let snapshot =
            document_info_snapshot(path.to_string_lossy().into_owned(), None, "UTF-8".into())
                .unwrap();

        let line_ending = expect_line_ending_ok(&snapshot.line_ending);
        assert_eq!(line_ending.lf, 1, "the trailing \"more content after\\n\"");
        assert_eq!(
            line_ending.crlf, 1,
            "must not be double-counted as a lone CR plus a lone LF across the sample seam"
        );
        assert_eq!(line_ending.cr, 0);
        assert_eq!(line_ending.total_size, content.len() as u64);
        assert_eq!(line_ending.scanned_bytes, content.len() as u64);

        std::fs::remove_file(&path).ok();
    }

    /// Per-section divergence from a *single* open+fstat (issue #254's own
    /// acceptance bar): a UTF-16 document routes the line-ending section to
    /// "skipped", never touching the scan, while metadata and detection —
    /// derived from the same handle — still succeed normally. This
    /// couldn't happen with three independent commands failing/succeeding
    /// in lockstep; it's the concrete proof the merged command still
    /// degrades per-section rather than as an all-or-nothing unit.
    #[test]
    fn document_info_snapshot_skips_line_ending_for_utf16_while_other_sections_still_succeed() {
        let path = write_temp("snapshot-utf16-gate.txt", b"whatever content\n");

        let snapshot =
            document_info_snapshot(path.to_string_lossy().into_owned(), None, "UTF-16LE".into())
                .unwrap();

        assert!(matches!(snapshot.metadata, SectionOutcome::Ok { .. }));
        assert!(matches!(snapshot.detection, SectionOutcome::Ok { .. }));
        match &snapshot.line_ending {
            LineEndingOutcome::Skipped { reason } => assert_eq!(*reason, "utf16"),
            LineEndingOutcome::Ok { .. } => panic!("expected line-ending to be skipped, got ok"),
            LineEndingOutcome::Error { message } => {
                panic!("expected line-ending to be skipped, got error: {message}")
            }
        }

        std::fs::remove_file(&path).ok();
    }

    /// Same per-section-divergence bar as above, for the other line-ending-
    /// only failure axis: an `encoding` label that isn't recognized at all
    /// (as opposed to a recognized-but-UTF-16 one) errors only the
    /// line-ending section — metadata and detection don't need `encoding`
    /// at all, so they're untouched by it being garbage.
    #[test]
    fn document_info_snapshot_errors_line_ending_only_for_an_unknown_encoding_label_while_other_sections_still_succeed(
    ) {
        let path = write_temp("snapshot-bad-label.txt", b"whatever content\n");

        let snapshot = document_info_snapshot(
            path.to_string_lossy().into_owned(),
            None,
            "not-a-real-encoding".into(),
        )
        .unwrap();

        assert!(matches!(snapshot.metadata, SectionOutcome::Ok { .. }));
        assert!(matches!(snapshot.detection, SectionOutcome::Ok { .. }));
        match &snapshot.line_ending {
            LineEndingOutcome::Error { message } => {
                assert_eq!(message, "Unknown encoding label: not-a-real-encoding");
            }
            LineEndingOutcome::Ok { .. } => panic!("expected line-ending to be an error, got ok"),
            LineEndingOutcome::Skipped { reason } => {
                panic!("expected line-ending to be an error, got skipped: {reason}")
            }
        }

        std::fs::remove_file(&path).ok();
    }

    /// The coarsest failure grain: `File::open` (or the fstat right after
    /// it) failing means not even `total_size` is known, so nothing can be
    /// derived at all and the whole command errors — unlike the two tests
    /// above, there is no per-section split to make here.
    #[test]
    fn document_info_snapshot_errors_entirely_when_the_file_does_not_exist() {
        let result = document_info_snapshot(
            "/mojidori-docinfo-does-not-exist/nope.txt".into(),
            None,
            "UTF-8".into(),
        );
        assert!(result.is_err());
    }

    /// The seeded continuation (sample, then further `read_chunk` calls)
    /// must still respect the exact same `LARGE_FILE_THRESHOLD` bound the
    /// standalone `line_ending_distribution` command's own
    /// `bounded_scan_stops_at_large_file_threshold` test pins — proving the
    /// large-file path wasn't broken by starting the scan's `offset` at
    /// `EXPLAIN_SAMPLE_BYTES` instead of 0.
    #[test]
    fn document_info_snapshot_bounded_scan_stops_at_large_file_threshold() {
        let threshold = LARGE_FILE_THRESHOLD as usize;
        let mut content = vec![b'a'; threshold + 1024];
        content[100] = b'\n'; // one LF well within the scanned bound
        content[threshold] = b'\n'; // strictly past the bound -- must be invisible
        content[threshold + 1] = b'\n';
        let path = write_temp("snapshot-bounded-large.txt", &content);

        let snapshot =
            document_info_snapshot(path.to_string_lossy().into_owned(), None, "UTF-8".into())
                .unwrap();

        let metadata = expect_ok(&snapshot.metadata);
        assert_eq!(metadata.size, content.len() as u64);

        let detection = expect_ok(&snapshot.detection);
        assert_eq!(detection.total_size, content.len() as u64);
        assert!(
            detection.large_file_preview,
            "total_size exceeds LARGE_FILE_THRESHOLD"
        );

        let line_ending = expect_line_ending_ok(&snapshot.line_ending);
        assert_eq!(
            line_ending.scanned_bytes, LARGE_FILE_THRESHOLD,
            "the seeded continuation must still stop at exactly LARGE_FILE_THRESHOLD"
        );
        assert_eq!(
            line_ending.lf, 1,
            "only the LF within the scanned bound counts"
        );
        assert_eq!(line_ending.crlf, 0);
        assert_eq!(line_ending.cr, 0);

        std::fs::remove_file(&path).ok();
    }

    /// Pins the exact wire shape `docinfo.ts`'s frontend adapter depends on
    /// — an internally-tagged `status` discriminant, not e.g. a
    /// `{"Ok":{...}}` externally-tagged shape serde would produce without
    /// the `#[serde(tag = "status")]` attribute. A regression here would
    /// compile fine on the Rust side and only surface as a silently-broken
    /// dialog at runtime, since nothing else in this test suite crosses
    /// the Rust/TypeScript boundary.
    #[test]
    fn section_outcome_serializes_with_the_expected_status_tag() {
        let ok: SectionOutcome<u8> = SectionOutcome::Ok { data: 5 };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({"status": "ok", "data": 5})
        );

        let error: SectionOutcome<u8> = SectionOutcome::Error {
            message: "boom".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"status": "error", "message": "boom"})
        );
    }

    /// Same wire-shape pin as above, for `LineEndingOutcome`'s extra
    /// `Skipped` variant specifically — the frontend's `DocInfoFetch`
    /// matches on `status === "skipped"` with a `reason` field, not a
    /// bare string or a differently-named key.
    #[test]
    fn line_ending_outcome_skipped_serializes_with_the_expected_status_tag() {
        let skipped = LineEndingOutcome::Skipped { reason: "utf16" };
        assert_eq!(
            serde_json::to_value(&skipped).unwrap(),
            serde_json::json!({"status": "skipped", "reason": "utf16"})
        );
    }
}
