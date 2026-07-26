mod backup;
mod batch;
mod bytedrift;
mod charinspect;
mod chunk;
mod comparepreview;
mod docinfo;
mod encoding;
mod fsguard;
// Fuzz-only content (PRNG, representable-text generators, and the fuzz
// tests themselves) -- nothing in this module is used outside `cargo
// test`, so the whole file is gated here rather than per-item.
#[cfg(test)]
mod fuzz_roundtrip;
// Fuzz-only content for the large-file chunk-paging subsystem (chunk.rs /
// lineindex.rs) -- same rationale as fuzz_roundtrip above.
#[cfg(test)]
mod fuzz_paging;
mod hexdump;
mod linebreak;
mod lineindex;
mod menu;
mod migrate;
mod mojibake;
mod normalize;
mod openfile_probe;
mod prefs;
mod recent;
mod replaceinfiles;
mod search;
mod session;
mod startup_probe;
mod store;
mod streamcodec;
mod streamconvert;
mod streamreplace;
mod watcher;

use fsguard::Fingerprint;
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

/// Files requested via OS integration (file association, CLI args) before
/// the frontend was ready to receive events. Drained by the frontend on
/// startup through `take_pending_files`.
struct PendingFiles(Mutex<Vec<String>>);

/// Extract existing file paths from process-style arguments, skipping the
/// binary name and anything that looks like a flag.
fn existing_paths_from_args<I: Iterator<Item = String>>(args: I) -> Vec<String> {
    args.skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_file())
        .collect()
}

#[tauri::command]
fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Open the native print dialog for the main webview. The frontend fills
/// its print-only view with the full document before calling this, because
/// the editor's virtualized viewport only renders visible lines.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .print()
        .map_err(|e| format!("Printing is not available: {e}"))
}

/// Files larger than this open as a read-only preview instead of loading
/// fully into the WebView. `pub(crate)` so other bounded-scan commands can
/// share the exact same cutoff rather than re-declaring their own — see
/// `docinfo.rs`'s `line_ending_distribution` (ROADMAP.md v0.6 E1).
pub(crate) const LARGE_FILE_THRESHOLD: u64 = 10 * 1024 * 1024;
/// How much of a large file the preview shows.
const PREVIEW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    path: String,
    content: String,
    encoding: String,
    had_bom: bool,
    malformed: bool,
    line_ending: String,
    /// True when only a leading slice of the file was loaded (read-only).
    truncated: bool,
    total_size: u64,
    /// When truncated: file offset where the next chunk begins.
    next_offset: Option<u64>,
    /// Metadata snapshot of the file as it was at open time, opaque to the
    /// frontend (see `fsguard.rs`). `None` only when the snapshot itself
    /// couldn't be captured (e.g. a filesystem that doesn't report mtime) —
    /// the frontend stores whatever comes back and passes it right back as
    /// `save_document`'s `expected_fingerprint`, where `None` means "no
    /// verified baseline, skip the staleness check" (issue #113).
    fingerprint: Option<Fingerprint>,
}

/// Cut a preview slice at the last line boundary so the tail is not a
/// half-loaded line (or a split multi-byte sequence) where avoidable.
///
/// `utf16` names the byte order when `bytes` is UTF-16 (see
/// `encoding::utf16_variant` / `encoding::preview_utf16_variant`), decided
/// by the caller from the same signal the real decode will use (explicit
/// label; else BOM; else, during auto-detection, a per-extension hint
/// resolved the same way the real decode resolves it — issue #71) *before*
/// decoding happens — this function only ever sees raw bytes. UTF-16's LF is the
/// two-byte code unit `0A 00` (LE) or `00 0A` (BE); the plain `None` path
/// below searches for a lone `0x0A` byte, which is correct for UTF-8 and
/// other byte-oriented encodings but — for UTF-16 — lands on only half of
/// that code unit, handing the decoder an odd-length slice that reports
/// `malformed` even though nothing in the file is actually corrupt (issue
/// #61). When `utf16` is `Some`, the cut point is instead the last
/// code-unit-aligned newline pair (even byte offset) within the window, or
/// the window rounded down to even length if none is found — the returned
/// slice is always even-length and never splits a code unit; the fallback
/// additionally drops a trailing high surrogate so a 4-byte character is
/// never split either, even at the cost of losing line alignment in that
/// rare no-newline-in-window case.
fn preview_slice(bytes: &[u8], max: usize, utf16: Option<encoding::Utf16Variant>) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let Some(variant) = utf16 else {
        let slice = &bytes[..max];
        return match slice.iter().rposition(|&b| b == b'\n') {
            Some(pos) => &slice[..=pos],
            None => slice,
        };
    };
    // Even-length window: never leave a dangling half code unit at the
    // tail, regardless of whether `max` itself is even.
    let even = max & !1;
    let window = &bytes[..even];
    let (b0, b1) = match variant {
        encoding::Utf16Variant::Le => (b'\n', 0u8),
        encoding::Utf16Variant::Be => (0u8, b'\n'),
    };
    let cut = window
        .chunks_exact(2)
        .rposition(|pair| pair[0] == b0 && pair[1] == b1)
        .map(|i| (i + 1) * 2);
    let mut end = cut.unwrap_or(even);
    // The no-newline fallback is code-unit aligned but could still split a
    // surrogate pair (a 4-byte character): a trailing high surrogate
    // decodes as U+FFFD and flags the preview malformed — the exact false
    // warning this function exists to avoid. Drop a dangling high
    // surrogate; a newline cut never needs this (newlines are complete
    // characters).
    if cut.is_none() && end >= 2 {
        let unit = match variant {
            encoding::Utf16Variant::Le => u16::from_le_bytes([window[end - 2], window[end - 1]]),
            encoding::Utf16Variant::Be => u16::from_be_bytes([window[end - 2], window[end - 1]]),
        };
        if (0xD800..=0xDBFF).contains(&unit) {
            end -= 2;
        }
    }
    &window[..end]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    unmappable: bool,
    written: bool,
    /// True when `expected_fingerprint` was given and no longer matches the
    /// file's current on-disk state — something else wrote to `path` since
    /// the fingerprint was captured. Nothing was written; the caller must
    /// re-invoke with `force: true` (after explicit user confirmation to
    /// overwrite) or reload the file's fresh content first (issue #113).
    stale: bool,
    /// The file's fingerprint immediately after a successful write, opaque
    /// to the frontend (see `fsguard.rs`) — store it and pass it back as
    /// the next save's `expected_fingerprint`. `None` unless `written` is
    /// true.
    fingerprint: Option<Fingerprint>,
    /// Which characters can't be represented in `encoding`, not just that
    /// some can't (ROADMAP.md v0.4 Track A "Lossy-save character preview")
    /// [danger]. Populated only on the lossy-rejection path (`unmappable:
    /// true, written: false`, from the first, `allow_lossy: false` call);
    /// `None` on every other result — a successful write (lossy or not)
    /// and a `stale` rejection both have nothing new to show, and the
    /// frontend never re-triggers the lossy-preview dialog from either.
    lossy_report: Option<normalize::LossySaveReport>,
}

/// Read a file from disk, decoding with the given encoding label or with
/// automatic detection when `encoding` is `None`. The returned content is
/// LF-normalized; the original line ending is reported in `line_ending`.
///
/// `extension_encoding` is an advisory hint forwarded by the frontend: the
/// encoding its per-extension preferences table maps this file's extension
/// to, if any (resolved from `Preferences::extension_encodings` — see
/// `src/extensionEncodings.ts`). It only takes effect during auto-detection
/// (`encoding: None`); the core decision — BOM first, then confident UTF-8
/// (valid non-ASCII UTF-8 is never reinterpreted by the hint), then the
/// hint if it decodes the bytes without malformed sequences, else the
/// statistical fallback — is made in `encoding::detect_with_extension`,
/// not here or in the frontend.
///
/// Files over `LARGE_FILE_THRESHOLD` are read as a bounded prefix instead
/// of the whole file — at most `PREVIEW_BYTES` end up in `content` — so
/// opening a multi-GB file costs `O(PREVIEW_BYTES)` I/O and memory, not
/// `O(file size)` (issue #59). `total_size` and the `truncated` decision
/// come from the `std::fs::metadata` snapshot taken at the top of this
/// function, before the file is reopened for the bounded read; if the file
/// is replaced, grown, or shrunk in that window, `total_size` can end up
/// stale, but the read itself stays bounded by `take` regardless of what
/// the file has become by the time it runs — an accepted race, not a
/// correctness guarantee for a file mutated mid-open.
#[tauri::command]
fn open_document(
    path: String,
    encoding: Option<String>,
    extension_encoding: Option<String>,
) -> Result<OpenedDocument, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = meta.len();
    // Captured from the same metadata snapshot `total_size`/`truncated`
    // already rest on, so this introduces no new race beyond the one this
    // function's own doc comment already accepts. `.ok()`: a filesystem
    // that can't report mtime shouldn't fail the whole open, just leave
    // this document without a verified save-time baseline (see
    // `OpenedDocument::fingerprint`).
    let fingerprint = Fingerprint::from_metadata(&meta).ok();
    let truncated = total_size > LARGE_FILE_THRESHOLD;
    let raw = if truncated {
        // Bounded read: at most PREVIEW_BYTES + 1 bytes are ever read from
        // disk, never the whole file. The extra sentinel byte is only
        // present in `raw` when the file has more data past the window; it
        // is what lets the unmodified `preview_slice` below tell "the file
        // continues past here" from "the window is the whole file" and cut
        // at the last line boundary exactly as it would if handed the full
        // file, without this call ever materializing more than
        // ~PREVIEW_BYTES in memory.
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
        // Capacity matches the take limit: one byte short would force a
        // 2 MB doubling realloc when the sentinel byte lands.
        let mut buf = Vec::with_capacity(PREVIEW_BYTES + 1);
        file.take(PREVIEW_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read {path}: {e}"))?;
        buf
    } else {
        // Small files: one full read is the right tradeoff here (a single
        // syscall, no window bookkeeping).
        std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?
    };
    let (bytes, next_offset) = if truncated {
        // Issue #71: alignment must match what the real decode below will
        // actually choose. During auto-detection that choice can come
        // from `extension_encoding`, not just the BOM — plain
        // `encoding::utf16_variant` cannot see that hint.
        // `preview_utf16_variant` runs the same guarded
        // `detect_with_extension` the decode itself calls, so the two
        // can never disagree.
        let utf16 = encoding::preview_utf16_variant(
            &raw,
            encoding.as_deref(),
            extension_encoding.as_deref(),
        );
        let slice = preview_slice(&raw, PREVIEW_BYTES, utf16);
        // Issue #71 (single-line P3) / #136: for a non-UTF-16 preview
        // whose *effective* encoding is UTF-8, `preview_slice` cuts at
        // the last newline — a clean UTF-8 boundary the real decode
        // relies on (auto-detect's confident-UTF-8 gate; an explicit
        // UTF-8 label's direct decode just as much). A single very long
        // line with no newline in the window has no such cut, so the
        // slice can still end mid-character; left as-is, auto-detect
        // would miss its gate and an extension hint could hijack the
        // whole window into mojibake, while an explicit UTF-8 reopen
        // would simply decode the truncated tail as malformed — a
        // spurious U+FFFD for a file that is not actually corrupt
        // anywhere (#136). Trimming the truncated trailing UTF-8
        // sequence realigns it, and `next_offset` below is derived from
        // the (possibly trimmed) slice's own length, so a trimmed open
        // always hands the next chunk read a character-aligned offset
        // too.
        //
        // Applies whenever the effective encoding is UTF-8: during
        // auto-detection (`encoding.is_none()` — trimming first is what
        // lets detection itself reach the verdict it would on the whole
        // file, so this cannot be narrowed to "only once we already know
        // it's UTF-8"; the trim is a no-op for any other detected
        // encoding, see below) or when the caller explicitly reopened as
        // UTF-8 (`encoding::is_utf8_label`; before #136 this took the
        // untrimmed `else` branch below). Both stay scoped to non-UTF-16
        // (`utf16.is_none()`): a UTF-16-aligned slice must stay whole,
        // and real UTF-16 has no truncated-UTF-8 tail to trim. An
        // explicit label naming a *legacy multi-byte* encoding (Big5,
        // Shift_JIS, GBK, gb18030, EUC-JP, EUC-KR) is handled by the
        // sibling branch below instead (issue #165) — this function
        // itself stays UTF-8-only, validated via `str::from_utf8` exactly
        // as before. Any other explicit label (a single-byte encoding, or
        // one neither branch below claims — see
        // `encoding::is_legacy_multibyte_label`'s doc comment for the
        // full exclusion list) is still left untouched — byte-range
        // trimming is only sound for an encoding one of the two functions
        // below explicitly supports. That same validation is also why
        // this UTF-8 branch is safe to apply unconditionally for
        // auto-detect regardless of what encoding detection eventually
        // settles on: the function only ever removes bytes that form a
        // truncated-at-the-very-end multibyte sequence (`error_len() ==
        // None`) and otherwise returns its input unchanged — a genuine
        // *interior* malformed sequence (`error_len() == Some(_)`, e.g.
        // real non-UTF-8 bytes, or truly corrupt UTF-8) is left in place
        // and still reported as malformed, and the multi-line/clean-cut
        // cases are untouched because they never hit the truncated-tail
        // branch at all.
        let effective_utf8 =
            encoding.is_none() || encoding.as_deref().is_some_and(encoding::is_utf8_label);
        // Issue #165: the same truncated-tail problem #136 fixed for an
        // explicit UTF-8 reopen also applies to an explicit reopen as one
        // of the legacy multi-byte encodings — a bare byte-range preview
        // cut can land mid-character there too. Unlike the UTF-8 branch,
        // this never applies during auto-detection: auto-detect has no
        // committed target encoding yet to validate a trimmed tail
        // against. chardetng *does* guess these encodings on clean
        // samples (see encoding.rs's detects_big5_from_realistic_sample),
        // but empirically its statistical verdict swings away from the
        // legacy encoding — to a single-byte candidate like windows-1252 —
        // precisely when the window ends mid-character, so the
        // truncated-tail misreport this branch fixes does not reproduce on
        // the auto-detect path (verified against encoding_rs 0.8.35 +
        // chardetng 0.1.17 in adversarial review; the separate
        // "mis-detected as single-byte" limitation that experiment exposed
        // is tracked as its own issue). This branch therefore only fires
        // for an explicit label, which `trim_truncated_legacy_tail`
        // resolves the same way `decode_with` below will.
        let is_legacy_multibyte = encoding
            .as_deref()
            .is_some_and(encoding::is_legacy_multibyte_label);
        let slice = if utf16.is_none() && effective_utf8 {
            encoding::trim_truncated_utf8_tail(slice)
        } else if utf16.is_none() && is_legacy_multibyte {
            // `is_legacy_multibyte` is true only when `encoding` is
            // `Some`, so this unwrap cannot panic.
            encoding::trim_truncated_legacy_tail(slice, encoding.as_deref().unwrap())
        } else {
            slice
        };
        (slice, Some(slice.len() as u64))
    } else {
        (&raw[..], None)
    };
    let decoded = match encoding {
        Some(label) => encoding::decode_with(bytes, &label)?,
        None => encoding::decode_auto_with_extension(bytes, extension_encoding.as_deref()),
    };
    let line_ending = encoding::detect_line_ending(&decoded.content).to_string();
    Ok(OpenedDocument {
        path,
        content: encoding::normalize_to_lf(&decoded.content),
        encoding: decoded.encoding,
        had_bom: decoded.had_bom,
        malformed: decoded.malformed,
        line_ending,
        truncated,
        total_size,
        next_offset,
        fingerprint,
    })
}

