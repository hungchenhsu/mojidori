//! Streaming encoding conversion for large files on disk (ROADMAP.md v0.4
//! Track B "Streaming encoding conversion for large files") [danger]:
//! re-encodes an entire file to a different target encoding via
//! bounded-chunk streaming decode -> re-encode, atomically committed, so
//! memory use stays flat (`O(CHUNK_BYTES)`) regardless of file size --
//! exactly the same architecture as `streamreplace.rs`'s streaming
//! find/replace (same `streamcodec.rs` chunk primitives, same
//! `fsguard.rs`-backed fail-closed external-modification guard, same
//! atomic temp-file-plus-rename commit), just with the transform being a
//! full encoding change instead of a text substitution. Backend for the
//! large-file preview window's encoding-menu "Convert File to Encoding…"
//! entry: a truncated preview only ever has a bounded slice of the file
//! loaded, so the ordinary in-editor "Save with Encoding" (which re-encodes
//! whatever's in memory) cannot be used to change such a file's encoding --
//! see `src/main.ts`'s `showEncodingMenu`.
//!
//! Unlike `stream_replace_in_file` (which reuses one encoding for both
//! decode and encode, and therefore rejects UTF-16 in both directions --
//! see that module's doc comment), this command's source and target
//! encodings are two independent parameters, so the UTF-16 dead end
//! (`Encoding::new_encoder()`'s documented output encoding for UTF-16BE/LE
//! is UTF-8, never a real UTF-16 encoder) only rules out UTF-16 as a
//! *target*. A UTF-16 *source* decodes perfectly well through the ordinary
//! streaming `Decoder` (that side has no such dead end) and is fully
//! supported -- see
//! `utf16le_source_converts_to_utf8_correctly_across_chunk_boundary`.
//!
//! Two-stage lossy gate, mirroring `lib.rs::save_document`'s two-phase gate
//! rather than introducing a separate up-front dry-run command: a single
//! call with `allow_lossy: false` streams the whole file exactly once --
//! decoding, scanning every decoded character's representability in the
//! target encoding (`normalize::UnmappableScanner`, fed one already-decoded
//! chunk at a time so the aggregation never needs the whole file's text in
//! memory at once -- the same sample cap/dedup/position machinery
//! `lossy_save_report` uses, just fed incrementally), and always encoding to
//! a temp file regardless of whether anything unmappable turns up (encoding_rs
//! substitutes a numeric-character-reference fallback for an unmappable
//! character rather than failing -- see `streamcodec::encode_chunk`'s doc
//! comment). If the scan ends with `unmappable_count > 0` and the caller
//! didn't already allow it, the temp file is discarded and the aggregated
//! report comes back with `written: false` -- nothing on disk changes, and
//! no fingerprint re-check is needed since nothing was written. Note this
//! means even a *rejected* dry run briefly needs as much free disk space as
//! the full converted output (the temp file is written in full before the
//! rejection is decided, then deleted) -- same cost `streamreplace.rs`
//! already accepts for every run, just also paid on this command's reject
//! path, not only its commit path. The
//! frontend shows the exact same `showLossySaveConfirm` dialog
//! `save_document`'s own lossy rejection uses (`src/lossysave.ts`, via
//! `src/streamconvert.ts`), since this command's report reuses
//! `normalize::LossySaveReport` verbatim, and only after the user explicitly
//! agrees, re-invokes this command with `allow_lossy: true` -- which
//! re-streams the file from scratch (there is no cheaper way to "resume" a
//! discarded temp file) and commits. This is the "one read per call, two
//! reads only when a lossy retry actually happens" trade the ROADMAP task
//! explicitly accepts as performance-acceptable, the same shape
//! `save_document`'s own two-call gate already has.
//!
//! Line endings are never touched (mirrors `stream_replace_in_file`, which
//! also never normalizes or re-applies a line ending): whatever `\n`,
//! `\r\n`, or lone `\r` sequences the source decodes to are just ordinary
//! characters as far as this module is concerned, encoded straight back out
//! -- there is no `line_ending` parameter here at all, unlike
//! `save_document`/`batch::commit_conversion`.
//!
//! BOM handling: the source and target encodings are independent, so unlike
//! `stream_replace_in_file` (which preserves whatever BOM bytes were
//! already there, since source and target are the same encoding), this
//! command's target BOM is a fresh, explicit decision (`target_with_bom`),
//! completely unrelated to whether the source happened to have one. A
//! source BOM matching `source_encoding` is always stripped by the
//! streaming decoder (`new_decoder_with_bom_removal`, same as
//! `stream_replace_in_file`) so it never leaks into the decoded text or
//! gets double-counted; a target BOM is written up front, before the main
//! loop, only when `target_with_bom` is set *and* `target_encoding` is
//! UTF-8 -- exactly the same `with_bom && encoding == UTF_8` rule
//! `encoding::encode` already applies for the regular (non-streaming) save
//! path, and the same "no BOM control for legacy targets" convention
//! `src/encodings.ts`'s `encodingChoices` already encodes on the frontend
//! (a plain "UTF-8" choice there always carries `withBom: false`, so
//! picking it is how the frontend expresses "no BOM" -- there is no
//! separate default-computation on this side of the IPC boundary).
//!
//! No byte-identical-output short circuit: unlike
//! `batch::commit_conversion`, which holds the whole original file in
//! memory and can cheaply compare it against the freshly encoded bytes
//! before deciding whether to write, this module never holds more than one
//! chunk of either the source or the re-encoded output in memory at once --
//! comparing the two in full would need a second complete read of the
//! original file. Given this command's entire purpose is an actual
//! encoding change (unlike batch conversion's `"keep"` + `"keep"` no-op
//! case), a request whose source and target already match commits a
//! harmless rewrite rather than detecting and skipping it; this is a
//! deliberate scope decision, not an oversight.

