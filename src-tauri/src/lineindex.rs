//! Line-offset index for huge files: fast go-to-line and bookmarks beyond
//! the loaded chunk window (ARCHITECTURE.md's large-file mode, Track B,
//! ROADMAP.md). `chunk.rs` only knows how to page forward/backward from an
//! already-loaded offset — jumping straight to line 1,234,567 of a
//! multi-gigabyte file would otherwise mean paging through every chunk in
//! between. This module instead builds a sparse index of checkpoint byte
//! offsets (one every `CHECKPOINT_INTERVAL` lines) by streaming the whole
//! file once, and resolves an arbitrary target line by scanning from the
//! nearest checkpoint — at most `CHECKPOINT_INTERVAL` lines of bytes per
//! call.
//!
//! Units discipline (large-file offset danger domain, see
//! `.claude/judgment-overlay.md`): every offset in this module is a raw
//! file *byte* offset, never a character or CodeMirror position. Line
//! numbers are always 0-based here, matching `checkpoints[k]` = the byte
//! offset of line `k * CHECKPOINT_INTERVAL` (0-based). The frontend owns
//! the 0-based <-> 1-based conversion at the UI boundary (see
//! `src/lineindex.ts`); nothing 1-based ever crosses this IPC boundary.
//!
//! Like `chunk.rs`, this scans raw bytes rather than decoding anything,
//! which is only sound for ASCII-compatible encodings — a literal `0x0A`
//! (LF) or `0x0D` (CR) byte can never appear as part of a multi-byte
//! sequence in any encoding this app supports (UTF-8 continuation bytes are
//! 0x80-0xBF; Big5/Shift_JIS/GB18030/EUC-* lead and trail bytes never dip
//! into the 0x00-0x1F control range either), so byte-level line-break
//! scanning is safe without decoding first. UTF-16 is the one exception
//! (0x0A/0x0D can appear as half of an unrelated code unit) and is rejected
//! up front in `build_line_index`, mirroring `chunk.rs`'s paging exclusion
//! and `streamreplace.rs`'s streaming-encode exclusion. `locate_line_offset`
//! takes no encoding parameter at all: it only ever runs from a checkpoint
//! an already-built (and therefore already UTF-16-checked) index produced.
//!
//! A line is terminated by LF, CRLF, or a lone CR (Classic Mac line
//! endings) — the shared byte-level semantics defined in `linebreak.rs`
//! (matching `encoding::detect_line_ending`'s three-way split, #92), so
//! "how many lines does this file have" agrees everywhere in the app,
//! including `chunk.rs`'s page alignment. CRLF counts as *one* terminator,
//! never two: `linebreak::scan_line_breaks`'s `pending_cr` flag carries
//! across `read_chunk` calls so a `\r\n` pair split across two reads (CR
//! the last byte of one, LF the first byte of the next) is still
//! recognized as a single boundary instead of a lone CR plus a lone LF —
//! the classic streaming-scanner pitfall for CRLF detection.
//!
//! `total_lines` counts every line implied by the byte stream: one for each
//! terminator found (LF, CRLF, or lone CR), plus one more if the file has
//! trailing bytes after the last terminator (or contains no terminator at
//! all). A file that ends exactly on a terminator does *not* get a phantom
//! empty trailing line counted — there is nothing there to jump to, and no
//! checkpoint is ever recorded pointing past end of file.

use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

use crate::fsguard::Fingerprint;
use crate::linebreak::{reject_utf16, scan_line_breaks};

