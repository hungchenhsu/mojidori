//! Chunked reading of large files for paged read-only viewing. Chunks are
//! aligned to line boundaries — LF, CRLF, or lone CR, the shared semantics
//! defined in `linebreak.rs` (#119/#132), so alignment always agrees with
//! the line starts `lineindex.rs` computes for go-to-line and bookmarks.
//! Byte-level alignment is only sound for ASCII-compatible, stateless
//! encodings — UTF-16 and ISO-2022-JP paging are both rejected at the
//! command layer (UTF-16 for the ASCII-compatibility reason; ISO-2022-JP,
//! issue #225, for the statelessness one — see below).
//!
//! A single line longer than `CHUNK_BYTES` (issue #118) cannot be aligned
//! to a terminator at all — the chunk that reads it finds none anywhere
//! in its buffer, so the buffer is returned as-is (a raw, unterminated
//! slice) and the next chunk continues from exactly where it left off.
//! Every offset this module ever hands out is therefore either a genuine
//! line start or one of these raw mid-line continuation points. Forward
//! reads take an `OffsetKind` so the two offset sources keep distinct
//! semantics: the module's own `next_offset` chain is continued exactly
//! (`Continuation` — forward paging has no later read that could recover
//! a skipped byte), while a goto/bookmark jump offset from the possibly
//! stale line index (`LineStart`) is defensively realigned to the next
//! real line start when it turns out not to be one. Backward reads
//! (`read_document_chunk_before`) only discard a leading fragment when a
//! non-empty remainder is guaranteed to be left after it. A raw cut can
//! also land mid-character; `encoding::trim_truncated_utf8_tail` /
//! `trim_truncated_utf8_head` fix the boundary back up for UTF-8, and
//! `trim_truncated_legacy_tail` / `trim_truncated_legacy_head` do the same
//! for the other paging-supported multi-byte encodings (Big5, Shift_JIS,
//! GBK, gb18030, EUC-JP, EUC-KR — issue #213, following #165's identical
//! tail-only fix for the large-file preview path). Single-byte encodings
//! never split a character across a byte cut in the first place, so they
//! need no trim either. For every encoding paging still supports, an
//! untrimmed raw cut that does land mid-sequence is caught by
//! `decode_with` reporting `malformed: true` on the very page the cut
//! lands in.
//!
//! ISO-2022-JP cannot rely on that same "an untrimmed cut still self-
//! reports" argument, which is why it is excluded from paging entirely
//! (issue #225) rather than merely left untrimmed like the single-byte
//! case above: it is the one `encoding_rs` encoding whose *decoder* is
//! genuinely stateful (a shift escape sequence changes the meaning of
//! every subsequent byte for the rest of the stream, not just the next
//! character — see `encoding::is_legacy_multibyte_label`'s doc comment and
//! the judgment-overlay dead-end this repeats), and every chunk read here
//! builds a brand new decoder with no memory of the previous page's shift
//! state. A raw cut landing inside a JIS shift sequence does report
//! `malformed: true` on *that* page as expected, but the *next* page's
//! fresh decoder silently resumes from the default ASCII/ROMAN state and
//! can misdecode well-formed-*looking* — but wrong — text with `malformed:
//! false`: exactly the silent-corruption failure mode this app's decode-
//! error contract (ARCHITECTURE.md) exists to prevent. No fixed
//! per-character byte bound exists to retry the cut against the way there
//! is for the legacy multi-byte encodings above, so unlike them there is
//! no sound trim to apply here; the whole encoding is refused at the
//! command layer instead, the same choice already made for UTF-16.

use crate::encoding;
use crate::fsguard::Fingerprint;
use crate::linebreak::{align_start, cut_tail_at_line_break, is_line_start};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};

pub const CHUNK_BYTES: usize = 2 * 1024 * 1024;

/// What `read_document_chunk`'s `offset` is, declared by the caller —
/// the two offset sources need opposite alignment policies (#118).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum OffsetKind {
    /// The offset claims to be a line start but comes from a source that
    /// can be stale — the line-offset index behind go-to-line and
    /// bookmark jumps (`lineindex.rs`; a missed watcher event leaves it
    /// describing the previous file version). Verified against the
    /// neighboring bytes and defensively realigned forward to the next
    /// real line start when the claim is wrong. Safe here, unlike in a
    /// continuation chain: a goto is a fresh jump, so skipping a stale
    /// offset's partial line moves the window, it doesn't lose bytes
    /// from an assembled sequence.
    LineStart,
    /// The offset is a continuation point from this module's own
    /// `next_offset` chain (Next paging, continuous reading). Read
    /// exactly from here — mid-line when the previous chunk ended inside
    /// an overlong line — because realigning would silently skip the
    /// bytes between the offset and the next terminator (issue #118).
    Continuation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChunk {
    pub content: String,
    /// Line-aligned offset this chunk actually starts at.
    pub offset: u64,
    /// File offset where the next chunk begins; None at end of file.
    pub next_offset: Option<u64>,
    pub total_size: u64,
    pub malformed: bool,
    /// True when the caller's `expected` fingerprint no longer matches the
    /// file — the offsets the caller is paging with describe a previous
    /// file version, so no content is returned (every other field is a
    /// placeholder) and the caller must reload before paging on (issue
    /// #251). Structured, not an `Err`: the same shape `save_document`'s
    /// `SaveResult.stale` uses for its own fingerprint rejection, so the
    /// frontend branches on a field instead of sniffing error strings.
    pub stale: bool,
}

/// The placeholder `DocumentChunk` every stale detection returns: no
/// content, no continuation. `total_size` is the file's *current* size,
/// purely informational.
fn stale_chunk(total_size: u64) -> DocumentChunk {
    DocumentChunk {
        content: String::new(),
        offset: 0,
        next_offset: None,
        total_size,
        malformed: false,
        stale: true,
    }
}

/// Fail-closed staleness test run against the just-opened handle's own
/// metadata — the read that follows uses the same handle, so (on Unix,
/// where identity pins the inode) content and verdict cannot diverge.
/// With an `expected` fingerprint: stale unless the metadata still
/// matches it exactly; a metadata/mtime read error also counts as stale
/// (fail-closed, mirroring `Fingerprint::matches_path`). Without one
/// (an old caller, or an `open_document` that couldn't fingerprint):
/// only the offset range can be checked — a `requested_end` past the
/// current EOF proves the caller's offsets describe a bigger, earlier
/// version of the file (issue #251's shrink-during-paging case, which
/// previously came back as a silent empty chunk).
fn is_stale(meta: &std::fs::Metadata, expected: Option<&Fingerprint>, requested_end: u64) -> bool {
    match expected {
        Some(expected) => !Fingerprint::from_metadata(meta).is_ok_and(|actual| actual == *expected),
        None => requested_end > meta.len(),
    }
}

fn read_up_to(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let n = file.read(&mut buf[total..])?;
        if n == 0 || total + n == buf.len() {
            return Ok(total + n);
        }
        total += n;
    }
}