use crate::fsguard::Fingerprint;
use crate::normalize::{self, UnmappableScanner};
use crate::streamcodec::{decode_chunk, encode_chunk, read_chunk, CHUNK_BYTES};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::io::Write;
use std::path::Path;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamConvertReport {
    /// False only on the lossy-rejection branch (`lossy_report: Some(_)`,
    /// unmappable characters found and `allow_lossy` was false) -- nothing
    /// was written and the file on disk is exactly as it was. True on every
    /// other successful outcome, including a lossy conversion the caller
    /// explicitly allowed.
    pub written: bool,
    /// Bytes actually written to the target file, including any BOM
    /// prefix. `0` whenever `written` is false.
    pub bytes_written: u64,
    /// Populated only when `written` is false because unmappable
    /// characters were found in the target encoding and `allow_lossy` was
    /// false -- mirrors `lib.rs::SaveResult::lossy_report` exactly, down to
    /// reusing the same `normalize::LossySaveReport` type, so the frontend
    /// can drive the identical confirm dialog (`showLossySaveConfirm`).
    /// `None` on every other result.
    pub lossy_report: Option<normalize::LossySaveReport>,
}

/// Fail closed if the file at `path` is no longer the file described by
/// `original` (see `Fingerprint::matches_path`) -- the same discipline
/// `streamreplace.rs`'s own `verify_unchanged` applies, duplicated here
/// (rather than shared) only because the two modules' error wording
/// differs; the underlying `Fingerprint` comparison itself already lives in
/// one place (`fsguard.rs`).
fn verify_unchanged(path: &Path, original: &Fingerprint) -> Result<(), String> {
    if original.matches_path(path) {
        Ok(())
    } else {
        Err(
            "file changed on disk during conversion; aborted, your file was not modified"
                .to_string(),
        )
    }
}

/// Result of streaming the whole source through decode -> scan -> encode:
/// the aggregated unmappable-character report (see
/// `normalize::UnmappableScanner`) and the total bytes written to `tmp`
/// (excluding any BOM prefix the caller already wrote before calling this).
struct ConvertOutcome {
    unmappable_count: usize,
    hits: Vec<normalize::UnmappableHit>,
    samples_truncated: bool,
    bytes_written: u64,
}

