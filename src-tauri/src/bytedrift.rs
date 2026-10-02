//! Lazy byte-drift detection for the save path (issue #96, part 2/3).
//!
//! `encoding.rs`'s module doc ("Round-trip contract") documents why this
//! exists: a handful of legacy multi-byte encodings (Big5, Shift_JIS, GBK)
//! have non-injective decode mappings, so `encode(decode(bytes)) != bytes`
//! is possible even when decoding reports nothing malformed and encoding
//! reports nothing unmappable -- a non-canonical input sequence is silently
//! canonicalized. Issue #96 (1/3) closed the streaming-replace half of this
//! (`streamreplace.rs`'s read-chunk passthrough); this is the ordinary-save
//! half: before a document's *first* save in a session silently
//! canonicalizes such bytes, ask the user once, informed-consent style.
//!
//! Deliberately lazy -- checked from the save path, not `open_document` --
//! by design, not oversight: running an extra decode+encode+memcmp on every
//! open would cost every document, including the overwhelming majority that
//! will never hit this, on the one hot path this project's "Instant" pillar
//! (ARCHITECTURE.md) cares most about. `check_byte_drift` below is instead
//! an independent, on-demand Tauri command the frontend calls at most once
//! per document per session, right before its first save (main.ts's
//! `runSaveFlow`, gated by `Doc.byteDriftChecked` -- see `src/bytedrift.ts`
//! for the frontend half of this gate).
//!
//! `detect_byte_drift` rebuilds the *exact* save pipeline
//! `lib.rs::save_document` runs -- `normalize_to_lf` -> `apply_line_ending`
//! -> `encode` (which itself re-applies `with_bom`) -- against a fresh
//! decode of the file's current on-disk bytes, reusing `encoding.rs`'s own
//! functions rather than re-deriving the transforms, and `memcmp`s the
//! result against those same on-disk bytes. A naive "does `encode(open-time
//! content))` match the original bytes" check would misfire on every
//! CRLF/BOM document (`encode`'s input must already be the line-ending-
//! converted buffer, not the LF-normalized one) -- see the `tests` module
//! below for the fixtures that pin this.
//!
//! The line ending fed to that rebuild is detected from the on-disk bytes
//! themselves (`encoding::detect_line_ending`, the same function
//! `open_document` derives a document's line ending with) -- deliberately
//! NOT the document's current line-ending *setting* (adversarial-review P2
//! on this feature's first version): the doc setting diverges from disk
//! the moment the user picks a different line ending from the Format menu,
//! and rebuilding with the doc's setting would then mismatch every newline
//! and misreport that explicit, reversible conversion as issue #96's
//! irreversible encoding canonicalization. The drift question is about the
//! *file as it sits on disk* -- "would re-encoding these bytes' own decoded
//! text, in their own line-ending style, reproduce them?" -- so nothing
//! doc-level belongs in it except the encoding itself (which determines
//! how the bytes decode at all, and any change to it resets the check --
//! see `Doc.byteDriftChecked`'s reopen reset in main.ts). A file whose own
//! bytes mix line-ending styles is skipped: `apply_line_ending` re-applies
//! one pure style, so a mixed file is inherently unreproducible and any
//! verdict on it would conflate line-ending unification with encoding
//! canonicalization.

use crate::encoding;
use crate::normalize;
use encoding_rs::Encoding;
use serde::Serialize;

/// `ByteDriftReport::reason` when the on-disk bytes' own detected line
/// ending is `"Mixed"`.
pub const SKIP_MIXED_LINE_ENDING: &str = "mixed-line-ending";
/// `ByteDriftReport::reason` when the target encoding is UTF-8 or UTF-16.
pub const SKIP_UNICODE_ENCODING: &str = "unicode-encoding";
/// `ByteDriftReport::reason` when the on-disk bytes don't decode cleanly in
/// the requested encoding.
pub const SKIP_MALFORMED: &str = "malformed";

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ByteDriftReport {
    /// True when rebuilding the save pipeline against the file's current
    /// on-disk bytes would *not* reproduce them byte-for-byte -- i.e. the
    /// next save would silently canonicalize a non-injective legacy byte
    /// sequence (issue #96). Always `false` when `skipped` is `true`: a
    /// skip means this verdict was never computed, not that it came back
    /// clean.
    pub drift: bool,
    /// True when the check didn't run to a real verdict -- see `reason`.
    pub skipped: bool,
    /// One of the `SKIP_*` constants above when `skipped` is `true`, else
    /// `None`.
    pub reason: Option<String>,
}