#[tauri::command]
pub fn read_document_chunk(
    path: String,
    offset: u64,
    encoding: String,
    kind: OffsetKind,
    expected: Option<Fingerprint>,
) -> Result<DocumentChunk, String> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Err("Paging is not supported for UTF-16 files".into());
    }
    // Issue #225: ISO-2022-JP's decoder is the one `encoding_rs` encoding
    // that is genuinely stateful (see the module doc comment above). A raw
    // chunk cut can land inside a JIS shift sequence; the next page's fresh
    // `decode_with` call has no way to resume that state and would silently
    // misdecode the rest of the page as ASCII with `malformed: false` --
    // there is no fixed per-character byte bound to retry the cut against
    // the way there is for the legacy multi-byte encodings the trims below
    // support, so paging is rejected outright here rather than attempting a
    // lossy cut, exactly like UTF-16 above. Identity comparison against the
    // static singleton (not a string/label compare), matching the
    // established pattern (streamreplace.rs's `enc != ISO_2022_JP` gate).
    if enc == encoding_rs::ISO_2022_JP {
        return Err("Paging is not supported for ISO-2022-JP files".into());
    }
    // Gates the legacy-multi-byte trims below (both the align_start
    // stale-offset fallback and the tail cut) exactly the way
    // `open_document`'s trim gate in `lib.rs` does, so this can never
    // disagree with what `decode_with` is about to do for the same label.
    let is_legacy_multibyte = encoding::is_legacy_multibyte_label(&encoding);

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();
    if is_stale(&meta, expected.as_ref(), offset) {
        return Ok(stale_chunk(total_size));
    }

    // Only a LineStart read peeks the byte before `offset`: together
    // with the chunk's own first byte it decides whether the claimed
    // line start really is one — see `linebreak::is_line_start` for why
    // the first byte matters (a CR directly followed by LF is a CRLF's
    // first half, not a line end). Reading the peek byte leaves the
    // cursor exactly at `offset`. A Continuation read never realigns
    // (issue #118: nothing ever revisits a byte forward paging skips),
    // so it seeks straight to `offset`.
    let mut prev_byte = None;
    if kind == OffsetKind::LineStart && offset > 0 {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        prev_byte = Some(prev[0]);
    } else {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
    }
    let mut buf = vec![0u8; CHUNK_BYTES];
    let n = read_up_to(&mut file, &mut buf).map_err(|e| format!("Failed to read {path}: {e}"))?;
    buf.truncate(n);

    let skip = match kind {
        OffsetKind::Continuation => 0,
        OffsetKind::LineStart => {
            let at_line_start = match prev_byte {
                None => true, // offset == 0
                Some(prev) => is_line_start(prev, buf.first().copied()),
            };
            if at_line_start {
                0
            } else {
                match align_start(&buf) {
                    // No line start anywhere in the window — the stale
                    // offset sits inside a line longer than CHUNK_BYTES.
                    // Fall back to a raw continuation-style read (never
                    // an empty or skipped window); the raw stale offset
                    // can split a multi-byte character, so drop its
                    // orphaned trailing-fragment bytes for whichever
                    // paging-supported encoding can have one (UTF-8, or
                    // one of the legacy multi-byte encodings — issue
                    // #213). `align_start`'s nonzero result needs no such
                    // trim: it lands right after a real terminator,
                    // always a clean boundary.
                    0 if enc == encoding_rs::UTF_8 => {
                        buf.len() - encoding::trim_truncated_utf8_head(&buf).len()
                    }
                    0 if is_legacy_multibyte => {
                        // `false`: unlike `read_document_chunk_before`'s
                        // window, `buf`'s own tail is not known to sit on
                        // a real boundary — the overlong line can well
                        // continue past this whole CHUNK_BYTES window too
                        // — so the check must tolerate a genuinely
                        // dangling tail instead of rejecting the correct
                        // candidate because of it (see
                        // `trim_truncated_legacy_head`'s doc comment).
                        buf.len()
                            - encoding::trim_truncated_legacy_head(&buf, &encoding, false).len()
                    }
                    aligned => aligned,
                }
            }
        }
    };
    let aligned = &buf[skip..];

    let end_is_eof = offset + n as u64 >= total_size;
    let (slice, next_offset) = if end_is_eof {
        // The file's own end is always a complete, valid boundary for a
        // well-formed encoding — trimming here would silently swallow a
        // genuinely malformed trailing sequence instead of reporting it.
        (aligned, None)
    } else {
        let cut = cut_tail_at_line_break(aligned);
        // `cut` ends either right after a real line terminator — always
        // a clean boundary, since a line-break byte is never part of a
        // multibyte sequence (linebreak.rs's ASCII-compatibility
        // guarantee) — or, when the whole buffer had no terminator at
        // all, at a raw CHUNK_BYTES cut that can land mid-character.
        // Trimming is then a no-op in the first case (both trim functions
        // only ever touch a truncated-at-the-end sequence) and otherwise
        // UTF-8- or legacy-multi-byte-specific — see
        // `trim_truncated_utf8_tail`'s doc for why a blind byte-range
        // check would misfire on other multibyte encodings, which its own
        // `str::from_utf8` validation avoids, and
        // `trim_truncated_legacy_tail`'s doc for the legacy-encoding
        // sibling (issue #213, following #165's identical fix for the
        // large-file preview path).
        let cut = if enc == encoding_rs::UTF_8 {
            encoding::trim_truncated_utf8_tail(cut)
        } else if is_legacy_multibyte {
            encoding::trim_truncated_legacy_tail(cut, &encoding)
        } else {
            cut
        };
        (cut, Some(offset + (skip + cut.len()) as u64))
    };

    let decoded = encoding::decode_with(slice, &encoding)?;
    Ok(DocumentChunk {
        content: encoding::normalize_to_lf(&decoded.content),
        offset: offset + skip as u64,
        next_offset,
        total_size,
        malformed: decoded.malformed,
        stale: false,
    })
}