/// Streams `source` end to end: decode with `source_enc`, scan every
/// decoded character's representability in `target_enc` (feeding
/// `normalize::UnmappableScanner` one chunk at a time), and encode with
/// `target_enc`, writing the result to `tmp` as it goes. Always runs to
/// completion and always writes full output to `tmp` regardless of what the
/// scan finds -- the caller (`stream_convert_file`) decides afterward
/// whether that output is acceptable to commit. Aborts immediately (without
/// writing the abort-triggering chunk) only for a genuine decode failure
/// (malformed source bytes), matching ARCHITECTURE.md's "decode errors are
/// surfaced, never silently rendered as if the text were fine" -- an
/// unmappable *target* character is never such a failure here, since
/// tolerating it (with consent) is this command's whole reason to exist.
///
/// No cross-chunk carry buffer is needed the way `streamreplace.rs`'s
/// `run_replace_loop` needs one: that carry exists only because a *search
/// pattern* match can straddle the boundary between one chunk's decoded
/// text and the next's. Every character here is scanned and encoded
/// independently of its neighbors, so each `decode_chunk` call's output can
/// be fed straight to the scanner and encoder with nothing held back --
/// the streaming `Decoder` itself already resolves any raw multi-byte or
/// surrogate-pair sequence split across the underlying `read_chunk` call
/// boundary (see `utf16le_source_converts_to_utf8_correctly_across_chunk_boundary`).
///
/// Performance note: `encode_chunk`'s bulk `had_unmappable` flag (needed
/// regardless, to produce `out_bytes`) doubles as a cheap per-chunk gate for
/// the much more expensive per-character `UnmappableScanner::feed` scan --
/// a chunk the bulk encode already reports clean only gets the cheap
/// `advance_position_only` (line/column bookkeeping alone), and only a
/// chunk that actually contains something unmappable pays for the full,
/// per-character probe. For the realistic case this command exists for (a
/// large, mostly- or fully-representable file with at most a handful of
/// stray unmappable characters), this keeps the dominant per-file cost at
/// one bulk encode pass rather than one bulk pass *plus* a full O(n)
/// per-character probe pass -- measured, before this gate existed, at
/// ~144s for a single ~13 MiB fixture with 3 unmappable characters run
/// *twice* (the two-stage gate's reject-then-commit round trip) in an
/// unoptimized build; splitting that into a small rejection-only test plus
/// a single large commit-only test (see `converts_utf8_to_big5_with_
/// allow_lossy_matches_oracle_large_file`) and adding this gate brought the
/// remaining large test down to ~80s. Correctness of mixing the two calls
/// across chunks is pinned both directly
/// (`advance_position_only_then_feed_matches_whole_feed` in normalize.rs)
/// and through this module's own command
/// (`mixed_clean_and_dirty_chunks_produce_correct_aggregate_report`,
/// `unmappable_character_split_across_raw_chunk_boundary_is_still_reported`).
fn run_convert_loop(
    source: &mut std::fs::File,
    tmp: &mut std::fs::File,
    source_enc: &'static Encoding,
    target_enc: &'static Encoding,
) -> Result<ConvertOutcome, String> {
    let mut decoder = source_enc.new_decoder_with_bom_removal();
    let mut encoder = target_enc.new_encoder();
    let mut scanner = UnmappableScanner::new(target_enc);
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut bytes_written = 0u64;

    loop {
        let n = read_chunk(source, &mut buf).map_err(|e| format!("Failed to read: {e}"))?;
        let is_last = n < buf.len();
        let (decoded_text, had_errors) = decode_chunk(&mut decoder, &buf[..n], is_last);
        if had_errors {
            return Err(format!(
                "file does not decode cleanly as {}; aborted, file untouched",
                source_enc.name()
            ));
        }

        let (out_bytes, had_unmappable) = encode_chunk(&mut encoder, &decoded_text, is_last);
        if had_unmappable {
            scanner.feed(&decoded_text);
        } else {
            scanner.advance_position_only(&decoded_text);
        }
        tmp.write_all(&out_bytes)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        bytes_written += out_bytes.len() as u64;

        if is_last {
            break;
        }
    }

    let (unmappable_count, hits, samples_truncated) = scanner.finish();
    Ok(ConvertOutcome {
        unmappable_count,
        hits,
        samples_truncated,
        bytes_written,
    })
}