/// Streaming read granularity, matching `streamreplace.rs`'s rationale:
/// large enough to amortize per-read overhead on multi-GB files, small
/// enough to keep memory flat regardless of file size.
const CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Checkpoints are recorded every this many lines.
pub const CHECKPOINT_INTERVAL: u64 = 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineIndexReport {
    /// `checkpoints[k]` is the byte offset of the first byte of line
    /// `k * CHECKPOINT_INTERVAL` (0-based). `checkpoints[0]` is always 0
    /// when the file is non-empty; empty only for a 0-byte file (nothing to
    /// index). ~20k checkpoints x 8 bytes for a gigabyte-class file — small
    /// enough to cross IPC as plain metadata, never raw file bytes.
    pub checkpoints: Vec<u64>,
    pub total_lines: u64,
    /// File size at the moment the index was built, so the frontend can
    /// detect a stale index (the file changed size since) and rebuild.
    pub indexed_size: u64,
    /// Fingerprint of the exact file version the checkpoints describe
    /// (issue #251) — the frontend passes it back as `locate_line_offset`
    /// / `read_document_chunk`'s `expected`, so a same-size overwrite the
    /// size check above can't see still gets caught before a stale
    /// checkpoint is dereferenced. `None` only if the fingerprint could
    /// not be captured; consumers then degrade to the size check alone.
    pub fingerprint: Option<Fingerprint>,
}

/// Fill `buf` as full as possible from `file`, short-reading only at EOF.
/// Mirrors `chunk.rs`'s private `read_up_to` / `streamreplace.rs`'s
/// `read_chunk`; duplicated rather than shared for the same reason
/// `streamreplace.rs` gives for its own copy — neither helper is
/// `pub(crate)`, and the duplication is a handful of lines.
fn read_chunk(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let n = file.read(&mut buf[total..])?;
        if n == 0 || total + n == buf.len() {
            return Ok(total + n);
        }
        total += n;
    }
}

/// Stream the whole file once, counting lines and recording a checkpoint
/// byte offset every `CHECKPOINT_INTERVAL` lines. `encoding` is the
/// document's already-detected encoding (the frontend passes `doc.encoding`
/// ) — used only to reject UTF-16 up front; the scan itself never decodes.
#[tauri::command]
pub fn build_line_index(path: String, encoding: String) -> Result<LineIndexReport, String> {
    reject_utf16(&encoding, "Line index")?;

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let indexed_size = meta.len();
    // Tied to the open handle's own metadata, same as the scan below —
    // never a re-stat of the path, which could describe a different file.
    let fingerprint = Fingerprint::from_metadata(&meta).ok();

    let mut checkpoints = Vec::new();
    if indexed_size > 0 {
        checkpoints.push(0);
    }

    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut offset: u64 = 0;
    let mut total_lines: u64 = 0;
    let mut pending_cr = false;
    // Absolute offset right after the most recently found line terminator;
    // 0 until the first one is found. Compared against `indexed_size` after
    // the loop to detect a trailing, unterminated partial line (replaces
    // the old LF-only `ends_with_newline` flag with one that also accounts
    // for CRLF and lone-CR terminators).
    let mut last_break_end: u64 = 0;
    loop {
        let n =
            read_chunk(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        scan_line_breaks(
            &buf[..n],
            offset,
            &mut pending_cr,
            |next_line_start, _kind| {
                total_lines += 1;
                last_break_end = next_line_start;
                if total_lines.is_multiple_of(CHECKPOINT_INTERVAL) && next_line_start < indexed_size
                {
                    checkpoints.push(next_line_start);
                }
            },
        );
        offset += n as u64;
        if n < buf.len() {
            break; // short read == EOF, matches read_chunk's contract
        }
    }
    if pending_cr {
        // The file's very last byte was an unresolved CR: a lone-CR
        // terminator right at EOF, exactly like a trailing LF/CRLF would
        // be — it ends the last line, so no phantom empty line follows it.
        // Never a checkpoint target: `last_break_end` lands on
        // `indexed_size`, which always fails the `< indexed_size` guard
        // above, same as any other terminator sitting at end of file.
        total_lines += 1;
        last_break_end = indexed_size;
    }
    if indexed_size > 0 && last_break_end != indexed_size {
        // Trailing content with no terminator at all is still a line.
        total_lines += 1;
    }

    Ok(LineIndexReport {
        checkpoints,
        total_lines,
        indexed_size,
        fingerprint,
    })
}

/// A resolved line offset, or the discovery that the index it came from
/// no longer describes the file (issue #251). Same structured-staleness
/// shape as `chunk.rs`'s `DocumentChunk.stale` / `save_document`'s
/// `SaveResult.stale`: the frontend branches on a field, never on an
/// error string.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocatedOffset {
    /// Meaningless (echoes `from_offset`) when `stale` is true.
    pub offset: u64,
    pub stale: bool,
}