impl ByteDriftReport {
    fn skip(reason: &'static str) -> Self {
        Self {
            drift: false,
            skipped: true,
            reason: Some(reason.to_string()),
        }
    }
}

/// Core, Tauri-free implementation (unit-testable without the command
/// harness -- see `normalize::check_representability`'s identical split).
///
/// `encoding`/`with_bom` are the document's own state as of its last
/// open/reload -- passed straight through from the frontend's `Doc` (see
/// `src/bytedrift.ts`). The line ending is deliberately NOT a parameter:
/// it is detected from the on-disk bytes themselves, so a doc-level
/// line-ending switch can never masquerade as encoding drift (see the
/// module doc). `with_bom` is kept for shape-symmetry with
/// `save_document`, but for every encoding that reaches the rebuild it is
/// provably inert: `encoding::encode` only prepends a BOM for UTF-8, and
/// UTF-8/UTF-16 never get past the skip above -- pinned by the
/// windows-1252 `with_bom: true` fixture below.
///
/// `path` is re-read from disk as it stands *right now*: if something
/// external changed the file since it was opened, this simply answers the
/// drift question against *today's* bytes rather than the open-time ones
/// -- not a bug this function needs to guard against, since an unrelated
/// external edit landing between open and save is `fsguard.rs`'s
/// stale-fingerprint problem to catch (at the actual save commit, which
/// runs after this check) -- worst case here is a spurious or missed drift
/// dialog for a save that's about to be rejected as stale anyway.
pub fn detect_byte_drift(
    path: &str,
    encoding: &str,
    with_bom: bool,
) -> Result<ByteDriftReport, String> {
    let resolved = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    // UTF-8/UTF-16's decode mapping is 1:1 -- issue #96 is specifically
    // about legacy multi-byte encodings' *non-injective* mappings -- same
    // skip precedent as `normalize::is_always_representable`. Checked
    // before the disk read: it needs nothing from the bytes.
    if normalize::is_always_representable(resolved) {
        return Ok(ByteDriftReport::skip(SKIP_UNICODE_ENCODING));
    }

    let original = std::fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    // Same decode path `open_document` uses for an explicit encoding, so a
    // rebuild starting here can never disagree with what the document's
    // live content actually is.
    let decoded = encoding::decode_with(&original, encoding)?;
    if decoded.malformed {
        // A malformed decode already gets its own, more specific warning
        // elsewhere; a drift verdict on top of it would just be redundant
        // noise about the same underlying bytes.
        return Ok(ByteDriftReport::skip(SKIP_MALFORMED));
    }

    // The disk bytes' own line ending, via the same function
    // `open_document` uses -- never the document's current setting (see
    // the module doc; adversarial-review P2). `apply_line_ending` can only
    // re-apply one pure style, so a file that itself mixes styles is
    // inherently unreproducible and skipped.
    let line_ending = encoding::detect_line_ending(&decoded.content);
    if line_ending == "Mixed" {
        return Ok(ByteDriftReport::skip(SKIP_MIXED_LINE_ENDING));
    }

    // The exact save pipeline, in the exact order `lib.rs::save_document`
    // runs it -- reusing its own functions rather than re-deriving the
    // transforms, so this can never quietly drift out of sync with what a
    // real save actually writes.
    let normalized = encoding::normalize_to_lf(&decoded.content);
    let text = encoding::apply_line_ending(&normalized, line_ending);
    let (rebuilt, _unmappable) = encoding::encode(&text, encoding, with_bom)?;

    Ok(ByteDriftReport {
        drift: rebuilt != original,
        skipped: false,
        reason: None,
    })
}