/// Convert an entire file on disk from `source_encoding` to
/// `target_encoding`/`target_with_bom`, streamed in bounded chunks so
/// memory use stays flat regardless of file size. Backend for the
/// large-file preview window's "Convert File to Encoding…" command.
///
/// Safety discipline, in order:
///
/// 1. `source_encoding`/`target_encoding` must both name a known encoding,
///    and `target_encoding` must not be UTF-16LE/BE (see the module doc
///    comment for why) -- checked before anything is read from disk.
/// 2. The source is opened and fingerprinted immediately (see
///    `Fingerprint::from_file`), tying the snapshot to the exact file this
///    command is about to spend a potentially long time streaming.
/// 3. A target BOM prefix is written up front only when `target_with_bom`
///    and `target_encoding` is UTF-8 (see the module doc comment).
/// 4. `path` is resolved past any destination symlink (following the same
///    chain `lib.rs::atomic_write_follow_symlinks` would -- see
///    `resolve_write_destination`; issue #301, streaming-path follow-up),
///    then the source is streamed, decoded, scanned for
///    target-representability, and re-encoded to a temp file in the
///    *resolved* target's directory (`create_tmp_exclusive`) -- see
///    [`run_convert_loop`]. Any malformed source byte sequence aborts
///    immediately: the temp file is discarded and the original is never
///    touched.
/// 5. If the scan found unmappable characters and `allow_lossy` is false,
///    the temp file is discarded and this returns `Ok` with `written:
///    false` and a populated `lossy_report` -- nothing on disk changes, and
///    (since nothing was written) no fingerprint re-check is needed. The
///    caller re-invokes with `allow_lossy: true` after explicit user
///    confirmation to actually commit the lossy bytes.
/// 6. Before committing, the file at `path` is re-stat'd and compared
///    against the fingerprint captured in step 2: if its size, mtime, or
///    (Unix) inode identity no longer match -- including the file having
///    been deleted outright -- the temp file is discarded and this returns
///    `Err` without ever touching `path`. This narrows (never eliminates)
///    the race between reading and committing, the same discipline
///    `stream_replace_in_file`'s `verify_unchanged` and `save_document`'s
///    `expected_fingerprint` check already apply (issues #94/#102/#113,
///    shared `fsguard.rs`).
/// 7. On success: `sync_all`, the fingerprint check above, carry over the
///    resolved target's permissions, then `rename` over the resolved
///    target -- never over `path` itself when it names a symlink, so the
///    link survives -- the same atomic discipline as
///    `lib.rs::atomic_write_follow_symlinks` and `stream_replace_in_file`,
///    just fed by a temp file filled incrementally instead of from one
///    in-memory buffer.
#[tauri::command]
pub fn stream_convert_file(
    path: String,
    source_encoding: String,
    target_encoding: String,
    target_with_bom: bool,
    allow_lossy: bool,
) -> Result<StreamConvertReport, String> {
    let source_enc = Encoding::for_label(source_encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {source_encoding}"))?;
    let target_enc = Encoding::for_label(target_encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {target_encoding}"))?;
    if target_enc == UTF_16LE || target_enc == UTF_16BE {
        return Err(
            "Convert File to Encoding does not support UTF-16 target encodings".to_string(),
        );
    }

    let path_ref = Path::new(&path);
    let mut source =
        std::fs::File::open(path_ref).map_err(|e| format!("Failed to read {path}: {e}"))?;
    // Captured immediately after opening, from this exact handle -- see
    // `stream_replace_in_file`'s identical rationale (issue #94).
    let fingerprint =
        Fingerprint::from_file(&source).map_err(|e| format!("Failed to read {path}: {e}"))?;

    // `path` is always a file the user chose to convert, never an
    // internal app-state path, so this follows a destination symlink the
    // same way `atomic_write_follow_symlinks` does -- see
    // `resolve_write_destination`'s doc comment (issue #301, streaming-path
    // follow-up). `write_target` (not necessarily `path_ref`'s own
    // directory) is what `dir`/`file_name` -- and the final rename below --
    // must use, so the temp file and its destination stay on the same
    // filesystem even when `path` is a symlink pointing elsewhere.
    let (write_target, dir, file_name) = crate::resolve_write_destination(path_ref, true)
        .map_err(|e| format!("Failed to write {path}: {e}"))?;
    let (mut tmp_file, tmp_path) = crate::create_tmp_exclusive(&dir, &file_name)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    // Target BOM: a fresh decision independent of whatever the source had
    // (see module doc comment) -- only a UTF-8 target with target_with_bom
    // gets one, mirroring `encoding::encode`'s own rule exactly. UTF-16 is
    // already rejected above, so `encoding::encode_utf16`'s own BOM-prefix
    // path (always-on for UTF-16) never applies here.
    let bom_prefix_len: u64 = if target_with_bom && target_enc == UTF_8 {
        if let Err(e) = tmp_file.write_all(&[0xEF, 0xBB, 0xBF]) {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to write temp file: {e}"));
        }
        3
    } else {
        0
    };

    let outcome = run_convert_loop(&mut source, &mut tmp_file, source_enc, target_enc);

    match outcome {
        Ok(outcome) if outcome.unmappable_count > 0 && !allow_lossy => {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            let samples = outcome
                .hits
                .into_iter()
                .map(|hit| normalize::UnmappableSample {
                    display: normalize::format_sample(hit.ch),
                    line: hit.line,
                    column: hit.column,
                })
                .collect();
            Ok(StreamConvertReport {
                written: false,
                bytes_written: 0,
                lossy_report: Some(normalize::LossySaveReport {
                    unmappable_count: outcome.unmappable_count,
                    samples,
                    samples_truncated: outcome.samples_truncated,
                }),
            })
        }
        Ok(outcome) => {
            if let Err(e) = tmp_file.sync_all() {
                drop(tmp_file);
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Failed to write {path}: {e}"));
            }
            drop(tmp_file);
            if let Err(e) = verify_unchanged(path_ref, &fingerprint) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(e);
            }
            if let Ok(meta) = std::fs::metadata(&write_target) {
                let _ = std::fs::set_permissions(&tmp_path, meta.permissions());
            }
            // Renaming onto `write_target` rather than `path_ref` is what
            // keeps a symlink at `path` intact -- see
            // `resolve_write_destination`'s doc comment.
            if let Err(e) = std::fs::rename(&tmp_path, &write_target) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("Failed to write {path}: {e}"));
            }
            Ok(StreamConvertReport {
                written: true,
                bytes_written: bom_prefix_len + outcome.bytes_written,
                lossy_report: None,
            })
        }
        Err(e) => {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scoped by PID as well as `name`: `std::env::temp_dir()` is the
    /// process-wide OS temp directory, shared by every `cargo test`
    /// invocation on the machine (including other git worktrees of this
    /// same repo, which is exactly what full-scale multi-agent development
    /// on one machine looks like). Without the PID suffix, two concurrent
    /// runs of the same test -- e.g. two worktrees' test suites overlapping
    /// -- resolve to the identical fixture path, and whichever one's
    /// multi-second stream (see `converts_utf8_to_big5_with_allow_lossy_matches_oracle_large_file`,
    /// which alone runs ~80s) finishes first renames its own output over
    /// the file the other is still mid-stream reading. The second process's
    /// post-stream fingerprint recheck then correctly -- but spuriously,
    /// from the test's perspective -- reports "file changed on disk",
    /// because it really did, just courtesy of a sibling test process
    /// rather than any genuine external actor. Confirmed by direct
    /// reproduction (issue #203): running this file's large-fixture test as
    /// two concurrent processes reliably reproduced exactly this failure,
    /// with the "after" fingerprint's size and inode matching the other
    /// process's completed output byte-for-byte. PID alone is sufficient
    /// (no nanos/counter needed, unlike `tmp_candidate_path`'s in-process
    /// collision concern in `lib.rs`) because distinct OS processes never
    /// share a PID while both are alive.
    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojidori-streamconvert-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_no_leftover_tmp(dir: &std::path::Path) {
        let leftovers: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("mojidori-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temp files may remain: {leftovers:?}"
        );
    }

    /// Core red-to-green case: a >12 MiB Big5 file, built the same cheap
    /// way `streamreplace.rs`'s own large Big5 fixture is (encode a small
    /// filler unit once, then repeat the raw bytes -- calling
    /// `encoding_rs`'s Big5 encoder directly on a multi-MiB string was
    /// measured there at tens of seconds in an unoptimized build). The
    /// filler unit is deliberately 3 bytes (1 ASCII + 1 two-byte CJK
    /// character) so its length does not evenly divide `CHUNK_BYTES` (8
    /// MiB) -- guaranteeing some repeat's CJK character actually straddles
    /// the raw chunk-read boundary, rather than every repeat happening to
    /// land cleanly on it.
    #[test]
    fn converts_big5_to_utf8_across_chunk_boundary_large_file() {
        let dir = fixture_dir("big5-to-utf8");
        let file = dir.join("big.txt");

        let (filler_unit, unmappable) = crate::encoding::encode("A測", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(filler_unit.len(), 3);
        assert_ne!(
            CHUNK_BYTES % filler_unit.len(),
            0,
            "filler length must not evenly divide CHUNK_BYTES, or no repeat would ever straddle it"
        );

        let repeats = 4_300_000usize;
        let bytes = filler_unit.repeat(repeats);
        assert!(
            bytes.len() as u64 > 12 * 1024 * 1024,
            "fixture must exceed 12 MiB, was {} bytes",
            bytes.len()
        );
        std::fs::write(&file, &bytes).unwrap();
        let expected_content = "A測".repeat(repeats);

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "Big5".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);
        assert!(report.lossy_report.is_none());

        let on_disk = std::fs::read(&file).unwrap();
        let text = String::from_utf8(on_disk).expect("must be valid UTF-8");
        assert_eq!(text, expected_content);
        assert_eq!(report.bytes_written, text.len() as u64);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Small, fast pin for the two-stage lossy gate's rejection mechanism
    /// and report shape (count/dedup/sample content, file left untouched).
    /// Deliberately tiny: the rejection behavior itself does not depend on
    /// file size, so this stays cheap while the large-file, chunk-crossing,
    /// oracle-matching *commit* path is separately covered at realistic
    /// scale by `converts_utf8_to_big5_with_allow_lossy_matches_oracle_large_file`
    /// below -- running both stages on the same >12 MiB fixture in one test
    /// would pay the (real, but here redundant) encode cost twice for no
    /// extra coverage.
    #[test]
    fn dry_run_rejects_unmappable_content_without_allow_lossy() {
        let dir = fixture_dir("utf8-to-big5-dry-run-reject");
        let file = dir.join("doc.txt");
        let content = "prefix 🚀 middle 🚀 tail 🚀 end";
        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(!report.written);
        assert_eq!(report.bytes_written, 0);
        let lossy = report
            .lossy_report
            .expect("unmappable characters must produce a report");
        assert_eq!(lossy.unmappable_count, 3, "3 rocket occurrences");
        assert_eq!(lossy.samples.len(), 1, "one distinct unmappable character");
        assert!(
            lossy.samples[0].display.contains("1F680"),
            "{:?}",
            lossy.samples[0]
        );
        assert!(!lossy.samples_truncated);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk,
            content.as_bytes(),
            "rejected conversion must leave the file untouched"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Companion red-to-green case for the two-stage lossy gate's *commit*
    /// path: a >12 MiB UTF-8 file with three occurrences of an emoji
    /// unmappable in Big5, converted directly with `allow_lossy: true` (the
    /// rejection path itself is covered above, at small scale). The Big5
    /// oracle is built the same cheap way as
    /// `converts_big5_to_utf8_across_chunk_boundary_large_file`'s fixture --
    /// encoding the small filler/rocket/tail units once and concatenating
    /// the resulting bytes -- which is valid because Big5 (like every
    /// encoding this crate supports as a *target*) is a stateless,
    /// per-character mapping: `encode(A) ++ encode(B) == encode(A ++ B)`
    /// exactly, so this is a real oracle, not an approximation.
    #[test]
    fn converts_utf8_to_big5_with_allow_lossy_matches_oracle_large_file() {
        let dir = fixture_dir("utf8-to-big5-lossy");
        let file = dir.join("doc.txt");

        let filler = "測試內容文字範例好棒棒";
        let repeats = 180_000usize;
        let segment = filler.repeat(repeats);
        let content = format!("{segment}🚀{segment}🚀{segment}🚀tail");
        assert!(
            content.len() as u64 > 12 * 1024 * 1024,
            "fixture must exceed 12 MiB, was {} bytes",
            content.len()
        );
        std::fs::write(&file, content.as_bytes()).unwrap();

        let (segment_big5, seg_unmappable) =
            crate::encoding::encode(&segment, "Big5", false).unwrap();
        assert!(!seg_unmappable);
        let (rocket_big5, rocket_unmappable) =
            crate::encoding::encode("🚀", "Big5", false).unwrap();
        assert!(
            rocket_unmappable,
            "the fixture's whole point is an unmappable character"
        );
        let (tail_big5, tail_unmappable) = crate::encoding::encode("tail", "Big5", false).unwrap();
        assert!(!tail_unmappable);
        let mut expected_bytes = Vec::new();
        for _ in 0..3 {
            expected_bytes.extend_from_slice(&segment_big5);
            expected_bytes.extend_from_slice(&rocket_big5);
        }
        expected_bytes.extend_from_slice(&tail_big5);

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            true,
        )
        .unwrap();
        assert!(report.written);
        assert!(report.lossy_report.is_none());
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk, expected_bytes);
        assert_eq!(report.bytes_written, expected_bytes.len() as u64);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Direct integration-level regression for the `had_unmappable`-gated
    /// scanner fast path in `run_convert_loop` (see its doc comment):
    /// unlike the other two large-file tests above -- Big5->UTF-8, where
    /// *every* chunk is clean since UTF-8 is always representable, and
    /// UTF-8->Big5 with 3 rockets spread such that *both* of its two chunks
    /// happen to contain one -- this fixture is deliberately built so
    /// exactly the *first* raw 8 MiB chunk is entirely Big5-representable
    /// (`advance_position_only` path) and only the *second* chunk contains
    /// the one unmappable character (`feed` path). This proves the
    /// aggregated count *and* position survive a real per-chunk path switch
    /// driven by `encode_chunk`'s own live output, going through the actual
    /// command -- not just the direct-call unit test in normalize.rs
    /// (`advance_position_only_then_feed_matches_whole_feed`), which never
    /// exercises `run_convert_loop`'s own branch at all.
    #[test]
    fn mixed_clean_and_dirty_chunks_produce_correct_aggregate_report() {
        let dir = fixture_dir("mixed-clean-dirty-chunks");
        let file = dir.join("doc.txt");

        let filler = "測試內容文字範例";
        assert_eq!(filler.chars().count(), 8);
        assert_eq!(filler.len(), 24);
        let repeats = 350_000usize; // 350_000 * 24 = 8,400,000 > CHUNK_BYTES
        let clean_prefix = filler.repeat(repeats);
        assert!(
            clean_prefix.len() > CHUNK_BYTES,
            "the clean filler alone must already overrun chunk 1, so the \
             emoji below falls entirely inside chunk 2"
        );
        let content = format!("{clean_prefix}🚀tail");
        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(!report.written);
        let lossy = report
            .lossy_report
            .expect("the one rocket must still be reported despite chunk 1 being clean");
        assert_eq!(lossy.unmappable_count, 1);
        assert_eq!(lossy.samples.len(), 1);
        assert!(
            lossy.samples[0].display.contains("1F680"),
            "{:?}",
            lossy.samples[0]
        );
        // Position tracking must have correctly advanced across the whole
        // clean prefix (via advance_position_only, never probed for
        // representability) for the dirty chunk's sample to land here.
        assert_eq!(lossy.samples[0].line, 1, "filler has no newlines");
        assert_eq!(
            lossy.samples[0].column,
            filler.chars().count() * repeats + 1,
            "{:?}",
            lossy.samples[0]
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adversarial-review companion to the test above: rather than placing
    /// the unmappable character well after the chunk boundary, this places
    /// it so its own 4 UTF-8 bytes straddle the raw `CHUNK_BYTES` read
    /// boundary exactly (2 bytes land in each raw chunk). The streaming
    /// `Decoder` can't decode a character from only half its bytes, so it
    /// defers the whole character to chunk 2's decoded text -- expected to
    /// behave identically to the "well after the boundary" case, but this
    /// pins the exact-seam case directly rather than relying on that
    /// inference, echoing this codebase's own review history of a
    /// near-but-not-at-the-seam blind spot in `streamreplace.rs`
    /// (`match_fully_inside_chunk_near_seam_is_found`).
    #[test]
    fn unmappable_character_split_across_raw_chunk_boundary_is_still_reported() {
        let dir = fixture_dir("unmappable-at-boundary");
        let file = dir.join("doc.txt");

        let prefix = "a".repeat(CHUNK_BYTES - 2);
        let content = format!("{prefix}🚀tail");
        assert_eq!(
            &content.as_bytes()[CHUNK_BYTES - 2..CHUNK_BYTES + 2],
            "🚀".as_bytes(),
            "the rocket's 4 bytes must straddle the exact chunk boundary"
        );
        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(!report.written);
        let lossy = report
            .lossy_report
            .expect("the boundary-straddling rocket must still be reported");
        assert_eq!(lossy.unmappable_count, 1);
        assert_eq!(lossy.samples.len(), 1);
        assert!(
            lossy.samples[0].display.contains("1F680"),
            "{:?}",
            lossy.samples[0]
        );
        assert_eq!(lossy.samples[0].line, 1);
        assert_eq!(
            lossy.samples[0].column,
            (CHUNK_BYTES - 2) + 1,
            "1-based column; the ASCII prefix is 1 UTF-16 unit per char"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// UTF-16 as a *source* has no dead end (only `new_encoder()`/`encode()`
    /// -- the *target* side -- claim UTF-8 as UTF-16's "output encoding");
    /// this pins the streaming `Decoder`'s cross-chunk carry for exactly
    /// the case a hand-rolled decoder would most likely get wrong: a
    /// surrogate pair whose two 2-byte code units fall on opposite sides of
    /// the raw `CHUNK_BYTES` read boundary. Since `CHUNK_BYTES` (8 MiB) is
    /// even, that boundary can only ever land *between* two code units in a
    /// coherent UTF-16LE stream (never inside one code unit's own 2 bytes,
    /// which would require an odd total byte count somewhere before it) --
    /// so the meaningful cross-chunk case is precisely "high surrogate ends
    /// chunk 1, low surrogate starts chunk 2", constructed exactly here.
    #[test]
    fn utf16le_source_converts_to_utf8_correctly_across_chunk_boundary() {
        let dir = fixture_dir("utf16-boundary");
        let file = dir.join("doc.txt");

        assert_eq!(
            "😀".encode_utf16().collect::<Vec<u16>>(),
            vec![0xD83Du16, 0xDE00u16]
        );
        let smiley_le: [u8; 4] = [0x3D, 0xD8, 0x00, 0xDE];

        let smiley_start = CHUNK_BYTES - 2;
        assert_eq!(smiley_start % 2, 0);
        let mut bytes = [0x61u8, 0x00].repeat(smiley_start / 2);
        assert_eq!(bytes.len(), smiley_start);
        bytes.extend_from_slice(&smiley_le);
        bytes.extend_from_slice(&[0x62u8, 0x00].repeat(2048));

        std::fs::write(&file, &bytes).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-16LE".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);
        assert!(report.lossy_report.is_none());

        let on_disk = std::fs::read(&file).unwrap();
        let text = String::from_utf8(on_disk).expect("must be valid UTF-8");
        let expected = format!("{}😀{}", "a".repeat(smiley_start / 2), "b".repeat(2048));
        assert_eq!(text, expected);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_utf16le_target_encoding() {
        let dir = fixture_dir("utf16le-target-rejected");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello world").unwrap();

        let result = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-16LE".to_string(),
            true,
            false,
        );
        let err = result.expect_err("UTF-16LE target must be rejected");
        assert!(err.contains("UTF-16"), "{err}");
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk, b"hello world", "rejected file must be untouched");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_utf16be_target_encoding_too() {
        let dir = fixture_dir("utf16be-target-rejected");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello world").unwrap();

        let result = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-16BE".to_string(),
            false,
            false,
        );
        assert!(result.is_err(), "UTF-16BE target must be rejected too");
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk, b"hello world");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn target_utf8_no_bom_by_default_even_when_source_had_bom() {
        let dir = fixture_dir("bom-default-none");
        let file = dir.join("doc.txt");
        let (bytes, unmappable) = crate::encoding::encode("hello world", "UTF-8", true).unwrap();
        assert!(!unmappable);
        assert_eq!(&bytes[..3], [0xEF, 0xBB, 0xBF]);
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, b"hello world",
            "no BOM by default, source BOM stripped"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn target_utf8_with_bom_prepends_bom() {
        let dir = fixture_dir("bom-explicit");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-8".to_string(),
            true,
            false,
        )
        .unwrap();
        assert!(report.written);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(&on_disk[..3], [0xEF, 0xBB, 0xBF]);
        assert_eq!(&on_disk[3..], b"hello");
        assert_eq!(report.bytes_written, on_disk.len() as u64);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn source_bom_is_stripped_when_converting_to_encoding_with_no_bom_concept() {
        let dir = fixture_dir("bom-stripped-to-big5");
        let file = dir.join("doc.txt");
        let (bytes, unmappable) = crate::encoding::encode("中文內容", "UTF-8", true).unwrap();
        assert!(!unmappable);
        assert_eq!(&bytes[..3], [0xEF, 0xBB, 0xBF]);
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);
        let on_disk = std::fs::read(&file).unwrap();
        let decoded = crate::encoding::decode_with(&on_disk, "Big5").unwrap();
        assert!(!decoded.malformed);
        assert!(!decoded.had_bom, "Big5 has no BOM concept");
        assert_eq!(decoded.content, "中文內容");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_target_ignores_target_with_bom_flag() {
        let dir = fixture_dir("bom-ignored-legacy-target");
        let file = dir.join("doc.txt");
        std::fs::write(&file, "hello".as_bytes()).unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            true,
            false,
        )
        .unwrap();
        assert!(report.written);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, b"hello",
            "Big5 target must never gain a BOM-like prefix"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A stray `0x80` byte is below Big5's lead-byte floor (0x81) and is not
    /// a valid trail byte either, so splicing it into otherwise-valid Big5
    /// content guarantees a malformed-sequence decode error (mirrors
    /// `streamreplace.rs`'s equivalent fixture). The abort must happen
    /// without touching the original file or leaving a temp file behind.
    #[test]
    fn malformed_source_aborts_untouched() {
        let dir = fixture_dir("malformed-source");
        let file = dir.join("doc.txt");
        let text = "正常的中文內容在這裡";
        let (mut bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let insert_at = bytes.len() / 2;
        bytes.insert(insert_at, 0x80);
        let (_, malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(malformed, "fixture must actually be malformed as Big5");
        std::fs::write(&file, &bytes).unwrap();

        let result = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "Big5".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        );
        assert!(result.is_err(), "malformed source must abort");
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, bytes,
            "original bytes must be untouched after an abort"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_source_encoding_label_errors() {
        let result = stream_convert_file(
            "/nonexistent/path/does/not/matter.txt".to_string(),
            "not-an-encoding".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn unknown_target_encoding_label_errors() {
        let result = stream_convert_file(
            "/nonexistent/path/does/not/matter.txt".to_string(),
            "UTF-8".to_string(),
            "not-an-encoding".to_string(),
            false,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn empty_file_converts_to_empty_output() {
        let dir = fixture_dir("empty-file");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"").unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "Big5".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);
        assert_eq!(report.bytes_written, 0);
        let on_disk = std::fs::read(&file).unwrap();
        assert!(on_disk.is_empty());

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn convert_succeeds_when_file_unchanged() {
        let dir = fixture_dir("fingerprint-happy-path");
        let file = dir.join("doc.txt");
        std::fs::write(&file, "hello world").unwrap();

        let report = stream_convert_file(
            file.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-8".to_string(),
            false,
            false,
        )
        .unwrap();
        assert!(report.written);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301, streaming-path follow-up (PR #317 third review round):
    /// `stream_convert_file` used to rename its temp file directly onto
    /// `path`, so "Convert File to Encoding..." on a file opened through a
    /// symlink replaced the symlink itself with a regular file, leaving
    /// the real target untouched -- the large-file counterpart to the
    /// small-file Save bug issue #301 originally reported. Now that the
    /// commit path resolves through `resolve_write_destination` the same
    /// way `atomic_write_follow_symlinks` does, the link must survive and
    /// the target must receive the converted bytes. `target_with_bom:
    /// true` on a UTF-8 target adds a 3-byte BOM prefix the original file
    /// never had, so the assertion on the target's bytes is proof the
    /// write actually landed there, not just that old bytes happened to
    /// still be present.
    #[cfg(unix)]
    #[test]
    fn stream_convert_file_through_symlink_updates_target_and_preserves_link() {
        use std::os::unix::fs::symlink;

        let dir = fixture_dir("through-symlink");
        let target = dir.join("target.txt");
        std::fs::write(&target, "hello world").unwrap();
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();

        let report = stream_convert_file(
            link.to_string_lossy().into_owned(),
            "UTF-8".to_string(),
            "UTF-8".to_string(),
            true,
            false,
        )
        .unwrap();
        assert!(report.written);

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must still be a symlink after conversion, not a regular file"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        let on_disk = std::fs::read(&target).unwrap();
        assert_eq!(
            on_disk,
            [&[0xEF, 0xBB, 0xBF][..], b"hello world"].concat(),
            "the target must hold the newly converted (BOM-prefixed) bytes"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Core red-to-green regression for the external-modification guard: a
    /// file externally replaced via atomic rename (log rotation,
    /// formatters, sync tools) while a conversion is (hypothetically) still
    /// in flight must be detected and the newer content must never be
    /// clobbered. Mirrors `streamreplace.rs`'s
    /// `replace_aborts_when_file_replaced_during_operation` and its
    /// rationale for exercising `verify_unchanged` directly against a real
    /// external rename rather than racing a background thread.
    #[cfg(unix)]
    #[test]
    fn convert_aborts_when_file_replaced_during_operation() {
        let dir = fixture_dir("external-replace");
        let file = dir.join("target.txt");
        std::fs::write(&file, b"original content, unchanged\n").unwrap();

        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = Fingerprint::from_file(&source).unwrap();

        let replacement = dir.join("replacement.txt");
        std::fs::write(&replacement, b"newer content from another process\n").unwrap();
        std::fs::rename(&replacement, &file).unwrap();

        let result = verify_unchanged(&file, &fingerprint);
        assert!(
            result.is_err(),
            "an externally-renamed-in file must be detected as changed"
        );
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, b"newer content from another process\n",
            "the externally-written content must survive untouched"
        );

        drop(source);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_unchanged_detects_size_change() {
        let dir = fixture_dir("verify-size");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = Fingerprint::from_file(&source).unwrap();

        fingerprint.len += 1;

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_unchanged_detects_mtime_change() {
        let dir = fixture_dir("verify-mtime");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = Fingerprint::from_file(&source).unwrap();

        fingerprint.modified.secs -= 3600;

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn verify_unchanged_detects_identity_change() {
        let dir = fixture_dir("verify-identity");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let mut fingerprint = Fingerprint::from_file(&source).unwrap();

        fingerprint.identity = (
            fingerprint.identity.0,
            fingerprint.identity.1.wrapping_add(1),
        );

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_unchanged_detects_deleted_file() {
        let dir = fixture_dir("verify-deleted");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = Fingerprint::from_file(&source).unwrap();

        std::fs::remove_file(&file).unwrap();

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