/// Resolve the byte offset of `target_line`'s first byte by streaming from
/// `from_offset` (the caller-guaranteed byte offset of `from_line`'s first
/// byte — normally a `build_line_index` checkpoint). Both line numbers are
/// 0-based, matching `LineIndexReport::checkpoints`. `target_line <
/// from_line` is rejected: the caller is expected to pick a checkpoint at
/// or before the target, never after. Scanning past EOF without reaching
/// `target_line` clamps to the last line's start instead of erroring —
/// asking to go to line 50,000,000 of a 10,000-line file is a normal user
/// typo, not a failure worth interrupting them over.
///
/// `expected` is the fingerprint of the index snapshot `from_offset` came
/// from (`LineIndexReport::fingerprint`); when given and no longer
/// matching the file — including a same-size overwrite the frontend's
/// size check cannot see — the walk is refused as stale instead of
/// resolving line numbers against a byte topology that no longer exists.
#[tauri::command]
pub fn locate_line_offset(
    path: String,
    target_line: u64,
    from_offset: u64,
    from_line: u64,
    expected: Option<Fingerprint>,
) -> Result<LocatedOffset, String> {
    if target_line < from_line {
        return Err(format!(
            "target_line {target_line} precedes from_line {from_line}; \
             the caller must pick a checkpoint at or before the target"
        ));
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();
    if let Some(expected) = &expected {
        // Fail-closed, mirroring chunk.rs's `is_stale`: an unreadable
        // mtime counts as a mismatch.
        let matches = Fingerprint::from_metadata(&meta).is_ok_and(|actual| actual == *expected);
        if !matches {
            return Ok(LocatedOffset {
                offset: from_offset,
                stale: true,
            });
        }
    }
    if target_line == from_line {
        // Verified above (when a fingerprint was given) even though no
        // scan is needed — a direct checkpoint hit on a stale index must
        // not slip through just because it required no walking.
        return Ok(LocatedOffset {
            offset: from_offset,
            stale: false,
        });
    }
    file.seek(SeekFrom::Start(from_offset))
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    let mut current_line = from_line;
    let mut offset = from_offset;
    // `from_offset` is guaranteed by the caller to be a real line start, so
    // it is always a valid clamp target even if nothing more is found.
    let mut last_line_start = from_offset;
    let mut pending_cr = false;
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let n =
            read_chunk(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
        if n == 0 {
            break;
        }
        let mut found: Option<u64> = None;
        scan_line_breaks(&buf[..n], offset, &mut pending_cr, |line_start, _kind| {
            if found.is_some() {
                return; // target already matched earlier in this chunk
            }
            current_line += 1;
            if line_start >= total_size {
                // Nothing actually starts here (EOF right at this
                // terminator) — matches build_line_index's own checkpoint
                // guard, so this can never be a real target.
                return;
            }
            last_line_start = line_start;
            if current_line == target_line {
                found = Some(line_start);
            }
        });
        if let Some(line_start) = found {
            return Ok(LocatedOffset {
                offset: line_start,
                stale: false,
            });
        }
        offset += n as u64;
        if n < buf.len() {
            break;
        }
    }
    // Unlike `build_line_index`, a trailing unresolved `pending_cr` at true
    // EOF needs no finalization here: it would always resolve to a line
    // start of exactly `total_size`, which the closure above already
    // rejects via the `line_start >= total_size` guard — so it can never
    // change `last_line_start` or the clamp result below.
    //
    // EOF (or a target beyond the last line) without a match: clamp.
    Ok(LocatedOffset {
        offset: last_line_start,
        stale: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 13 bytes/line ("line-" + 7 digits + "\n") so offsets are k * 13 and
    /// hand-computable.
    fn fixed_width_lines(count: u64) -> String {
        let mut s = String::with_capacity((count * 13) as usize);
        for i in 0..count {
            s.push_str(&format!("line-{i:07}\n"));
        }
        s
    }

    /// 14 bytes/line ("line-" + 7 digits + "\r\n").
    fn fixed_width_crlf_lines(count: u64) -> String {
        let mut s = String::with_capacity((count * 14) as usize);
        for i in 0..count {
            s.push_str(&format!("line-{i:07}\r\n"));
        }
        s
    }

    /// 13 bytes/line ("line-" + 7 digits + "\r"): lone-CR (Classic Mac)
    /// line endings, same width as `fixed_width_lines` so offsets stay
    /// hand-computable and directly comparable to the LF fixture.
    fn fixed_width_cr_lines(count: u64) -> String {
        let mut s = String::with_capacity((count * 13) as usize);
        for i in 0..count {
            s.push_str(&format!("line-{i:07}\r"));
        }
        s
    }

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn index_counts_lines_and_checkpoints_correctly() {
        let content = fixed_width_lines(5000);
        let path = write_temp("mojidori-lineindex-5000.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(report.total_lines, 5000);
        assert_eq!(report.indexed_size, content.len() as u64);
        assert_eq!(
            report.checkpoints,
            vec![0, 1024 * 13, 2048 * 13, 3072 * 13, 4096 * 13],
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn index_spans_multiple_chunk_reads() {
        // Just over CHUNK_BYTES (8 MiB) at 13 bytes/line, so build_line_index
        // must loop its read_chunk call at least twice — this is the case
        // that would break from an off-by-one in the running `offset`
        // counter carried across reads.
        let lines = (CHUNK_BYTES as u64 / 13) + 2000;
        let content = fixed_width_lines(lines);
        assert!(
            content.len() > CHUNK_BYTES,
            "fixture must span >1 chunk read"
        );
        let path = write_temp("mojidori-lineindex-multichunk.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(report.total_lines, lines);
        assert_eq!(report.indexed_size, content.len() as u64);
        let expected_last_k = (lines - 1) / CHECKPOINT_INTERVAL;
        assert_eq!(
            *report.checkpoints.last().unwrap(),
            expected_last_k * CHECKPOINT_INTERVAL * 13
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn locate_line_offset_finds_exact_line() {
        let content = fixed_width_lines(5000);
        let path = write_temp("mojidori-lineindex-locate.txt", &content);
        let path_str = path.to_string_lossy().into_owned();

        // target_line == from_line: returns from_offset without scanning.
        assert_eq!(
            locate_line_offset(path_str.clone(), 0, 0, 0, None)
                .unwrap()
                .offset,
            0
        );

        // From the checkpoint at line 1024 (offset 1024*13), find line 1500.
        let offset = locate_line_offset(path_str.clone(), 1500, 1024 * 13, 1024, None)
            .unwrap()
            .offset;
        assert_eq!(offset, 1500 * 13);
        std::fs::remove_file(&path).ok();

        // CRLF file: line starts still land right after \n (the \r stays
        // part of the previous line), so each line is 14 bytes wide here —
        // same treatment chunk.rs gives CRLF content.
        let crlf_content = fixed_width_crlf_lines(3000);
        let crlf_path = write_temp("mojidori-lineindex-crlf.txt", &crlf_content);
        let crlf_offset =
            locate_line_offset(crlf_path.to_string_lossy().into_owned(), 2500, 0, 0, None)
                .unwrap()
                .offset;
        assert_eq!(crlf_offset, 2500 * 14);
        std::fs::remove_file(&crlf_path).ok();
    }

    #[test]
    fn locate_line_offset_rejects_target_before_from() {
        let result = locate_line_offset("/tmp/whatever.txt".into(), 5, 1300, 100, None);
        assert!(result.is_err());
    }

    #[test]
    fn locate_clamps_past_eof() {
        let content = fixed_width_lines(10);
        let path = write_temp("mojidori-lineindex-clamp.txt", &content);
        let path_str = path.to_string_lossy().into_owned();

        let offset = locate_line_offset(path_str, 999_999, 0, 0, None)
            .unwrap()
            .offset;
        assert_eq!(
            offset,
            9 * 13,
            "clamps to line 9's start, the last of 0..=9"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16() {
        let result = build_line_index("/tmp/whatever.txt".into(), "UTF-16LE".into());
        assert!(result.is_err());
        let result = build_line_index("/tmp/whatever.txt".into(), "UTF-16BE".into());
        assert!(result.is_err());
    }

    #[test]
    fn empty_file_and_single_line_file() {
        let empty_path = write_temp("mojidori-lineindex-empty.txt", "");
        let report =
            build_line_index(empty_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 0);
        assert_eq!(report.checkpoints, Vec::<u64>::new());
        assert_eq!(report.indexed_size, 0);
        std::fs::remove_file(&empty_path).ok();

        // No trailing newline: still exactly one line.
        let single_path = write_temp("mojidori-lineindex-single.txt", "hello, world");
        let report =
            build_line_index(single_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 1);
        assert_eq!(report.checkpoints, vec![0]);
        std::fs::remove_file(&single_path).ok();

        // A lone newline: one (empty) line, fully terminated.
        let lone_nl_path = write_temp("mojidori-lineindex-lonenl.txt", "\n");
        let report =
            build_line_index(lone_nl_path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 1);
        assert_eq!(report.checkpoints, vec![0]);
        std::fs::remove_file(&lone_nl_path).ok();
    }

    // --- Issue #119: CR-only (Classic Mac) large-file line index ---------
    //
    // The line index previously only recognized `0x0A` (LF) as a line
    // terminator, matching the pre-#92 blind spot in
    // `encoding::detect_line_ending`. A CR-only file was therefore counted
    // as a single line regardless of its real size, breaking Go to Line and
    // bookmarks for Classic Mac line endings. These tests lock the fixed
    // behavior: LF, CRLF (counted once), and lone CR all terminate a line,
    // matching `encoding::detect_line_ending`'s three-way split (#92).

    #[test]
    fn cr_only_index_counts_lines_and_checkpoints_correctly() {
        let content = fixed_width_cr_lines(5000);
        let path = write_temp("mojidori-lineindex-cronly-5000.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(
            report.total_lines, 5000,
            "CR-only file must not collapse into a single line"
        );
        assert_eq!(report.indexed_size, content.len() as u64);
        assert_eq!(
            report.checkpoints,
            vec![0, 1024 * 13, 2048 * 13, 3072 * 13, 4096 * 13],
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn cr_only_locate_line_offset_finds_exact_line() {
        let content = fixed_width_cr_lines(3000);
        let path = write_temp("mojidori-lineindex-cronly-locate.txt", &content);
        let path_str = path.to_string_lossy().into_owned();

        let offset = locate_line_offset(path_str, 2500, 0, 0, None)
            .unwrap()
            .offset;
        assert_eq!(offset, 2500 * 13);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn crlf_index_does_not_double_count_lines() {
        // A CRLF pair must contribute exactly one line break, not two (one
        // for the CR, one for the LF) — otherwise total_lines would come
        // out double the real line count.
        let content = fixed_width_crlf_lines(3000);
        let path = write_temp("mojidori-lineindex-crlf-nodouble.txt", &content);

        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();

        assert_eq!(report.total_lines, 3000);
        assert_eq!(report.indexed_size, content.len() as u64);
        assert_eq!(
            report.checkpoints,
            vec![0, 1024 * 14, 2048 * 14],
            "checkpoints must land on real line starts, 14 bytes apart"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mixed_line_endings_each_style_counts_once() {
        // LF, CRLF, and lone CR in the same file, each terminating exactly
        // one line: "aaa\n" + "bbb\r\n" + "ccc\r" + "ddd\n".
        let content = "aaa\nbbb\r\nccc\rddd\n";
        let path = write_temp("mojidori-lineindex-mixed.txt", content);
        let path_str = path.to_string_lossy().into_owned();

        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 4);
        assert_eq!(report.indexed_size, content.len() as u64);

        assert_eq!(
            locate_line_offset(path_str.clone(), 1, 0, 0, None)
                .unwrap()
                .offset,
            4
        );
        assert_eq!(
            locate_line_offset(path_str.clone(), 2, 0, 0, None)
                .unwrap()
                .offset,
            9
        );
        assert_eq!(
            locate_line_offset(path_str.clone(), 3, 0, 0, None)
                .unwrap()
                .offset,
            13
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lone_cr_terminates_last_line_without_phantom_trailing_line() {
        // Mirrors `empty_file_and_single_line_file`'s LF cases but for a
        // trailing lone CR: the file ends exactly on a terminator, so no
        // phantom empty line follows it.
        let path = write_temp("mojidori-lineindex-cr-trailing.txt", "hello\r");
        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 1);
        assert_eq!(report.checkpoints, vec![0]);
        std::fs::remove_file(&path).ok();

        // Two consecutive lone CRs: two empty lines, both fully terminated.
        let path2 = write_temp("mojidori-lineindex-cr-cr.txt", "\r\r");
        let report2 =
            build_line_index(path2.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert_eq!(report2.total_lines, 2);
        std::fs::remove_file(&path2).ok();
    }

    #[test]
    fn crlf_split_exactly_across_chunk_boundary() {
        // The classic streaming-scanner pitfall: a "\r\n" pair straddles a
        // `read_chunk` call boundary, CR as the very last byte of the first
        // CHUNK_BYTES-sized read and LF as the very first byte of the next.
        // Must still be recognized as a single line break, not a lone CR
        // plus a lone LF (which would over-count by one and misplace every
        // subsequent offset by one byte).
        let prefix_len = CHUNK_BYTES - 1;
        let mut content = vec![b'a'; prefix_len];
        content.extend_from_slice(b"\r\nsecond\nthird");
        assert_eq!(
            content[CHUNK_BYTES - 1],
            b'\r',
            "fixture must place CR as the last byte of the first chunk read"
        );
        assert_eq!(
            content[CHUNK_BYTES], b'\n',
            "fixture must place LF as the first byte of the second chunk read"
        );

        let path = crate::testutil::temp_path("mojidori-lineindex-crlf-chunk-split.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        assert_eq!(
            report.total_lines, 3,
            "split CRLF must count as exactly one line break, not two"
        );
        assert_eq!(report.indexed_size, content.len() as u64);

        // Line 1 ("second") must start right after the split CRLF, at
        // CHUNK_BYTES + 1 — not CHUNK_BYTES (double-counted CR) or anything
        // else off by one.
        let line1_offset = locate_line_offset(path_str.clone(), 1, 0, 0, None)
            .unwrap()
            .offset;
        assert_eq!(line1_offset, CHUNK_BYTES as u64 + 1);
        let line2_offset = locate_line_offset(path_str, 2, 0, 0, None).unwrap().offset;
        assert_eq!(
            line2_offset,
            CHUNK_BYTES as u64 + 1 + "second\n".len() as u64
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn lone_cr_at_chunk_boundary_not_confused_with_crlf() {
        // The other half of the classic pitfall: a lone CR (not part of a
        // CRLF) as the very last byte of a chunk read, followed by a
        // non-newline byte as the first byte of the next chunk. Must
        // resolve as a completed lone-CR line break exactly at the chunk
        // boundary, without waiting to see whether a `\n` was coming.
        let prefix_len = CHUNK_BYTES - 1;
        let mut content = vec![b'a'; prefix_len];
        content.extend_from_slice(b"\rXsecond\nthird");
        assert_eq!(content[CHUNK_BYTES - 1], b'\r');
        assert_eq!(
            content[CHUNK_BYTES], b'X',
            "fixture must place a non-newline byte right after the CR, at the next chunk's start"
        );

        let path = crate::testutil::temp_path("mojidori-lineindex-lonecr-chunk-split.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 3);
        assert_eq!(report.indexed_size, content.len() as u64);

        // Line 1 ("Xsecond") starts immediately after the lone CR, i.e. at
        // the very first byte of the second chunk read.
        let line1_offset = locate_line_offset(path_str.clone(), 1, 0, 0, None)
            .unwrap()
            .offset;
        assert_eq!(line1_offset, CHUNK_BYTES as u64);
        let line2_offset = locate_line_offset(path_str, 2, 0, 0, None).unwrap().offset;
        assert_eq!(line2_offset, CHUNK_BYTES as u64 + "Xsecond\n".len() as u64);

        std::fs::remove_file(&path).ok();
    }

    // ---- issue #251: index fingerprint + locate version validation ----

    #[test]
    fn line_index_report_carries_a_fingerprint() {
        let path = write_temp("mojidori-lineindex-fp.txt", &fixed_width_lines(10));
        let report = build_line_index(path.to_string_lossy().into_owned(), "UTF-8".into()).unwrap();
        assert!(
            report.fingerprint.is_some(),
            "a freshly built index must describe the file version it scanned"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn locate_is_stale_when_the_file_changed_since_the_index() {
        let path = write_temp("mojidori-lineindex-stale.txt", &fixed_width_lines(2000));
        let path_str = path.to_string_lossy().into_owned();
        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        let fp = report.fingerprint.expect("fingerprint must be captured");

        // Grow the file after the index was built: len changes, so the
        // mismatch is deterministic regardless of mtime resolution.
        std::fs::write(&path, fixed_width_lines(2001)).unwrap();

        let located = locate_line_offset(path_str, 1500, 1024 * 13, 1024, Some(fp)).unwrap();
        assert!(
            located.stale,
            "a checkpoint from a superseded index must not be dereferenced"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn locate_with_matching_fingerprint_resolves_normally() {
        let path = write_temp("mojidori-lineindex-fp-match.txt", &fixed_width_lines(2000));
        let path_str = path.to_string_lossy().into_owned();
        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        let fp = report.fingerprint.expect("fingerprint must be captured");

        let located = locate_line_offset(path_str, 1500, 1024 * 13, 1024, Some(fp)).unwrap();
        assert!(!located.stale);
        assert_eq!(located.offset, 1500 * 13);
        std::fs::remove_file(&path).ok();
    }

    /// A goto that lands exactly on a checkpoint line needs no scan at all
    /// -- the fast path used to return before the file was even opened.
    /// A stale index must be caught on this path too, not only when a
    /// walk happens.
    #[test]
    fn locate_checkpoint_direct_hit_still_validates_the_fingerprint() {
        let path = write_temp("mojidori-lineindex-stale-hit.txt", &fixed_width_lines(2000));
        let path_str = path.to_string_lossy().into_owned();
        let report = build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        let fp = report.fingerprint.expect("fingerprint must be captured");

        std::fs::write(&path, fixed_width_lines(2001)).unwrap();

        let located = locate_line_offset(path_str, 1024, 1024 * 13, 1024, Some(fp)).unwrap();
        assert!(located.stale);
        std::fs::remove_file(&path).ok();
    }
}