/// Diagnostics evidence never touches raw bytes: `bom` is a formatted
/// description, not the bytes themselves (ARCHITECTURE.md: raw bytes never
/// cross IPC).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectionExplanation {
    /// e.g. "UTF-8 BOM (EF BB BF)"; `None` when no BOM was found.
    bom: Option<String>,
    /// chardetng's verdict on the sampled bytes, e.g. "windows-1252".
    detector_verdict: String,
    sampled_bytes: usize,
    total_size: u64,
    /// "{encoding} ({reason})" where reason is "bom" | "extension" |
    /// "detector" | "fallback" — the encoding `open_document`'s
    /// auto-detection would pick, and why.
    would_choose: String,
    /// True when `total_size` exceeds `LARGE_FILE_THRESHOLD` (issue #201):
    /// `open_document`'s real auto-detect for a file this large never sees
    /// the whole file, only a bounded preview window (`PREVIEW_BYTES`), so
    /// `detector_verdict` — and `would_choose`, whenever its reason isn't
    /// `"bom"` — reflects chardetng's statistical read of a truncated
    /// sample, not the whole file. For a large single-line legacy
    /// multi-byte file with no newline in that window, that statistical
    /// read can swing to the wrong (single-byte) encoding family with
    /// `malformed == false`, so nothing else catches it.
    ///
    /// This is a distinct condition from `sampled_bytes < total_size`:
    /// that one is about *this command's own* `EXPLAIN_SAMPLE_BYTES` cap
    /// and is true for any file merely over 64 KiB, including plenty
    /// `open_document` itself reads whole (anything at or under
    /// `LARGE_FILE_THRESHOLD`). Conflating the two would warn about files
    /// whose real on-screen encoding was never actually truncated.
    ///
    /// A BOM is read from the first few bytes regardless of file size, so
    /// a BOM-based `would_choose` is exactly as reliable here as it would
    /// be on the whole file; the frontend gates its truncated-sample hint
    /// on `reason != "bom"` accordingly (see `detectcard.ts`).
    large_file_preview: bool,
}

/// Diagnostics sample size: large enough for chardetng to reach a stable
/// verdict, small enough to never require reading a whole large file just
/// to explain a detection. `pub(crate)` so `docinfo.rs`'s
/// `document_info_snapshot` (issue #254) can read this exact same bounded
/// prefix once, off its own single open handle, and reuse it for both the
/// detection section and the leading portion of its line-ending scan,
/// rather than re-reading the same leading bytes a second time under a
/// separate command.
pub(crate) const EXPLAIN_SAMPLE_BYTES: usize = 64 * 1024;

/// Read a bounded `EXPLAIN_SAMPLE_BYTES` prefix from `file` (whose read
/// cursor must already be positioned where the sample should start — every
/// current caller passes a freshly-opened handle, so that's always offset
/// 0). Exact for a file at or under `EXPLAIN_SAMPLE_BYTES`, a leading
/// sample beyond it. The bound is enforced on the disk read itself via
/// `Read::take`, not by reading the whole file and slicing the sample out
/// in memory afterward — so this costs `O(EXPLAIN_SAMPLE_BYTES)` I/O
/// regardless of how large the file actually is (issue #59).
///
/// Split out of `explain_detection` so `document_info_snapshot`
/// (`docinfo.rs`, issue #254) can call it once against its own single open
/// handle and hand the result to both the detection section and (as the
/// seed for) the line-ending scan.
pub(crate) fn read_explain_sample(file: &mut std::fs::File, path: &str) -> Result<Vec<u8>, String> {
    let mut sample = Vec::with_capacity(EXPLAIN_SAMPLE_BYTES);
    file.take(EXPLAIN_SAMPLE_BYTES as u64)
        .read_to_end(&mut sample)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    Ok(sample)
}

/// Build the detection evidence (`DetectionExplanation`) from an
/// already-read `sample` (the file's first `sample.len()` bytes) and the
/// file's already-known `total_size`. Pure, no I/O — reuses
/// `encoding::detect_with_extension`, the same function
/// `decode_auto_with_extension` (and therefore `open_document`) calls, so
/// this can never disagree with what `open_document` would choose for
/// files at or under the sample size — see the
/// `detect_agrees_with_decode_auto_*` tests in `encoding.rs`.
///
/// Split out of `explain_detection` so `document_info_snapshot`
/// (`docinfo.rs`, issue #254) can reuse it against a sample it read from
/// its own single open handle, instead of a second, independent read.
pub(crate) fn build_detection_explanation(
    sample: &[u8],
    total_size: u64,
    extension_encoding: Option<&str>,
) -> DetectionExplanation {
    let detection = encoding::detect_with_extension(sample, extension_encoding);
    DetectionExplanation {
        bom: encoding::describe_bom(sample),
        detector_verdict: detection.detector_guess.name().to_string(),
        sampled_bytes: sample.len(),
        total_size,
        would_choose: format!("{} ({})", detection.chosen.name(), detection.reason),
        // Same threshold `open_document` uses to decide whether *it* reads
        // this file whole or through the bounded large-file preview path —
        // deliberately recomputed here (not passed in) so this stays a
        // read-only re-derivation from the file's own metadata rather than
        // trusting a caller-supplied flag, consistent with how `total_size`
        // above is already a fresh read, not something the frontend hands
        // back from the original open.
        large_file_preview: total_size > LARGE_FILE_THRESHOLD,
    }
}

/// Re-read a bounded prefix of `path` and report the evidence behind the
/// encoding auto-detection would use, without decoding or returning any
/// raw bytes. This is a read-only diagnostics command: it never affects
/// `open_document`'s behavior. `extension_encoding` is the same advisory
/// hint the frontend passes to `open_document` (see there).
///
/// Opens the file once and derives `total_size` from an fstat on the
/// resulting handle (`file.metadata()`), not a second, independent
/// path-based `std::fs::metadata` call before the open — the same
/// single-open discipline `document_info_snapshot` (`docinfo.rs`, issue
/// #254) generalizes to all three Document Info sections at once.
#[tauri::command]
fn explain_detection(
    path: String,
    extension_encoding: Option<String>,
) -> Result<DetectionExplanation, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let total_size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len();
    let sample = read_explain_sample(&mut file, &path)?;
    Ok(build_detection_explanation(
        &sample,
        total_size,
        extension_encoding.as_deref(),
    ))
}

/// Process-local counter mixed into temporary-file names (alongside a
/// timestamp) so that two [`create_tmp_exclusive`] calls in the same
/// process can never produce the same candidate, even within the same
/// nanosecond.
static TMP_NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build one same-directory temporary-file candidate path for `file_name`.
/// The name mixes the process id, the current time's subsecond
/// nanoseconds, and [`TMP_NAME_COUNTER`], so it cannot be guessed from
/// public information alone the way a bare `.{file_name}.mojidori-tmp-{pid}`
/// name could (issue #60). Unpredictability is defense in depth, not the
/// actual safety guarantee — [`open_exclusive`] is what makes a guessed or
/// colliding name safe.
fn tmp_candidate_path(dir: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let counter = TMP_NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".{file_name}.mojidori-tmp-{}-{nanos}-{counter}",
        std::process::id()
    ))
}