/// IPC entry point (src/ipc.ts's `checkByteDrift`), called at most once per
/// document per session, right before its first save -- see the module doc.
#[tauri::command]
pub fn check_byte_drift(
    path: String,
    encoding: String,
    with_bom: bool,
) -> Result<ByteDriftReport, String> {
    detect_byte_drift(&path, &encoding, with_bom)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes `bytes` to a fresh, uniquely-named temp file for `case` and
    /// returns its path. Mirrors `lib.rs`'s save_document test fixtures --
    /// one directory per test function so parallel `cargo test` runs never
    /// collide.
    fn write_fixture(case: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mojidori-bytedrift-{case}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.txt");
        std::fs::write(&file, bytes).unwrap();
        file
    }

    // --- (1)/(8): issue #96's three directly-verified non-injective byte
    // pairs (same fixture bytes as encoding.rs's
    // `*_non_canonical_bytes_are_canonicalized_on_encode` tests and
    // streamreplace.rs's passthrough-eligibility tests) must each report
    // drift: true -- the core, positive case.

    #[test]
    fn big5_non_injective_pair_reports_drift() {
        let file = write_fixture("big5-non-injective", &[0x8E, 0x69]);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: true,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn shift_jis_non_injective_pair_reports_drift() {
        let file = write_fixture("shiftjis-non-injective", &[0x87, 0x90]);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Shift_JIS", false).unwrap();
        assert!(report.drift && !report.skipped, "{report:?}");

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    #[test]
    fn gbk_non_injective_pair_reports_drift() {
        let file = write_fixture("gbk-non-injective", &[0xA2, 0xE3]);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "GBK", false).unwrap();
        assert!(report.drift && !report.skipped, "{report:?}");

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// The non-injective pair must still be caught when the file's own
    /// line ending is CRLF -- proving the disk-detected line ending feeds
    /// the rebuild correctly (true drift is not masked by, or confused
    /// with, line-ending handling).
    #[test]
    fn big5_non_injective_pair_in_crlf_file_reports_drift() {
        let mut bytes = b"line one\r\n".to_vec();
        bytes.extend_from_slice(&[0x8E, 0x69]);
        bytes.extend_from_slice(b"\r\nline two");
        let file = write_fixture("big5-non-injective-crlf", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: true,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (2): an ordinary, canonical Big5 file must round-trip byte-identical
    /// -- the "no false alarm on the common case" guarantee. LF on disk;
    /// together with the CRLF twin below this pins that the rebuild's line
    /// ending comes from the disk bytes themselves, not from any doc-level
    /// setting (adversarial-review P2: the first version took the doc's
    /// line ending as a parameter, and a Format-menu LF -> CRLF switch made
    /// this exact fixture misreport the user's own reversible conversion as
    /// encoding drift -- red first as
    /// `doc_level_line_ending_conversion_is_not_drift`, then the parameter
    /// was removed entirely).
    #[test]
    fn clean_big5_lf_file_reports_no_drift() {
        let text = "第一行\n第二行\n第三行";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = write_fixture("big5-clean-lf", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: false,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (2b): CRLF twin of the fixture above -- see its doc comment.
    #[test]
    fn clean_big5_crlf_file_reports_no_drift() {
        let text = "第一行\r\n第二行\r\n第三行";
        let (bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let file = write_fixture("big5-clean-crlf", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: false,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (3): pipeline-reconstruction fidelity, not the non-injective-mapping
    /// concern -- windows-1252 is a single-byte encoding with a total,
    /// injective mapping (no #96 issue exists for it), so any drift this
    /// reports could only come from a bug in the rebuild: `normalize_to_lf`
    /// -> `apply_line_ending` with the disk-detected "CRLF" ->
    /// `encode(with_bom)`. `with_bom: true` is exercised too even though
    /// windows-1252 has no BOM concept (`encoding::encode` only ever
    /// prepends one for UTF-8) -- proving that flag can't spuriously
    /// inject bytes for an encoding it doesn't apply to. This is the
    /// anti-false-positive line the module doc's "naive check" paragraph
    /// warns about.
    #[test]
    fn clean_windows1252_crlf_with_bom_flag_reports_no_drift() {
        let text = "café\r\nrésumé\r\nend";
        let (bytes, unmappable) = encoding::encode(text, "windows-1252", false).unwrap();
        assert!(!unmappable);
        let file = write_fixture("windows1252-crlf", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "windows-1252", true).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: false,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (4): classic Mac (lone CR) line endings must round-trip too --
    /// `detect_line_ending`'s "CR" verdict feeding `apply_line_ending`'s
    /// other non-default branch.
    #[test]
    fn clean_windows1252_cr_reports_no_drift() {
        let text = "café\rrésumé\rend";
        let (bytes, unmappable) = encoding::encode(text, "windows-1252", false).unwrap();
        assert!(!unmappable);
        let file = write_fixture("windows1252-cr", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "windows-1252", false).unwrap();
        assert_eq!(
            report,
            ByteDriftReport {
                drift: false,
                skipped: false,
                reason: None
            }
        );

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (5): a file whose own on-disk bytes mix line-ending styles is
    /// skipped -- `apply_line_ending` re-applies one pure style, so the
    /// rebuild is inherently unreproducible for it and a drift verdict
    /// would conflate line-ending unification with encoding
    /// canonicalization. Detected from the disk bytes (P2: no doc-level
    /// line ending exists in this API anymore). ASCII is a valid Big5
    /// subset, so this fixture decodes cleanly and reaches the detection
    /// step rather than the malformed skip.
    #[test]
    fn mixed_line_ending_on_disk_is_skipped() {
        let file = write_fixture("mixed-on-disk", b"one\r\ntwo\nthree\r\n");
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(report, ByteDriftReport::skip(SKIP_MIXED_LINE_ENDING));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    /// (6): UTF-8/UTF-16 targets are unconditionally skipped -- issue #96
    /// is specifically about legacy multi-byte encodings' non-injective
    /// mappings; UTF-8/UTF-16 are always 1:1 (same precedent as
    /// `normalize::is_always_representable`). This never even touches the
    /// filesystem (the path below is never created), which this test's
    /// success itself demonstrates: a real `std::fs::read` would fail with
    /// an `Err`, not the `Ok(skipped: true)` asserted here.
    #[test]
    fn unicode_encodings_are_skipped_without_touching_disk() {
        let unreadable =
            crate::testutil::temp_path("mojidori-bytedrift-unicode-should-not-be-read")
                .join("doc.txt");
        for label in ["UTF-8", "UTF-16LE", "UTF-16BE"] {
            let report = detect_byte_drift(&unreadable.to_string_lossy(), label, false).unwrap();
            assert_eq!(
                report,
                ByteDriftReport::skip(SKIP_UNICODE_ENCODING),
                "{label}"
            );
        }
    }

    /// (7): a file that doesn't decode cleanly in the requested encoding is
    /// skipped -- a more specific malformed-content warning already exists
    /// elsewhere; a drift verdict on top would be redundant noise about the
    /// same underlying bytes. Same stray-0x80-byte technique as
    /// `streamreplace.rs::malformed_file_aborts_untouched` (0x80 is below
    /// Big5's lead-byte floor of 0x81 and not a valid trail byte either).
    #[test]
    fn malformed_content_is_skipped() {
        let text = "正常的中文內容在這裡，這是一段測試文字。";
        let (mut bytes, unmappable) = encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let insert_at = bytes.len() / 2;
        bytes.insert(insert_at, 0x80);
        let (_, malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(malformed, "fixture must actually be malformed as Big5");

        let file = write_fixture("big5-malformed", &bytes);
        let path = file.to_string_lossy().into_owned();

        let report = detect_byte_drift(&path, "Big5", false).unwrap();
        assert_eq!(report, ByteDriftReport::skip(SKIP_MALFORMED));

        std::fs::remove_dir_all(file.parent().unwrap()).ok();
    }

    // The P2 red test (`doc_level_line_ending_conversion_is_not_drift`:
    // clean Big5 LF disk file + a doc-level "CRLF" parameter must not be
    // drift -- it failed with drift: true) forced this API's line_ending
    // parameter out entirely; the scenario is now unexpressible by
    // construction, and the LF/CRLF clean-fixture twins above pin the
    // disk-side detection that replaced it.

    /// Matches `encoding::encode`/`normalize::check_representability`'s own
    /// contract for an unrecognized label.
    #[test]
    fn unknown_encoding_label_errors() {
        assert!(detect_byte_drift("/irrelevant", "not-an-encoding", false).is_err());
    }
}