/// Read the chunk that ends exactly at `end` (exclusive), for extending a
/// large-file window backward. `end` must be line-aligned, which holds for
/// every window start this app produces. The returned `offset` is the
/// line-aligned start of the chunk; `next_offset` echoes `end`.
#[tauri::command]
pub fn read_document_chunk_before(
    path: String,
    end: u64,
    encoding: String,
    expected: Option<Fingerprint>,
) -> Result<DocumentChunk, String> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Err("Paging is not supported for UTF-16 files".into());
    }
    // Same ISO-2022-JP gate as `read_document_chunk`'s -- see its comment
    // for why (issue #225).
    if enc == encoding_rs::ISO_2022_JP {
        return Err("Paging is not supported for ISO-2022-JP files".into());
    }
    // Same gate as `read_document_chunk`'s, reused for the head trim below.
    let is_legacy_multibyte = encoding::is_legacy_multibyte_label(&encoding);
    if end == 0 {
        return Err("Already at the start of the file".into());
    }

    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();
    // `end` is this read's furthest byte, so it doubles as the range probe
    // for the no-fingerprint fallback (a shrunken file would otherwise
    // fail the `read_exact` below with a raw IO error).
    if is_stale(&meta, expected.as_ref(), end) {
        return Ok(stale_chunk(total_size));
    }
    let start = end.saturating_sub(CHUNK_BYTES as u64);

    let mut prev_byte = None;
    if start > 0 {
        file.seek(SeekFrom::Start(start - 1))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        let mut prev = [0u8; 1];
        file.read_exact(&mut prev)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        prev_byte = Some(prev[0]);
    } else {
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
    }

    let mut buf = vec![0u8; (end - start) as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    // Same neighbor-pair line-start test as `read_document_chunk`; the
    // buffer's first byte disambiguates a preceding CR (lone CR vs the
    // first half of a CRLF).
    let at_line_start = match prev_byte {
        None => true, // start == 0
        Some(prev) => is_line_start(prev, buf.first().copied()),
    };
    // Unlike forward paging, discarding a leading fragment here is
    // usually safe: a further backward read re-covers whatever this one
    // discards, since `end` becomes exactly this chunk's `offset`. The
    // one exception is issue #118's overlong-line case: a window that
    // lands entirely inside one line longer than CHUNK_BYTES has exactly
    // one terminator-like byte — that line's own closing terminator,
    // which (because `end` is always defined as immediately after it)
    // sits at the window's very last byte(s). `align_start`'s "skip past
    // the first terminator" would then consume the *entire* buffer,
    // leaving an empty, non-progressing chunk (offset == end, forever).
    // Only trust its result when a non-empty remainder is left;
    // otherwise fall back to the whole window, mirroring the forward
    // direction's raw continuation.
    let skip = if at_line_start {
        0
    } else {
        let aligned = align_start(&buf);
        if aligned < buf.len() {
            aligned
        } else {
            0
        }
    };
    // A raw (non-terminator-based) start can land mid-character; one
    // right after a genuine terminator never does (linebreak.rs's
    // ASCII-compatibility guarantee). Trimming is a no-op in the
    // terminator case and otherwise UTF-8- or legacy-multi-byte-specific,
    // like the forward direction's tail trim. Same guard as `skip` above:
    // never trust a trim that would consume the entire window — a window
    // of nothing but orphaned trailing-fragment bytes (unreachable
    // through the app's own line-aligned `end` values today, but a
    // future caller could drift) must stay an honest U+FFFD chunk rather
    // than collapse to an empty, non-progressing one with offset == end.
    let pre_trim = &buf[skip..];
    let slice = if enc == encoding_rs::UTF_8 {
        let trimmed = encoding::trim_truncated_utf8_head(pre_trim);
        if trimmed.is_empty() && !pre_trim.is_empty() {
            pre_trim
        } else {
            trimmed
        }
    } else if is_legacy_multibyte {
        // `true`: this window's tail always sits exactly at the
        // caller-supplied `end`, which the module doc guarantees is
        // line-aligned — a real, already-verified character boundary —
        // so the stricter forced-final check correctly rejects a
        // wrong-phase candidate that would otherwise dangle right at that
        // edge (see `trim_truncated_legacy_head`'s doc comment).
        let trimmed = encoding::trim_truncated_legacy_head(pre_trim, &encoding, true);
        if trimmed.is_empty() && !pre_trim.is_empty() {
            pre_trim
        } else {
            trimmed
        }
    } else {
        pre_trim
    };
    let head_trimmed = pre_trim.len() - slice.len();

    let decoded = encoding::decode_with(slice, &encoding)?;
    Ok(DocumentChunk {
        content: encoding::normalize_to_lf(&decoded.content),
        offset: start + skip as u64 + head_trimmed as u64,
        next_offset: Some(end),
        total_size,
        malformed: decoded.malformed,
        stale: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit tests for `align_start` / `cut_tail_at_line_break` /
    // `is_line_start` (including the LF cases that used to live here) are
    // in `linebreak.rs` next to the shared definitions; this module keeps
    // the end-to-end paging tests.

    #[test]
    fn pages_through_a_large_file_losslessly() {
        let path = crate::testutil::temp_path("mojidori-chunk-test.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();
        assert!(original.len() > CHUNK_BYTES);

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(pages >= 2);
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_utf16_paging() {
        let result = read_document_chunk(
            "/tmp/whatever.txt".into(),
            0,
            "UTF-16LE".into(),
            OffsetKind::Continuation,
            None,
        );
        assert!(result.is_err());
        let result =
            read_document_chunk_before("/tmp/whatever.txt".into(), 100, "UTF-16BE".into(), None);
        assert!(result.is_err());
    }

    /// Issue #225: ISO-2022-JP must be rejected at the command layer exactly
    /// like UTF-16, mirroring `rejects_utf16_paging` above. A raw chunk cut
    /// can land inside a JIS shift sequence; the next page's fresh decoder
    /// has no way to resume that state and silently misdecodes the rest of
    /// the page as ASCII with `malformed: false` -- no fixed per-character
    /// byte bound exists to retry the cut against the way there is for the
    /// other legacy multi-byte encodings (`encoding::is_legacy_multibyte_
    /// label`'s doc comment), so the only sound choice is to refuse paging
    /// outright rather than attempt a lossy cut.
    ///
    /// Asserts the specific rejection message rather than plain `is_err()`:
    /// `/tmp/whatever.txt` not existing already makes both calls return
    /// `Err` regardless of any encoding gate (a bare `is_err()` check would
    /// pass even with no ISO-2022-JP handling at all, exactly the false-
    /// green `rejects_utf16_paging` would also produce). Checking for the
    /// encoding gate's own message is what makes this test genuinely red
    /// before the gate exists and green only once it does.
    #[test]
    fn rejects_iso2022jp_paging() {
        let result = read_document_chunk(
            "/tmp/whatever.txt".into(),
            0,
            "ISO-2022-JP".into(),
            OffsetKind::Continuation,
            None,
        );
        // `DocumentChunk` (the `Ok` payload) has no `Debug` impl, so
        // `expect_err`/`unwrap_err` (which require `T: Debug` to format the
        // panic message) don't apply here -- match instead.
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("ISO-2022-JP paging must be rejected"),
        };
        assert!(
            err.contains("ISO-2022-JP"),
            "must be rejected by the encoding gate itself, not merely fail \
             to find the nonexistent file -- got: {err}"
        );
        let result =
            read_document_chunk_before("/tmp/whatever.txt".into(), 100, "ISO-2022-JP".into(), None);
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("ISO-2022-JP paging must be rejected"),
        };
        assert!(
            err.contains("ISO-2022-JP"),
            "must be rejected by the encoding gate itself -- got: {err}"
        );
    }

    // --- Issue #132 (with #119): chunk alignment must share the line
    // semantics of `lineindex.rs`/`encoding::detect_line_ending` (#92):
    // LF, CRLF (one pair, never split), and lone CR all end a line. ----

    /// End-to-end repro of the go-to-line misalignment: `locate_line_offset`
    /// returns the correct byte offset of a line that starts right after a
    /// lone CR, but `read_document_chunk` used to see prev != b'\n', run
    /// `align_start`, and silently shift the window to the *next* LF-line —
    /// while the frontend still labeled the window with the requested line.
    #[test]
    fn goto_offset_on_lone_cr_line_start_is_not_misaligned() {
        let mut content = vec![b'a'; CHUNK_BYTES - 1];
        content.extend_from_slice(b"\rBBB\nCCC\rDDD");
        let path = crate::testutil::temp_path("mojidori-chunk-goto-lonecr.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let report = crate::lineindex::build_line_index(path_str.clone(), "UTF-8".into()).unwrap();
        assert_eq!(report.total_lines, 4);
        let offset = crate::lineindex::locate_line_offset(path_str.clone(), 1, 0, 0, None)
            .unwrap()
            .offset;
        assert_eq!(
            offset, CHUNK_BYTES as u64,
            "line 1 starts after the lone CR"
        );

        let chunk = read_document_chunk(
            path_str,
            offset,
            "UTF-8".into(),
            OffsetKind::LineStart,
            None,
        )
        .unwrap();
        assert_eq!(
            chunk.offset, offset,
            "a locate()-produced line start must not be shifted by alignment"
        );
        assert_eq!(chunk.content, "BBB\nCCC\nDDD");
        std::fs::remove_file(&path).ok();
    }

    /// Same misalignment in the backward-paging path: `end` lands on a line
    /// start whose previous byte is a lone CR; the old prev == b'\n' check
    /// aligned the whole window away into an empty chunk.
    #[test]
    fn backward_page_ending_after_lone_cr_is_not_misaligned() {
        let mut content = b"AA\r".to_vec();
        content.extend(vec![b'b'; CHUNK_BYTES - 1]);
        content.extend_from_slice(b"\nCCC");
        let path = crate::testutil::temp_path("mojidori-chunk-before-lonecr.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // Line starts: 0 ("AA"), 3 (the b-line), CHUNK_BYTES + 3 ("CCC").
        let end = (CHUNK_BYTES + 3) as u64;
        let chunk = read_document_chunk_before(path_str, end, "UTF-8".into(), None).unwrap();
        assert_eq!(chunk.offset, 3);
        assert_eq!(chunk.next_offset, Some(end));
        let expected = "b".repeat(CHUNK_BYTES - 1) + "\n";
        assert_eq!(chunk.content, expected);
        std::fs::remove_file(&path).ok();
    }

    /// CR-only (Classic Mac) file paging: every page boundary must land on
    /// a real line start — before this fix a CR-only file had no
    /// recognizable terminator at all in chunk.rs, so pages degenerated to
    /// arbitrary CHUNK_BYTES cuts mid-line.
    #[test]
    fn pages_through_cr_only_large_file_line_aligned_and_losslessly() {
        let path = crate::testutil::temp_path("mojidori-chunk-cr-only.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\r"));
        }
        let line_width = "line 0000000 with some padding text\r".len() as u64;
        std::fs::write(&path, &original).unwrap();
        assert!(original.len() > 2 * CHUNK_BYTES, "must take several pages");

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assert_eq!(
                chunk.offset % line_width,
                0,
                "every page must start on a real line boundary"
            );
            if chunk.next_offset.is_some() {
                assert!(
                    chunk.content.ends_with('\n'),
                    "every non-final page must end on a complete line"
                );
            }
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(pages >= 2);
        assert_eq!(assembled, original.replace('\r', "\n"));
        std::fs::remove_file(&path).ok();
    }

    /// A CRLF pair whose CR is the last byte of one 2 MiB page read and
    /// whose LF opens the next must stay one pair: assembling all pages
    /// yields exactly one newline there, never two.
    #[test]
    fn crlf_split_at_page_read_boundary_stays_one_pair() {
        let mut content = b"x\n".to_vec();
        content.extend(vec![b'a'; CHUNK_BYTES - 3]);
        content.extend_from_slice(b"\r\nzzz\n");
        assert_eq!(content[CHUNK_BYTES - 1], b'\r');
        assert_eq!(content[CHUNK_BYTES], b'\n');
        let path = crate::testutil::temp_path("mojidori-chunk-crlf-page-split.txt");
        std::fs::write(&path, &content).unwrap();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path.to_string_lossy().into_owned(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        let expected = String::from_utf8(content.clone())
            .unwrap()
            .replace("\r\n", "\n");
        assert_eq!(
            assembled, expected,
            "split CRLF must contribute exactly one newline"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_backward_through_a_large_file_losslessly() {
        let path = crate::testutil::temp_path("mojidori-chunk-back-test.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();

        let path_str = path.to_string_lossy().into_owned();
        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = original.len() as u64;
        let mut pages = 0;
        loop {
            let chunk =
                read_document_chunk_before(path_str.clone(), end, "UTF-8".into(), None).unwrap();
            assert_eq!(chunk.next_offset, Some(end));
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 100, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(pages >= 2);
        assembled_parts.reverse();
        assert_eq!(assembled_parts.concat(), original);

        let result = read_document_chunk_before(path_str, 0, "UTF-8".into(), None);
        assert!(result.is_err(), "end=0 has nothing before it");
        std::fs::remove_file(&path).ok();
    }

    // --- Issue #118: a single line longer than CHUNK_BYTES must never
    // have bytes silently skipped while paging across it, in either
    // direction.
    //
    // Forward: the old path treated "offset doesn't look like a line
    // start" as "realign by skipping to the next terminator" — safe for
    // backward paging (a further backward read recovers whatever it
    // discards) but never safe going forward, where nothing ever
    // revisits a skipped byte. Once a chunk read finally reaches the
    // overlong line's own closing terminator, `align_start` skips past
    // it and discards the whole unterminated remainder that chunk was
    // continuing.
    //
    // Backward: `align_start`'s "skip past the first terminator" is only
    // safe when something remains *after* it. A CHUNK_BYTES backward
    // window that lands entirely inside one overlong line has exactly
    // one terminator-like byte — the line's own closing byte, which
    // (because `end` is always defined as immediately after it) sits at
    // the window's very last position. Skipping past it discards the
    // whole window, producing an empty, non-progressing chunk (offset
    // == end) forever. ---------------------------------------------

    /// 40,000 short lines, then a single ~12 MB line with no newline in
    /// it, then 100,000 more short lines. Plain ASCII — the multibyte
    /// character-boundary concern has its own dedicated fixture/test
    /// below — with enough content on both sides that the chunk which
    /// finally discovers the overlong line's closing terminator is never
    /// itself an EOF read (an EOF read returns its buffer whole with no
    /// call to `cut_tail_at_line_break`/`align_start`, which would
    /// sidestep the bug entirely instead of exercising it).
    fn overlong_line_fixture() -> String {
        let mut original = String::new();
        for i in 0..40_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        original.push_str(&"x".repeat(12_000_000));
        original.push('\n');
        for i in 40_000..140_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        original
    }

    #[test]
    fn pages_through_a_line_longer_than_chunk_bytes_losslessly() {
        let original = overlong_line_fixture();
        assert!(
            original.len() > 8 * CHUNK_BYTES,
            "fixture must span several chunks on both sides of the overlong line"
        );
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-fwd.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert!(
            pages >= 5,
            "the overlong line alone must span several pages"
        );
        assert_eq!(
            assembled.len(),
            original.len(),
            "large-file paging skipped {} bytes across a single line longer \
             than CHUNK_BYTES",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_backward_through_a_line_longer_than_chunk_bytes_losslessly() {
        let original = overlong_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-back.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = original.len() as u64;
        let mut pages = 0;
        loop {
            let chunk =
                read_document_chunk_before(path_str.clone(), end, "UTF-8".into(), None).unwrap();
            assert_eq!(chunk.next_offset, Some(end));
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 100, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(
            pages >= 5,
            "the overlong line alone must span several pages"
        );
        assembled_parts.reverse();
        let assembled = assembled_parts.concat();
        assert_eq!(
            assembled.len(),
            original.len(),
            "backward paging skipped {} bytes across a single line longer \
             than CHUNK_BYTES",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    /// Minimal, fast repro of the backward-paging degenerate case: a
    /// CHUNK_BYTES-sized backward window that sits entirely inside one
    /// line longer than CHUNK_BYTES has exactly one terminator-like byte
    /// — the line's own closing `\n` — and it is always the window's
    /// very last byte (since `end` is defined as immediately after it).
    /// Treating `align_start`'s "skip past it" result at face value
    /// discards the *entire* window, producing an empty chunk whose
    /// offset equals `end` — no progress, forever.
    #[test]
    fn read_document_chunk_before_makes_progress_when_window_is_entirely_one_overlong_line() {
        let mut content = "x".repeat(CHUNK_BYTES + 1000);
        content.push('\n');
        content.push_str("tail\n");
        let path = crate::testutil::temp_path("mojidori-chunk-backward-degenerate.txt");
        std::fs::write(&path, &content).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let end = (CHUNK_BYTES + 1001) as u64; // start of "tail\n"
        let chunk = read_document_chunk_before(path_str, end, "UTF-8".into(), None).unwrap();
        assert_ne!(
            chunk.offset, end,
            "backward paging made no progress: the whole window was discarded"
        );
        assert!(
            !chunk.content.is_empty(),
            "a CHUNK_BYTES-sized window inside one overlong line must not \
             collapse to an empty page"
        );
        std::fs::remove_file(&path).ok();
    }

    /// Pins the exact mid-line cut semantics (issue #118): an interior page
    /// that never reaches a line terminator must still land its
    /// `next_offset` on a UTF-8 character boundary, consuming as many
    /// whole "中" (3-byte) characters as fit in CHUNK_BYTES. CHUNK_BYTES is
    /// not a multiple of 3, so this also pins the exact trim-to-boundary
    /// amount (the dangling tail bytes of a partial character).
    /// "prefix line\n" + a single line of "中" (3-byte UTF-8) repeated well
    /// past CHUNK_BYTES + "\nsuffix line\n". CHUNK_BYTES is not a multiple
    /// of 3, so a raw byte-count cut lands mid-character unless trimmed.
    fn overlong_multibyte_line_fixture() -> String {
        let overlong = "中".repeat(4_000_000); // 12,000,000 bytes
        format!("prefix line\n{overlong}\nsuffix line\n")
    }

    #[test]
    fn overlong_line_chunk_offsets_advance_by_whole_characters_mid_line() {
        let original = overlong_multibyte_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-offsets.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // Page 0 is exactly "prefix line\n"; page 1 is the first full read
        // entirely inside the "中" run (no terminator anywhere in it).
        let page0 = read_document_chunk(
            path_str.clone(),
            0,
            "UTF-8".into(),
            OffsetKind::Continuation,
            None,
        )
        .unwrap();
        assert_eq!(page0.content, "prefix line\n");
        let page1_offset = page0.next_offset.expect("more pages remain");

        let page1 = read_document_chunk(
            path_str,
            page1_offset,
            "UTF-8".into(),
            OffsetKind::Continuation,
            None,
        )
        .unwrap();
        assert!(
            !page1.malformed,
            "a chunk boundary must never manufacture a decode error out of a \
             valid file"
        );
        assert!(
            !page1.content.contains('\u{FFFD}'),
            "a raw chunk cut must never split a multibyte character"
        );
        let consumed = page1
            .next_offset
            .expect("the overlong line continues past this page")
            - page1.offset;
        assert_eq!(
            consumed,
            (CHUNK_BYTES - CHUNK_BYTES % 3) as u64,
            "an interior page must consume whole characters only, trimming \
             the {} dangling tail byte(s) of a partial character",
            CHUNK_BYTES % 3
        );
        assert_eq!(page1.content.len() as u64, consumed);
        assert!(page1.content.chars().all(|c| c == '中'));
        assert!(!page1.content.contains('\n'));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn pages_through_a_trailing_overlong_line_with_no_terminator_losslessly() {
        // Issue #118's EOF/no-newline case: the file ends abruptly in the
        // middle of the overlong line — no terminator anywhere after the
        // prefix line, all the way to EOF. Multibyte content, so this also
        // proves the true-EOF path never needs (or wrongly applies) the
        // character-boundary trim: any corruption would show up as a
        // length mismatch below (U+FFFD is not byte-length-neutral once
        // more than one accumulates against the "中" it replaces).
        let overlong = "中".repeat(4_000_000);
        let original = format!("prefix line\n{overlong}");
        assert!(original.len() > 5 * CHUNK_BYTES);
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-eof.txt");
        std::fs::write(&path, &original).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "UTF-8".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 100, "paging must terminate");
        }
        assert_eq!(
            assembled.len(),
            original.len(),
            "lost {} bytes paging to EOF through an overlong final line with \
             no terminator",
            original.len() as i64 - assembled.len() as i64
        );
        assert_eq!(assembled, original);
        std::fs::remove_file(&path).ok();
    }

    // --- Issue #213: the multibyte-character-boundary concern above,
    // extended from UTF-8 to the legacy multi-byte encodings paging
    // supports (Big5, Shift_JIS, GBK, gb18030, EUC-JP, EUC-KR). These are
    // not self-synchronizing the way UTF-8 is — trail-byte ranges overlap
    // lead-byte ranges — so both fixtures below deliberately cycle
    // through several distinct characters rather than repeating one, so
    // that a wrong-phase resync can't coincidentally stay "clean": a
    // short, uniform repeat period is exactly the shape that could let an
    // accidental realignment go undetected across the whole window. -----

    /// A Big5 character (U+4E9E "亞") whose own encoded bytes, *reversed*
    /// (trail byte first, lead byte second), do **not** form a valid Big5
    /// character. Big5 is dense enough — most of its lead/trail byte
    /// space is assigned — that picking CJK characters merely to "look
    /// varied" is not enough: an earlier version of this fixture cycled
    /// through 20 common Hanzi and found *every* adjacent cross-pair
    /// (and even a character's own reversed pair) coincidentally valid,
    /// because all 20 landed in Big5's densely packed common-character
    /// block. This one is confirmed by direct, exhaustive scan (see the
    /// debug session behind issue #213) to be one of only 67 (out of the
    /// 8040 candidate CJK Unified Ideographs checked) whose reversed pair
    /// is not itself mapped — pinned here rather than recomputed per test
    /// run.
    const BIG5_SELF_SAFE_CHAR: char = '亞';

    /// A Big5 run of *uniform* 2-byte width (`BIG5_SELF_SAFE_CHAR`
    /// repeated) except for a single 1-byte ASCII character at the very
    /// start. Width must be non-uniform somewhere: `CHUNK_BYTES` is a
    /// power of two, so a *purely* uniform-width run would have every raw
    /// cut coincidentally land back on a character boundary (2 always
    /// divides `CHUNK_BYTES`) and never actually exercise the bug this
    /// fixture exists to catch. A lone 1-byte perturbation right before
    /// the uniform run permanently shifts that run's character
    /// boundaries to the opposite byte parity from every later
    /// `CHUNK_BYTES`-stepped cut (`CHUNK_BYTES` is even, so stepping by
    /// it can never change which parity class a cut lands in) — so
    /// *every* page transition after the first is provably, not just
    /// probably, mid-character. And because every character in the
    /// uniform run is the *same* self-safe character, a wrong-phase
    /// resync's very first attempted pairing is always exactly the one
    /// reversed pair already proven invalid — not a statistical
    /// long-shot, a structural certainty: the wrong-phase decode fails
    /// immediately, every time, rather than merely "almost always".
    fn overlong_big5_line_fixture() -> (String, Vec<u8>) {
        let mut text = String::from("prefix line\n");
        text.push('a'); // the single width-1 perturbation
        for _ in 0..5_000_000usize {
            text.push(BIG5_SELF_SAFE_CHAR);
        }
        text.push_str("\nsuffix line\n");
        let (bytes, unmappable) = encoding::encode(&text, "Big5", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in Big5"
        );
        (text, bytes)
    }

    /// U+20010, a gb18030 supplementary-plane character (4 bytes: `95 32
    /// 84 32`) whose bytes *rotated* left by 2 (`84 32 95 32`) do **not**
    /// form a valid gb18030 sequence — the gb18030 mirror of
    /// `BIG5_SELF_SAFE_CHAR`, confirmed by direct scan (see the debug
    /// session behind issue #213; one of the first 5 self-safe
    /// candidates found scanning U+20000 upward). The rotation (not a
    /// reversal, unlike Big5's 2-byte case) is what a wrong-phase resync
    /// 2 bytes into a repeated run of this character actually
    /// re-attempts — see `overlong_gb18030_line_fixture`'s doc comment.
    const GB18030_SELF_SAFE_SUPPLEMENTARY_CHAR: char = '\u{20010}';

    /// gb18030 mirror of `overlong_big5_line_fixture`: a *uniform* run of
    /// `GB18030_SELF_SAFE_SUPPLEMENTARY_CHAR` repeated (4-byte
    /// supplementary-plane characters — `max_legacy_seq_len`'s one 4-byte
    /// case among the six supported legacy encodings), except for a
    /// single 2-byte BMP CJK character at the very start. `CHUNK_BYTES`
    /// is a multiple of 4 as well as 2, so the same non-uniform-width
    /// requirement as the Big5 fixture applies, and the same parity
    /// argument holds one level up: the lone 2-byte perturbation shifts
    /// the uniform run's boundaries to residue 2 (mod 4) while every
    /// later `CHUNK_BYTES`-stepped cut stays at residue 0 (mod 4) — 2
    /// bytes away, always. That lands every cut exactly 2 bytes into a
    /// 4-byte character (never at the 1- or 3-byte split, whose orphaned
    /// first byte would be the sequence's second or fourth byte — always
    /// an ASCII digit `0x30`-`0x39` by construction of gb18030's 4-byte
    /// form itself, the same trivial standalone-ASCII escape hatch the
    /// Big5 fixture's self-safe character rules out). A 2-byte orphan
    /// starting there is `[b2, b3]`; since every character in the run is
    /// the same repeated one, a wrong-phase resync's very first attempted
    /// 4-byte re-decode is always exactly the `[b2, b3, b0, b1]` rotation
    /// already proven invalid — a structural certainty, not a long-run
    /// coincidence, exactly as for the Big5 fixture.
    fn overlong_gb18030_line_fixture() -> (String, Vec<u8>) {
        let mut text = String::from("prefix line\n");
        text.push('中'); // the single width-2 perturbation
        for _ in 0..2_500_000usize {
            text.push(GB18030_SELF_SAFE_SUPPLEMENTARY_CHAR);
        }
        text.push_str("\nsuffix line\n");
        let (bytes, unmappable) = encoding::encode(&text, "gb18030", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in gb18030"
        );
        (text, bytes)
    }

    /// Forward `Next` chain through the Big5 fixture: every page must
    /// decode cleanly (no U+FFFD, `malformed: false`) and offsets must
    /// stay byte-continuous — `chunk.offset` must never drift from the
    /// requested continuation offset (Continuation reads never realign,
    /// see `OffsetKind`), so the loop chaining `offset = chunk.next_offset`
    /// can never skip or repeat a byte span. Reassembling every page's
    /// content must reproduce the original text exactly — the strongest
    /// possible proof that no byte was dropped, duplicated, or
    /// misdecoded at a chunk boundary.
    #[test]
    fn pages_through_an_overlong_big5_line_losslessly() {
        let (original_text, bytes) = overlong_big5_line_fixture();
        assert!(
            bytes.len() > 4 * CHUNK_BYTES,
            "fixture must span several chunks on both sides of the overlong line"
        );
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-big5-fwd.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "Big5".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assert_eq!(
                chunk.offset, at,
                "a Continuation read never realigns its own offset"
            );
            assert!(
                !chunk.malformed,
                "a chunk boundary must never manufacture a decode error out \
                 of a valid Big5 file"
            );
            assert!(
                !chunk.content.contains('\u{FFFD}'),
                "a raw chunk cut must never split a Big5 multibyte character"
            );
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 200, "paging must terminate");
        }
        assert!(
            pages >= 3,
            "the overlong line alone must span several pages"
        );
        assert_eq!(assembled, original_text);
        std::fs::remove_file(&path).ok();
    }

    /// Backward `Prev` chain mirror of the test above: every page must
    /// decode cleanly, and each page's `next_offset` must equal exactly
    /// the `end` it was asked for — the byte-continuity guarantee for the
    /// backward direction, since the next call's `end` becomes this
    /// call's `offset`, so a gap or overlap would show up as content loss
    /// or duplication once every part is reassembled in order.
    #[test]
    fn pages_backward_through_an_overlong_big5_line_losslessly() {
        let (original_text, bytes) = overlong_big5_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-big5-back.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = bytes.len() as u64;
        let mut pages = 0;
        loop {
            let chunk =
                read_document_chunk_before(path_str.clone(), end, "Big5".into(), None).unwrap();
            assert_eq!(
                chunk.next_offset,
                Some(end),
                "byte-continuity: this page's next_offset must equal the end \
                 it was asked to stop at"
            );
            assert!(
                !chunk.malformed,
                "a chunk boundary must never manufacture a decode error out \
                 of a valid Big5 file"
            );
            assert!(
                !chunk.content.contains('\u{FFFD}'),
                "a raw chunk cut must never split a Big5 multibyte character"
            );
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 200, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(
            pages >= 3,
            "the overlong line alone must span several pages"
        );
        assembled_parts.reverse();
        assert_eq!(assembled_parts.concat(), original_text);
        std::fs::remove_file(&path).ok();
    }

    /// Forward mirror of `pages_through_an_overlong_big5_line_losslessly`
    /// for gb18030's 4-byte plane, the one case among the six supported
    /// legacy encodings with more than two candidate trim depths.
    #[test]
    fn pages_through_an_overlong_gb18030_line_losslessly() {
        let (original_text, bytes) = overlong_gb18030_line_fixture();
        assert!(
            bytes.len() > 4 * CHUNK_BYTES,
            "fixture must span several chunks on both sides of the overlong line"
        );
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-gb18030-fwd.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "gb18030".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assert_eq!(
                chunk.offset, at,
                "a Continuation read never realigns its own offset"
            );
            assert!(
                !chunk.malformed,
                "a chunk boundary must never manufacture a decode error out \
                 of a valid gb18030 file"
            );
            assert!(
                !chunk.content.contains('\u{FFFD}'),
                "a raw chunk cut must never split a gb18030 multibyte character"
            );
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 200, "paging must terminate");
        }
        assert!(
            pages >= 3,
            "the overlong line alone must span several pages"
        );
        assert_eq!(assembled, original_text);
        std::fs::remove_file(&path).ok();
    }

    /// Backward mirror, gb18030.
    #[test]
    fn pages_backward_through_an_overlong_gb18030_line_losslessly() {
        let (original_text, bytes) = overlong_gb18030_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-overlong-gb18030-back.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled_parts: Vec<String> = Vec::new();
        let mut end = bytes.len() as u64;
        let mut pages = 0;
        loop {
            let chunk =
                read_document_chunk_before(path_str.clone(), end, "gb18030".into(), None).unwrap();
            assert_eq!(
                chunk.next_offset,
                Some(end),
                "byte-continuity: this page's next_offset must equal the end \
                 it was asked to stop at"
            );
            assert!(
                !chunk.malformed,
                "a chunk boundary must never manufacture a decode error out \
                 of a valid gb18030 file"
            );
            assert!(
                !chunk.content.contains('\u{FFFD}'),
                "a raw chunk cut must never split a gb18030 multibyte character"
            );
            assembled_parts.push(chunk.content.clone());
            end = chunk.offset;
            pages += 1;
            assert!(pages < 200, "backward paging must terminate");
            if end == 0 {
                break;
            }
        }
        assert!(
            pages >= 3,
            "the overlong line alone must span several pages"
        );
        assembled_parts.reverse();
        assert_eq!(assembled_parts.concat(), original_text);
        std::fs::remove_file(&path).ok();
    }

    /// gb18030 mirror of `big5_self_safe_char_reversed_pair_is_never_valid`:
    /// pins `GB18030_SELF_SAFE_SUPPLEMENTARY_CHAR`'s doc-comment claim as
    /// an executable fact.
    #[test]
    fn gb18030_self_safe_char_rotated_bytes_is_never_valid() {
        let (encoded, unmappable) = encoding::encode(
            &GB18030_SELF_SAFE_SUPPLEMENTARY_CHAR.to_string(),
            "gb18030",
            false,
        )
        .unwrap();
        assert!(!unmappable);
        assert_eq!(encoded.len(), 4);
        let rotated = [encoded[2], encoded[3], encoded[0], encoded[1]];
        let enc = encoding_rs::Encoding::for_label(b"gb18030").unwrap();
        assert!(
            enc.decode_without_bom_handling_and_without_replacement(&rotated)
                .is_none(),
            "rotated bytes must not decode as a valid gb18030 character"
        );
        let mut probe = enc.new_decoder_without_bom_handling();
        let (_, malformed_last_false) =
            crate::streamcodec::decode_chunk(&mut probe, &rotated, false);
        assert!(
            malformed_last_false,
            "must be malformed even under is_last=false (genuinely invalid, \
             not merely an incomplete-at-the-end sequence)"
        );
    }

    /// Pins the exhaustive scan behind `BIG5_SELF_SAFE_CHAR`'s doc comment
    /// as an executable fact rather than only a comment someone could
    /// forget to re-verify after an `encoding_rs` upgrade: encoding
    /// `BIG5_SELF_SAFE_CHAR` and reversing its two bytes must decode as
    /// *malformed*, under both possible-more-input-later and
    /// definitely-final decode semantics (the wrong-phase resync this
    /// guards against can appear in either place a raw cut occurs).
    #[test]
    fn big5_self_safe_char_reversed_pair_is_never_valid() {
        let (encoded, unmappable) =
            encoding::encode(&BIG5_SELF_SAFE_CHAR.to_string(), "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(encoded.len(), 2);
        let reversed = [encoded[1], encoded[0]];
        let enc = encoding_rs::Encoding::for_label(b"Big5").unwrap();
        assert!(
            enc.decode_without_bom_handling_and_without_replacement(&reversed)
                .is_none(),
            "reversed byte pair must not decode as a valid Big5 character"
        );
        let mut probe = enc.new_decoder_without_bom_handling();
        let (_, malformed_last_false) =
            crate::streamcodec::decode_chunk(&mut probe, &reversed, false);
        assert!(
            malformed_last_false,
            "must be malformed even under is_last=false (genuinely invalid, \
             not merely an incomplete-at-the-end sequence)"
        );
    }

    // --- Issue #227: `trim_truncated_legacy_head`'s one genuinely
    // ambiguous shape (see its doc comment) made concrete as an
    // executable backward-paging scenario, rather than only inferred from
    // the probe tests above. When a backward window's raw start lands
    // exactly on an ASCII byte immediately followed by a clean run of
    // complete multibyte characters, the byte's own value alone can never
    // tell the algorithm whether it is a genuine standalone character or
    // an orphaned trailing fragment whose lead byte was cut into the
    // previous page -- both readings decode without error from `bytes`
    // alone. The algorithm is documented to break the tie by preferring
    // the deeper (post-ASCII) boundary, *shifting* the ASCII byte into
    // the neighboring backward page rather than ever dropping it. -------

    /// A Big5 file engineered so a backward window's raw start lands
    /// exactly on a single ASCII byte ('a', 0x61 -- inside Big5's low
    /// trail-byte range 0x40-0x7E, so the "orphaned trail fragment"
    /// reading is genuinely plausible, not merely mechanically
    /// triggered) immediately followed by a uniform run of
    /// `BIG5_SELF_SAFE_CHAR`. Layout: `"head\npad" + 'a' + (BIG5_SELF_
    /// SAFE_CHAR repeated) + '\n'`, with the run length chosen so the
    /// file's total length is exactly `p1 + CHUNK_BYTES` (`p1` = the 'a'
    /// byte's offset, returned alongside) -- so the *first* natural
    /// backward read in an EOF-anchored paging loop (`end` = file length)
    /// computes `start = end - CHUNK_BYTES == p1` with no hand-picked
    /// `end` needed, exactly mirroring how a real large file reaches this
    /// shape. The window's only terminator sits at its very last byte
    /// (the run's own closing `\n`), so `align_start` cannot realign past
    /// it -- `read_document_chunk_before`'s "non-empty remainder" guard
    /// falls back to the raw window -- and 'a' is preceded by "pad", not
    /// a terminator, so `at_line_start` is false too: this is a raw
    /// mid-content cut, not a coincidental line start.
    fn ascii_before_cjk_big5_boundary_fixture() -> (String, Vec<u8>, u64) {
        let prefix = "head\npad";
        let p1 = prefix.len() as u64; // offset of the ambiguous 'a' byte
        let window_tail_len = 2u64; // 'a' itself + the run's closing '\n'
        let run_bytes = CHUNK_BYTES as u64 - window_tail_len;
        assert_eq!(run_bytes % 2, 0, "must be a whole number of 2-byte chars");
        let run_chars = (run_bytes / 2) as usize;

        let mut text = String::from(prefix);
        text.push('a');
        for _ in 0..run_chars {
            text.push(BIG5_SELF_SAFE_CHAR);
        }
        text.push('\n');
        let (bytes, unmappable) = encoding::encode(&text, "Big5", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in Big5"
        );
        assert_eq!(
            bytes.len() as u64,
            p1 + CHUNK_BYTES as u64,
            "file length must place the ambiguous boundary exactly \
             CHUNK_BYTES before EOF"
        );
        (text, bytes, p1)
    }

    /// Forward `Next` chain over the fixture: `trim_truncated_legacy_head`
    /// is never on this path (only the tail trim is), so this is a plain
    /// completeness check that the fixture itself round-trips, mirroring
    /// `pages_through_an_overlong_big5_line_losslessly`.
    #[test]
    fn pages_through_an_ascii_before_cjk_big5_boundary_losslessly() {
        let (original_text, bytes, _p1) = ascii_before_cjk_big5_boundary_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-ascii-before-cjk-big5-fwd.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        let mut assembled = String::new();
        let mut offset = Some(0u64);
        let mut pages = 0;
        while let Some(at) = offset {
            let chunk = read_document_chunk(
                path_str.clone(),
                at,
                "Big5".into(),
                OffsetKind::Continuation,
                None,
            )
            .unwrap();
            assert!(
                !chunk.malformed,
                "a chunk boundary must never manufacture a decode error out \
                 of a valid Big5 file"
            );
            assert!(
                !chunk.content.contains('\u{FFFD}'),
                "a raw chunk cut must never split a Big5 multibyte character"
            );
            assembled.push_str(&chunk.content);
            offset = chunk.next_offset;
            pages += 1;
            assert!(pages < 200, "paging must terminate");
        }
        assert_eq!(assembled, original_text);
        std::fs::remove_file(&path).ok();
    }

    /// Backward `Prev` chain: pins the exact shift issue #227 asks for.
    /// The first (EOF-anchored) page's raw window starts exactly on the
    /// ambiguous 'a' byte; `trim_truncated_legacy_head` must resolve the
    /// ambiguity by skipping it (the deeper, CJK-lead-byte boundary is the
    /// only *trustworthy* clean candidate), so this page's reported
    /// `offset` lands one byte past the raw window start and its content
    /// excludes 'a' entirely -- proof that a trim actually fired, not
    /// merely that reassembly happens to work out. The second (final)
    /// page then reaches file start in one more read, and its content
    /// ends with exactly that same 'a' byte: the trimmed byte reappears
    /// whole at the adjacent page's edge, never dropped. Concatenating
    /// both pages in order reproduces the original file byte-for-byte --
    /// the invariant's actual statement (#213's doc comment: "shifting
    /// (never losing)").
    #[test]
    fn pages_backward_through_an_ascii_before_cjk_big5_boundary_shifts_the_ambiguous_byte() {
        let (original_text, bytes, p1) = ascii_before_cjk_big5_boundary_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-ascii-before-cjk-big5-back.txt");
        std::fs::write(&path, &bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();

        // First page: the raw backward window starts exactly at `p1`, the
        // 'a' byte -- see the fixture's doc comment for why.
        let end = bytes.len() as u64;
        let start = end - CHUNK_BYTES as u64;
        assert_eq!(
            start, p1,
            "sanity: fixture must place the window start on 'a'"
        );

        let page1 = read_document_chunk_before(path_str.clone(), end, "Big5".into(), None).unwrap();
        assert_eq!(page1.next_offset, Some(end));
        assert!(!page1.malformed);
        assert!(!page1.content.contains('\u{FFFD}'));
        assert_eq!(
            page1.offset,
            start + 1,
            "the ambiguous 'a' byte must be trimmed from this page's head \
             -- offset lands one byte past the raw window start, not at it"
        );
        assert!(
            !page1.content.starts_with('a'),
            "trim must actually have fired: page content must not start \
             with the ambiguous ASCII byte"
        );
        assert!(
            page1.content.starts_with(BIG5_SELF_SAFE_CHAR),
            "page must resume exactly at the CJK run's first character"
        );

        // Second page: reaches file start; the trimmed 'a' must reappear
        // as this page's very last byte/character, never dropped.
        let page2 = read_document_chunk_before(path_str.clone(), page1.offset, "Big5".into(), None)
            .unwrap();
        assert_eq!(page2.offset, 0);
        assert_eq!(page2.next_offset, Some(page1.offset));
        assert!(!page2.malformed);
        assert!(!page2.content.contains('\u{FFFD}'));
        assert!(
            page2.content.ends_with('a'),
            "the byte trimmed from page1's head must reappear as page2's \
             own trailing byte -- shifted, never lost"
        );

        let assembled = format!("{}{}", page2.content, page1.content);
        assert_eq!(
            assembled, original_text,
            "full backward reassembly must be byte-exact despite the shift \
             -- the invariant's actual statement: absorbed, never dropped"
        );
        std::fs::remove_file(&path).ok();
    }

    /// `OffsetKind::LineStart`'s stale-offset fallback (the `align_start`
    /// UTF-8-only branch this issue also extends) must realign cleanly for
    /// a legacy multi-byte encoding too: a goto landing mid-character deep
    /// inside an overlong Big5 line, with no line start anywhere in the
    /// window, must fall back to a raw read trimmed only of the stale
    /// offset's own orphaned fragment bytes — mirroring
    /// `goto_read_falls_back_to_raw_inside_an_overlong_line`'s UTF-8 case.
    #[test]
    fn goto_read_falls_back_to_raw_inside_an_overlong_big5_line() {
        let (_original_text, bytes) = overlong_big5_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-goto-stale-overlong-big5.txt");
        std::fs::write(&path, &bytes).unwrap();

        // "prefix line\n" is 12 bytes, then the single 1-byte ASCII
        // perturbation at offset 12, then the uniform 2-byte CJK run
        // starting at offset 13 — land one byte into its first character,
        // mid-character, with the nearest terminator megabytes away in
        // both directions.
        let stale = 12 + 1 + 1;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "Big5".into(),
            OffsetKind::LineStart,
            None,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            stale + 1,
            "no line start in the window: fall back to a raw read, dropping \
             only the stale offset's own orphaned fragment byte"
        );
        assert!(
            !chunk.content.is_empty(),
            "fallback must not produce an empty window"
        );
        assert!(!chunk.content.contains('\u{FFFD}'));
        assert!(!chunk.malformed);
        assert!(
            chunk.content.starts_with(BIG5_SELF_SAFE_CHAR),
            "must resume exactly at the second character of the uniform \
             run, the true boundary right after the orphaned byte"
        );
        std::fs::remove_file(&path).ok();
    }

    // --- #118 follow-up (critic review): goto's chunk read must keep its
    // defensive realignment. `locate_line_offset` results ride on the
    // line index, which a missed watcher event can leave stale — a stale
    // index can hand goto a mid-line, even mid-character, offset. Removing
    // forward realignment (the #118 fix) must not turn that stale offset
    // into a garbled window top; a goto read realigns to the next real
    // line start (nothing is permanently lost — goto is a fresh jump, not
    // a continuation chain), while paging reads stay raw. -----------------

    #[test]
    fn goto_read_realigns_a_stale_mid_line_offset_to_the_next_line_start() {
        let path = crate::testutil::temp_path("mojidori-chunk-goto-stale-midline.txt");
        let mut original = String::new();
        for i in 0..120_000 {
            original.push_str(&format!("line {i:07} with some padding text\n"));
        }
        std::fs::write(&path, &original).unwrap();
        let line_width = "line 0000000 with some padding text\n".len() as u64;

        // A stale index claims line 1001 starts 7 bytes into line 1000.
        let stale = 1000 * line_width + 7;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
            None,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            1001 * line_width,
            "a goto read from a stale mid-line offset must realign to the \
             next real line start, not render a partial line at the window top"
        );
        assert!(chunk.content.starts_with("line 0001001 "));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn goto_read_realigns_a_stale_mid_character_offset_cleanly() {
        let path = crate::testutil::temp_path("mojidori-chunk-goto-stale-midchar.txt");
        let line = format!("{}\n", "中".repeat(10)); // 31 bytes per line
        let original = line.repeat(200_000);
        std::fs::write(&path, &original).unwrap();
        let line_width = line.len() as u64;

        // A stale index lands one byte into the second "中" of line 500 —
        // both mid-line and mid-character.
        let stale = 500 * line_width + 4;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
            None,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            501 * line_width,
            "a stale mid-character offset must realign to the next line start"
        );
        assert!(
            !chunk.content.contains('\u{FFFD}'),
            "a realigned goto window must never start mid-character"
        );
        assert!(chunk.content.starts_with("中中"));
        std::fs::remove_file(&path).ok();
    }

    /// When the stale offset sits inside a line longer than CHUNK_BYTES,
    /// there is no line start anywhere in the window to realign to. The
    /// goto read must then fall back to a raw continuation-style read —
    /// never an empty window, never a skipped window — only nudged off
    /// the mid-character position (the raw stale offset can split a
    /// multibyte character; the continuation chain's own offsets never do).
    #[test]
    fn goto_read_falls_back_to_raw_inside_an_overlong_line() {
        let original = overlong_multibyte_line_fixture();
        let path = crate::testutil::temp_path("mojidori-chunk-goto-stale-overlong.txt");
        std::fs::write(&path, &original).unwrap();

        // One byte into a "中" deep inside the 12 MB run: mid-character,
        // with the nearest terminator megabytes away in both directions.
        let stale = (12 + 300_000 * 3 + 1) as u64;
        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            stale,
            "UTF-8".into(),
            OffsetKind::LineStart,
            None,
        )
        .unwrap();
        assert_eq!(
            chunk.offset,
            stale + 2,
            "no line start in the window: fall back to a raw read, dropping \
             only the stale offset's own orphaned continuation bytes"
        );
        assert!(
            !chunk.content.is_empty(),
            "fallback must not produce an empty window"
        );
        assert!(!chunk.content.contains('\u{FFFD}'));
        assert!(chunk.content.chars().all(|c| c == '中'));
        let consumed = chunk.next_offset.unwrap() - chunk.offset;
        assert_eq!(consumed % 3, 0, "must consume whole characters");
        std::fs::remove_file(&path).ok();
    }

    /// Symmetric guard on the backward head-trim (critic follow-up): a
    /// window consisting entirely of orphaned continuation bytes must not
    /// be trimmed into an empty, non-progressing chunk (offset == end).
    /// Unreachable through the app's own line-aligned `end` values today —
    /// a line-aligned window never both starts and ends inside one
    /// character — so this pins the defensive fallback for future callers:
    /// deliberately hand in a non-line-aligned `end` inside a malformed
    /// file head and expect an honest U+FFFD window over an empty one.
    #[test]
    fn backward_head_trim_never_consumes_the_entire_window() {
        let path = crate::testutil::temp_path("mojidori-chunk-before-all-continuation.txt");
        std::fs::write(&path, b"\x80\x81\nrest of the file\n").unwrap();

        let chunk = read_document_chunk_before(
            path.to_string_lossy().into_owned(),
            2,
            "UTF-8".into(),
            None,
        )
        .unwrap();
        assert!(
            !chunk.content.is_empty(),
            "an all-continuation-bytes window must fall back to the raw \
             bytes, not collapse to an empty chunk"
        );
        assert_eq!(
            chunk.offset, 0,
            "the window must keep covering its bytes (offset == end would \
             make backward paging spin in place)"
        );
        std::fs::remove_file(&path).ok();
    }

    // ---- issue #251: file-version validation on every chunk read ----

    #[test]
    fn stale_fingerprint_returns_stale_marker_not_content() {
        let path = crate::testutil::temp_path("mojidori-chunk-stale-grown.txt");
        std::fs::write(&path, "first version\nsecond line\n").unwrap();
        let fp = Fingerprint::from_path(&path).unwrap();

        // Grow the file: len changes, so the mismatch is deterministic on
        // every platform regardless of mtime resolution.
        std::fs::write(&path, "replaced with something longer\nmore\nlines\n").unwrap();

        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            0,
            "UTF-8".into(),
            OffsetKind::Continuation,
            Some(fp),
        )
        .unwrap();
        assert!(chunk.stale, "a mismatched fingerprint must read as stale");
        assert!(
            chunk.content.is_empty() && chunk.next_offset.is_none(),
            "a stale marker must not carry content or a continuation"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn matching_fingerprint_reads_normally() {
        let path = crate::testutil::temp_path("mojidori-chunk-stale-match.txt");
        std::fs::write(&path, "alpha\nbeta\n").unwrap();
        let fp = Fingerprint::from_path(&path).unwrap();

        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            0,
            "UTF-8".into(),
            OffsetKind::Continuation,
            Some(fp),
        )
        .unwrap();
        assert!(!chunk.stale);
        assert_eq!(chunk.content, "alpha\nbeta\n");
        std::fs::remove_file(&path).ok();
    }

    /// The shrink-during-paging fallback when no fingerprint was supplied
    /// (issue #251's second repro path): an offset past the new EOF used
    /// to come back as a silent empty success chunk the frontend applied
    /// as "end of file".
    #[test]
    fn no_expected_with_offset_past_eof_is_stale() {
        let path = crate::testutil::temp_path("mojidori-chunk-stale-shrunk.txt");
        std::fs::write(&path, "short\n").unwrap();

        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            1_000_000,
            "UTF-8".into(),
            OffsetKind::Continuation,
            None,
        )
        .unwrap();
        assert!(
            chunk.stale,
            "a continuation offset past EOF proves the caller's offsets \
             describe an earlier, larger file version"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn before_read_stale_on_fingerprint_mismatch() {
        let path = crate::testutil::temp_path("mojidori-chunk-stale-before.txt");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let fp = Fingerprint::from_path(&path).unwrap();
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").unwrap();

        let chunk = read_document_chunk_before(
            path.to_string_lossy().into_owned(),
            8,
            "UTF-8".into(),
            Some(fp),
        )
        .unwrap();
        assert!(chunk.stale);
        std::fs::remove_file(&path).ok();
    }

    /// The same-size overwrite issue #251 centers on: byte length is
    /// unchanged, so the frontend's `indexedSize === totalSize` check can
    /// never see it — only the fingerprint can. Unix-only because it pins
    /// the `(dev, ino)` identity component (an atomic-rename replacement
    /// always lands on a fresh inode); on Windows the same scenario is
    /// covered by mtime, which a test cannot control precisely enough to
    /// assert deterministically.
    #[cfg(unix)]
    #[test]
    fn same_size_replace_is_stale_via_inode_identity() {
        let path = crate::testutil::temp_path("mojidori-chunk-stale-samesize.txt");
        std::fs::write(&path, "AAAA\nBBBB\n").unwrap();
        let fp = Fingerprint::from_path(&path).unwrap();

        // Same byte count, different content, new inode via atomic rename.
        let tmp = crate::testutil::temp_path("mojidori-chunk-stale-samesize.tmp");
        std::fs::write(&tmp, "CCCC\nDDDD\n").unwrap();
        std::fs::rename(&tmp, &path).unwrap();

        let chunk = read_document_chunk(
            path.to_string_lossy().into_owned(),
            0,
            "UTF-8".into(),
            OffsetKind::Continuation,
            Some(fp),
        )
        .unwrap();
        assert!(
            chunk.stale,
            "a same-size atomic-rename replacement must be caught by the \
             inode identity component"
        );
        std::fs::remove_file(&path).ok();
    }
}