/// Open `path` for writing only if it does not already exist:
/// `O_CREAT | O_EXCL` on Unix, `CREATE_NEW` on Windows. If `path` already
/// exists — including as a symlink, dangling or not — this fails with
/// `AlreadyExists` instead of following it. That is the actual fix for
/// issue #60: an attacker who pre-plants a symlink at a path we are about
/// to use as a temp file can no longer redirect our write to the
/// symlink's target, because we never open through it in the first place.
fn open_exclusive(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Create a same-directory temporary file with an unpredictable name,
/// refusing to follow any symlink already occupying a candidate path (see
/// [`open_exclusive`]). Retries up to 16 times on `AlreadyExists` — a
/// genuine name collision and a pre-planted symlink look identical from
/// here, and both are handled the same way: try the next unpredictable
/// candidate. Any other error is returned immediately. On exhausting all
/// attempts, returns the last `AlreadyExists` error. Returns the open file
/// together with the path it was created at, since the caller needs the
/// path for `rename` and for cleanup on a later failure.
fn create_tmp_exclusive(
    dir: &std::path::Path,
    file_name: &str,
) -> std::io::Result<(std::fs::File, std::path::PathBuf)> {
    let mut last_err =
        std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no candidate attempted");
    for _ in 0..16 {
        let candidate = tmp_candidate_path(dir, file_name);
        match open_exclusive(&candidate) {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = e,
            Err(e) => return Err(e),
        }
    }
    Err(last_err)
}

/// Maximum symlink hops [`resolve_symlink_target`] follows before
/// concluding a chain is cyclic (or simply absurd). Matches the
/// traditional Unix `MAXSYMLINKS` (Linux, *BSD) so a self-referential
/// chain fails with a clear error instead of looping forever.
const MAX_SYMLINK_HOPS: u32 = 40;

/// Resolve `path` to the file an atomic write should actually replace:
/// `path` itself, unchanged, when it is not a symlink (including when it
/// does not exist at all — the ordinary new-file save path); otherwise the
/// final, non-symlink component that the chain of symlinks rooted at
/// `path` ultimately names, so that writing there and leaving `path` (and
/// every intermediate link) untouched preserves the whole link topology
/// (issue #301).
///
/// Deliberately not `std::fs::canonicalize`: canonicalize requires every
/// path component, including the final target, to already exist. That
/// would turn saving through a *dangling* symlink into a hard error, when
/// creating a fresh file at the link's target — leaving the dangling link
/// now pointing at something real — is exactly the well-defined behavior
/// this function enables (see
/// `atomic_write_through_dangling_symlink_heals_target`). Instead this
/// walks the chain one hop at a time with `symlink_metadata`, which
/// (unlike `metadata`) reports the final path component itself rather
/// than following it, and stops as soon as a hop is not a symlink —
/// whether or not that final path exists yet. A `symlink_metadata` error
/// at any hop (dangling target, permission denied, ...) is treated the
/// same way: nothing more to resolve, so the current candidate is the
/// answer. A genuine permission problem still surfaces, just later — at
/// the real write attempt against that candidate — with an I/O error tied
/// to the actual destination instead of a synthetic one from here.
///
/// Each relative link target is resolved against the directory of the
/// symlink that named it (`read_link`'s own contract), not against
/// `path`'s directory or the process's current directory, so a multi-hop
/// chain of relative links spread across different directories resolves
/// exactly the way the OS would resolve it.
///
/// TOCTOU note: like every other fail-closed check in this file (see
/// `save_document`'s fingerprint doc comment), this resolves the chain
/// once and hands the result to the caller, which then creates a temp
/// file and renames it into place; a link in the chain can still be
/// repointed, or an intermediate directory swapped, between this
/// resolution and that rename. No portable API closes that window —
/// this only narrows it from the whole open-to-save span down to the
/// resolve-to-rename gap, the same trade-off every other check here
/// already makes.
fn resolve_symlink_target(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let mut current = path.to_path_buf();
    for _ in 0..MAX_SYMLINK_HOPS {
        let is_symlink = std::fs::symlink_metadata(&current)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if !is_symlink {
            return Ok(current);
        }
        let link_target = std::fs::read_link(&current)?;
        current = if link_target.is_absolute() {
            link_target
        } else {
            current
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join(link_target)
        };
    }
    Err(std::io::Error::other(format!(
        "too many levels of symbolic links resolving {}",
        path.display()
    )))
}

/// Write bytes atomically: create a temporary file in the same directory
/// (same filesystem) — with an unpredictable name and exclusive create, so
/// the temp-file step can never be redirected through a pre-planted
/// symlink (see [`create_tmp_exclusive`], [`open_exclusive`]; issue #60) —
/// write it, fsync, then rename over the target. A crash mid-save leaves
/// either the old file or the new one — never a half-written file.
/// Existing file permissions are carried over to the replacement.
///
/// When `path` is itself a symlink (or a chain of them), the rename lands
/// on the resolved target instead — see [`resolve_symlink_target`] — so a
/// save through a symlink updates the file it points to and leaves the
/// link itself in place, rather than replacing the link with a regular
/// file (issue #301). This is layered on top of, and does not change, the
/// issue #60 hardening above: the temp file is still created next to the
/// resolved target with an unpredictable, exclusively-created name, so it
/// can never be redirected through a pre-planted symlink either.
pub(crate) fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let write_target = resolve_symlink_target(path)?;
    let dir = write_target
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let file_name = write_target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let (mut tmp, tmp_path) = create_tmp_exclusive(dir, &file_name)?;

    let result = (|| {
        tmp.write_all(bytes)?;
        tmp.sync_all()?;
        drop(tmp);
        if let Ok(meta) = std::fs::metadata(&write_target) {
            let _ = std::fs::set_permissions(&tmp_path, meta.permissions());
        }
        // std::fs::rename replaces the destination on every platform
        // (MOVEFILE_REPLACE_EXISTING on Windows). Renaming onto
        // `write_target` rather than `path` is what keeps a symlink at
        // `path` intact: the rename only ever touches the directory entry
        // of the file the link (transitively) points to, never the
        // link's own directory entry.
        std::fs::rename(&tmp_path, &write_target)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

/// Encode LF-normalized content with the given encoding and line ending,
/// then write it to disk atomically.
///
/// This is a multi-phase save. `unmappable` is true when characters could
/// not be represented in the target encoding. When that happens and
/// `allow_lossy` is `false`, nothing is written — the file on disk is left
/// exactly as it was, and the caller must re-invoke with `allow_lossy: true`
/// (after explicit user confirmation) to actually write the lossy bytes.
/// This guarantees a save can never silently overwrite the user's original
/// text with lossy replacement bytes before they've agreed to that trade.
///
/// That guarantee is about *unmappable* characters specifically, not
/// byte-for-byte fidelity in general: every save re-encodes the entire
/// document from scratch (there is no per-region diffing), so for the
/// legacy encodings `encoding::encode`'s round-trip contract note
/// documents, saving can silently canonicalize bytes the user never
/// touched even when nothing is unmappable and `allow_lossy` never comes
/// into play. See `encoding.rs`'s module doc.
///
/// Issue #113: after encoding but before the commit (`atomic_write`), this
/// also fail-closes against an external change to `path` since it was last
/// read — the ordinary Save path had no guard at all against another
/// process (or a second Mojidori window) writing to the same file during the
/// encode step, unlike the large-file streaming replace path's existing
/// fingerprint check (issue #94, shared here via `fsguard.rs`). When
/// `expected_fingerprint` is `Some` and `force` is `false`, `path` is
/// re-fingerprinted right before the write and compared; a mismatch aborts
/// with `stale: true, written: false` and touches nothing on disk. `force:
/// true` skips the check entirely — the retry path after the user
/// explicitly chooses to overwrite. `expected_fingerprint: None` also skips
/// the check: there is no prior on-disk baseline to compare against for an
/// untitled document's first save or a Save As to a brand-new path. On a
/// successful write, the fresh post-write fingerprint is returned so the
/// caller can use it as the baseline for the *next* save.
///
/// Like the streaming-replace guard this shares `fsguard.rs` with (#102),
/// the check narrows the race to the tiny stat-to-rename window rather
/// than eliminating it — no portable rename is conditional on file
/// identity — but that is a vast improvement over leaving the whole
/// open-to-save span unguarded.
// Flat parameters (rather than a grouped-struct argument) match every other
// command in this file, whose shape is dictated by the frontend's IPC call
// (src/ipc.ts `saveDocument`), not by ordinary Rust API ergonomics.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn save_document(
    path: String,
    content: String,
    encoding: String,
    with_bom: bool,
    line_ending: String,
    allow_lossy: bool,
    expected_fingerprint: Option<Fingerprint>,
    force: bool,
) -> Result<SaveResult, String> {
    let text = encoding::apply_line_ending(&content, &line_ending);
    let (bytes, unmappable) = encoding::encode(&text, &encoding, with_bom)?;
    if unmappable && !allow_lossy {
        // Scan `content` (the LF-normalized buffer as sent by the
        // frontend), never `text` (the line-ending-converted buffer just
        // encoded above) -- see `normalize::lossy_save_report`'s doc
        // comment for why a CR-converted buffer would silently break
        // position reporting.
        let lossy_report = normalize::lossy_save_report(&content, &encoding)?;
        return Ok(SaveResult {
            unmappable: true,
            written: false,
            stale: false,
            fingerprint: None,
            lossy_report: Some(lossy_report),
        });
    }
    let target = std::path::Path::new(&path);
    if !force {
        if let Some(expected) = &expected_fingerprint {
            if !expected.matches_path(target) {
                return Ok(SaveResult {
                    unmappable,
                    written: false,
                    stale: true,
                    fingerprint: None,
                    lossy_report: None,
                });
            }
        }
    }
    atomic_write(target, &bytes).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(SaveResult {
        unmappable,
        written: true,
        stale: false,
        fingerprint: Fingerprint::from_path(target).ok(),
        lossy_report: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // As early as possible: the startup probe measures from here.
    startup_probe::mark_process_start();
    startup_probe::checkpoint("run() entered");

    // Hoisted out of the final `.build(context)` call below so the
    // identifier is available before the `tauri::Builder` chain starts —
    // see the migration call immediately after this for why that matters.
    let context = tauri::generate_context!();

    // Must complete before any Tauri plugin's own setup runs — in
    // particular tauri-plugin-window-state's (registered a few lines
    // down): that plugin loads its on-disk cache (`.window-state.json`,
    // itself under app_config_dir()) as part of its *own* plugin setup,
    // which Tauri runs during `Builder::build()`, strictly before this
    // app's `.setup()` closure ever gets a chance to run. Migrating from
    // inside `.setup()` (the previous design) is therefore too late: any
    // `.window-state.json` this migrates in would already have been
    // missed by window-state's one-time cache load.
    //
    // The obvious-looking fix — move window-state's *registration* into
    // `.setup()`, after migration — doesn't work either: per
    // tauri 2.11.5's `fn setup()` (src/app.rs), windows declared in
    // `tauri.conf.json` are built *before* the app-level `.setup()`
    // closure runs, and a plugin's `on_window_ready` hook only fires for
    // windows created *after* that plugin is registered (see
    // `PluginStore::window_created`, `src/plugin.rs`) — a late
    // registration would silently never attach window-state to the main
    // window at all, breaking it far worse than the bug being fixed.
    //
    // Running the migration here, before `tauri::Builder` is even
    // constructed, sidesteps both problems: it's simply earlier than any
    // plugin setup or window creation. It's a synchronous, one-time cost
    // (every later launch is a completion-marker file check — see
    // migrate.rs — cheap enough to be a no-op in practice), so blocking
    // here on the one launch that actually does work is accepted; only a
    // *failure* additionally blocks on user interaction, via the dialog
    // shown from `.setup()` below once a `Dialog` is available to show it
    // with.
    let migration_result = migrate::run(&context.config().identifier);
    if let Err(e) = &migration_result {
        eprintln!("migrate: data migration failed: {e}");
    }
    startup_probe::checkpoint("migration completed");

    let builder = tauri::Builder::default();

    // On Windows and Linux, opening an associated file launches a second
    // process; forward its arguments to the running instance instead.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
        let paths = existing_paths_from_args(argv.into_iter());
        if !paths.is_empty() {
            let _ = app.emit("mojidori://open-files", paths);
        }
    }));

    // Restores window size/position across launches (desktop only).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // Auto-update (ROADMAP.md D2), desktop only (Windows/Linux/macOS) per
    // the plugin's own docs — same gate as tauri-plugin-window-state above.
    // The frontend drives the whole check/prompt/download/relaunch flow
    // (src/updater.ts) via raw `invoke("plugin:updater|...")` calls rather
    // than a Rust-side command, so registration here is all this plugin
    // needs; `tauri.conf.json`'s `plugins.updater` config (pubkey +
    // endpoints) supplies the rest.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Lets the updater flow (src/updater.ts) relaunch the app after
        // installing a downloaded update (ROADMAP.md D2).
        .plugin(tauri_plugin_process::init())
        .manage(PendingFiles(Mutex::new(existing_paths_from_args(
            std::env::args(),
        ))))
        .setup(move |app| {
            use tauri::Manager;
            // The migration itself already ran, above, before this
            // Builder chain even started — see the comment there. All
            // that's left here is surfacing a failure to the user, once
            // the app is far enough along to have a `Dialog` to show it
            // with.
            if let Err(e) = &migration_result {
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                // migrate::MigrationError distinguishes two very
                // different states of the user's data on disk (see its
                // own doc comment) — the message must match, since
                // telling someone their old data is untouched when it's
                // actually already been moved would be actively
                // misleading, not just imprecise.
                let message = match e {
                    migrate::MigrationError::NotStarted(msg) => format!(
                        "Mojidori couldn't automatically bring over your settings, \
                         session, and backups from the previous install ({msg}). \
                         Your old data has not been modified or deleted; the app \
                         will start fresh. See the application log for details."
                    ),
                    migrate::MigrationError::ConfirmationFailed(msg) => format!(
                        "Mojidori brought over your settings, session, and backups \
                         from the previous install, but couldn't confirm that move \
                         was fully saved to disk ({msg}). Your data is already in \
                         its new location — nothing was lost. The app will \
                         automatically finish confirming this on the next launch. \
                         See the application log for details."
                    ),
                };
                app.dialog()
                    .message(message)
                    .title("Mojidori")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            let state = watcher::init(app.handle().clone())?;
            app.manage(state);
            // Built in setup (not Builder::menu) because the menu reads
            // preferences via app.path(), which is unavailable until the
            // path resolver state is managed.
            app.set_menu(menu::build(app.handle())?)?;
            startup_probe::checkpoint("setup() completed");
            Ok(())
        })
        .on_page_load(|_window, payload| {
            use tauri::webview::PageLoadEvent;
            match payload.event() {
                PageLoadEvent::Started => startup_probe::checkpoint("on_page_load: Started"),
                PageLoadEvent::Finished => startup_probe::checkpoint("on_page_load: Finished"),
            }
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("mojidori://menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            explain_detection,
            docinfo::document_metadata,
            docinfo::line_ending_distribution,
            docinfo::document_info_snapshot,
            save_document,
            bytedrift::check_byte_drift,
            session::load_session,
            session::save_session,
            prefs::load_preferences,
            prefs::save_preferences,
            menu::sync_theme_menu,
            menu::sync_read_only_menu,
            menu::sync_reopen_closed_tab_menu,
            menu::sync_clear_recent_menu,
            menu::retitle_menu,
            menu::palette_commands,
            take_pending_files,
            print_window,
            chunk::read_document_chunk,
            chunk::read_document_chunk_before,
            lineindex::build_line_index,
            lineindex::locate_line_offset,
            watcher::watch_file,
            watcher::unwatch_file,
            recent::load_recent_files,
            recent::add_recent_file,
            recent::clear_recent_files,
            search::search_in_folder,
            replaceinfiles::scan_replace_in_folder,
            replaceinfiles::execute_replace_in_folder,
            backup::save_backup,
            backup::load_backup,
            backup::delete_backup,
            backup::list_backups,
            hexdump::read_hex_dump,
            mojibake::detect_mojibake,
            mojibake::apply_mojibake_repair,
            batch::scan_batch_conversion,
            batch::execute_batch_conversion,
            comparepreview::preview_two_encodings,
            streamreplace::stream_replace_in_file,
            streamconvert::stream_convert_file,
            charinspect::encode_char,
            normalize::check_representable,
            openfile_probe::openfile_probe_path,
            openfile_probe::report_openfile_ready,
            startup_probe::report_startup_ready
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers associated files through Apple Events; they can
            // arrive before the frontend is listening, so they are queued in
            // PendingFiles as well as emitted.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::Manager;
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    _app.state::<PendingFiles>()
                        .0
                        .lock()
                        .unwrap()
                        .extend(paths.clone());
                    let _ = _app.emit("mojidori://open-files", paths);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, existing_paths_from_args, explain_detection, open_document, preview_slice,
        save_document, tmp_candidate_path, Fingerprint, EXPLAIN_SAMPLE_BYTES, LARGE_FILE_THRESHOLD,
        PREVIEW_BYTES,
    };
    // Only the unix-gated symlink test uses this; an unconditional import
    // is an unused-import error under -D warnings on Windows.
    #[cfg(unix)]
    use super::open_exclusive;

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join("mojidori-atomic-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        atomic_write(&target, b"first version").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first version");
        atomic_write(&target, "第二版 with 中文".as_bytes()).unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            "第二版 with 中文".as_bytes()
        );

        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("mojidori-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp files may remain");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301 — the core regression: saving through a symlink must
    /// update the file the link points to and leave the link itself
    /// exactly as it was, never replace the link with a regular file.
    /// Windows symlink creation needs an elevated privilege or developer
    /// mode that CI does not reliably have, so this whole family is
    /// `#[cfg(unix)]`; the non-symlink path this same function handles is
    /// still exercised on every platform by the tests around it.
    #[cfg(unix)]
    #[test]
    fn atomic_write_through_symlink_updates_target_and_preserves_link() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-atomic-symlink-basic");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let target = dir.join("target.txt");
        std::fs::write(&target, b"original target content").unwrap();
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();

        atomic_write(&link, b"saved through the link").unwrap();

        let link_meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(
            link_meta.file_type().is_symlink(),
            "the link path must still be a symlink after save, not a regular file"
        );
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            target,
            "the link must still point at the same target"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"saved through the link",
            "the target's content must be the newly saved bytes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301 — a dangling symlink (target does not exist yet) must
    /// not be an error: the write lands at the link's target path,
    /// creating it, and the link ends up pointing at something real
    /// instead of dangling. `resolve_symlink_target`'s doc comment is the
    /// reasoning for why this is preferred over `canonicalize`, which
    /// would simply fail here.
    #[cfg(unix)]
    #[test]
    fn atomic_write_through_dangling_symlink_heals_target() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-atomic-symlink-dangling");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let target = dir.join("not-yet-created.txt");
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();
        assert!(
            std::fs::metadata(&link).is_err(),
            "sanity check: the link must actually be dangling before the save"
        );

        atomic_write(&link, b"resurrected content").unwrap();

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must still be a symlink, not a regular file"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"resurrected content",
            "the target must now exist with the saved content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301 — a multi-hop chain (`link -> mid -> target`) must
    /// resolve all the way to the real file: only `target` receives the
    /// new content, and every link in the chain — including the
    /// intermediate one — stays a symlink, untouched.
    #[cfg(unix)]
    #[test]
    fn atomic_write_through_multi_hop_symlink_chain_resolves_to_final_target() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-atomic-symlink-chain");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let target = dir.join("target.txt");
        std::fs::write(&target, b"original").unwrap();
        let mid = dir.join("mid.txt");
        symlink(&target, &mid).unwrap();
        let link = dir.join("link.txt");
        symlink(&mid, &link).unwrap();

        atomic_write(&link, b"multi-hop save").unwrap();

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(&mid)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), mid);
        assert_eq!(std::fs::read_link(&mid).unwrap(), target);
        assert_eq!(std::fs::read(&target).unwrap(), b"multi-hop save");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301 — a self-referential symlink chain must fail closed with
    /// a clear error instead of looping forever or overflowing the stack.
    #[cfg(unix)]
    #[test]
    fn atomic_write_through_symlink_cycle_fails_cleanly() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-atomic-symlink-cycle");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        symlink(&b, &a).unwrap();
        symlink(&a, &b).unwrap();

        let result = atomic_write(&a, b"never written");
        assert!(result.is_err(), "a cyclic symlink chain must be rejected");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("mojidori-atomic-perms");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("script.sh");

        std::fs::write(&target, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        atomic_write(&target, b"#!/bin/sh\necho updated\n").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_fails_cleanly_on_missing_directory() {
        let target = std::env::temp_dir()
            .join("mojidori-no-such-dir")
            .join("nested")
            .join("doc.txt");
        assert!(atomic_write(&target, b"x").is_err());
    }

    /// Issue #60, layer 1 — attack the public `atomic_write` behavior
    /// directly. Before the fix, `atomic_write` built its temp file path
    /// from only the target file name and process id
    /// (`.{file_name}.mojidori-tmp-{pid}`), then opened it with
    /// `File::create`, which follows symlinks. A local attacker who can
    /// write into the save directory could pre-plant a symlink at that
    /// exact, guessable path pointing at any other file they can write
    /// (`victim.txt` here), and `atomic_write` would write the new
    /// document's bytes straight through the symlink into the victim
    /// file, then `rename` the symlink itself over the real save target —
    /// a successful-looking save that silently clobbered an unrelated
    /// file. This test pre-plants that exact symlink and asserts the
    /// victim's content survives the save untouched. Against the
    /// unfixed implementation this assertion fails (the victim is
    /// overwritten with the new document's bytes) — that is the
    /// failing-test-first red. After the fix this passes because
    /// `atomic_write` never reuses that predictable name; the
    /// exclusive-create guarantee that also protects a name collision is
    /// locked separately by `tmp_file_creation_refuses_preexisting_symlink`.
    #[cfg(unix)]
    #[test]
    fn atomic_write_refuses_preplanted_symlink_at_predictable_tmp_path() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-atomic-symlink-attack");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"victim data").unwrap();

        let target = dir.join("doc.txt");
        // The predictable temp path the pre-fix implementation used:
        // `.{file_name}.mojidori-tmp-{pid}`, no randomness at all.
        let legacy_tmp_path = dir.join(format!(".doc.txt.mojidori-tmp-{}", std::process::id()));
        symlink(&victim, &legacy_tmp_path).unwrap();

        let save_result = atomic_write(&target, b"attacker-controlled new content");

        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"victim data",
            "atomic_write must never write through a pre-planted symlink at a \
             predictable temp path onto an unrelated file"
        );
        assert!(
            save_result.is_ok(),
            "the save itself must still succeed, via an unpredictable candidate \
             that the attacker could not have pre-occupied"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"attacker-controlled new content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #60, layer 2 — the unit-level guarantee that actually closes
    /// the hole: opening a temp-file candidate must refuse to follow a
    /// symlink already sitting at that path, rather than silently writing
    /// through it. This is the same open call `create_tmp_exclusive` uses
    /// for every candidate.
    #[cfg(unix)]
    #[test]
    fn tmp_file_creation_refuses_preexisting_symlink() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-open-exclusive-symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"victim data").unwrap();
        let candidate = dir.join("preplanted-link");
        symlink(&victim, &candidate).unwrap();

        match open_exclusive(&candidate) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            other => panic!(
                "expected Err(AlreadyExists) for a path already occupied by a \
                 symlink, got {other:?}"
            ),
        }
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"victim data",
            "the symlink must not have been followed — victim content must be untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #60: two candidate names generated back-to-back for the same
    /// (dir, file_name) must differ (the counter component guarantees it).
    /// This locks uniqueness only — safety against a pre-planted path does
    /// not rest on name entropy but on `open_exclusive` refusing to open
    /// anything that already exists.
    #[test]
    fn tmp_candidates_are_unique() {
        let dir = std::env::temp_dir().join("mojidori-tmp-candidate-uniqueness");
        let first = tmp_candidate_path(&dir, "doc.txt");
        let second = tmp_candidate_path(&dir, "doc.txt");
        assert_ne!(
            first, second,
            "consecutive candidates for the same (dir, file_name) must differ"
        );
    }

    #[test]
    fn preview_slice_cuts_at_line_boundary() {
        let bytes = b"line one\nline two\nline three";
        let slice = preview_slice(bytes, 12, None);
        assert_eq!(slice, b"line one\n");
        // No newline within the budget: keep the raw slice.
        let slice = preview_slice(b"abcdefgh", 4, None);
        assert_eq!(slice, b"abcd");
        // Small files pass through whole.
        let slice = preview_slice(b"tiny\n", 100, None);
        assert_eq!(slice, b"tiny\n");
    }

    /// Issue #61 regression lock: the `None` path (non-UTF-16 preview
    /// cutting) must behave exactly as it did before the UTF-16 fix —
    /// including for multi-byte UTF-8 content, which
    /// `preview_slice_cuts_at_line_boundary` above does not exercise. UTF-8
    /// continuation and lead bytes are always >= 0x80, so a raw `0x0A`
    /// search never lands inside a multi-byte sequence; this pins that
    /// invariant stays true after adding the `utf16` parameter.
    #[test]
    fn preview_slice_plain_utf8_behavior_unchanged() {
        let bytes = "第一行\n第二行\n第三行".as_bytes();
        let cut_after_first_line = "第一行\n".len();
        let slice = preview_slice(bytes, cut_after_first_line + 2, None);
        assert_eq!(slice, "第一行\n".as_bytes());

        let slice = preview_slice(b"abcdefgh", 4, None);
        assert_eq!(slice, b"abcd");

        let slice = preview_slice(b"tiny\n", 100, None);
        assert_eq!(slice, b"tiny\n");
    }

    /// Issue #61. UTF-16LE's LF is the two-byte code unit `0A 00`; a raw
    /// `0x0A` search (the `None` path) finds the low byte but
    /// `slice[..=pos]` then excludes the high byte right after it, always
    /// producing an odd-length cut whenever a newline is found at all —
    /// this is not a rare edge case, it is what happens on essentially
    /// every real UTF-16LE large-file preview. `max=37` here lands exactly
    /// one byte past the third newline's `0x0A` and one byte before its
    /// `0x00` partner. Before the fix this test is red: the unmodified
    /// raw-byte search returns all 37 bytes (odd length, a dangling
    /// `0x0A`). After the fix it must fall back to the last *complete*
    /// pair reachable in the even-rounded window (end of "line2\n" at
    /// offset 24) rather than keep a split code unit.
    #[test]
    fn preview_slice_utf16le_cuts_at_code_unit_newline() {
        let text = "line1\nline2\nline3\nline4\n";
        let (bytes, _) = crate::encoding::encode(text, "UTF-16LE", true).unwrap();
        assert_eq!(
            bytes.len(),
            50,
            "fixture byte layout must match the offsets this test hand-verifies"
        );

        let slice = preview_slice(&bytes, 37, Some(crate::encoding::Utf16Variant::Le));

        assert_eq!(slice, &bytes[..26]);
        assert_eq!(
            slice.len() % 2,
            0,
            "utf16 preview slice must be even-length"
        );
        assert_eq!(
            &slice[slice.len() - 2..],
            &[0x0A, 0x00],
            "must end on a full LE newline code unit, never split"
        );
    }

    /// Issue #61. No newline anywhere in the UTF-16LE window: the fixed
    /// function must still fall back to an even-length slice
    /// (`max & !1`), not the raw `max` byte count. Before the fix, the
    /// unmodified raw-byte search also finds no `0x0A` match and returns
    /// the odd-length raw slice unchanged (`max` itself is chosen odd
    /// here specifically so the two fallbacks disagree).
    #[test]
    fn preview_slice_utf16le_no_newline_falls_back_even() {
        let text = "abcdefghij".repeat(20); // no '\n' anywhere
        let (bytes, _) = crate::encoding::encode(&text, "UTF-16LE", true).unwrap();
        assert!(bytes.len() > 101);

        let slice = preview_slice(&bytes, 101, Some(crate::encoding::Utf16Variant::Le));

        assert_eq!(
            slice.len(),
            100,
            "an odd max must round down to an even length"
        );
        assert_eq!(slice, &bytes[..100]);
    }

    /// Issue #61, adversarial-review follow-up: the no-newline even-length
    /// fallback is code-unit aligned but could still split a *surrogate
    /// pair* (a 4-byte character), leaving a dangling high surrogate that
    /// decodes as U+FFFD and re-creates the exact false malformed warning
    /// this fix exists to remove. Three emoji (4 bytes each in UTF-16)
    /// after a 2-byte BOM put every pair boundary at `offset % 4 == 2`, so
    /// an even cut at 8 lands mid-emoji — the fallback must retreat to 6.
    #[test]
    fn preview_slice_utf16_no_newline_never_splits_surrogate_pair() {
        let (bytes, _) = crate::encoding::encode("🚀🚀🚀", "UTF-16LE", true).unwrap();
        assert_eq!(bytes.len(), 14, "BOM(2) + 3 × 4-byte emoji");
        let slice = preview_slice(&bytes, 8, Some(crate::encoding::Utf16Variant::Le));
        assert_eq!(
            slice.len(),
            6,
            "must retreat past the dangling high surrogate"
        );
        let decoded = crate::encoding::decode_with(slice, "UTF-16LE").unwrap();
        assert!(!decoded.malformed);

        let (bytes, _) = crate::encoding::encode("🚀🚀🚀", "UTF-16BE", true).unwrap();
        let slice = preview_slice(&bytes, 8, Some(crate::encoding::Utf16Variant::Be));
        assert_eq!(slice.len(), 6, "BE mirror must retreat identically");
        let decoded = crate::encoding::decode_with(slice, "UTF-16BE").unwrap();
        assert!(!decoded.malformed);
    }

    /// Issue #61, BE counterpart of
    /// `preview_slice_utf16le_cuts_at_code_unit_newline`: UTF-16BE's LF is
    /// `00 0A`, and the fix must cut on the same code-unit-aligned pair
    /// search mirrored for the opposite byte order.
    #[test]
    fn preview_slice_utf16be_cuts_at_code_unit_newline() {
        let text = "line1\nline2\nline3\nline4\n";
        let (bytes, _) = crate::encoding::encode(text, "UTF-16BE", true).unwrap();
        assert_eq!(
            bytes.len(),
            50,
            "fixture byte layout must match the offsets this test hand-verifies"
        );

        let slice = preview_slice(&bytes, 37, Some(crate::encoding::Utf16Variant::Be));

        assert_eq!(slice, &bytes[..26]);
        assert_eq!(
            slice.len() % 2,
            0,
            "utf16 preview slice must be even-length"
        );
        assert_eq!(
            &slice[slice.len() - 2..],
            &[0x00, 0x0A],
            "must end on a full BE newline code unit, never split"
        );
    }

    #[test]
    fn filters_args_to_existing_files() {
        let file = std::env::temp_dir().join("mojidori-args-test.txt");
        std::fs::write(&file, "x").unwrap();
        let args = vec![
            "mojidori".to_string(),
            "--flag".to_string(),
            "/no/such/file.txt".to_string(),
            file.to_string_lossy().into_owned(),
        ];
        let paths = existing_paths_from_args(args.into_iter());
        assert_eq!(paths, vec![file.to_string_lossy().into_owned()]);
        std::fs::remove_file(&file).ok();
    }

    /// Pull the encoding name out of a `"{encoding} ({reason})"` would-choose
    /// string, mirroring the parsing the frontend does.
    fn would_choose_encoding(would_choose: &str) -> &str {
        would_choose.split(" (").next().unwrap_or(would_choose)
    }

    /// `explain_detection`'s `wouldChoose` must agree with what
    /// `open_document`'s auto-detection actually picks, for every scenario
    /// the diagnostics popup is meant to explain — including when both are
    /// given the same per-extension encoding hint. All fixtures here are
    /// well under the 64 KB sample cap, so the sample is the whole file and
    /// the two commands see identical bytes.
    fn assert_explain_matches_open_with_ext(
        bytes: &[u8],
        dir_name: &str,
        ext_encoding: Option<&str>,
    ) {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let path = file.to_string_lossy().into_owned();
        let ext = ext_encoding.map(str::to_string);

        let opened = open_document(path.clone(), None, ext.clone()).unwrap();
        let explained = explain_detection(path, ext).unwrap();

        assert_eq!(
            would_choose_encoding(&explained.would_choose),
            opened.encoding,
            "explain_detection and open_document disagree for {dir_name}"
        );
        assert_eq!(explained.sampled_bytes, bytes.len());
        assert_eq!(explained.total_size, bytes.len() as u64);
        // Issue #201: every fixture this helper exercises is well under
        // LARGE_FILE_THRESHOLD, so none of them is the large-file-preview
        // scenario the new flag exists to call out.
        assert!(
            !explained.large_file_preview,
            "a small fixture must not be flagged as a large-file-preview sample for {dir_name}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    fn assert_explain_matches_open(bytes: &[u8], dir_name: &str) {
        assert_explain_matches_open_with_ext(bytes, dir_name, None);
    }

    #[test]
    fn explain_detection_agrees_with_open_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_explain_matches_open(&bytes, "mojidori-explain-utf8-bom");

        let dir = std::env::temp_dir().join("mojidori-explain-utf8-bom-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom.as_deref(), Some("UTF-8 BOM (EF BB BF)"));
        assert!(explained.would_choose.ends_with("(bom)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_agrees_with_open_utf16le_bom() {
        let (bytes, _) = crate::encoding::encode("hi", "UTF-16LE", true).unwrap();
        assert_explain_matches_open(&bytes, "mojidori-explain-utf16le-bom");
    }

    #[test]
    fn explain_detection_agrees_with_open_plain_ascii() {
        let bytes = b"hello world, this is plain ascii text with no accents";
        assert_explain_matches_open(bytes, "mojidori-explain-ascii");

        let dir = std::env::temp_dir().join("mojidori-explain-ascii-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, bytes).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom, None);
        assert!(explained.would_choose.ends_with("(detector)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_agrees_with_open_big5_sample() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert_explain_matches_open(&bytes, "mojidori-explain-big5");
    }

    #[test]
    fn explain_detection_agrees_with_open_empty_file() {
        assert_explain_matches_open(&[], "mojidori-explain-empty");

        let dir = std::env::temp_dir().join("mojidori-explain-empty-evidence");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, []).unwrap();
        let explained = explain_detection(file.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(explained.bom, None);
        assert!(explained.would_choose.ends_with("(fallback)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn explain_detection_reports_missing_file_as_error() {
        let path = std::env::temp_dir()
            .join("mojidori-explain-does-not-exist.txt")
            .to_string_lossy()
            .into_owned();
        assert!(explain_detection(path, None).is_err());
    }

    /// With a per-extension hint, the diagnostics command and the open
    /// command must still agree — both when the hint is honored (Big5
    /// bytes, Big5 hint) and when it is rejected (UTF-8 bytes, Big5 hint).
    #[test]
    fn explain_detection_agrees_with_open_under_extension_hint() {
        let text =
            "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";
        let (big5_bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert_explain_matches_open_with_ext(
            &big5_bytes,
            "mojidori-explain-ext-big5",
            Some("Big5"),
        );
        assert_explain_matches_open_with_ext(
            text.as_bytes(),
            "mojidori-explain-ext-utf8-mismatch",
            Some("Big5"),
        );
        // Short valid UTF-8 that is byte-valid as Big5 (the UTF-8 gate
        // case): both commands must agree it stays UTF-8.
        assert_explain_matches_open_with_ext(
            "測試".as_bytes(),
            "mojidori-explain-ext-short-utf8",
            Some("Big5"),
        );
        // BOM still wins over the hint at the command level too.
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        assert_explain_matches_open_with_ext(&bytes, "mojidori-explain-ext-bom", Some("Big5"));
    }

    /// Issue #47: an even-length, pure-ASCII sample with a UTF-16
    /// extension hint must be rejected by both commands identically.
    /// `explain_detection` and `open_document` share `detect_with_extension`
    /// so they are consistent by construction, but this locks the new
    /// branch the same way `explain_detection_agrees_with_open_under_extension_hint`
    /// locks the existing ones — a regression that made the two commands
    /// call the guard differently would show up here even though the
    /// hijack itself is covered directly in `encoding.rs`.
    #[test]
    fn explain_detection_agrees_with_open_under_utf16_extension_hint() {
        assert_explain_matches_open_with_ext(
            b"ab\ncd\n",
            "mojidori-explain-ext-utf16-ascii",
            Some("UTF-16LE"),
        );
    }

    /// End-to-end round trip through the real commands and the disk, with a
    /// per-extension preference in play: a Big5 .txt file opened with a
    /// Big5 extension hint, saved, and reopened must keep both its content
    /// and its Big5 encoding byte-for-byte.
    #[test]
    fn open_save_reopen_round_trips_big5_via_extension_hint() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。\n第二行內容。\n";
        let (original_bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);

        let dir = std::env::temp_dir().join("mojidori-ext-roundtrip-big5");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, &original_bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, Some("Big5".into())).unwrap();
        assert_eq!(opened.encoding, "Big5");
        assert_eq!(opened.content, text);
        assert!(!opened.malformed);
        assert_eq!(opened.line_ending, "LF");

        let saved = save_document(
            path.clone(),
            opened.content.clone(),
            opened.encoding.clone(),
            opened.had_bom,
            opened.line_ending.clone(),
            false,
            None,
            false,
        )
        .unwrap();
        assert!(!saved.unmappable);
        assert!(saved.written);
        assert_eq!(std::fs::read(&file).unwrap(), original_bytes);

        let reopened = open_document(path, None, Some("Big5".into())).unwrap();
        assert_eq!(reopened.encoding, "Big5");
        assert_eq!(reopened.content, text);
        assert!(!reopened.malformed);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The mirror-image safety case on disk: a legitimate multi-byte UTF-8
    /// .txt file must not be opened as Big5 mojibake just because the
    /// user's extension table says .txt = Big5. It opens clean as UTF-8 and
    /// survives a save/reopen cycle unchanged.
    #[test]
    fn open_save_reopen_keeps_utf8_despite_wrong_extension_hint() {
        let text = "中文編碼偵測測試，這是繁體中文範例文字。\n";
        let original_bytes = text.as_bytes().to_vec();

        let dir = std::env::temp_dir().join("mojidori-ext-roundtrip-utf8-mismatch");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, &original_bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, Some("Big5".into())).unwrap();
        assert_eq!(opened.encoding, "UTF-8");
        assert_eq!(opened.content, text);
        assert!(!opened.malformed);

        let saved = save_document(
            path.clone(),
            opened.content.clone(),
            opened.encoding.clone(),
            opened.had_bom,
            opened.line_ending.clone(),
            false,
            None,
            false,
        )
        .unwrap();
        assert!(!saved.unmappable);
        assert!(saved.written);
        assert_eq!(std::fs::read(&file).unwrap(), original_bytes);

        let reopened = open_document(path, None, Some("Big5".into())).unwrap();
        assert_eq!(reopened.encoding, "UTF-8");
        assert_eq!(reopened.content, text);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #64: saving content with characters unmappable in the target
    /// encoding must never touch disk until the caller opts in via
    /// `allow_lossy`. This is the core data-integrity assertion — comparing
    /// the bytes on disk to the pre-save original, not just checking the
    /// return value.
    #[test]
    fn save_document_refuses_lossy_write_without_consent() {
        let dir = std::env::temp_dir().join("mojidori-save-lossy-refuse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        let original = "hello 🚀 世界".as_bytes().to_vec();
        std::fs::write(&target, &original).unwrap();
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "hello 🚀 世界".to_string(),
            "Big5".to_string(),
            false,
            "LF".to_string(),
            false,
            None,
            false,
        )
        .unwrap();

        assert!(result.unmappable);
        assert!(!result.written);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            original,
            "refused save must leave the original bytes on disk untouched"
        );

        // ROADMAP.md v0.4 Track A "Lossy-save character preview": the
        // rejection must name *which* character can't be encoded and
        // *where* (Ln:Col), not just that some can't. "hello 🚀 世界" -- 世
        // and 界 are ordinary Big5-representable Traditional Chinese
        // characters; only the emoji is the problem, at its 1-based column
        // (h-e-l-l-o-space-🚀 = column 7).
        let report = result
            .lossy_report
            .expect("lossy rejection must carry a report");
        assert_eq!(report.unmappable_count, 1);
        assert_eq!(
            report.samples,
            vec![crate::normalize::UnmappableSample {
                display: "🚀 (U+1F680)".to_string(),
                line: 1,
                column: 7,
            }]
        );
        assert!(!report.samples_truncated);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Failing-test-first target (ROADMAP.md v0.4 Track A "Lossy-save
    /// character preview"): position must be computed against the
    /// LF-normalized `content` the frontend sent, never the
    /// line-ending-converted buffer `encoding::encode` actually writes.
    /// `line_ending: "CR"` is the sharpest regression case -- a CR-only
    /// converted buffer has no `\n` at all (`encoding::apply_line_ending`
    /// replaces every `\n` with a bare `\r`), so an implementation that
    /// mistakenly scanned the converted buffer instead of `content` would
    /// see zero line breaks and report every line as line 1. The
    /// unmappable character sits on the second of three lines here, so a
    /// correct implementation must still report `line: 2`.
    #[test]
    fn save_document_lossy_report_uses_lf_buffer_positions_regardless_of_line_ending() {
        let dir = std::env::temp_dir().join("mojidori-save-lossy-cr-position");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"placeholder").unwrap();
        let path = target.to_string_lossy().into_owned();

        let content = "line one\nline two \u{1F680}\nline three".to_string();
        let result = save_document(
            path,
            content,
            "Big5".to_string(),
            false,
            "CR".to_string(),
            false,
            None,
            false,
        )
        .unwrap();

        assert!(result.unmappable);
        assert!(!result.written);
        let report = result
            .lossy_report
            .expect("lossy rejection must carry a report");
        assert_eq!(report.unmappable_count, 1, "{report:?}");
        assert_eq!(
            report.samples,
            vec![crate::normalize::UnmappableSample {
                display: "\u{1F680} (U+1F680)".to_string(),
                line: 2,
                column: 10,
            }],
            "position must reflect the LF-normalized buffer, not the CR-converted save buffer"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `stale` rejection (issue #113's fingerprint guard) only happens on
    /// a retry that already passed `allow_lossy: true`, so the frontend
    /// never needs a fresh lossy sample list there -- `lossy_report` stays
    /// `None` even though `unmappable` itself is still computed and may be
    /// true.
    #[test]
    fn save_document_stale_rejection_has_no_lossy_report() {
        let dir = std::env::temp_dir().join("mojidori-save-lossy-stale-no-report");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original").unwrap();
        let path = target.to_string_lossy().into_owned();

        // A fingerprint that can never match anything currently on disk --
        // stands in for "the file changed since this baseline was taken".
        let stale_fingerprint = Fingerprint::from_path(&target).unwrap();
        std::fs::write(&target, b"changed on disk by someone else").unwrap();

        let result = save_document(
            path,
            "hello \u{1F680} world".to_string(),
            "Big5".to_string(),
            false,
            "LF".to_string(),
            true, // already consented to lossy, as the frontend's stale retry does
            Some(stale_fingerprint),
            false,
        )
        .unwrap();

        assert!(result.stale);
        assert!(!result.written);
        assert!(
            result.lossy_report.is_none(),
            "a stale rejection must not carry a lossy report"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A successful UTF-8 save is never unmappable in the first place, so
    /// `lossy_report` must stay `None` on the ordinary happy path -- it
    /// should never spuriously populate outside the one rejection branch.
    #[test]
    fn save_document_successful_utf8_save_has_no_lossy_report() {
        let dir = std::env::temp_dir().join("mojidori-save-lossy-utf8-happy-path");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "hello \u{1F680} world".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            None,
            false,
        )
        .unwrap();

        assert!(!result.unmappable);
        assert!(result.written);
        assert!(result.lossy_report.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The consenting counterpart: once the caller re-invokes with
    /// `allow_lossy: true`, the write proceeds and the bytes on disk become
    /// the lossy Big5 encoding of the content.
    #[test]
    fn save_document_writes_lossy_with_consent() {
        let dir = std::env::temp_dir().join("mojidori-save-lossy-consent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");

        let original = "hello 🚀 世界".as_bytes().to_vec();
        std::fs::write(&target, &original).unwrap();
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "hello 🚀 世界".to_string(),
            "Big5".to_string(),
            false,
            "LF".to_string(),
            true,
            None,
            false,
        )
        .unwrap();

        assert!(result.unmappable);
        assert!(result.written);
        let on_disk = std::fs::read(&target).unwrap();
        assert_ne!(on_disk, original);
        let (expected_bytes, unmappable) =
            crate::encoding::encode("hello 🚀 世界", "Big5", false).unwrap();
        assert!(unmappable);
        assert_eq!(on_disk, expected_bytes);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #113 core regression (P1 data loss): the plain Save path had
    /// no guard at all against another process writing to the same path
    /// between when the editor's snapshot was taken (here, the
    /// `open_document` that produced `expected_fingerprint`) and this
    /// command's own commit. This drives the real end-to-end sequence the
    /// issue describes — open, external atomic replace, then Save with the
    /// now-stale fingerprint — and pins both halves of the fix: the call
    /// reports `stale: true, written: false`, *and* the externally-written
    /// content is byte-for-byte untouched on disk afterward. The external
    /// write uses different-length content so the size field alone
    /// guarantees detection, independent of filesystem mtime resolution or
    /// of `std::fs::write`'s reuse of the same inode for a same-path
    /// rewrite (see `fsguard.rs`'s own
    /// `matches_path_false_after_size_change`).
    #[test]
    fn save_document_rejects_stale_fingerprint_and_preserves_external_write() {
        let dir = std::env::temp_dir().join("mojidori-save-stale-fingerprint-reject");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content on disk").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();
        let expected_fingerprint = opened.fingerprint;
        assert!(
            expected_fingerprint.is_some(),
            "opening a real file must yield a verifiable fingerprint"
        );

        // Another process (or a second Mojidori window) replaces the file's
        // content while this editor's tab still holds the old snapshot.
        let external_content = b"externally written, much newer and longer content";
        std::fs::write(&target, external_content).unwrap();

        let result = save_document(
            path,
            "editor's stale in-memory buffer content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            expected_fingerprint,
            false,
        )
        .unwrap();

        assert!(result.stale, "a changed file must be reported stale");
        assert!(!result.written, "a stale save must not write anything");
        assert!(result.fingerprint.is_none());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            external_content,
            "the externally-written content must survive completely untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The happy-path counterpart: when nothing external touched the file
    /// between open and save, the matching fingerprint must not block the
    /// write, and the response carries a fresh fingerprint the caller can
    /// use as the next save's baseline.
    #[test]
    fn save_document_succeeds_when_fingerprint_matches() {
        let dir = std::env::temp_dir().join("mojidori-save-fingerprint-matches");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();

        let result = save_document(
            path,
            "freshly edited content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            opened.fingerprint,
            false,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert!(
            result.fingerprint.is_some(),
            "a successful write must return a fresh fingerprint"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "freshly edited content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #301, full-stack regression: `open_document` and
    /// `save_document` both operate on the *symlink* path a user actually
    /// has open (never the resolved target), so this exercises exactly
    /// the reported bug end to end. `open_document`'s `metadata`/`read`
    /// and `Fingerprint::from_path`'s `metadata` both already follow the
    /// link (unchanged by this fix), and `atomic_write` now writes through
    /// it too — so the fingerprint baseline `open_document` hands back
    /// stays valid for a second save via the same link path, proving the
    /// fingerprint/link interaction stays consistent across a save, not
    /// just that the first save doesn't corrupt the link.
    #[cfg(unix)]
    #[test]
    fn save_document_through_symlink_preserves_link_and_keeps_fingerprint_valid() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("mojidori-save-through-symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let target = dir.join("target.txt");
        std::fs::write(&target, b"original target content").unwrap();
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();
        let link_path = link.to_string_lossy().into_owned();

        let opened = open_document(link_path.clone(), None, None).unwrap();
        assert_eq!(
            opened.content, "original target content",
            "opening the link must read the target's bytes"
        );

        let result = save_document(
            link_path.clone(),
            "edited through the link".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            opened.fingerprint,
            false,
        )
        .unwrap();

        assert!(
            !result.stale,
            "the link's own fingerprint must not misreport staleness"
        );
        assert!(result.written);
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must survive the save as a symlink"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "edited through the link",
            "the target file must hold the newly saved content"
        );

        // The fingerprint this save returned must still be a valid
        // baseline for a second save through the same link path — proof
        // that the fingerprint/link interaction is consistent across
        // saves, not just that a single save avoided corruption.
        let second = save_document(
            link_path,
            "edited a second time".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            result.fingerprint,
            false,
        )
        .unwrap();
        assert!(
            !second.stale,
            "the fresh fingerprint must match on the next save"
        );
        assert!(second.written);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "edited a second time"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `force: true` is the Overwrite retry path: even against a fingerprint
    /// that no longer matches (the same external-replace scenario as
    /// `save_document_rejects_stale_fingerprint_and_preserves_external_write`),
    /// the caller's explicit choice to overwrite must go through.
    #[test]
    fn save_document_force_overwrites_despite_stale_fingerprint() {
        let dir = std::env::temp_dir().join("mojidori-save-force-overwrite");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("doc.txt");
        std::fs::write(&target, b"original content on disk").unwrap();
        let path = target.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), None, None).unwrap();
        std::fs::write(
            &target,
            b"externally written, much newer and longer content",
        )
        .unwrap();

        let result = save_document(
            path,
            "user explicitly chose to overwrite".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            opened.fingerprint,
            true,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "user explicitly chose to overwrite"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `expected_fingerprint: None` is the untitled-first-save / Save As
    /// path: there is no prior on-disk baseline to compare against (the
    /// document was never opened from this path), so the check must be
    /// skipped entirely rather than failing closed on a `None` that was
    /// never a real mismatch.
    #[test]
    fn save_document_skips_check_when_no_expected_fingerprint() {
        let dir = std::env::temp_dir().join("mojidori-save-no-expected-fingerprint");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("new-doc.txt");
        let path = target.to_string_lossy().into_owned();

        let result = save_document(
            path,
            "brand new untitled content".to_string(),
            "UTF-8".to_string(),
            false,
            "LF".to_string(),
            false,
            None,
            false,
        )
        .unwrap();

        assert!(!result.stale);
        assert!(result.written);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "brand new untitled content"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Build a large-file fixture: `n` lines of `"line {i}\n"`, generated
    /// in one pass and written to disk in a single `std::fs::write` call
    /// (not line-by-line), so fixture setup itself stays fast. Returns the
    /// file path and the exact bytes written, so a test can compute an
    /// expected value from the same content without a second disk read.
    fn write_line_fixture(dir_name: &str, n: u32) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.txt");
        let data: String = (0..n).map(|i| format!("line {i}\n")).collect();
        std::fs::write(&file, data.as_bytes()).unwrap();
        (file, data)
    }

    /// Issue #59. Memory usage cannot be observed from a unit test, so this
    /// pins the *behavior* the bounded read must produce instead of the
    /// bound itself: for a file over `LARGE_FILE_THRESHOLD`, `open_document`
    /// reports `truncated`, the returned content never exceeds
    /// `PREVIEW_BYTES` on the wire, `next_offset` is a *byte* offset that
    /// matches the content's own UTF-8 byte length exactly (large-file
    /// offsets are bytes, never chars — see judgment-overlay.md), and
    /// `total_size` reports the real file size. The sharper regression
    /// lock against the pre-fix full-read code path — the one that would
    /// actually catch an off-by-one in the bounded read — is
    /// `open_document_large_file_agrees_with_full_read_prefix` below; this
    /// test's content assertion is a lighter, independent check computed
    /// straight from the in-memory fixture rather than a second file read.
    #[test]
    fn open_document_large_file_is_bounded_preview() {
        let (file, data) = write_line_fixture("mojidori-large-file-bounded-preview", 1_000_000);
        assert!(
            data.len() as u64 > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.total_size, data.len() as u64);
        let content_bytes = opened.content.as_bytes();
        assert!(
            content_bytes.len() <= PREVIEW_BYTES,
            "preview content must never exceed PREVIEW_BYTES"
        );
        assert_eq!(
            opened.next_offset,
            Some(content_bytes.len() as u64),
            "next_offset must be the byte offset right after the previewed content"
        );

        // Independent check: the preview must equal decoding the first
        // PREVIEW_BYTES of the fixture's own in-memory bytes, cut at the
        // last line boundary by the same (unmodified) `preview_slice`.
        let expected_slice = preview_slice(data.as_bytes(), PREVIEW_BYTES, None);
        assert_eq!(opened.content, std::str::from_utf8(expected_slice).unwrap());

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #59, regression lock. Builds one large fixture and compares
    /// `open_document`'s bounded-read content against content computed the
    /// pre-fix way for the identical bytes: read the whole file, then apply
    /// the same `preview_slice` + `decode_auto_with_extension` the command
    /// itself uses. A bounded implementation that reads the wrong window,
    /// or fails to cut at the same line boundary as the full-read path
    /// (the off-by-one this test exists to catch), produces different
    /// content or a different `next_offset` here.
    #[test]
    fn open_document_large_file_agrees_with_full_read_prefix() {
        let (file, _) = write_line_fixture("mojidori-large-file-prefix-agreement", 1_000_000);
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        let full = std::fs::read(&file).unwrap();
        assert!(full.len() as u64 > LARGE_FILE_THRESHOLD);
        let reference_slice = preview_slice(&full, PREVIEW_BYTES, None);
        let reference_decoded = crate::encoding::decode_auto_with_extension(reference_slice, None);
        let reference_content = crate::encoding::normalize_to_lf(&reference_decoded.content);

        assert_eq!(opened.content, reference_content);
        assert_eq!(opened.encoding, reference_decoded.encoding);
        assert_eq!(opened.next_offset, Some(reference_slice.len() as u64));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large UTF-16LE fixture: `n` lines of `"line {i}\n"`,
    /// generated as a single `String` in one pass (mirrors
    /// `write_line_fixture`'s "build the string once, one disk write"
    /// shape, so fixture setup stays fast even though UTF-16 roughly
    /// doubles the byte count per character) and encoded to UTF-16LE with
    /// one `encoding::encode` call. `with_bom` toggles the UTF-16LE BOM,
    /// so callers can exercise the BOM-sniff and explicit-label branches
    /// of `encoding::utf16_variant` separately (issue #61). Returns the
    /// file path.
    fn write_utf16le_line_fixture(dir_name: &str, n: u32, with_bom: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16.txt");
        let data: String = (0..n).map(|i| format!("line {i}\n")).collect();
        let (bytes, unmappable) = crate::encoding::encode(&data, "UTF-16LE", with_bom).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #61. A UTF-16LE file with a BOM, well over
    /// `LARGE_FILE_THRESHOLD`, must open its bounded preview without ever
    /// reporting `malformed`: the preview cut point must land on a real
    /// code-unit boundary, never mid `0A 00` newline pair. Before the fix
    /// this test is red — the raw-byte `preview_slice` this replaced
    /// corrupts essentially every such file (an odd-length slice handed to
    /// the UTF-16 decoder reports at least one replacement character) even
    /// though nothing on disk is actually damaged.
    #[test]
    fn open_document_large_utf16le_preview_not_malformed() {
        let file = write_utf16le_line_fixture("mojidori-large-utf16le-bom-preview", 600_000, true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.encoding, "UTF-16LE");
        assert!(opened.had_bom);
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #61, explicit-encoding variant: no BOM, reopened via the
    /// explicit `encoding` parameter (as the frontend does when the user
    /// picks an encoding from the menu) instead of auto-detection — this
    /// exercises the explicit-label branch of `encoding::utf16_variant`
    /// rather than the BOM-sniff branch.
    #[test]
    fn open_document_large_utf16le_explicit_reopen_not_malformed() {
        let file =
            write_utf16le_line_fixture("mojidori-large-utf16le-explicit-reopen", 600_000, false);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("UTF-16LE".to_string()), None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.encoding, "UTF-16LE");
        assert!(!opened.had_bom, "fixture has no BOM");
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large, BOM-less UTF-16 fixture whose lines are genuinely
    /// non-ASCII (`"第 {i} 行\n"`), unlike `write_utf16le_line_fixture`'s
    /// pure-ASCII lines. This distinction matters for issue #71: every
    /// ASCII byte — including the zero high byte UTF-16 pads Latin text
    /// with — is independently valid UTF-8, so a pure-ASCII UTF-16
    /// fixture's raw bytes pass `str::from_utf8` and the extension hint
    /// is *never* consulted for it (the #47 gate already documents this
    /// exact trade-off). `write_utf16le_line_fixture`'s fixtures are the
    /// right choice for the BOM and explicit-label tests above, which
    /// don't go anywhere near that gate; a fixture meant to exercise the
    /// ext-hint path needs bytes that actually fail it, mirroring why
    /// `encoding.rs`'s `utf16_ext_hint_still_applies_to_real_utf16_without_bom`
    /// uses "中文" instead of ASCII. `label` selects the byte order
    /// ("UTF-16LE" / "UTF-16BE"); always BOM-less since that is this
    /// fixture's entire point.
    fn write_utf16_nonascii_line_fixture(
        dir_name: &str,
        n: u32,
        label: &str,
    ) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16-nonascii.txt");
        let data: String = (0..n).map(|i| format!("第 {i} 行\n")).collect();
        let (bytes, unmappable) = crate::encoding::encode(&data, label, false).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #71 core regression, LE. A BOM-less UTF-16LE file whose text
    /// is genuinely non-ASCII (so its raw bytes are *not* coincidentally
    /// valid UTF-8 — see `write_utf16_nonascii_line_fixture`), well over
    /// `LARGE_FILE_THRESHOLD`, opened via auto-detection (`encoding:
    /// None`) with a per-extension preference hinting UTF-16LE — exactly
    /// what `open_document` receives once the frontend resolves the
    /// file's extension through `Preferences::extension_encodings`.
    ///
    /// The *real* decode already picks this up correctly:
    /// `decode_auto_with_extension` -> `detect_with_extension` accepts
    /// the hint (rule 4; the #47 UTF-8 gate does not block it because
    /// this content genuinely is not valid UTF-8). Before this fix, the
    /// *preview cut* disagreed with that decision: `encoding::
    /// utf16_variant(&raw, None)` only ever consults the explicit reopen
    /// label and the BOM, saw neither, and returned `None`, so `preview_
    /// slice` fell back to its raw `0x0A` byte search — which on real
    /// UTF-16LE content lands mid code-unit almost every time, leaving a
    /// dangling final byte. That dangling byte then makes the *real*
    /// decode's own `detect_with_extension` call see a malformed UTF-16LE
    /// trial decode and reject the very hint that should have won,
    /// falling back to a statistical guess that is never UTF-16 (see
    /// `detect_with_extension`'s doc comment) — the wrong encoding
    /// entirely, not just a stray warning.
    ///
    /// Red before the fix (`opened.encoding` is not `"UTF-16LE"` and the
    /// content is garbled); green after, because `encoding::preview_
    /// utf16_variant` runs the very same guarded `detect_with_extension`
    /// call the real decode uses, so the two can never disagree.
    #[test]
    fn open_document_large_bomless_utf16le_via_ext_hint_not_malformed() {
        let file = write_utf16_nonascii_line_fixture(
            "mojidori-large-bomless-utf16le-ext-hint",
            600_000,
            "UTF-16LE",
        );
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert!(!opened.had_bom, "fixture has no BOM");
        assert_eq!(
            opened.encoding, "UTF-16LE",
            "the extension hint must win exactly as the real decode would pick it"
        );
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16LE file must never report malformed, \
             even when picked up only via the extension hint"
        );
        assert!(
            opened.content.starts_with("第 0 行\n"),
            "content must decode correctly, not as whatever encoding a \
             corrupted preview cut would fall back to"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large, BOM-less UTF-16BE fixture that is `n` repeats of
    /// U+0A85 — a character chosen purely for its byte layout, not its
    /// meaning: U+0A85's BE encoding is the byte pair `[0x0A, 0x85]`, so
    /// its *high* byte is `0x0A`. Every code unit in the file repeats
    /// this same pair, and a 2-byte period divides any even window
    /// length exactly, so the pre-#71-fix raw `0x0A` byte search always
    /// finds *this* character's high byte as the very last occurrence in
    /// the window — deterministically reproducing a mid-code-unit cut
    /// regardless of exactly where `PREVIEW_BYTES` falls.
    ///
    /// This probe is what BE specifically needs, and ordinary prose
    /// cannot provide it: BE's newline code unit is `00 0A`, so a raw
    /// `0x0A` search lands on that code unit's own *last* byte whenever
    /// it finds a real newline — which, for text with no character in
    /// the U+0A00-U+0AFF block (essentially all real-world text; that
    /// block is Gurmukhi), is *always* what it finds. The bug is just as
    /// real for BE as for LE (neither `utf16_variant` nor the pre-fix
    /// call site know the byte order without a BOM or explicit label),
    /// but a `write_utf16_nonascii_line_fixture`-style "第 {i} 行\n"
    /// fixture cannot exhibit it for BE — the raw search always
    /// (accidentally) lands on a complete code unit already. See
    /// `open_document_large_bomless_utf16be_via_ext_hint_not_malformed`.
    fn write_utf16be_high_byte_0a_fixture(dir_name: &str, n: usize) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big16be-0a-probe.txt");
        let data: String = "\u{0A85}".repeat(n);
        let (bytes, unmappable) = crate::encoding::encode(&data, "UTF-16BE", false).unwrap();
        assert!(
            !unmappable,
            "UTF-16 encoding never reports unmappable characters"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #71, BE counterpart of
    /// `open_document_large_bomless_utf16le_via_ext_hint_not_malformed`.
    /// Cannot reuse that test's realistic line-oriented fixture — see
    /// `write_utf16be_high_byte_0a_fixture`'s doc comment for why BE
    /// needs a deliberate byte-layout probe instead of ordinary prose to
    /// reproduce the mid-code-unit cut. Same red-before/green-after
    /// shape otherwise: before the fix, the dangling probe byte makes
    /// the real decode's own `detect_with_extension` call see a
    /// malformed UTF-16BE trial decode and reject the extension hint,
    /// falling back to a statistical guess that is never UTF-16.
    #[test]
    fn open_document_large_bomless_utf16be_via_ext_hint_not_malformed() {
        let file = write_utf16be_high_byte_0a_fixture(
            "mojidori-large-bomless-utf16be-ext-hint",
            6_000_000,
        );
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16BE".to_string())).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert!(!opened.had_bom, "fixture has no BOM");
        assert_eq!(
            opened.encoding, "UTF-16BE",
            "the extension hint must win exactly as the real decode would pick it"
        );
        assert!(
            !opened.malformed,
            "a structurally valid UTF-16BE file must never report malformed, \
             even when picked up only via the extension hint"
        );
        assert_eq!(
            opened.content.chars().count(),
            PREVIEW_BYTES / 2,
            "the preview must be exactly the full even window decoded as \
             whole code units — this fixture has no newline to cut at"
        );
        assert!(
            opened.content.chars().all(|c| c == '\u{0A85}'),
            "content must decode as the repeated marker character, not \
             garbage from a wrong encoding"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Build a large, genuinely-valid-UTF-8 fixture of pure-`中` content —
    /// either many short lines (`multiline`) or one newline-free line —
    /// sized past `LARGE_FILE_THRESHOLD`. `中` is U+4E2D → UTF-8 `E4 B8
    /// AD`: a 3-byte sequence whose bytes (E0-EF lead, 80-BF continuation)
    /// never fall in the UTF-16 surrogate high-byte range D8-DF. That is
    /// the exact adversarial shape issue #71's P1/P3 need — the 2 MiB
    /// preview bound splits a character (so a naive `from_utf8` on the
    /// window fails), and a UTF-16 *trial* decode of these bytes never
    /// reports a malformed sequence, so nothing but the confident-UTF-8
    /// gate stops an extension hint from silently reinterpreting the whole
    /// preview as mojibake.
    fn write_large_cjk_utf8_fixture(dir_name: &str, multiline: bool) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cjk-utf8.txt");
        let data: String = if multiline {
            // 31-byte lines: 10 × `中` (30 bytes) + `\n`. The 2 MiB bound
            // lands mid-character, but earlier newlines give the preview a
            // clean line boundary to cut at.
            "中中中中中中中中中中\n".repeat(400_000)
        } else {
            // One ~12 MB line, no newline anywhere in the 2 MiB window, so
            // the cut itself cannot land on a clean boundary (P3).
            "中".repeat(4_000_000)
        };
        assert!(
            std::str::from_utf8(data.as_bytes()).is_ok(),
            "fixture must be genuinely valid UTF-8"
        );
        std::fs::write(&file, data.as_bytes()).unwrap();
        file
    }

    /// Issue #71, P1 regression (the hole a naive #71 fix reopened, LE
    /// hint). A large *valid UTF-8* CJK file, no BOM, auto-detected with a
    /// per-extension preference of UTF-16LE. The #47 gate protects small
    /// files; this pins that the large-file preview path does not reopen
    /// the silent-mojibake hole. Before the truncation-tolerance fix the
    /// preview probed the mid-character-truncated 2 MiB window, mis-read
    /// it as UTF-16 (a UTF-16 trial of these surrogate-free bytes never
    /// reports malformed), cut the whole window, and the real decode then
    /// reinterpreted every byte as UTF-16 — `encoding == "UTF-16LE"`,
    /// garbled content, `malformed == false`, no U+FFFD: exactly the
    /// "decode errors surfaced, never silently rendered as fine" hard
    /// constraint, violated. Multi-line, so after the fix the cut lands on
    /// a newline and the real decode sees clean UTF-8.
    #[test]
    fn open_document_large_cjk_utf8_multiline_ext_hint_le_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("mojidori-large-cjk-utf8-multiline-le", true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a valid UTF-8 CJK file must not be reinterpreted as UTF-16 via the ext hint (#47/#71)"
        );
        assert!(
            !opened.malformed,
            "valid UTF-8 content must never report malformed"
        );
        assert!(
            opened.content.starts_with("中中中"),
            "content must decode as CJK, not mojibake"
        );
        assert!(
            opened.content.ends_with('\n'),
            "a multi-line preview must cut on a line boundary"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters when nothing is actually corrupt"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #71, P1 regression, BE-hint symmetry of
    /// `open_document_large_cjk_utf8_multiline_ext_hint_le_not_corrupted`.
    /// A UTF-16BE hint over the same valid-UTF-8 CJK file must be rejected
    /// identically (the confident-UTF-8 gate does not care which UTF-16
    /// byte order the hint names).
    #[test]
    fn open_document_large_cjk_utf8_multiline_ext_hint_be_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("mojidori-large-cjk-utf8-multiline-be", true);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16BE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a valid UTF-8 CJK file must not be reinterpreted as UTF-16 via the ext hint (#47/#71)"
        );
        assert!(!opened.malformed);
        assert!(opened.content.starts_with("中中中"));
        assert!(opened.content.ends_with('\n'));
        assert!(!opened.content.contains('\u{FFFD}'));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #71, P3 (pre-existing, fixed here in passing). One very long
    /// valid-UTF-8 CJK line with *no newline* in the 2 MiB window, plus a
    /// UTF-16LE hint. With no newline the preview cut cannot land on a
    /// clean boundary, so even after the probe correctly rejects UTF-16
    /// the slice still ends mid-character — and the real decode would then
    /// miss the confident-UTF-8 gate and let the hint hijack the whole
    /// window (the same silent mojibake, reached through the decode rather
    /// than the cut). The fix trims the slice's truncated trailing UTF-8
    /// sequence before decoding, so the decode sees clean UTF-8. Content
    /// does not end on a newline here (there is none), so this asserts
    /// correct CJK decode and no U+FFFD instead.
    #[test]
    fn open_document_large_cjk_utf8_singleline_ext_hint_not_corrupted() {
        let file = write_large_cjk_utf8_fixture("mojidori-large-cjk-utf8-singleline", false);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, None, Some("UTF-16LE".to_string())).unwrap();

        assert!(opened.truncated);
        assert_eq!(
            opened.encoding, "UTF-8",
            "a single-line valid UTF-8 CJK file with no newline in the window \
             must still not be reinterpreted as UTF-16 (#71 P3)"
        );
        assert!(!opened.malformed);
        assert!(
            opened.content.starts_with("中中中"),
            "content must decode as CJK, not mojibake"
        );
        assert!(
            opened.content.chars().all(|c| c == '中'),
            "every decoded character must be the fixture's CJK character"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "the truncated tail must be trimmed, not surfaced as U+FFFD"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #136 core regression. Same fixture as
    /// `open_document_large_cjk_utf8_singleline_ext_hint_not_corrupted`
    /// (one line, no newline anywhere in the 2 MiB preview window, so the
    /// raw cut always lands mid-character — it splits the 699,051st `中`
    /// after its first two bytes), but opened with an *explicit* "UTF-8"
    /// label — as when the user manually reopens a file with a chosen
    /// encoding — instead of auto-detection.
    ///
    /// Before the fix, `open_document`'s trim gate only called
    /// `trim_truncated_utf8_tail` when `encoding.is_none()`
    /// (auto-detect); an explicit "UTF-8" label took the untrimmed
    /// `else` branch, so the raw `preview_slice` cut was decoded as
    /// given: `decode_with` reports a spurious U+FFFD and `malformed ==
    /// true` for a file that is not actually corrupt anywhere, and
    /// `next_offset` lands two bytes short of that character's boundary
    /// — so a subsequent `Continuation`-kind chunk read (which never
    /// re-aligns; see `chunk.rs`) would start mid-character and mint a
    /// second spurious U+FFFD at the seam. Red before the fix; green
    /// after, because the widened trim gate applies
    /// `trim_truncated_utf8_tail` for an explicit UTF-8 label exactly as
    /// it already did for auto-detected UTF-8.
    #[test]
    fn open_document_large_cjk_utf8_singleline_explicit_utf8_not_corrupted() {
        let file =
            write_large_cjk_utf8_fixture("mojidori-large-cjk-utf8-singleline-explicit-utf8", false);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path.clone(), Some("UTF-8".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "UTF-8");
        assert!(
            !opened.malformed,
            "an explicit UTF-8 reopen of a genuinely well-formed file must never \
             report malformed (issue #136)"
        );
        assert!(
            opened.content.chars().all(|c| c == '中'),
            "content must decode as CJK, not a wrong-boundary artifact"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "the truncated tail must be trimmed, not surfaced as U+FFFD (issue #136)"
        );

        let next_offset = opened
            .next_offset
            .expect("a truncated large-file open must report next_offset")
            as usize;
        let full = std::fs::read(&file).unwrap();
        assert!(
            std::str::from_utf8(&full[..next_offset]).is_ok(),
            "next_offset must land on a UTF-8 character boundary, not mid-character (issue #136)"
        );

        // Consistency with the auto-detect path: the same bytes, opened
        // without an explicit label, have trimmed this way since #71 —
        // the explicit-UTF-8 reopen must now agree with it exactly.
        let auto = open_document(path, None, None).unwrap();
        assert_eq!(opened.next_offset, auto.next_offset);
        assert_eq!(opened.content, auto.content);

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #136, control/pin test. A genuine *interior* invalid UTF-8
    /// byte within the 2 MiB preview window — not merely a truncated
    /// tail — must still surface as `malformed == true` after widening
    /// the trim gate to cover explicit UTF-8 reopens. This is exactly
    /// what `trim_truncated_utf8_tail`'s `error_len().is_none()`
    /// discriminator exists to protect (see its doc comment): a real
    /// interior corruption reports `error_len() == Some(_)`, which the
    /// trim leaves untouched, so nothing about the #136 fix masks a
    /// genuinely broken file.
    #[test]
    fn open_document_large_explicit_utf8_interior_malformed_still_reported() {
        let dir = std::env::temp_dir().join("mojidori-large-explicit-utf8-interior-malformed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("interior-malformed.txt");

        let mut data = "中".repeat(4_000_000).into_bytes();
        assert!(data.len() as u64 > LARGE_FILE_THRESHOLD);
        // A lone 0xFF is never valid UTF-8 in any position (not a valid
        // lead byte, not a valid continuation byte): genuine interior
        // corruption, well inside the 2 MiB preview window and far from
        // its tail.
        data[1000] = 0xFF;
        std::fs::write(&file, &data).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("UTF-8".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "UTF-8");
        assert!(
            opened.malformed,
            "a genuine interior invalid byte must still be reported as malformed, \
             not masked by the #136 trim-gate widening"
        );
        assert!(
            opened.content.contains('\u{FFFD}'),
            "the interior corruption must surface as a replacement character"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // --- Issue #165: the #136 fix's sibling for an explicit reopen as a
    // legacy multi-byte encoding (Big5, gb18030 here; the underlying
    // `encoding::trim_truncated_legacy_tail` also covers Shift_JIS, GBK,
    // EUC-JP, EUC-KR — see its own unit tests in `encoding.rs`). Same
    // fixture shape as the #136 UTF-8 tests above: one line, no newline
    // anywhere in the 2 MiB preview window, so the raw `preview_slice` cut
    // always lands mid-character. ---

    /// Build a large, genuinely-valid Big5 fixture: a single leading ASCII
    /// byte followed by `中` (a 2-byte Big5 character) repeated enough
    /// times to exceed `LARGE_FILE_THRESHOLD`, with no newline anywhere.
    /// `PREVIEW_BYTES` is a power of two (so even), and every character
    /// here is 2 bytes starting at offset 1 (odd) — without the leading
    /// ASCII byte, the preview cut at `PREVIEW_BYTES` would always land
    /// exactly on a character boundary (even cut, even-aligned 2-byte
    /// characters starting at 0) and never actually exercise the
    /// mid-character split this fixture exists to test. The one leading
    /// odd-parity byte shifts every later character's start to an odd
    /// offset, so the even `PREVIEW_BYTES` cut always splits the
    /// character straddling it after exactly its first byte.
    fn write_large_big5_fixture(dir_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big5.txt");
        let mut text = String::from("a");
        text.push_str(&"中".repeat(6_000_000));
        let (bytes, unmappable) = crate::encoding::encode(&text, "Big5", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in Big5"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #165 core regression, Big5 analogue of
    /// `open_document_large_cjk_utf8_singleline_explicit_utf8_not_corrupted`
    /// (#136). Before the fix, `open_document`'s trim gate never applied
    /// any trim for an explicit non-UTF-8 label, so the raw
    /// `preview_slice` cut (landing 1 byte into the 6,000,000th `中`, per
    /// `write_large_big5_fixture`'s doc comment) was decoded as given:
    /// `decode_with` reports a spurious trailing U+FFFD and `malformed ==
    /// true` for a file that is not actually corrupt anywhere, and
    /// `next_offset` lands 1 byte short of that character's boundary.
    /// Red before the fix; green after, because the widened trim gate now
    /// applies `trim_truncated_legacy_tail` for an explicit legacy
    /// multi-byte label the same way it already applied
    /// `trim_truncated_utf8_tail` for an explicit UTF-8 label (#136).
    ///
    /// This also stands in for issue #165's failing-test item 4 ("true
    /// tail malformed" control): there is no separate test for a
    /// genuinely-corrupt-at-EOF file, because #136's own argument already
    /// rules it out structurally for this code path, unchanged by #165 —
    /// the trim gate only ever runs when `truncated` is true, which
    /// requires the *whole file* to exceed `LARGE_FILE_THRESHOLD` (10
    /// MiB) while the preview window is only `PREVIEW_BYTES` (2 MiB), so
    /// the byte the trim gate ever looks at as "the tail" is always deep
    /// inside the real file, never its actual last byte. A genuine
    /// end-of-file malformed sequence physically cannot be the thing this
    /// gate trims, on this path, regardless of encoding.
    #[test]
    fn open_document_large_big5_singleline_explicit_reopen_not_corrupted() {
        let file = write_large_big5_fixture("mojidori-large-big5-singleline");
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("Big5".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "Big5");
        assert!(
            !opened.malformed,
            "an explicit Big5 reopen of a genuinely well-formed file must never \
             report malformed (issue #165)"
        );
        assert!(opened.content.starts_with('a'));
        assert!(
            opened.content[1..].chars().all(|c| c == '中'),
            "content must decode as CJK, not a wrong-boundary artifact"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "the truncated tail must be trimmed, not surfaced as U+FFFD (issue #165)"
        );

        let next_offset = opened
            .next_offset
            .expect("a truncated large-file open must report next_offset")
            as usize;
        let full = std::fs::read(&file).unwrap();
        let realigned = crate::encoding::decode_with(&full[..next_offset], "Big5").unwrap();
        assert!(
            !realigned.malformed,
            "next_offset must land on a Big5 character boundary, not mid-character (issue #165)"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #165, control/pin test mirroring
    /// `open_document_large_explicit_utf8_interior_malformed_still_reported`
    /// (#136) for Big5: a genuine *interior* invalid byte within the 2 MiB
    /// preview window — not merely a truncated tail — must still surface
    /// as `malformed == true` after adding the legacy-encoding trim gate.
    /// `0xFF` is never a valid Big5 lead byte under any continuation, so
    /// `encoding::trim_truncated_legacy_tail`'s step 1 (whole-slice,
    /// `last: false` decode) must report it regardless of the trailing
    /// bytes, and no cut depth in step 2 can make it disappear — nothing
    /// about the #165 fix may mask a genuinely broken file.
    #[test]
    fn open_document_large_big5_interior_malformed_still_reported() {
        let dir = std::env::temp_dir().join("mojidori-large-big5-interior-malformed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("interior-malformed.txt");

        // Big5 is 2 bytes/char (not UTF-8's 3), so this needs more
        // repeats than the UTF-8 interior-malformed fixture to clear
        // LARGE_FILE_THRESHOLD.
        let text = "中".repeat(6_000_000);
        let (mut data, unmappable) = crate::encoding::encode(&text, "Big5", false).unwrap();
        assert!(!unmappable);
        assert!(data.len() as u64 > LARGE_FILE_THRESHOLD);
        // A lone 0xFF is never valid Big5 in any position (not a valid
        // lead byte, not a valid trail byte): genuine interior
        // corruption, well inside the 2 MiB preview window and far from
        // its tail.
        data[1000] = 0xFF;
        std::fs::write(&file, &data).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("Big5".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "Big5");
        assert!(
            opened.malformed,
            "a genuine interior invalid byte must still be reported as malformed, \
             not masked by the #165 trim-gate widening"
        );
        assert!(
            opened.content.contains('\u{FFFD}'),
            "the interior corruption must surface as a replacement character"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Build a large, genuinely-valid gb18030 fixture: `pad` ASCII bytes
    /// (1, 2, or 3) followed by U+20000 (a 4-byte gb18030 sequence — see
    /// `encoding::tests::trim_truncated_legacy_tail_gb18030_drops_truncated_four_byte_tail_at_each_split_position`)
    /// repeated enough times to exceed `LARGE_FILE_THRESHOLD`, with no
    /// newline anywhere. `PREVIEW_BYTES` is a power of two >= 4, so with
    /// no padding the preview cut always lands exactly on a 4-byte
    /// character boundary; shifting every character's start by `pad`
    /// bytes instead makes the even `PREVIEW_BYTES` cut land `pad` bytes
    /// into whichever character straddles it. Concretely, `pad == 3, 2,
    /// 1` leave exactly `1, 2, 3` complete bytes of the split character
    /// before the cut — the three "split position" fixtures issue #165
    /// asks for, driven by `split_after_bytes` in
    /// `assert_open_document_large_gb18030_split_not_corrupted` below.
    fn write_large_gb18030_fixture(dir_name: &str, pad: usize) -> std::path::PathBuf {
        assert!((1..=3).contains(&pad), "pad must leave 1..=3 bytes visible");
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gb18030.txt");
        let mut text = "a".repeat(pad);
        text.push_str(&"\u{20000}".repeat(3_000_000));
        let (bytes, unmappable) = crate::encoding::encode(&text, "gb18030", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in gb18030"
        );
        assert_eq!(bytes.len(), pad + 4 * 3_000_000);
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Shared body for the three `open_document_large_gb18030_split_after_*`
    /// tests below — see `write_large_gb18030_fixture`'s doc comment for
    /// the `pad`/`split_after_bytes` arithmetic. Otherwise the gb18030
    /// analogue of `open_document_large_big5_singleline_explicit_reopen_not_corrupted`
    /// above.
    fn assert_open_document_large_gb18030_split_not_corrupted(
        split_after_bytes: usize,
        dir_name: &str,
    ) {
        let pad = (4 - split_after_bytes) % 4;
        let file = write_large_gb18030_fixture(dir_name, pad);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("gb18030".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "gb18030");
        assert!(
            !opened.malformed,
            "an explicit gb18030 reopen of a genuinely well-formed file must never \
             report malformed even when the preview window splits a 4-byte \
             character after {split_after_bytes} of its bytes (issue #165)"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "the truncated tail must be trimmed, not surfaced as U+FFFD (issue #165)"
        );
        assert!(
            opened.content.chars().skip(pad).all(|c| c == '\u{20000}'),
            "content must decode as the fixture's supplementary-plane character, \
             not a wrong-boundary artifact"
        );

        let next_offset = opened
            .next_offset
            .expect("a truncated large-file open must report next_offset")
            as usize;
        let full = std::fs::read(&file).unwrap();
        let realigned = crate::encoding::decode_with(&full[..next_offset], "gb18030").unwrap();
        assert!(
            !realigned.malformed,
            "next_offset must land on a gb18030 character boundary, not mid-character \
             (issue #165)"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn open_document_large_gb18030_split_after_1_byte_not_corrupted() {
        assert_open_document_large_gb18030_split_not_corrupted(
            1,
            "mojidori-large-gb18030-split-after-1",
        );
    }

    #[test]
    fn open_document_large_gb18030_split_after_2_bytes_not_corrupted() {
        assert_open_document_large_gb18030_split_not_corrupted(
            2,
            "mojidori-large-gb18030-split-after-2",
        );
    }

    #[test]
    fn open_document_large_gb18030_split_after_3_bytes_not_corrupted() {
        assert_open_document_large_gb18030_split_not_corrupted(
            3,
            "mojidori-large-gb18030-split-after-3",
        );
    }

    /// Issue #165, zero-regression pin for single-byte encodings: every
    /// byte of a single-byte encoding already *is* one whole character, so
    /// `encoding::is_legacy_multibyte_label` must reject it and
    /// `open_document`'s trim gate must take the same untrimmed path it
    /// always did before #165. Pinned precisely (`next_offset ==
    /// PREVIEW_BYTES`, not merely "not malformed") so a future bug in
    /// `max_legacy_seq_len` wrongly matching a single-byte encoding would
    /// fail this test even though nothing here could ever actually produce
    /// `malformed == true` either way.
    #[test]
    fn open_document_large_windows1252_singleline_explicit_reopen_unaffected_by_legacy_gate() {
        let dir = std::env::temp_dir().join("mojidori-large-windows1252-singleline");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("windows-1252.txt");
        let text = "é".repeat(11_000_000);
        let (bytes, unmappable) = crate::encoding::encode(&text, "windows-1252", false).unwrap();
        assert!(!unmappable);
        assert!(bytes.len() as u64 > LARGE_FILE_THRESHOLD);
        std::fs::write(&file, &bytes).unwrap();
        let path = file.to_string_lossy().into_owned();

        let opened = open_document(path, Some("windows-1252".to_string()), None).unwrap();

        assert!(opened.truncated);
        assert_eq!(opened.encoding, "windows-1252");
        assert!(!opened.malformed);
        assert!(!opened.content.contains('\u{FFFD}'));
        assert!(opened.content.chars().all(|c| c == 'é'));
        assert_eq!(
            opened.next_offset,
            Some(PREVIEW_BYTES as u64),
            "a single-byte encoding must never be trimmed by the #165 legacy gate"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Issue #59. `explain_detection` must sample a bounded prefix from
    /// disk (not the whole file) for files above `EXPLAIN_SAMPLE_BYTES`;
    /// its doc comment already promised "a bounded prefix" — this locks
    /// the implementation to that promise. `sampled_bytes` must be exactly
    /// the sample cap, and the detection evidence must match calling
    /// `encoding::detect_with_extension` directly on the same first
    /// `EXPLAIN_SAMPLE_BYTES` bytes.
    #[test]
    fn explain_detection_large_file_samples_bounded() {
        let (file, data) = write_line_fixture("mojidori-explain-large-sample", 14_000);
        assert!(
            data.len() > EXPLAIN_SAMPLE_BYTES,
            "fixture must exceed the diagnostics sample size"
        );
        assert!(
            (data.len() as u64) < LARGE_FILE_THRESHOLD,
            "fixture must stay under the large-file threshold — this test's whole point is \
             pinning `large_file_preview` apart from the unrelated `sampled_bytes < total_size` \
             condition this fixture *does* cross"
        );
        let path = file.to_string_lossy().into_owned();

        let explained = explain_detection(path, None).unwrap();

        assert_eq!(explained.sampled_bytes, EXPLAIN_SAMPLE_BYTES);
        assert_eq!(explained.total_size, data.len() as u64);

        let expected =
            crate::encoding::detect_with_extension(&data.as_bytes()[..EXPLAIN_SAMPLE_BYTES], None);
        assert_eq!(explained.detector_verdict, expected.detector_guess.name());
        assert_eq!(
            explained.would_choose,
            format!("{} ({})", expected.chosen.name(), expected.reason)
        );
        // Issue #201: this fixture crosses EXPLAIN_SAMPLE_BYTES (so
        // `sampled_bytes < total_size`) but not LARGE_FILE_THRESHOLD, so
        // `open_document`'s real auto-detect for this same file would have
        // read it whole, untruncated. `large_file_preview` must track that
        // — not `sampled_bytes < total_size` — or this diagnostics-only
        // command would wrongly warn about *its own* smaller re-sample as
        // if it were the truncation `open_document` actually did.
        assert!(
            !explained.large_file_preview,
            "a file under LARGE_FILE_THRESHOLD must not be flagged as a large-file-preview \
             sample, even though explain_detection's own EXPLAIN_SAMPLE_BYTES cap made its \
             sample partial"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// Issue #201: for a file over `LARGE_FILE_THRESHOLD`, `open_document`'s
    /// real auto-detect never sees the whole file — only a bounded preview
    /// window (`PREVIEW_BYTES`). For a large single-line legacy multi-byte
    /// file with no newline anywhere in that window (this fixture: one
    /// leading ASCII byte then six million `中` in Big5, the same shape
    /// `write_large_big5_fixture` builds for the #165 tests above),
    /// chardetng's statistical read of that truncated sample can swing to
    /// the wrong (single-byte) encoding family — with `malformed == false`,
    /// so nothing else flags it either. Empirically confirmed against this
    /// exact fixture (encoding_rs 0.8.35 + chardetng 0.1.17): even
    /// `explain_detection`'s own smaller `EXPLAIN_SAMPLE_BYTES` prefix of
    /// it — which also ends mid-character, one leading odd-parity byte
    /// making every later `中` land on an odd offset the same way the
    /// `write_large_big5_fixture` doc comment explains for the 2 MiB
    /// `PREVIEW_BYTES` window — reproduces the swing (verdict:
    /// windows-874, `reason=detector`), so the assertion below checks the
    /// general "wrong family" shape rather than pinning that one
    /// third-party statistical guess, which could change across a
    /// chardetng version bump. Red before `large_file_preview` existed on
    /// `DetectionExplanation` (does not compile); green after.
    #[test]
    fn explain_detection_large_file_preview_flags_truncated_sample() {
        let file = write_large_big5_fixture("mojidori-explain-large-big5-truncated-flag");
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        let explained = explain_detection(path, None).unwrap();

        assert_eq!(explained.total_size, size);
        assert!(
            explained.large_file_preview,
            "a file over LARGE_FILE_THRESHOLD must flag its verdict as based on a truncated \
             large-file-preview sample (issue #201)"
        );
        // Grounding: this is not a hypothetical risk for this fixture. The
        // truncated sample's statistical read swings away from Big5 (see
        // the doc comment above) — with `reason=detector`, not `bom`, so
        // the frontend's BOM exclusion does not suppress the new hint here.
        assert_ne!(
            explained.detector_verdict, "Big5",
            "this fixture only reproduces the issue #201 scenario this test protects if the \
             truncated sample's statistical read actually swings away from the true encoding \
             family — if a future encoding_rs/chardetng upgrade fixes that read, this fixture \
             stops being a meaningful regression lock and must be revisited"
        );
        assert!(explained.would_choose.ends_with("(detector)"));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    // --- Issue #225: the large-file *preview* path (this section) is a
    // different code path from chunk-*paging*'s continuation reads
    // (`chunk.rs`), which is what issue #225 actually fixes (paging is now
    // rejected outright for ISO-2022-JP, mirroring UTF-16). Neither
    // `open_document` nor `preview_slice` changed for that fix, so this
    // locks in that the preview path was, and remains, unaffected. -------

    /// Build a large ISO-2022-JP fixture: `n` lines of `"第 {i} 行\n"`
    /// (common kanji, representable in JIS X 0208), generated as a single
    /// `String` in one pass and encoded with one `encoding::encode` call.
    /// A single whole-string `encode` call is safe for ISO-2022-JP — only a
    /// *streaming*, split-across-calls encode is the hazard the
    /// judgment-overlay dead-end and `streamreplace.rs`'s module doc
    /// describe; one call always starts and ends in a self-consistent
    /// state. Frequent newlines (every short line) guarantee
    /// `open_document`'s preview cut (`preview_slice`'s "last raw 0x0A
    /// byte in the window" rule) always lands right after a real line
    /// terminator: 0x0A is a control byte, never part of a JIS X 0208
    /// two-byte sequence (whose bytes occupy 0x21-0x7E), so the cut is
    /// unambiguous regardless of shift state. Returns the file path.
    fn write_iso2022jp_line_fixture(dir_name: &str, n: u32) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{dir_name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big-iso2022jp.txt");
        let data: String = (0..n).map(|i| format!("第 {i} 行\n")).collect();
        let (bytes, unmappable) = crate::encoding::encode(&data, "ISO-2022-JP", false).unwrap();
        assert!(
            !unmappable,
            "fixture text must be fully representable in ISO-2022-JP"
        );
        std::fs::write(&file, &bytes).unwrap();
        file
    }

    /// Issue #225 regression lock: opening a large, well-formed ISO-2022-JP
    /// file whose preview window contains frequent newlines must still
    /// produce a clean, non-malformed preview, exactly as before the
    /// chunk-*paging* fix elsewhere in this issue. This is a single,
    /// self-contained decode from the true start of the file (offset 0),
    /// unlike a chunk-paging continuation page: a fresh decoder's default
    /// ASCII/ROMAN start state is *correct* at a real file start, so there
    /// is no cross-call shift-state loss to exploit here — the preview's
    /// own `malformed` signal stays a reliable indicator on this path,
    /// unlike the paging bug this issue fixes for `chunk.rs`.
    #[test]
    fn open_document_large_iso2022jp_preview_not_malformed() {
        let file = write_iso2022jp_line_fixture("mojidori-large-iso2022jp-preview", 600_000);
        let size = std::fs::metadata(&file).unwrap().len();
        assert!(
            size > LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let path = file.to_string_lossy().into_owned();

        // Explicit label: chardetng never guesses ISO-2022-JP, it carries
        // no BOM, and every frontend encoding list deliberately excludes
        // it (encodings.ts) — no UI path currently reaches this encoding.
        // This test guards the raw `open_document` command contract
        // (defense-in-depth, same as the chunk-read gates), not a
        // user-triggerable flow.
        let opened = open_document(path, Some("ISO-2022-JP".to_string()), None).unwrap();

        assert!(
            opened.truncated,
            "a file over the threshold must be truncated"
        );
        assert_eq!(opened.encoding, "ISO-2022-JP");
        assert!(
            !opened.malformed,
            "a structurally valid ISO-2022-JP file with frequent newlines \
             in the preview window must not report malformed"
        );
        assert!(
            opened.content.ends_with('\n'),
            "the preview must end on a full line, not mid line"
        );
        assert!(
            !opened.content.contains('\u{FFFD}'),
            "no replacement characters may appear when nothing is actually corrupt"
        );
        assert!(
            opened.content.starts_with("第 0 行"),
            "content must decode as the fixture's actual JIS text, not mojibake"
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }
}
