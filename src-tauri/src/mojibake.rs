//! Mojibake repair: detect "bytes decoded with the wrong encoding, then
//! saved back to disk" round-trips and offer a previewed, reversible fix.
//!
//! The shape of the bug this repairs: a file's *real* bytes were originally
//! `original`-encoded text. Something (an editor, a script, a browser)
//! opened those bytes using the wrong encoding, `intermediate`, producing
//! garbled but still-valid-looking text -- mojibake -- and that garbled
//! text got saved, so the bytes on disk now really are `intermediate`'s
//! encoding of the mojibake. To undo it: take the mojibake text the user
//! sees and *encode* it with `intermediate` (this losslessly reconstructs
//! the original bytes, because that is exactly the byte sequence
//! `intermediate` decoded to produce this text in the first place), then
//! *decode* those bytes with `original` (the encoding they actually were
//! all along). Example: Big5 bytes opened as Windows-1252 and re-saved --
//! encoding the garbled text back to Windows-1252 recovers the original
//! Big5 bytes, and decoding those as Big5 recovers the real text.
//!
//! This module never touches disk and never emits a raw byte over IPC
//! (ARCHITECTURE.md's hard constraints): it operates purely on the
//! in-memory document string the frontend already holds, and always
//! returns decoded `String`s. The repaired text becomes an unsaved editor
//! change (undoable, not auto-saved) -- reversibility is the caller's
//! responsibility, this module only ever computes the candidate/result.

use chardetng::EncodingDetector;
use encoding_rs::{
    Encoding, BIG5, EUC_JP, EUC_KR, GB18030, GBK, KOI8_R, KOI8_U, SHIFT_JIS, UTF_8, WINDOWS_1250,
    WINDOWS_1251, WINDOWS_1252, WINDOWS_1253, WINDOWS_1256, WINDOWS_1258,
};
use serde::Serialize;

/// Candidate "wrong" encodings bytes may have been mis-decoded with.
///
/// `ISO-8859-1` is deliberately not listed here. In encoding_rs (which
/// implements the WHATWG Encoding Standard), every ISO-8859-1 label --
/// "iso-8859-1", "latin1", "l1", "iso_8859-1", "csisolatin1", ... -- is
/// verified (against encoding_rs 0.8.35's own `LABELS_SORTED` /
/// `ENCODINGS_IN_LABEL_SORT` label table) to resolve to the exact same
/// `&'static Encoding` as the "windows-1252" label: both point at
/// `WINDOWS_1252_INIT`, i.e. `Encoding::for_label(b"iso-8859-1") ==
/// Encoding::for_label(b"windows-1252")`. This is intentional upstream --
/// the Encoding Standard requires content labeled ISO-8859-1 on the web to
/// actually be decoded as Windows-1252 for legacy-web compatibility -- so
/// there is no separate "true Latin-1" decoder available to offer as a
/// distinct candidate here; listing both labels would just enter the
/// identical hypothesis twice.
/// The `(intermediate, original)` hypotheses worth testing, restricted to
/// mis-decode shapes that actually occur in the wild:
///
/// 1. East Asian or UTF-8 bytes opened by a Western tool whose default is
///    Windows-1252 (the dominant real-world case),
/// 2. UTF-8 bytes opened on a system defaulting to a CJK legacy encoding,
///    and
/// 3. Windows-1251 bytes opened by a tool defaulting to KOI8-R (issue
///    #182) -- the classic Runet "кракозябры" mojibake, from the decades
///    where Unix/Fidonet mail and web tooling defaulted to KOI8-R while
///    Windows defaulted to windows-1251.
///
/// Legacy-CJK ↔ legacy-CJK pairs (e.g. GBK-encode → Big5-decode) are
/// deliberately absent: adversarial review demonstrated that perfectly
/// valid Japanese text passes every structural gate for (GBK, Big5) —
/// clean encode, clean decode, zero U+FFFD, chardetng agreement — while
/// producing garbage, because the CJK legacy encodings overlap enough that
/// chardetng's frequency model cannot referee between them on re-encoded
/// text. The real-world scenario they would repair (a CJK file mis-opened
/// under another CJK encoding, then re-saved) is also vanishingly rare:
/// the result is full-screen garbage nobody keeps working in. Narrow and
/// right beats broad and wrong for a repair tool.
///
/// `(WINDOWS_1251, KOI8_R)` -- the reverse of the pair below, i.e. genuine
/// KOI8-R bytes mis-decoded as windows-1251 -- is deliberately absent, and
/// for a *structural*, not just statistical, reason this time: chardetng
/// 0.1.17 has no KOI8-R candidate in its detection model at all, only
/// KOI8-U (its README's "Notes About Encodings" lists "KOI8-R: Detected as
/// KOI8-U (Always guessing the U variant is less likely to corrupt
/// non-box drawing characters.)"; confirmed directly against the crate's
/// `SINGLE_BYTE_DATA` table, which has 21 candidates and no `KOI8_R_INIT`
/// among them; `src/encodings.ts`'s `MANUAL_ONLY_ENCODINGS` documents the
/// identical fact for this app's own open-file auto-detect). Gate (c)
/// below requires chardetng's cold guess on the recovered bytes to equal
/// `original`; when `original` is `KOI8_R` that comparison can *never*
/// succeed, for any input whatsoever -- verified empirically too: genuine
/// KOI8-R text mis-decoded as windows-1251 structurally passes gates (a)
/// and (b) (clean encode, clean decode) but chardetng still guesses
/// KOI8-U on the recovered bytes, so gate (c) rejects it every time. Since
/// this wizard's UI only ever offers candidates `detect_mojibake` returns
/// (`src/mojibake.ts`'s `showMojibakeWizard` has no manual pair picker),
/// an `original: KOI8_R` entry would be permanently unreachable dead code
/// -- not a working-but-rare hypothesis, a candidate that can *never*
/// appear.
///
/// ISO-8859-5 hypotheses (`windows-1251`/`KOI8-R` ↔ `ISO-8859-5`) were
/// evaluated for issue #182 and left out too: ISO-8859-5 is the least
/// common of the three encodings in real-world Cyrillic mojibake (curated
/// per E1 mainly for IANA mail-standard completeness), and empirically the
/// (windows-1251, ISO-8859-5) / (ISO-8859-5, windows-1251) pairing is
/// actively ambiguous rather than merely lower-priority: genuine
/// ISO-8859-5 bytes mis-decoded as windows-1251 pass every gate --
/// including chardetng agreement -- under *both* the correct hypothesis
/// and the reversed, wrong one, and the wrong one recovers a different,
/// incorrect text. Two structurally-clean-but-contradictory candidates for
/// the same input is exactly the ambiguity the CJK exclusion above avoids;
/// adding this pairing would reintroduce that failure mode rather than
/// widen coverage, and would do so specifically for the rarest of the
/// three encodings. See this module's
/// `windows1251_iso88595_hypotheses_are_mutually_ambiguous` test for the
/// reproducing case.
///
/// `(WINDOWS_1252, EUC_JP)` -- genuine EUC-JP bytes mis-decoded as
/// windows-1252 -- was evaluated for ROADMAP v0.6 E2 and passed both
/// required gates, so unlike the three exclusions just above, this one
/// was *included*. Gate 1 (reachability): chardetng 0.1.17 carries a
/// real, positively-detected EUC-JP candidate (`EucJpCandidate` /
/// `EUC_JP_INDEX` in its `src/lib.rs`; its README lists EUC-JP under
/// "Detected: Historical locale-specific fallbacks", not aliased away the
/// way GB18030->GBK or KOI8-R->KOI8-U are) -- structurally unlike the
/// absent-candidate KOI8-R case above, so this hypothesis is reachable in
/// principle, confirmed empirically on diverse real Japanese text by
/// `repairs_eucjp_misdecoded_as_windows1252`. Gate 2 (mutual ambiguity):
/// unlike the ISO-8859-5 case just above, the reversed hypothesis,
/// (EUC_JP, WINDOWS_1252), does not also pass on the same genuine-EUC-JP-
/// as-1252 mojibake (`windows1252_eucjp_reverse_hypothesis_is_rejected`);
/// legitimate windows-1252 Western-European prose does not trigger this
/// pair either (`no_candidates_for_normal_western_european_text`); and it
/// does not shadow the existing Big5/Shift_JIS pairs' correct hits on
/// their own genuine mojibake
/// (`windows1252_eucjp_pair_does_not_shadow_existing_cjk_pairs`).
///
/// **ROADMAP v0.7 Track E mojibake-pair investigation batch** evaluated
/// five more candidates with the same dual-gate process, cheapest-death-
/// first per the planning review; all five passed and were admitted --
/// this batch, unlike issue #182's and v0.6 E2's, found no rejections.
///
/// `(WINDOWS_1251, UTF_8)` -- Cyrillic UTF-8 mis-decoded as windows-1251,
/// the same shape as the already-admitted `(WINDOWS_1252, UTF_8)`.
/// windows-1251 is a "total" single-byte decoder like windows-1252
/// (confirmed empirically: decoding every byte 0x00..=0xFF individually
/// reports zero malformed sequences), so gate 1 reduces to chardetng
/// recognizing UTF-8 on the recovered bytes -- reliable given
/// `allow_utf8: true` -- confirmed by `repairs_utf8_misdecoded_as_
/// windows1251`. Gate 2: the reverse, `(UTF_8, WINDOWS_1251)`, is rejected
/// (`windows1251_utf8_reverse_hypothesis_is_rejected`); real Cyrillic text
/// doesn't trigger it (`no_candidates_for_normal_cyrillic_excludes_
/// windows1251_utf8_pair`); and it doesn't shadow the structurally similar
/// windows-1250/windows-1252 single-byte pairs in either direction
/// (`windows1251_utf8_pair_does_not_shadow_sibling_single_byte_pairs`) --
/// Cyrillic and Western/Central-European Latin repertoires don't overlap,
/// so gate (a) alone separates them.
///
/// `(EUC_KR, UTF_8)` and `(EUC_JP, UTF_8)` -- UTF-8 mis-decoded as a
/// legacy CJK double-byte encoding, the same shape as the already-admitted
/// `(BIG5, UTF_8)`/`(GBK, UTF_8)`/`(SHIFT_JIS, UTF_8)`. Both EUC-KR and
/// EUC-JP are genuine, positively-detected chardetng candidates (not
/// aliased away). Gate 1 needed the same care those three pairs already
/// required: genuine 3-byte-UTF-8 Korean/Japanese text essentially never
/// forms valid 2-byte EUC lead/trail pairs by chance (confirmed
/// empirically: EUC-KR/EUC-JP decoding of native Korean/Japanese sentences
/// reports `malformed`), so -- exactly like the Big5/GBK/Shift_JIS pairs
/// before them -- the fixture that actually clears gates (a)+(b) is
/// `LATIN1_SUPPLEMENT_TEXT` (2-byte-UTF-8-range accented Latin, already
/// used for Big5/GBK/Shift_JIS; confirmed by direct byte-range probing
/// that lead `0xC3`/trail `0xA1..=0xBF` -- the exact shape that fixture is
/// built from -- is also valid EUC-JP and EUC-KR structure), not native
/// Korean/Japanese prose. The real-world scenario these two pairs repair
/// is therefore the same as their three CJK siblings': "a UTF-8 document
/// with occasional Western-accented characters, opened by a tool
/// defaulting to EUC-KR/EUC-JP", not "Korean/Japanese text misread".
/// Confirmed by `repairs_utf8_misdecoded_as_euckr`/`_eucjp`. Gate 2: both
/// reverses rejected (`euckr_utf8_reverse_hypothesis_is_rejected`,
/// `eucjp_utf8_reverse_hypothesis_is_rejected`); real Korean/Japanese text
/// doesn't trigger either (`no_candidates_for_normal_korean_excludes_
/// euckr_utf8_pair`, `no_candidates_for_normal_japanese_excludes_eucjp_
/// utf8_pair`); and neither shadows the other, the three existing
/// `(*, UTF_8)` CJK pairs, or the existing `(WINDOWS_1252, EUC_KR)`/
/// `(WINDOWS_1252, EUC_JP)` pairs that use EUC-KR/EUC-JP in the opposite
/// role (`euckr_utf8_pair_does_not_shadow_other_cjk_pairs`, `eucjp_utf8_
/// pair_does_not_shadow_other_cjk_pairs`).
///
/// `(WINDOWS_1250, UTF_8)` -- Central European UTF-8 mis-decoded as
/// windows-1250, the fourth single-byte-Latin `(*, UTF_8)` pair. Gate 1
/// reachability was double-checked directly against chardetng 0.1.17's
/// source (not just its README): `WINDOWS_1250_INDEX = 1` in
/// `src/data.rs`'s `SINGLE_BYTE_DATA` table, backed by `WINDOWS_1250_INIT`
/// -- a real, distinct candidate, not aliased away the way GB18030->GBK or
/// KOI8-R->KOI8-U are. windows-1250 is also a total single-byte decoder,
/// so as with windows-1251 above, gate 1 in practice reduces to chardetng
/// recognizing the recovered UTF-8 bytes -- confirmed by
/// `repairs_utf8_misdecoded_as_windows1250`. Gate 2: reverse rejected
/// (`windows1250_utf8_reverse_hypothesis_is_rejected`); real Central
/// European text doesn't trigger it -- a genuinely new false-positive
/// surface this batch had to cover, since no existing test used Central
/// European script before (`no_candidates_for_normal_central_european_
/// text`); and it doesn't shadow windows-1251/windows-1252 in either
/// direction (`windows1250_utf8_pair_does_not_shadow_sibling_single_byte_
/// pairs`).
///
/// `(KOI8_U, WINDOWS_1251)` -- genuine windows-1251 bytes (including
/// Ukrainian-specific letters і/ї/є/ґ) mis-decoded as KOI8-U -- the
/// Ukrainian-locale counterpart to issue #182's `(KOI8_R, WINDOWS_1251)`.
/// Unlike KOI8-R, chardetng 0.1.17 has a real KOI8-U candidate
/// (`KOI8_U_INDEX = 4` in `SINGLE_BYTE_DATA`), so this pair is not
/// structurally blocked the way a `KOI8_R` `original` is -- confirmed by
/// `repairs_windows1251_misdecoded_as_koi8u`. Gate 2 was the real question
/// here (planning review flagged this as the pair most likely to repeat
/// the `(WINDOWS_1251, ISO_8859_5)` mutual-ambiguity failure, since KOI8-U
/// and windows-1251 are both real chardetng targets): empirically, the
/// reverse, `(WINDOWS_1251, KOI8_U)`, is rejected on every fixture tried,
/// including plain `RUSSIAN_TEXT` with no Ukrainian-specific letters at
/// all, and the mechanism traces to a *structural* gate (a) rejection, not
/// merely a statistical one -- KOI8-U inherits KOI8-R's legacy
/// box-drawing characters at several byte positions windows-1251 uses for
/// real letters (Ё/ё among them), and windows-1251 cannot re-encode a
/// box-drawing character. Even the adversarial worst case that dodges
/// every such byte (the bare repeated alphabet) still fails at gate (c):
/// with no real word/bigram structure, chardetng doesn't recognize it as
/// any specific Cyrillic encoding at all. Full detail in
/// `koi8u_windows1251_reverse_hypothesis_is_rejected`'s doc comment; real
/// Ukrainian text doesn't false-positive either
/// (`no_candidates_for_normal_ukrainian_text`). One benign interaction
/// with the existing KOI8-R pair, documented rather than hidden: for
/// plain-Russian mojibake (no і/ї/є/ґ), both `(KOI8_R, WINDOWS_1251)` and
/// this new pair can legitimately match the same input -- but both recover
/// the identical, correct text (KOI8-R and KOI8-U share their core
/// Cyrillic-letter layout), so this is a redundant-candidate UX footnote,
/// not the wrong-repair hazard the ISO-8859-5 case was
/// (`koi8u_windows1251_pair_does_not_shadow_existing_koi8r_pair`).
///
/// `(WINDOWS_1256, UTF_8)` -- Arabic UTF-8 mis-decoded as windows-1256,
/// the sixth single-byte-Latin/Cyrillic-shaped `(*, UTF_8)` pair (the
/// first non-Latin-script one). windows-1256 is a total single-byte
/// decoder like windows-1250/1251/1252 (confirmed empirically: decoding
/// every byte 0x00..=0xFF individually reports zero malformed sequences),
/// so gate 1 reduces to chardetng recognizing UTF-8 on the recovered
/// bytes -- confirmed by `repairs_utf8_misdecoded_as_windows1256`. Gate 2:
/// the reverse, `(UTF_8, WINDOWS_1256)`, is rejected
/// (`windows1256_utf8_reverse_hypothesis_is_rejected`); real Arabic text
/// doesn't trigger it (`no_candidates_for_normal_arabic_text`); and it
/// doesn't shadow the sibling single-byte pairs, or the other two new
/// pairs in this same batch, in either direction
/// (`windows1256_utf8_pair_does_not_shadow_sibling_single_byte_pairs`,
/// `new_windows125x_pairs_do_not_shadow_each_other`) -- Arabic's
/// repertoire doesn't overlap Cyrillic or Central/Western European Latin.
///
/// `(WINDOWS_1258, UTF_8)` -- Vietnamese UTF-8 mis-decoded as
/// windows-1258, same shape as `(WINDOWS_1256, UTF_8)` (also a total
/// single-byte decoder). Confirmed by
/// `repairs_utf8_misdecoded_as_windows1258`; reverse rejected
/// (`windows1258_utf8_reverse_hypothesis_is_rejected`); no false positive
/// on real Vietnamese (`no_candidates_for_normal_vietnamese_text`); no
/// shadowing (`windows1258_utf8_pair_does_not_shadow_sibling_single_byte_
/// pairs`, `new_windows125x_pairs_do_not_shadow_each_other`).
/// `docs/archive/roadmap-completed-cycles.md`'s v0.5 Track E1 record notes
/// windows-1258's single-byte path does no Unicode normalization, so a
/// combining-character non-injectivity concern was raised and held off
/// there for the unrelated round-trip-fuzz encode-filter pool; it does not
/// apply here either, for the same reason: `encoding_rs::encode()` never
/// normalizes, so only precomposed Vietnamese letters -- exactly what
/// `VIETNAMESE_TEXT` is written with, the only form Rust source text
/// naturally produces -- ever reach the encoder, and this pair's own
/// forward test empirically confirms the full round trip on that text.
///
/// `(WINDOWS_1253, UTF_8)` -- Greek UTF-8 mis-decoded as windows-1253.
/// Unlike the two pairs just above, windows-1253 is *not* a total
/// single-byte decoder: three byte values (`0xAA`, `0xD2`, `0xFF`) are
/// unassigned (confirmed empirically). `GREEK_TEXT`'s doc comment works
/// out why none of the three are reachable from its content (0xFF can
/// never appear in valid UTF-8 at all; 0xD2 would require a lead byte
/// outside the Greek-and-Coptic block's UTF-8 lead-byte range entirely;
/// 0xAA as a trail byte only arises from two rare letters not used in the
/// fixture), and `repairs_utf8_misdecoded_as_windows1253` empirically
/// confirms the decode is clean. Gate 2: reverse rejected
/// (`windows1253_utf8_reverse_hypothesis_is_rejected`); no false positive
/// on real Greek (`no_candidates_for_normal_greek_text`); no shadowing
/// (`windows1253_utf8_pair_does_not_shadow_sibling_single_byte_pairs`,
/// `new_windows125x_pairs_do_not_shadow_each_other`).
///
/// This three-pair batch (ROADMAP v0.9 B1) was evaluated against six
/// windows-125x-family candidates chardetng 0.1.17 has no coverage for
/// yet, capped at three per batch; the other three:
/// - `(WINDOWS_1255, UTF_8)` (Hebrew) passed every gate identically to the
///   three admitted here, and is next in line for a future batch -- left
///   out purely for this batch's 3-pair cap, not any structural concern.
/// - `(WINDOWS_1254, UTF_8)` (Turkish) also passed every gate, but was
///   deprioritized: windows-1254 and windows-1252 differ at only 8 of 256
///   byte positions, with disjoint character assignments at each (so the
///   two hypotheses can never both cleanly pass and disagree -- the same
///   benign-duplicate shape as the KOI8-R/KOI8-U pair above, not the
///   ISO-8859-5 hazard), meaning most real Turkish mojibake already
///   resolves correctly via the existing `(WINDOWS_1252, UTF_8)` pair;
///   admitting this one would mostly just add a redundant candidate.
/// - `(WINDOWS_1257, UTF_8)` (Baltic) was rejected outright, not merely
///   deprioritized: chardetng 0.1.17's own README states its windows-1257
///   detection "is very inaccurate" (it doesn't use trigrams for it), and
///   empirically windows-1257's two gap bytes (`0xA1`, `0xA5`) land inside
///   the UTF-8 continuation-byte range -- a real, realistic Baltic-script
///   fixture failed gate 1 (reachability) outright in the investigation
///   probe, not just rarely.
///
/// `pub(crate)` so `fuzz_roundtrip.rs`'s reversibility fuzz can iterate
/// this exact list instead of maintaining a separately-drifting copy.
pub(crate) const REPAIR_PAIRS: [(&Encoding, &Encoding); 18] = [
    (WINDOWS_1252, UTF_8),
    (WINDOWS_1252, BIG5),
    (WINDOWS_1252, GB18030),
    (WINDOWS_1252, SHIFT_JIS),
    (WINDOWS_1252, EUC_KR),
    // ROADMAP v0.6 E2: see the doc comment above for the two-gate
    // evaluation this pair passed.
    (WINDOWS_1252, EUC_JP),
    (BIG5, UTF_8),
    (GBK, UTF_8),
    (SHIFT_JIS, UTF_8),
    // Issue #182: genuine windows-1251 bytes mis-decoded as KOI8-R --
    // see the doc comment above for why only this direction is listed.
    (KOI8_R, WINDOWS_1251),
    // ROADMAP v0.7 Track E mojibake-pair investigation batch: see the
    // doc comment above for each pair's two-gate evaluation.
    (WINDOWS_1251, UTF_8),
    (EUC_KR, UTF_8),
    (EUC_JP, UTF_8),
    (WINDOWS_1250, UTF_8),
    (KOI8_U, WINDOWS_1251),
    // ROADMAP v0.9 Track B1 mojibake-pair investigation batch: see the
    // doc comment above for each pair's two-gate evaluation and the
    // rejected/deferred candidates from the same investigation.
    (WINDOWS_1256, UTF_8),
    (WINDOWS_1258, UTF_8),
    (WINDOWS_1253, UTF_8),
];

/// `detect_mojibake` samples at most this many bytes of `content`.
/// `apply_mojibake_repair` always runs the same round trip over the full
/// text, never just the sample -- see its doc comment.
const SAMPLE_BYTES: usize = 64 * 1024;

/// `RepairCandidate::preview` shows at most this many characters.
const PREVIEW_CHARS: usize = 200;

/// At most this many candidates are ever returned, strongest first.
const MAX_CANDIDATES: usize = 5;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepairCandidate {
    /// The wrong encoding the bytes were mis-decoded with, e.g. "windows-1252".
    pub intermediate: String,
    /// The encoding the bytes actually are, e.g. "Big5".
    pub original: String,
    /// First ~200 characters of the repaired text (char-boundary safe).
    pub preview: String,
    /// Heuristic count of characters that differ between the current
    /// (mojibake) sample and this candidate's repaired sample -- see
    /// `count_char_differences`. Used to rank candidates (higher first)
    /// and to give the UI a concrete "this changes about N characters"
    /// number.
    pub replacement_count: usize,
}

/// The longest prefix of `s` that is at most `max_bytes` long and ends on a
/// UTF-8 character boundary. `str::is_char_boundary(0)` is always `true`,
/// so this loop always terminates, even for content that is one giant
/// character run straddling the cut point.
fn char_boundary_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// First `max_chars` Unicode scalar values of `s` -- trivially char-boundary
/// safe since it walks `chars()` rather than slicing bytes.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// Rough "is this character East Asian" test: CJK ideographs (plus the
/// Extension-A block and the compatibility block), hiragana/katakana, and
/// Hangul syllables. This is a sort tiebreaker, not an exhaustive Unicode
/// block classification.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // Hiragana, Katakana
        | 0x3400..=0x4DBF // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF // CJK Unified Ideographs
        | 0xAC00..=0xD7A3 // Hangul syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
    )
}

/// Fraction of `text`'s characters that are East Asian. Only used to break
/// ties between candidates that repair a sample equally well by
/// `replacement_count`: East Asian mojibake is this feature's primary
/// scenario, so given two equally-plausible repairs, the one recovering
/// more CJK text is more likely to be the right one.
fn cjk_ratio(text: &str) -> f64 {
    let total = text.chars().count();
    if total == 0 {
        return 0.0;
    }
    let cjk = text.chars().filter(|&c| is_cjk(c)).count();
    cjk as f64 / total as f64
}

/// Heuristic "how many characters would change" between the current
/// mojibake sample and a candidate's repaired sample: a plain positional
/// comparison, counting a mismatch at every position the two differ plus
/// one for every character of any trailing length difference. This is not
/// a true edit-distance diff, but mojibake corrupts nearly every
/// multi-byte character in the affected run, so this coarse count already
/// tracks "how much of the text is actually being fixed" well enough to
/// rank candidates and to show the user a concrete number.
fn count_char_differences(a: &str, b: &str) -> usize {
    let mut ac = a.chars();
    let mut bc = b.chars();
    let mut count = 0usize;
    loop {
        match (ac.next(), bc.next()) {
            (None, None) => break,
            (Some(x), Some(y)) => {
                if x != y {
                    count += 1;
                }
            }
            _ => count += 1,
        }
    }
    count
}

/// Decode `bytes` as `enc`, tolerating an incomplete multi-byte sequence
/// at the very end only: trims 0–3 trailing bytes (GB18030's longest
/// sequence is 4) until the remainder decodes with zero malformed
/// sequences. Returns the decoded text plus the byte length that decoded
/// cleanly; `None` when no trim length yields a clean decode — i.e. the
/// damage is interior, which genuinely refutes the hypothesis rather than
/// being a sampling artifact.
fn decode_tolerating_truncated_tail(
    bytes: &[u8],
    enc: &'static Encoding,
) -> Option<(String, usize)> {
    for trim in 0..=3usize.min(bytes.len()) {
        let end = bytes.len() - trim;
        let (decoded, malformed) = enc.decode_without_bom_handling(&bytes[..end]);
        if !malformed {
            return Some((decoded.into_owned(), end));
        }
    }
    None
}

/// Try one `(intermediate, original)` hypothesis against `sample`. Returns
/// the repaired text and its CJK ratio when every quality gate passes,
/// `None` the moment any gate rejects the hypothesis.
fn try_repair(
    sample: &str,
    intermediate: &'static Encoding,
    original: &'static Encoding,
) -> Option<(String, f64)> {
    // Gate (a): `sample` must be exactly representable in `intermediate`.
    // If any character can't be, `sample` cannot possibly be
    // `intermediate`'s decoding of anything, so this hypothesis is wrong
    // on its face.
    let (bytes, _, unmappable) = intermediate.encode(sample);
    if unmappable {
        return None;
    }
    // Gate (b): the recovered bytes must decode cleanly as `original`.
    // `decode_without_bom_handling` is used deliberately instead of
    // `decode` (which sniffs a BOM and can silently swap encodings, e.g.
    // jumping from UTF-8 to UTF-16 on a stray `FF FE`) or
    // `decode_with_bom_removal` (irrelevant: these recovered bytes never
    // legitimately carry an original-file BOM at this point -- if the
    // original bytes had genuinely started with one, auto-detection would
    // have caught it long before this content ever became mojibake).
    //
    // The sample path tolerates a truncated *tail* only: the char-boundary
    // sample cut lands mid-character in the *recovered* byte stream about
    // half the time for CJK mojibake (each garbled character re-encodes to
    // part of a multi-byte sequence), and without this tolerance every
    // >SAMPLE_BYTES document would silently detect nothing — an artifact
    // of sampling, not evidence against the hypothesis. Interior damage
    // still rejects: trimming at most 3 bytes (GB18030's longest sequence
    // is 4) must yield a perfectly clean decode. `apply_mojibake_repair`
    // runs the full text with no tolerance at all.
    let (repaired, clean_len) = decode_tolerating_truncated_tail(&bytes, original)?;
    // Gate (c): no replacement characters (implied by `!malformed` above,
    // but checked explicitly since it is the actual promise being made to
    // the caller), and chardetng -- fed the same bytes cold, independent
    // of this hypothesis -- must independently agree the bytes are
    // `original`. This is what rejects "structurally clean but
    // statistically wrong" hypotheses: e.g. genuine Big5 text
    // re-interpreted as GB18030 can sometimes decode without a single
    // malformed sequence, but chardetng's frequency model still tells the
    // two apart. Gatekeeper order matters, though: for the
    // (windows-1252, multi-byte-CJK) family it is the *structural* gate
    // above -- the re-encoded high bytes must form valid, contiguous
    // multi-byte sequences, which real Western prose (accents separated
    // by ASCII/spaces) never does -- that rejects nearly everything;
    // chardetng alone would accept a measurable share of dense
    // high-byte-only strings (adversarial review measured ~7% of random
    // contiguous A1-FE even-length strings passing it for EUC-JP), so a
    // future relaxation of the structural gate must not lean on
    // chardetng as the sole remaining referee.
    if repaired.contains('\u{FFFD}') {
        return None;
    }
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes[..clean_len], true);
    if detector.guess(None, true) != original {
        return None;
    }
    let ratio = cjk_ratio(&repaired);
    Some((repaired, ratio))
}

/// Detect candidate mojibake repairs for `content`. Samples at most
/// `SAMPLE_BYTES` (char-boundary safe) so this stays cheap even for large
/// documents; the repair itself, in `apply_mojibake_repair`, always runs
/// over the full text. Returns at most `MAX_CANDIDATES` candidates, ranked
/// by `replacement_count` descending, then by post-repair CJK ratio
/// descending.
#[tauri::command]
pub fn detect_mojibake(content: String) -> Vec<RepairCandidate> {
    let sample = char_boundary_prefix(&content, SAMPLE_BYTES);
    let mut scored: Vec<(RepairCandidate, f64)> = Vec::new();

    for &(intermediate, original) in REPAIR_PAIRS.iter() {
        let Some((repaired, ratio)) = try_repair(sample, intermediate, original) else {
            continue;
        };
        // Gate (d): no visible change means this pair -- however
        // structurally valid -- does not actually repair anything
        // (pure ASCII round-trips identically through every candidate
        // pair here); never offer a no-op "repair".
        if repaired == sample {
            continue;
        }
        let replacement_count = count_char_differences(sample, &repaired);
        let preview = truncate_chars(&repaired, PREVIEW_CHARS);
        scored.push((
            RepairCandidate {
                intermediate: intermediate.name().to_string(),
                original: original.name().to_string(),
                preview,
                replacement_count,
            },
            ratio,
        ));
    }

    scored.sort_by(|(a, a_ratio), (b, b_ratio)| {
        b.replacement_count.cmp(&a.replacement_count).then_with(|| {
            b_ratio
                .partial_cmp(a_ratio)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    scored.truncate(MAX_CANDIDATES);
    scored.into_iter().map(|(candidate, _)| candidate).collect()
}

/// Re-run the same encode/decode round trip `detect_mojibake` previewed,
/// but over the *entire* document text -- and fail loudly instead of
/// silently corrupting anything. A detection sample (at most
/// `SAMPLE_BYTES`) passing every gate does not guarantee the rest of a
/// large document has no character `intermediate` can't encode, or no byte
/// sequence `original` can't decode; this is the actual safety net for
/// that gap. Never writes to disk -- the caller decides what to do with
/// the returned text (ARCHITECTURE.md: the frontend owns in-memory text,
/// the user decides when to save).
#[tauri::command]
pub fn apply_mojibake_repair(
    content: String,
    intermediate: String,
    original: String,
) -> Result<String, String> {
    let intermediate_enc = Encoding::for_label(intermediate.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {intermediate}"))?;
    let original_enc = Encoding::for_label(original.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {original}"))?;

    let (bytes, _, unmappable) = intermediate_enc.encode(&content);
    if unmappable {
        return Err(format!(
            "Some characters in the document can't be represented in {intermediate}; \
             repairing would lose data, so nothing was changed."
        ));
    }
    let (repaired, malformed) = original_enc.decode_without_bom_handling(&bytes);
    if malformed {
        return Err(format!(
            "The recovered bytes are not valid {original}; repairing would corrupt \
             the document, so nothing was changed."
        ));
    }
    Ok(repaired.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic, reasonably long Traditional Chinese sample -- the same
    /// fixture `encoding.rs`'s own `detects_big5_from_realistic_sample`
    /// test uses, since it is already proven to be reliably chardetng-
    /// detected as Big5 (statistical detection needs a realistic amount of
    /// text; a few bytes are genuinely ambiguous across legacy encodings).
    const BIG5_TEXT: &str =
        "中文編碼偵測測試。這是一段用來驗證繁體中文自動偵測的文字，包含標點符號與常用詞彙。";

    /// Reasonably long Japanese sample mixing kanji, hiragana and
    /// katakana, mirroring `BIG5_TEXT`'s shape for Shift_JIS.
    const SHIFT_JIS_TEXT: &str = "日本語文字エンコーディングの検出テストです。これは自動検出機能を検証するための文章であり、句読点や一般的な語彙も含まれています。";

    /// Realistic Russian sample for the Cyrillic hypothesis (issue #182):
    /// a classic Russian pangram ("Съешь же ещё этих мягких французских
    /// булок, да выпей чаю" -- "Eat some more of these soft French rolls,
    /// and drink some tea", used precisely because it exercises every
    /// letter of the modern Cyrillic alphabet) plus a second sentence for
    /// length, mirroring `BIG5_TEXT`/`SHIFT_JIS_TEXT`'s "realistic amount
    /// of text" reasoning. Deliberately ASCII-punctuation-only (plain `.`
    /// and `,`, no curly quotes or "№") so it is exactly representable in
    /// windows-1251, KOI8-R, *and* ISO-8859-5 alike -- confirmed
    /// empirically while evaluating this issue, and depended on by the
    /// ISO-8859-5-ambiguity regression test below, which needs the same
    /// text clean-encodable in all three.
    const RUSSIAN_TEXT: &str = "Съешь же ещё этих мягких французских булок, да выпей чаю. Это пример текста для проверки кодировки после перекодирования.";

    /// Western-European accented text built only from lowercase Latin-1
    /// Supplement characters U+00E1..=U+00FF. Restricting to this range is
    /// deliberate: each such character is exactly 2 UTF-8 bytes `C3 xx`
    /// with `xx` in `A1..=BF`, which is simultaneously a valid Big5
    /// lead/trail byte pair (Big5 lead bytes span `81..=FE`, trail bytes
    /// span `40..=7E` and `A1..=FE`) -- so this text's raw UTF-8 bytes are
    /// *guaranteed* to Big5-decode without a single malformed sequence,
    /// which `repairs_utf8_misdecoded_as_big5` depends on. (Codepoints
    /// below U+00E1, e.g. plain "à", land the second UTF-8 byte in
    /// `80..=A0`, which Big5 rejects as a trail byte -- avoided here.)
    const LATIN1_SUPPLEMENT_TEXT: &str = "café où l'étoile étée ça résumé vécu ôté née bébé";

    /// ROADMAP v0.6 E2 evaluation fixture: diverse EUC-JP text for the
    /// (WINDOWS_1252, EUC_JP) mojibake pair under evaluation. Three
    /// unrelated-topic sentences (weather, a library/cafe visit, an
    /// evening meal) so the fixture exercises kanji, hiragana, *and*
    /// katakana together rather than one script in isolation --
    /// deliberately distinct content from `SHIFT_JIS_TEXT` above (same
    /// "reasonably long, multi-sentence" shape for chardetng's statistical
    /// detection) so this pair's evaluation is not just re-running the
    /// Shift_JIS fixture under a different label.
    const EUC_JP_TEXT: &str = "今日は朝から雨が降っていて、少し肌寒い一日でした。図書館で新しい小説を借り、カフェでコーヒーを飲みながら静かな時間を過ごしました。夕方には近所の店で温かい料理を食べて、心も体も温まりました。";

    /// ROADMAP v0.6 E2 evaluation fixture: realistic French prose using
    /// common windows-1252 Western-European accented characters (é, è, ê,
    /// ô, ç, ù) in natural sentences. Unlike `LATIN1_SUPPLEMENT_TEXT`
    /// above -- deliberately restricted to lowercase U+00E1..=U+00FF for
    /// its Big5-collision property -- this fixture exists purely to stand
    /// in for "a real windows-1252 document a user might have open", for
    /// the false-positive check below.
    const WESTERN_EUROPEAN_TEXT: &str = "Le café est déjà prêt, mais l'hôtel n'a pas encore reçu la réservation. Où puis-je trouver une pharmacie près d'ici ? C'est très important pour moi.";

    /// v0.7 Track E evaluation fixture: realistic Russian prose for the
    /// (windows-1251, UTF-8) pair, deliberately distinct from `RUSSIAN_TEXT`
    /// above (that pangram is reserved for the KOI8-R/ISO-8859-5
    /// evaluations) so this pair's evaluation is not just re-running that
    /// fixture under a different label -- same weather/cafe/evening-walk,
    /// three-topic shape as `EUC_JP_TEXT`.
    const WINDOWS1251_UTF8_RUSSIAN_TEXT: &str = "Сегодня утром шёл сильный дождь, и улицы были почти пустыми. Мы зашли в маленькое кафе выпить горячего чая и почитать книгу. Вечером небо прояснилось, и мы решили прогуляться в парке перед ужином.";

    /// v0.7 Track E evaluation fixture: realistic Polish prose for the
    /// (windows-1250, UTF-8) pair -- Central European script was not
    /// previously represented in this file at all (every existing
    /// single-byte fixture above is either Western European or Cyrillic).
    /// Kept under `PREVIEW_CHARS` (200) like every other fixture this file
    /// asserts an exact `candidate.preview` match against, while still
    /// exercising all nine of windows-1250's Polish-specific diacritics (ą
    /// ć ę ł ń ó ś ź ż each appear at least once).
    const WINDOWS1250_UTF8_POLISH_TEXT: &str = "Dzisiaj słońce świeci jasno, a księżyc będzie pięknie widoczny nad górami. Mój dziadek mówi, że źle się czuje, gdy pogoda się zmienia, więc wolę być ostrożny i mieć gorącą herbatę pod ręką.";

    /// v0.7 Track E evaluation fixture: realistic Ukrainian prose for the
    /// (KOI8-U, windows-1251) pair, deliberately using the four letters (і,
    /// ї, є, ґ) that distinguish Ukrainian from Russian -- exactly the
    /// letters KOI8-U adds over KOI8-R (see `koi8_r_can_never_be_confirmed_
    /// as_original_by_chardetng`'s doc comment) and the content this new
    /// pair specifically exists to cover that the already-admitted
    /// (KOI8-R, windows-1251) pair structurally cannot (see
    /// `koi8u_windows1251_pair_does_not_shadow_existing_koi8r_pair` below).
    const KOI8U_WINDOWS1251_UKRAINIAN_TEXT: &str = "Україна – це моя батьківщина. У Києві є багато гарних парків. Я люблю пити чай і їсти смачну їжу. Мій дідусь вирощує квіти у своєму ґрунті.";

    /// v0.9 Track B1 evaluation fixture: realistic Arabic prose for the
    /// (windows-1256, UTF-8) pair -- windows-1256 is, like windows-1250/
    /// 1251/1252, a "total" single-byte decoder (confirmed in the batch's
    /// investigation record: decoding every byte 0x00..=0xFF individually
    /// reports zero malformed sequences), so gate 1 reduces to chardetng
    /// recognizing UTF-8 on the recovered bytes, same shape as the three
    /// already-admitted `(windows-1250/1251/1252, UTF_8)` pairs. Same
    /// three-sentence weather/park/dinner shape as `WINDOWS1251_UTF8_
    /// RUSSIAN_TEXT`/`WINDOWS1250_UTF8_POLISH_TEXT` above, for the same
    /// "realistic amount of text for chardetng's statistical detection"
    /// reason. Not reviewed by a native Arabic speaker (see the batch's
    /// investigation record) -- grammar is believed correct but unverified;
    /// this only affects fixture naturalness, not any test assertion,
    /// since every gate here is purely structural/statistical, not a
    /// meaning check.
    const ARABIC_TEXT: &str = "اليوم الطقس جميل جدًا والشمس مشرقة. ذهبنا إلى الحديقة مع العائلة ولعبنا هناك طويلاً. في المساء تناولنا عشاءً لذيذًا مع الأصدقاء.";

    /// v0.9 Track B1 evaluation fixture: realistic Vietnamese prose for the
    /// (windows-1258, UTF-8) pair -- windows-1258 is also a total
    /// single-byte decoder. Same three-sentence shape as `ARABIC_TEXT`
    /// above. Exercises a wide spread of Vietnamese tone-mark diacritics
    /// (ô, ậ, ẹ, ắ, ấ, á, ạ, ơ, ố, ệ), which is a deliberate stress case:
    /// `docs/archive/roadmap-completed-cycles.md`'s v0.5 Track E1 record
    /// notes windows-1258's single-byte path does no Unicode
    /// normalization, so only precomposed forms round-trip -- this fixture
    /// is written with precomposed Vietnamese letters throughout (the only
    /// form Rust source text naturally produces for these characters), and
    /// `repairs_utf8_misdecoded_as_windows1258` below is the direct
    /// empirical confirmation that this holds for a real mojibake
    /// round-trip, not just the encoder pool sanity checks that guarantee
    /// predates this batch. Not reviewed by a native Vietnamese speaker
    /// (see the batch's investigation record) -- same caveat as
    /// `ARABIC_TEXT`.
    const VIETNAMESE_TEXT: &str = "Hôm nay thời tiết rất đẹp và nắng ấm áp. Chúng tôi đi dạo trong công viên cùng gia đình và chơi bóng ở đó rất lâu. Buổi tối chúng tôi ăn một bữa tối ngon miệng cùng bạn bè.";

    /// v0.9 Track B1 evaluation fixture: realistic Greek prose for the
    /// (windows-1253, UTF-8) pair. Unlike windows-1250/1251/1252/1256/1258,
    /// windows-1253 is *not* a total single-byte decoder -- three byte
    /// values (`0xAA`, `0xD2`, `0xFF`) are unassigned (confirmed in the
    /// batch's investigation record via exhaustive 0x00..=0xFF probing).
    /// This fixture is written using only common modern Greek letters and
    /// their precomposed tonos accents (ά, έ, ή, ί, ό, ύ); none of the
    /// codepoints used land on the two gap bytes that are even
    /// theoretically reachable from valid UTF-8 (`0xAA` as a 2-byte
    /// UTF-8 trail byte requires a codepoint congruent to `0x2A` mod `0x40`
    /// within the Greek-and-Coptic block, i.e. only U+03AA/U+03EA -- rare
    /// letters not used here; `0xFF` can never appear in valid UTF-8 at
    /// all, lead or trail; `0xD2` would require a lead byte outside the
    /// Greek block's `0xCD..=0xCF` range entirely). `repairs_utf8_
    /// misdecoded_as_windows1253` below empirically confirms the resulting
    /// bytes decode cleanly. Not reviewed by a native Greek speaker (see
    /// the batch's investigation record) -- same caveat as `ARABIC_TEXT`.
    const GREEK_TEXT: &str = "Σήμερα ο καιρός είναι πολύ όμορφος και ο ήλιος λάμπει. Πήγαμε στο πάρκο με την οικογένεια και παίξαμε εκεί για πολλή ώρα. Το βράδυ φάγαμε ένα νόστιμο δείπνο με τους φίλους μας.";

    #[test]
    fn repairs_big5_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable, "fixture must be fully Big5-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, BIG5_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "Big5")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, Big5) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, BIG5_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "Big5".to_string())
                .unwrap();
        assert_eq!(repaired, BIG5_TEXT);
    }

    #[test]
    fn repairs_utf8_misdecoded_as_windows1252() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );
        // Pin the classic "Ã©"-style shape: each 2-byte UTF-8 char becomes
        // two separate mojibake characters once mis-decoded byte-by-byte.
        assert!(mojibake.contains('Ã'));

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn repairs_shiftjis_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = SHIFT_JIS.encode(SHIFT_JIS_TEXT);
        assert!(!unmappable, "fixture must be fully Shift_JIS-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, SHIFT_JIS_TEXT,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "Shift_JIS")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, Shift_JIS) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, SHIFT_JIS_TEXT);

        let repaired = apply_mojibake_repair(
            mojibake,
            "windows-1252".to_string(),
            "Shift_JIS".to_string(),
        )
        .unwrap();
        assert_eq!(repaired, SHIFT_JIS_TEXT);
    }

    /// ROADMAP v0.6 E2, gate 1 (reachability): genuine EUC-JP bytes
    /// mis-decoded as windows-1252, same shape as
    /// `repairs_shiftjis_misdecoded_as_windows1252` above. chardetng
    /// 0.1.17 carries a real, positively-detected EUC-JP candidate
    /// (`EucJpCandidate` / `EUC_JP_INDEX` in its `src/lib.rs`, and its
    /// README lists EUC-JP under "Detected: Historical locale-specific
    /// fallbacks", not aliased away the way GB18030->GBK or KOI8-R->KOI8-U
    /// are) -- structurally unlike the absent-candidate KOI8-R case
    /// documented on `REPAIR_PAIRS` and in judgment-overlay.md §4, so this
    /// hypothesis is not dead on arrival. This test is the empirical
    /// confirmation that gate (c)'s chardetng cross-check actually agrees
    /// on real, diverse Japanese text, not just the structural possibility.
    #[test]
    fn repairs_eucjp_misdecoded_as_windows1252() {
        let (bytes, _, unmappable) = EUC_JP.encode(EUC_JP_TEXT);
        assert!(!unmappable, "fixture must be fully EUC-JP-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, EUC_JP_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1252, EUC-JP) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, EUC_JP_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1252".to_string(), "EUC-JP".to_string())
                .unwrap();
        assert_eq!(repaired, EUC_JP_TEXT);
    }

    #[test]
    fn repairs_utf8_misdecoded_as_big5() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = BIG5.decode_without_bom_handling(bytes);
        assert!(
            !malformed,
            "fixture is constructed so its UTF-8 bytes are valid Big5 lead/trail pairs"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "Big5" && c.original == "UTF-8")
            .unwrap_or_else(|| panic!("expected a (Big5, UTF-8) candidate, got {candidates:?}"));
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "Big5".to_string(), "UTF-8".to_string()).unwrap();
        assert_eq!(repaired, original_text);
    }

    /// Issue #182: genuine windows-1251 bytes wrongly opened as KOI8-R --
    /// the classic Runet "кракозябры" mojibake shape (KOI8-R was the
    /// standard Unix/Fidonet encoding, windows-1251 the standard Windows
    /// one; tools defaulting to the wrong one produced this constantly).
    #[test]
    fn repairs_windows1251_misdecoded_as_koi8r() {
        let (bytes, _, unmappable) = WINDOWS_1251.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully windows-1251-encodable");
        let (mojibake, malformed) = KOI8_R.decode_without_bom_handling(&bytes);
        assert!(
            !malformed,
            "fixture bytes must also decode cleanly as KOI8-R"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, RUSSIAN_TEXT, "fixture must actually look garbled");

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "KOI8-R" && c.original == "windows-1251")
            .unwrap_or_else(|| {
                panic!("expected a (KOI8-R, windows-1251) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, RUSSIAN_TEXT);

        let repaired =
            apply_mojibake_repair(mojibake, "KOI8-R".to_string(), "windows-1251".to_string())
                .unwrap();
        assert_eq!(repaired, RUSSIAN_TEXT);
    }

    #[test]
    fn pure_ascii_yields_no_candidates() {
        let text = "Hello, World! This is plain ASCII text with no accents at all.".to_string();
        assert_eq!(detect_mojibake(text), Vec::new());
    }

    #[test]
    fn normal_utf8_chinese_content_has_no_content_changing_candidates() {
        // Genuinely correct, un-garbled UTF-8 Chinese text must never be
        // flagged: every candidate `detect_mojibake` could ever return
        // necessarily changes the content (gate (d) filters out anything
        // that wouldn't), so "no candidate changes the content" means this
        // list must be empty.
        let candidates = detect_mojibake(BIG5_TEXT.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct UTF-8 Chinese text must not be mistaken for mojibake"
        );
    }

    /// Adversarial-review regression: correct Japanese used to pass every
    /// structural gate for the (GBK, Big5) hypothesis — clean encode,
    /// clean decode, zero U+FFFD, and chardetng agreeing the re-encoded
    /// bytes look like Big5 — while producing pure garbage. The pair
    /// matrix now excludes legacy-CJK ↔ legacy-CJK hypotheses entirely;
    /// this locks that correct Japanese yields no candidate at all.
    #[test]
    fn no_candidates_for_normal_japanese() {
        for text in [
            "日本語の文章です。これはテストであり句読点も含まれています。",
            "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
        ] {
            let candidates = detect_mojibake(text.to_string());
            assert_eq!(
                candidates,
                Vec::new(),
                "correct Japanese must not be mistaken for mojibake: {text}"
            );
        }
    }

    /// Same shape as the Japanese case for Hangul: correct Korean must
    /// never produce a content-changing candidate.
    #[test]
    fn no_candidates_for_normal_korean() {
        let text = "안녕하세요. 이것은 한국어 테스트 문장입니다. 데이터가 손상되면 안 됩니다.";
        let candidates = detect_mojibake(text.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct Korean must not be mistaken for mojibake"
        );
    }

    /// Same shape again for Cyrillic: correct Russian text, in its native
    /// UTF-8 form and never touched by any encoding round-trip, must never
    /// produce a content-changing candidate.
    #[test]
    fn no_candidates_for_normal_cyrillic() {
        let candidates = detect_mojibake(RUSSIAN_TEXT.to_string());
        assert_eq!(
            candidates,
            Vec::new(),
            "correct Russian text must not be mistaken for mojibake"
        );
    }

    /// ROADMAP v0.6 E2, gate 2a (false-positive check): a real, correctly-
    /// decoded windows-1252 Western-European document -- never touched by
    /// any mis-decode -- must not trigger the new (WINDOWS_1252, EUC_JP)
    /// hypothesis. Same family as `no_candidates_for_normal_japanese`
    /// /`_korean`/`_cyrillic` above, extended to the script this new
    /// pair's `intermediate` encoding natively serves. Scoped to the
    /// specific new candidate (not "candidates must be empty" overall)
    /// because that is the literal risk this pair introduces: whether
    /// legitimate windows-1252 prose can also pass this one new gate,
    /// independent of whatever the four pre-existing (WINDOWS_1252, *)
    /// pairs already do or don't do with this text.
    #[test]
    fn no_candidates_for_normal_western_european_text() {
        let candidates = detect_mojibake(WESTERN_EUROPEAN_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "correct Western-European windows-1252 text must not trigger a false-positive \
             (windows-1252, EUC-JP) repair candidate: {candidates:?}"
        );
    }

    /// Adversarial-review regression: the 64 KiB sample cut lands
    /// mid-character in the *recovered* byte stream about half the time
    /// for CJK mojibake, and gate (b) used to reject the whole hypothesis
    /// over that sampling artifact — large documents silently detected
    /// nothing. With tail tolerance, detection must keep working past the
    /// sample boundary at any alignment.
    #[test]
    fn detects_mojibake_in_content_over_sample_boundary() {
        let (bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable);
        let (unit, malformed) = WINDOWS_1252.decode_without_bom_handling(&bytes);
        assert!(!malformed);
        let unit = unit.into_owned();

        // Both sizes straddle SAMPLE_BYTES with different tail alignments
        // (the second reproduces the adversarial review's failing case).
        for target in [SAMPLE_BYTES + 2_000, SAMPLE_BYTES + 38_000] {
            let mut mojibake = String::new();
            while mojibake.len() < target {
                mojibake.push_str(&unit);
            }
            let candidates = detect_mojibake(mojibake);
            assert!(
                candidates
                    .iter()
                    .any(|c| c.intermediate == "windows-1252" && c.original == "Big5"),
                "large mojibake (~{target} bytes) must still be detected, got {candidates:?}"
            );
        }
    }

    /// Issue #182 evaluation: documents/locks in *why* `(WINDOWS_1251,
    /// KOI8_R)` is excluded from `REPAIR_PAIRS` (see that const's doc
    /// comment). Gates (a) and (b) of `try_repair` pass cleanly for a
    /// genuine KOI8-R-as-windows-1251 mis-decode -- the encode/decode
    /// round trip itself is perfectly reversible -- but gate (c)'s
    /// chardetng cross-check can never confirm `KOI8_R` as `original`,
    /// because chardetng has no KOI8-R candidate in its statistical model
    /// at all (only KOI8-U). This is a structural rejection, not a
    /// judgment call about this particular fixture.
    #[test]
    fn koi8_r_can_never_be_confirmed_as_original_by_chardetng() {
        let (real_bytes, _, unmappable) = KOI8_R.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully KOI8-R-encodable");
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(&real_bytes);
        assert!(
            !malformed,
            "windows-1251 must decode the KOI8-R bytes cleanly"
        );
        let mojibake = mojibake.into_owned();

        // Gates (a)+(b) alone (plain encode/decode, no chardetng): the
        // round trip is perfectly clean and recovers the exact original
        // bytes and text.
        let (recovered_bytes, _, unmappable) = WINDOWS_1251.encode(&mojibake);
        assert!(!unmappable);
        assert_eq!(recovered_bytes.as_ref(), real_bytes.as_ref());
        let (recovered_text, malformed) = KOI8_R.decode_without_bom_handling(&recovered_bytes);
        assert!(!malformed);
        assert_eq!(recovered_text, RUSSIAN_TEXT);

        // But try_repair -- which also runs gate (c) -- must still reject
        // it, because chardetng can never guess KOI8_R specifically.
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1251, KOI8_R),
            None,
            "chardetng cannot confirm KOI8-R as `original`, so this \
             hypothesis must never pass even though the encode/decode \
             round trip itself is perfectly clean"
        );

        // Pin the specific reason: chardetng guesses KOI8-U, never KOI8-R.
        let mut detector = EncodingDetector::new();
        detector.feed(&real_bytes, true);
        assert_eq!(detector.guess(None, true).name(), "KOI8-U");
    }

    /// Issue #182 evaluation: documents/locks in *why* ISO-8859-5
    /// hypotheses were left out of `REPAIR_PAIRS` (see that const's doc
    /// comment). Genuine ISO-8859-5 bytes mis-decoded as windows-1251 pass
    /// every one of `try_repair`'s gates -- including chardetng agreement
    /// -- under *both* the correct hypothesis, (windows-1251, ISO-8859-5),
    /// *and* the reversed, wrong one, (ISO-8859-5, windows-1251), which
    /// recovers different, incorrect text. Shipping this pairing would
    /// show the wizard user two structurally-clean candidates for the
    /// same mojibake, one of them wrong.
    #[test]
    fn windows1251_iso88595_hypotheses_are_mutually_ambiguous() {
        use encoding_rs::ISO_8859_5;

        let (real_bytes, _, unmappable) = ISO_8859_5.encode(RUSSIAN_TEXT);
        assert!(!unmappable, "fixture must be fully ISO-8859-5-encodable");
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(&real_bytes);
        assert!(
            !malformed,
            "windows-1251 must decode the ISO-8859-5 bytes cleanly"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, RUSSIAN_TEXT, "fixture must actually look garbled");

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1251, ISO_8859_5)
            .expect("the correct (windows-1251, ISO-8859-5) hypothesis must pass every gate");
        assert_eq!(
            correct_text, RUSSIAN_TEXT,
            "the correct hypothesis must recover the real text"
        );

        let (wrong_text, _) = try_repair(&mojibake, ISO_8859_5, WINDOWS_1251).expect(
            "the reversed (ISO-8859-5, windows-1251) hypothesis ALSO passes every \
             gate -- this is exactly the ambiguity that keeps it out of REPAIR_PAIRS",
        );
        assert_ne!(
            wrong_text, RUSSIAN_TEXT,
            "the reversed hypothesis passing every gate while recovering the WRONG \
             text is the documented collision -- if this ever starts recovering the \
             right text too, the ambiguity argument in REPAIR_PAIRS's doc comment \
             needs re-checking before adding ISO-8859-5 pairs"
        );
    }

    /// ROADMAP v0.6 E2, gate 2b (mutual-ambiguity check): same shape as
    /// `windows1251_iso88595_hypotheses_are_mutually_ambiguous` above, but
    /// checking the *reverse* of the pair under evaluation here. Genuine
    /// EUC-JP bytes mis-decoded as windows-1252 pass the forward
    /// hypothesis, (WINDOWS_1252, EUC_JP) -- the one ROADMAP v0.6 E2 asks
    /// to evaluate -- and recover the real text. Unlike the ISO-8859-5
    /// case, the reversed hypothesis, (EUC_JP, WINDOWS_1252) (i.e. "this
    /// text is EUC-JP-decoded bytes that were really windows-1252"), must
    /// NOT also pass: if it did, the same mojibake string would have two
    /// structurally-clean-but-contradictory readings, exactly the
    /// ambiguity that kept ISO-8859-5 out.
    #[test]
    fn windows1252_eucjp_reverse_hypothesis_is_rejected() {
        let (real_bytes, _, unmappable) = EUC_JP.encode(EUC_JP_TEXT);
        assert!(!unmappable, "fixture must be fully EUC-JP-encodable");
        let (mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&real_bytes);
        assert!(!malformed, "windows-1252 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, EUC_JP_TEXT, "fixture must actually look garbled");

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1252, EUC_JP)
            .expect("the forward (windows-1252, EUC-JP) hypothesis must pass every gate");
        assert_eq!(
            correct_text, EUC_JP_TEXT,
            "the forward hypothesis must recover the real text"
        );

        assert_eq!(
            try_repair(&mojibake, EUC_JP, WINDOWS_1252),
            None,
            "the reversed (EUC_JP, windows-1252) hypothesis must not also pass -- if it \
             ever starts passing, this pair has the same mutual-ambiguity problem that \
             kept (windows-1251, ISO-8859-5) out of REPAIR_PAIRS"
        );
    }

    /// ROADMAP v0.6 E2, gate 2c (interaction with the nine pairs that
    /// predate this evaluation): the new (WINDOWS_1252, EUC_JP)
    /// hypothesis must not shadow an existing pair's correct hit on real
    /// mojibake. Reuses the same
    /// Big5- and Shift_JIS-via-windows-1252 mojibake the `repairs_*` tests
    /// above already build and pin -- a real Big5 (or Shift_JIS) file
    /// mis-decoded as windows-1252 must keep resolving to its own correct
    /// pair only, never spuriously also to (windows-1252, EUC-JP).
    #[test]
    fn windows1252_eucjp_pair_does_not_shadow_existing_cjk_pairs() {
        let (big5_bytes, _, unmappable) = BIG5.encode(BIG5_TEXT);
        assert!(!unmappable);
        let (big5_mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&big5_bytes);
        assert!(!malformed);
        let big5_candidates = detect_mojibake(big5_mojibake.into_owned());
        assert!(
            big5_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "Big5"),
            "the real Big5 pair must still be found: {big5_candidates:?}"
        );
        assert!(
            !big5_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "a genuine Big5-as-windows-1252 mojibake must not also spuriously match the \
             EUC-JP hypothesis: {big5_candidates:?}"
        );

        let (sjis_bytes, _, unmappable) = SHIFT_JIS.encode(SHIFT_JIS_TEXT);
        assert!(!unmappable);
        let (sjis_mojibake, malformed) = WINDOWS_1252.decode_without_bom_handling(&sjis_bytes);
        assert!(!malformed);
        let sjis_candidates = detect_mojibake(sjis_mojibake.into_owned());
        assert!(
            sjis_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "Shift_JIS"),
            "the real Shift_JIS pair must still be found: {sjis_candidates:?}"
        );
        assert!(
            !sjis_candidates
                .iter()
                .any(|c| c.intermediate == "windows-1252" && c.original == "EUC-JP"),
            "a genuine Shift_JIS-as-windows-1252 mojibake must not also spuriously match \
             the EUC-JP hypothesis: {sjis_candidates:?}"
        );
    }

    #[test]
    fn apply_rejects_unmappable_content_with_readable_error() {
        let err = apply_mojibake_repair(
            "rocket 🚀 emoji is not in Big5".to_string(),
            "Big5".to_string(),
            "UTF-8".to_string(),
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(err.contains("Big5"));
    }

    #[test]
    fn apply_rejects_content_whose_recovered_bytes_are_malformed_in_original() {
        // Big5-encoding this realistic Chinese sample, then trying to
        // decode those bytes as EUC-KR (a different double-byte encoding
        // with different valid trail-byte ranges) must fail cleanly rather
        // than silently emit replacement characters.
        let err = apply_mojibake_repair(
            BIG5_TEXT.to_string(),
            "Big5".to_string(),
            "EUC-KR".to_string(),
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(err.contains("EUC-KR"));
    }

    #[test]
    fn detection_on_content_over_64kib_does_not_panic() {
        // "中" is 3 UTF-8 bytes; 30,000 repeats is 90,000 bytes, and
        // SAMPLE_BYTES (65,536) lands one byte inside a character (65,536
        // is not a multiple of 3), exercising the char-boundary retreat in
        // `char_boundary_prefix` instead of trivially landing on one.
        let big = "中".repeat(30_000);
        assert!(big.len() > SAMPLE_BYTES);
        assert!(!big.is_char_boundary(SAMPLE_BYTES));
        let candidates = detect_mojibake(big);
        assert!(candidates.len() <= MAX_CANDIDATES);
    }

    #[test]
    fn char_boundary_prefix_handles_short_content() {
        assert_eq!(char_boundary_prefix("hi", SAMPLE_BYTES), "hi");
    }

    // ----------------------------------------------------------------
    // v0.7 Track E mojibake-pair investigation batch. Each admitted pair
    // below gets the same four-test shape ROADMAP v0.6 E2 established for
    // (WINDOWS_1252, EUC_JP) (see that pair's tests above, ~line 566):
    // reachability/correctness, a pair-scoped false-positive check, reverse-
    // hypothesis rejection, and a non-shadowing check against the pairs
    // most structurally likely to collide with it. See `REPAIR_PAIRS`'s doc
    // comment for the written evaluation each pair went through.
    // ----------------------------------------------------------------

    // --- (WINDOWS_1251, UTF_8): Cyrillic UTF-8 mis-decoded as windows-1251 ---

    #[test]
    fn repairs_utf8_misdecoded_as_windows1251() {
        let original_text = WINDOWS1251_UTF8_RUSSIAN_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1251 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1251" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1251, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1251".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    /// False-positive check scoped to this pair, same shape as
    /// `no_candidates_for_normal_western_european_text`: reuses
    /// `RUSSIAN_TEXT`, the file's canonical "normal Cyrillic" fixture
    /// (already exercised generically by `no_candidates_for_normal_
    /// cyrillic`), since windows-1251's native script is exactly what that
    /// fixture represents.
    #[test]
    fn no_candidates_for_normal_cyrillic_excludes_windows1251_utf8_pair() {
        let candidates = detect_mojibake(RUSSIAN_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1251" && c.original == "UTF-8"),
            "correct Cyrillic UTF-8 text must not trigger a false-positive \
             (windows-1251, UTF-8) repair candidate: {candidates:?}"
        );
    }

    #[test]
    fn windows1251_utf8_reverse_hypothesis_is_rejected() {
        let text = WINDOWS1251_UTF8_RUSSIAN_TEXT;
        let (mojibake, malformed) = WINDOWS_1251.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, text);

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1251, UTF_8)
            .expect("the forward (windows-1251, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct_text, text);

        assert_eq!(
            try_repair(&mojibake, UTF_8, WINDOWS_1251),
            None,
            "the reversed (UTF-8, windows-1251) hypothesis must not also pass -- every \
             Unicode string trivially UTF-8-encodes (gate (a) always passes), so this \
             relies entirely on gate (b)/(c) rejecting windows-1251 as a match for the \
             mojibake's own UTF-8 bytes"
        );
    }

    /// Checks the pair most structurally likely to collide with this one:
    /// windows-1250 and windows-1252 are both single-byte "total decoders"
    /// like windows-1251 (any UTF-8 byte sequence decodes without
    /// `malformed`), so the only thing that can possibly separate them is
    /// gate (a) (does the *other* codepage's character repertoire also
    /// contain whatever this mojibake decoded to?) followed by gate (c).
    /// Cyrillic (windows-1251) and Western/Central European Latin
    /// (windows-1252/1250) repertoires don't overlap, so gate (a) alone
    /// should already separate them -- checked in both directions.
    #[test]
    fn windows1251_utf8_pair_does_not_shadow_sibling_single_byte_pairs() {
        let (mojibake, _) =
            WINDOWS_1251.decode_without_bom_handling(WINDOWS1251_UTF8_RUSSIAN_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1252, UTF_8),
            None,
            "genuine windows-1251 Cyrillic mojibake must not also match (windows-1252, UTF-8)"
        );
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1250, UTF_8),
            None,
            "genuine windows-1251 Cyrillic mojibake must not also match (windows-1250, UTF-8)"
        );

        let (m1252, _) = WINDOWS_1252.decode_without_bom_handling(WESTERN_EUROPEAN_TEXT.as_bytes());
        assert_eq!(
            try_repair(&m1252, WINDOWS_1251, UTF_8),
            None,
            "genuine windows-1252 Western-European mojibake must not also match \
             (windows-1251, UTF-8)"
        );
    }

    // --- (EUC_KR, UTF_8) / (EUC_JP, UTF_8): UTF-8 mis-decoded as a legacy
    // CJK double-byte encoding. Both reuse `LATIN1_SUPPLEMENT_TEXT` for
    // their positive fixture -- like the existing (Big5, UTF_8)/(GBK,
    // UTF_8)/(SHIFT_JIS, UTF_8) pairs, genuine native-script (Korean/
    // Japanese) UTF-8 text is 3-byte per character and essentially never
    // lines up with a 2-byte legacy encoding's lead/trail byte structure by
    // chance (confirmed empirically: EUC-KR/EUC-JP decode of the native
    // Korean/Japanese sentences used in `no_candidates_for_normal_korean`/
    // `no_candidates_for_normal_japanese` reports `malformed`), so -- same
    // as Big5/GBK/Shift_JIS before them -- the real-world scenario these
    // two pairs actually repair is "a UTF-8 document with occasional
    // Western-accented characters, opened by a tool defaulting to
    // EUC-KR/EUC-JP", not "Korean/Japanese text misread as EUC-KR/EUC-JP".
    // ---

    #[test]
    fn repairs_utf8_misdecoded_as_euckr() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = EUC_KR.decode_without_bom_handling(bytes);
        assert!(
            !malformed,
            "fixture is constructed so its UTF-8 bytes are valid EUC-KR lead/trail pairs"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "EUC-KR" && c.original == "UTF-8")
            .unwrap_or_else(|| panic!("expected a (EUC-KR, UTF-8) candidate, got {candidates:?}"));
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "EUC-KR".to_string(), "UTF-8".to_string()).unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn repairs_utf8_misdecoded_as_eucjp() {
        let original_text = LATIN1_SUPPLEMENT_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = EUC_JP.decode_without_bom_handling(bytes);
        assert!(
            !malformed,
            "fixture is constructed so its UTF-8 bytes are valid EUC-JP lead/trail pairs"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "EUC-JP" && c.original == "UTF-8")
            .unwrap_or_else(|| panic!("expected a (EUC-JP, UTF-8) candidate, got {candidates:?}"));
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "EUC-JP".to_string(), "UTF-8".to_string()).unwrap();
        assert_eq!(repaired, original_text);
    }

    /// False-positive check scoped to (EUC-KR, UTF-8): reuses the exact
    /// sentence from `no_candidates_for_normal_korean` (already exercised
    /// generically there), same shape as
    /// `no_candidates_for_normal_western_european_text`.
    #[test]
    fn no_candidates_for_normal_korean_excludes_euckr_utf8_pair() {
        let korean = "안녕하세요. 이것은 한국어 테스트 문장입니다. 데이터가 손상되면 안 됩니다.";
        let candidates = detect_mojibake(korean.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "EUC-KR" && c.original == "UTF-8"),
            "correct Korean text must not trigger a false-positive (EUC-KR, UTF-8) \
             candidate: {candidates:?}"
        );
    }

    /// False-positive check scoped to (EUC-JP, UTF-8): reuses the exact
    /// sentences from `no_candidates_for_normal_japanese`.
    #[test]
    fn no_candidates_for_normal_japanese_excludes_eucjp_utf8_pair() {
        for japanese in [
            "日本語の文章です。これはテストであり句読点も含まれています。",
            "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。",
        ] {
            let candidates = detect_mojibake(japanese.to_string());
            assert!(
                !candidates
                    .iter()
                    .any(|c| c.intermediate == "EUC-JP" && c.original == "UTF-8"),
                "correct Japanese text must not trigger a false-positive (EUC-JP, UTF-8) \
                 candidate: {candidates:?}"
            );
        }
    }

    #[test]
    fn euckr_utf8_reverse_hypothesis_is_rejected() {
        let text = LATIN1_SUPPLEMENT_TEXT;
        let (mojibake, malformed) = EUC_KR.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        let (correct, _) = try_repair(&mojibake, EUC_KR, UTF_8)
            .expect("the forward (EUC-KR, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct, text);
        assert_eq!(
            try_repair(&mojibake, UTF_8, EUC_KR),
            None,
            "the reversed (UTF-8, EUC-KR) hypothesis must not also pass"
        );
    }

    #[test]
    fn eucjp_utf8_reverse_hypothesis_is_rejected() {
        let text = LATIN1_SUPPLEMENT_TEXT;
        let (mojibake, malformed) = EUC_JP.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        let (correct, _) = try_repair(&mojibake, EUC_JP, UTF_8)
            .expect("the forward (EUC-JP, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct, text);
        assert_eq!(
            try_repair(&mojibake, UTF_8, EUC_JP),
            None,
            "the reversed (UTF-8, EUC-JP) hypothesis must not also pass"
        );
    }

    /// Shadowing directions checked for (EUC-KR, UTF-8): the same
    /// `LATIN1_SUPPLEMENT_TEXT` bytes, mis-decoded via EUC-KR vs the three
    /// existing (Big5|GBK|Shift_JIS, UTF-8) pairs and the sibling
    /// (EUC-JP, UTF-8) pair, must each match only their own pair -- all
    /// five legacy CJK codecs assign this byte pattern to different
    /// characters from different (mostly disjoint) charsets, so gate (a)
    /// should already separate them; and it doesn't collide with the
    /// *existing* (windows-1252, EUC-KR) pair, which uses EUC-KR in the
    /// opposite role (`original` instead of `intermediate`).
    #[test]
    fn euckr_utf8_pair_does_not_shadow_other_cjk_pairs() {
        let (mojibake, _) = EUC_KR.decode_without_bom_handling(LATIN1_SUPPLEMENT_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        for (name, enc) in [
            ("Big5", BIG5),
            ("GBK", GBK),
            ("Shift_JIS", SHIFT_JIS),
            ("EUC-JP", EUC_JP),
        ] {
            assert_eq!(
                try_repair(&mojibake, enc, UTF_8),
                None,
                "EUC-KR mojibake must not also match ({name}, UTF-8)"
            );
        }

        // Existing (windows-1252, EUC-KR) pair uses EUC-KR as `original`,
        // not `intermediate` -- confirm no cross-interaction in either
        // direction.
        let korean_text =
            "안녕하세요. 이것은 한국어 테스트 문장입니다. 데이터가 손상되면 안 됩니다.";
        let (euckr_real_bytes, _, _) = EUC_KR.encode(korean_text);
        let (existing_euckr_mojibake, _) =
            WINDOWS_1252.decode_without_bom_handling(&euckr_real_bytes);
        assert_eq!(
            try_repair(&existing_euckr_mojibake, EUC_KR, UTF_8),
            None,
            "existing (windows-1252, EUC-KR) mojibake must not also match (EUC-KR, UTF-8)"
        );
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1252, EUC_KR),
            None,
            "new (EUC-KR, UTF-8) mojibake must not also match (windows-1252, EUC-KR)"
        );
    }

    /// Mirror of `euckr_utf8_pair_does_not_shadow_other_cjk_pairs` for
    /// (EUC-JP, UTF-8).
    #[test]
    fn eucjp_utf8_pair_does_not_shadow_other_cjk_pairs() {
        let (mojibake, _) = EUC_JP.decode_without_bom_handling(LATIN1_SUPPLEMENT_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        for (name, enc) in [
            ("Big5", BIG5),
            ("GBK", GBK),
            ("Shift_JIS", SHIFT_JIS),
            ("EUC-KR", EUC_KR),
        ] {
            assert_eq!(
                try_repair(&mojibake, enc, UTF_8),
                None,
                "EUC-JP mojibake must not also match ({name}, UTF-8)"
            );
        }

        // Existing (windows-1252, EUC-JP) pair uses EUC-JP as `original`,
        // not `intermediate` -- confirm no cross-interaction in either
        // direction.
        let (eucjp_real_bytes, _, _) = EUC_JP.encode(EUC_JP_TEXT);
        let (existing_eucjp_mojibake, _) =
            WINDOWS_1252.decode_without_bom_handling(&eucjp_real_bytes);
        assert_eq!(
            try_repair(&existing_eucjp_mojibake, EUC_JP, UTF_8),
            None,
            "existing (windows-1252, EUC-JP) mojibake must not also match (EUC-JP, UTF-8)"
        );
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1252, EUC_JP),
            None,
            "new (EUC-JP, UTF-8) mojibake must not also match (windows-1252, EUC-JP)"
        );
    }

    // --- (WINDOWS_1250, UTF_8): Central European UTF-8 mis-decoded as
    // windows-1250. chardetng 0.1.17 carries a real, positively-detected
    // windows-1250 candidate (`WINDOWS_1250_INDEX = 1` in its
    // `src/data.rs`'s `SINGLE_BYTE_DATA` table, backed by `WINDOWS_1250_
    // INIT` -- not aliased away like GB18030->GBK or KOI8-R->KOI8-U), and
    // its README lists "windows-1250" plainly under "Detected", so this
    // pair is not structurally dead on arrival the way a hypothetical
    // KOI8-R-as-`original` pair would be. ---

    #[test]
    fn repairs_utf8_misdecoded_as_windows1250() {
        let original_text = WINDOWS1250_UTF8_POLISH_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1250.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1250 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1250" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1250, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1250".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    /// New false-positive risk surface: Central European script was not
    /// previously represented in this file at all (unlike Korean/Japanese/
    /// Cyrillic/Chinese, which already had generic coverage before this
    /// batch). Same shape as `no_candidates_for_normal_western_european_
    /// text`.
    #[test]
    fn no_candidates_for_normal_central_european_text() {
        let candidates = detect_mojibake(WINDOWS1250_UTF8_POLISH_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1250" && c.original == "UTF-8"),
            "correct Central-European windows-1250 text must not trigger a false-positive \
             (windows-1250, UTF-8) repair candidate: {candidates:?}"
        );
    }

    #[test]
    fn windows1250_utf8_reverse_hypothesis_is_rejected() {
        let text = WINDOWS1250_UTF8_POLISH_TEXT;
        let (mojibake, malformed) = WINDOWS_1250.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, text);

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1250, UTF_8)
            .expect("the forward (windows-1250, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct_text, text);

        assert_eq!(
            try_repair(&mojibake, UTF_8, WINDOWS_1250),
            None,
            "the reversed (UTF-8, windows-1250) hypothesis must not also pass"
        );
    }

    /// Same reasoning as `windows1251_utf8_pair_does_not_shadow_sibling_
    /// single_byte_pairs`: windows-1250 (Central European Latin) vs
    /// windows-1251 (Cyrillic) and windows-1252 (Western European Latin)
    /// have different-enough repertoires that gate (a) should separate
    /// them, checked in both directions for both siblings.
    #[test]
    fn windows1250_utf8_pair_does_not_shadow_sibling_single_byte_pairs() {
        let (mojibake, _) =
            WINDOWS_1250.decode_without_bom_handling(WINDOWS1250_UTF8_POLISH_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1251, UTF_8),
            None,
            "genuine windows-1250 Polish mojibake must not also match (windows-1251, UTF-8)"
        );
        assert_eq!(
            try_repair(&mojibake, WINDOWS_1252, UTF_8),
            None,
            "genuine windows-1250 Polish mojibake must not also match (windows-1252, UTF-8)"
        );

        let (m1252, _) = WINDOWS_1252.decode_without_bom_handling(WESTERN_EUROPEAN_TEXT.as_bytes());
        assert_eq!(
            try_repair(&m1252, WINDOWS_1250, UTF_8),
            None,
            "genuine windows-1252 Western-European mojibake must not also match \
             (windows-1250, UTF-8)"
        );
    }

    // --- (KOI8_U, WINDOWS_1251): genuine windows-1251 Cyrillic bytes
    // (including Ukrainian-specific letters) mis-decoded as KOI8-U -- the
    // Ukrainian-locale counterpart to the already-admitted (KOI8_R,
    // WINDOWS_1251) pair (issue #182). Unlike KOI8-R, chardetng 0.1.17 has
    // a real KOI8-U candidate (`KOI8_U_INDEX = 4` in `SINGLE_BYTE_DATA`),
    // so this pair is not structurally blocked the way a `KOI8_R` `original`
    // is. ---

    #[test]
    fn repairs_windows1251_misdecoded_as_koi8u() {
        let original_text = KOI8U_WINDOWS1251_UKRAINIAN_TEXT;
        let (bytes, _, unmappable) = WINDOWS_1251.encode(original_text);
        assert!(!unmappable, "fixture must be fully windows-1251-encodable");
        let (mojibake, malformed) = KOI8_U.decode_without_bom_handling(&bytes);
        assert!(
            !malformed,
            "fixture bytes must also decode cleanly as KOI8-U"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "KOI8-U" && c.original == "windows-1251")
            .unwrap_or_else(|| {
                panic!("expected a (KOI8-U, windows-1251) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "KOI8-U".to_string(), "windows-1251".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    /// New false-positive risk surface distinct from `no_candidates_for_
    /// normal_cyrillic` (plain Russian, no і/ї/є/ґ): correct Ukrainian UTF-8
    /// text, using the letters this pair specifically exists to serve, must
    /// not trigger it either.
    #[test]
    fn no_candidates_for_normal_ukrainian_text() {
        let candidates = detect_mojibake(KOI8U_WINDOWS1251_UKRAINIAN_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "KOI8-U" && c.original == "windows-1251"),
            "correct Ukrainian text must not trigger a false-positive (KOI8-U, \
             windows-1251) repair candidate: {candidates:?}"
        );
    }

    /// Gate 2 (mutual-ambiguity check), robustly: unlike the ISO-8859-5
    /// case (which passes every gate, including chardetng, in *both*
    /// directions), the reverse hypothesis here, (windows-1251, KOI8-U),
    /// fails structurally at gate (a) for every real fixture tried --
    /// Ukrainian text with і/ї/є/ґ, and even plain ASCII-punctuation-only
    /// `RUSSIAN_TEXT` with no Ukrainian-specific letters at all. Root
    /// cause, traced directly: KOI8-U inherits KOI8-R's legacy box-drawing
    /// characters (e.g. U+2566) at several byte positions windows-1251
    /// uses for real Cyrillic letters (Ё/ё among them, at 0xA8/0xB8) --
    /// genuine windows-1251 text almost always uses at least one such byte,
    /// and windows-1251 cannot re-encode the resulting box-drawing
    /// character, so gate (a) rejects before chardetng is ever consulted.
    /// Even the adversarially-constructed worst case that avoids every such
    /// byte (the bare repeated `А..я` alphabet, which *does* pass gates (a)
    /// and (b)) still gets rejected at gate (c): with no real word/bigram
    /// structure, chardetng doesn't recognize it as any specific Cyrillic
    /// encoding at all (it guesses windows-1252, not KOI8-U) -- so this
    /// pair has the same defense-in-depth shape as `windows1252_eucjp_
    /// reverse_hypothesis_is_rejected`, just with the structural gate doing
    /// most of the work instead of the statistical one.
    #[test]
    fn koi8u_windows1251_reverse_hypothesis_is_rejected() {
        for text in [
            KOI8U_WINDOWS1251_UKRAINIAN_TEXT,
            RUSSIAN_TEXT,
            "Щодня вранці я п'ю каву і читаю новини про події в Європі. \
             Мій брат живе у Львові, де є багато старовинних будівель. \
             Восени листя жовтіє, і стає прохолодніше.",
        ] {
            let (real_bytes, _, unmappable) = WINDOWS_1251.encode(text);
            assert!(
                !unmappable,
                "fixture must be windows-1251-encodable: {text}"
            );
            let (mojibake, malformed) = KOI8_U.decode_without_bom_handling(&real_bytes);
            assert!(!malformed, "fixture must KOI8-U-decode cleanly: {text}");
            let mojibake = mojibake.into_owned();

            let (correct_text, _) = try_repair(&mojibake, KOI8_U, WINDOWS_1251)
                .expect("the forward (KOI8-U, windows-1251) hypothesis must pass every gate");
            assert_eq!(correct_text, text);

            assert_eq!(
                try_repair(&mojibake, WINDOWS_1251, KOI8_U),
                None,
                "the reversed (windows-1251, KOI8-U) hypothesis must not also pass \
                 for: {text}"
            );
        }
    }

    /// Documents a known, benign interaction with the pre-existing
    /// (KOI8-R, windows-1251) pair rather than hiding it: for
    /// Ukrainian-flavored content (using і/ї/є/ґ), the old KOI8-R pair
    /// cannot match at all -- KOI8-R lacks those letters entirely, so
    /// decoding their windows-1251 bytes via KOI8-R lands on KOI8-R's own
    /// legacy box-drawing characters, which windows-1251 can't re-encode
    /// (gate (a) fails), exactly the mechanism `koi8u_windows1251_reverse_
    /// hypothesis_is_rejected` documents in the other direction. But for
    /// plain-Russian content with no Ukrainian-specific letters (e.g.
    /// `RUSSIAN_TEXT`), KOI8-R and KOI8-U share enough of their layout that
    /// *both* pairs legitimately match the same mojibake -- unlike the
    /// ISO-8859-5 mutual-ambiguity case, this is not a hazard: both
    /// hypotheses recover the exact same, correct text, so a user offered
    /// both candidates loses nothing by picking either.
    #[test]
    fn koi8u_windows1251_pair_does_not_shadow_existing_koi8r_pair() {
        let (real_bytes, _, unmappable) = WINDOWS_1251.encode(KOI8U_WINDOWS1251_UKRAINIAN_TEXT);
        assert!(!unmappable);
        let (ukr_mojibake, malformed) = KOI8_U.decode_without_bom_handling(&real_bytes);
        assert!(!malformed);
        let ukr_mojibake = ukr_mojibake.into_owned();
        assert_eq!(
            try_repair(&ukr_mojibake, KOI8_R, WINDOWS_1251),
            None,
            "genuine Ukrainian-flavored KOI8-U mojibake must not be wrongly matched by the \
             existing (KOI8-R, windows-1251) pair -- KOI8-R has no candidate letters for \
             і/ї/є/ґ at all"
        );

        let (real_bytes, _, unmappable) = WINDOWS_1251.encode(RUSSIAN_TEXT);
        assert!(!unmappable);
        let (ru_mojibake, malformed) = KOI8_R.decode_without_bom_handling(&real_bytes);
        assert!(!malformed);
        let ru_mojibake = ru_mojibake.into_owned();
        let koi8u_reading = try_repair(&ru_mojibake, KOI8_U, WINDOWS_1251);
        assert_eq!(
            koi8u_reading.map(|(t, _)| t),
            Some(RUSSIAN_TEXT.to_string()),
            "for plain-Russian content the new (KOI8-U, windows-1251) pair, if it also \
             matches genuine (KOI8-R, windows-1251) mojibake, must recover the SAME \
             correct text as the existing pair -- a benign duplicate candidate, not a \
             wrong-repair hazard"
        );
    }

    // ----------------------------------------------------------------
    // v0.9 Track B1 mojibake-pair investigation batch: three more pairs,
    // same dual-gate process as v0.7 Track E, evaluated in a dedicated
    // investigation record before implementation (see the PR description
    // for the full writeup, including rejected/deferred candidates:
    // windows-1257 rejected structurally -- chardetng's own README says
    // its detection "is very inaccurate", and its two gap bytes land in
    // the UTF-8 continuation-byte range, which a real probe showed
    // rejects realistic text at gate 1 itself, not just rarely; windows-
    // 1255 (Hebrew) passed every gate identically to the three admitted
    // here but was deferred purely for this batch's 3-pair cap; windows-
    // 1254 (Turkish) passed every gate but was deprioritized as a
    // low-marginal-value duplicate of the already-admitted (windows-1252,
    // UTF-8) pair for most real Turkish mojibake). Each pair below gets
    // the same four-test shape v0.6 E2/v0.7 Track E established: forward
    // reachability/correctness, a pair-scoped false-positive check,
    // reverse-hypothesis rejection, and non-shadowing checks against the
    // sibling single-byte `(*, UTF_8)` pairs and each other.
    // ----------------------------------------------------------------

    // --- (WINDOWS_1256, UTF_8): Arabic UTF-8 mis-decoded as windows-1256 ---

    #[test]
    fn repairs_utf8_misdecoded_as_windows1256() {
        let original_text = ARABIC_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1256.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1256 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1256" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1256, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1256".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn no_candidates_for_normal_arabic_text() {
        let candidates = detect_mojibake(ARABIC_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1256" && c.original == "UTF-8"),
            "correct Arabic UTF-8 text must not trigger a false-positive \
             (windows-1256, UTF-8) repair candidate: {candidates:?}"
        );
    }

    #[test]
    fn windows1256_utf8_reverse_hypothesis_is_rejected() {
        let text = ARABIC_TEXT;
        let (mojibake, malformed) = WINDOWS_1256.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, text);

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1256, UTF_8)
            .expect("the forward (windows-1256, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct_text, text);

        assert_eq!(
            try_repair(&mojibake, UTF_8, WINDOWS_1256),
            None,
            "the reversed (UTF-8, windows-1256) hypothesis must not also pass"
        );
    }

    /// Checks the pairs most structurally likely to collide with this one:
    /// the three sibling single-byte total-decoder `(*, UTF_8)` pairs
    /// (Cyrillic/Central-European/Western-European Latin), and the other
    /// two new pairs this same batch admits (Vietnamese/Greek). Arabic's
    /// repertoire doesn't overlap any of theirs, so gate (a) alone should
    /// already separate them -- checked in both directions.
    #[test]
    fn windows1256_utf8_pair_does_not_shadow_sibling_single_byte_pairs() {
        let (mojibake, _) = WINDOWS_1256.decode_without_bom_handling(ARABIC_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        for (name, enc) in [
            ("windows-1250", WINDOWS_1250),
            ("windows-1251", WINDOWS_1251),
            ("windows-1252", WINDOWS_1252),
        ] {
            assert_eq!(
                try_repair(&mojibake, enc, UTF_8),
                None,
                "genuine windows-1256 Arabic mojibake must not also match ({name}, UTF-8)"
            );
        }

        let (m1252, _) = WINDOWS_1252.decode_without_bom_handling(WESTERN_EUROPEAN_TEXT.as_bytes());
        assert_eq!(
            try_repair(&m1252, WINDOWS_1256, UTF_8),
            None,
            "genuine windows-1252 Western-European mojibake must not also match \
             (windows-1256, UTF-8)"
        );
    }

    // --- (WINDOWS_1258, UTF_8): Vietnamese UTF-8 mis-decoded as windows-1258 ---

    #[test]
    fn repairs_utf8_misdecoded_as_windows1258() {
        let original_text = VIETNAMESE_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1258.decode_without_bom_handling(bytes);
        assert!(!malformed, "windows-1258 decodes every byte value");
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1258" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1258, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1258".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn no_candidates_for_normal_vietnamese_text() {
        let candidates = detect_mojibake(VIETNAMESE_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1258" && c.original == "UTF-8"),
            "correct Vietnamese UTF-8 text must not trigger a false-positive \
             (windows-1258, UTF-8) repair candidate: {candidates:?}"
        );
    }

    #[test]
    fn windows1258_utf8_reverse_hypothesis_is_rejected() {
        let text = VIETNAMESE_TEXT;
        let (mojibake, malformed) = WINDOWS_1258.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, text);

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1258, UTF_8)
            .expect("the forward (windows-1258, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct_text, text);

        assert_eq!(
            try_repair(&mojibake, UTF_8, WINDOWS_1258),
            None,
            "the reversed (UTF-8, windows-1258) hypothesis must not also pass"
        );
    }

    #[test]
    fn windows1258_utf8_pair_does_not_shadow_sibling_single_byte_pairs() {
        let (mojibake, _) = WINDOWS_1258.decode_without_bom_handling(VIETNAMESE_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        for (name, enc) in [
            ("windows-1250", WINDOWS_1250),
            ("windows-1251", WINDOWS_1251),
            ("windows-1252", WINDOWS_1252),
        ] {
            assert_eq!(
                try_repair(&mojibake, enc, UTF_8),
                None,
                "genuine windows-1258 Vietnamese mojibake must not also match ({name}, UTF-8)"
            );
        }

        let (m1252, _) = WINDOWS_1252.decode_without_bom_handling(WESTERN_EUROPEAN_TEXT.as_bytes());
        assert_eq!(
            try_repair(&m1252, WINDOWS_1258, UTF_8),
            None,
            "genuine windows-1252 Western-European mojibake must not also match \
             (windows-1258, UTF-8)"
        );
    }

    // --- (WINDOWS_1253, UTF_8): Greek UTF-8 mis-decoded as windows-1253 ---

    #[test]
    fn repairs_utf8_misdecoded_as_windows1253() {
        let original_text = GREEK_TEXT;
        let bytes = original_text.as_bytes();
        let (mojibake, malformed) = WINDOWS_1253.decode_without_bom_handling(bytes);
        assert!(
            !malformed,
            "fixture must be constructed so it avoids windows-1253's three gap bytes \
             (0xAA, 0xD2, 0xFF) -- see GREEK_TEXT's doc comment"
        );
        let mojibake = mojibake.into_owned();
        assert_ne!(
            mojibake, original_text,
            "fixture must actually look garbled"
        );

        let candidates = detect_mojibake(mojibake.clone());
        let candidate = candidates
            .iter()
            .find(|c| c.intermediate == "windows-1253" && c.original == "UTF-8")
            .unwrap_or_else(|| {
                panic!("expected a (windows-1253, UTF-8) candidate, got {candidates:?}")
            });
        assert_eq!(candidate.preview, original_text);

        let repaired =
            apply_mojibake_repair(mojibake, "windows-1253".to_string(), "UTF-8".to_string())
                .unwrap();
        assert_eq!(repaired, original_text);
    }

    #[test]
    fn no_candidates_for_normal_greek_text() {
        let candidates = detect_mojibake(GREEK_TEXT.to_string());
        assert!(
            !candidates
                .iter()
                .any(|c| c.intermediate == "windows-1253" && c.original == "UTF-8"),
            "correct Greek UTF-8 text must not trigger a false-positive \
             (windows-1253, UTF-8) repair candidate: {candidates:?}"
        );
    }

    #[test]
    fn windows1253_utf8_reverse_hypothesis_is_rejected() {
        let text = GREEK_TEXT;
        let (mojibake, malformed) = WINDOWS_1253.decode_without_bom_handling(text.as_bytes());
        assert!(!malformed);
        let mojibake = mojibake.into_owned();
        assert_ne!(mojibake, text);

        let (correct_text, _) = try_repair(&mojibake, WINDOWS_1253, UTF_8)
            .expect("the forward (windows-1253, UTF-8) hypothesis must pass every gate");
        assert_eq!(correct_text, text);

        assert_eq!(
            try_repair(&mojibake, UTF_8, WINDOWS_1253),
            None,
            "the reversed (UTF-8, windows-1253) hypothesis must not also pass"
        );
    }

    #[test]
    fn windows1253_utf8_pair_does_not_shadow_sibling_single_byte_pairs() {
        let (mojibake, _) = WINDOWS_1253.decode_without_bom_handling(GREEK_TEXT.as_bytes());
        let mojibake = mojibake.into_owned();
        for (name, enc) in [
            ("windows-1250", WINDOWS_1250),
            ("windows-1251", WINDOWS_1251),
            ("windows-1252", WINDOWS_1252),
        ] {
            assert_eq!(
                try_repair(&mojibake, enc, UTF_8),
                None,
                "genuine windows-1253 Greek mojibake must not also match ({name}, UTF-8)"
            );
        }

        let (m1252, _) = WINDOWS_1252.decode_without_bom_handling(WESTERN_EUROPEAN_TEXT.as_bytes());
        assert_eq!(
            try_repair(&m1252, WINDOWS_1253, UTF_8),
            None,
            "genuine windows-1252 Western-European mojibake must not also match \
             (windows-1253, UTF-8)"
        );
    }

    /// Cross-check among the three new pairs themselves: Arabic, Vietnamese
    /// and Greek repertoires are pairwise disjoint (and disjoint from the
    /// existing single-byte Latin/Cyrillic pairs, checked separately above
    /// in each pair's own `_does_not_shadow_sibling_single_byte_pairs`
    /// test), so gate (a) should separate every combination.
    #[test]
    fn new_windows125x_pairs_do_not_shadow_each_other() {
        let (arabic_mojibake, _) = WINDOWS_1256.decode_without_bom_handling(ARABIC_TEXT.as_bytes());
        let arabic_mojibake = arabic_mojibake.into_owned();
        let (vietnamese_mojibake, _) =
            WINDOWS_1258.decode_without_bom_handling(VIETNAMESE_TEXT.as_bytes());
        let vietnamese_mojibake = vietnamese_mojibake.into_owned();
        let (greek_mojibake, _) = WINDOWS_1253.decode_without_bom_handling(GREEK_TEXT.as_bytes());
        let greek_mojibake = greek_mojibake.into_owned();

        assert_eq!(try_repair(&arabic_mojibake, WINDOWS_1258, UTF_8), None);
        assert_eq!(try_repair(&arabic_mojibake, WINDOWS_1253, UTF_8), None);
        assert_eq!(try_repair(&vietnamese_mojibake, WINDOWS_1256, UTF_8), None);
        assert_eq!(try_repair(&vietnamese_mojibake, WINDOWS_1253, UTF_8), None);
        assert_eq!(try_repair(&greek_mojibake, WINDOWS_1256, UTF_8), None);
        assert_eq!(try_repair(&greek_mojibake, WINDOWS_1258, UTF_8), None);
    }

    // ----------------------------------------------------------------
    // v0.9 Track B1 aggregate ranking-regression gate. `REPAIR_PAIRS` is a
    // manually-grown list (10 pairs pre-v0.7, 15 after v0.7 Track E); every
    // individual `repairs_*` test above proves its own pair's fixture is
    // *found* by `detect_mojibake`, but none of them prove it is not
    // *outranked* once the list has grown this large. `RankCase`/
    // `assert_ranks_first` below assert, for every pair's own canonical
    // fixture (the same fixture its dedicated `repairs_*` test above uses,
    // or the equivalent construction for the three pairs that only had
    // fuzz coverage before this test -- (WINDOWS_1252, GB18030),
    // (WINDOWS_1252, EUC_KR), (GBK, UTF_8)), that `detect_mojibake` ranks
    // the correct (intermediate, original) candidate strictly first
    // (`candidates[0]`), not merely "present somewhere in the
    // `MAX_CANDIDATES`-truncated list". This is deliberately the stricter
    // reading: every fixture here is constructed to trigger only its own
    // pair, with exactly one documented, benign exception -- KOI8-R/KOI8-U
    // sharing plain-Russian mojibake (see
    // `koi8u_windows1251_pair_does_not_shadow_existing_koi8r_pair` above,
    // and the tie-break reasoning in `assert_ranks_first`'s doc comment) --
    // which is why this asserts the specific winner, not just
    // non-emptiness: a silent rank change away from the expected winner is
    // exactly the signal that `REPAIR_PAIRS`'s growth introduced new
    // ambiguity.
    //
    // `cases.len()` is asserted equal to `REPAIR_PAIRS.len() -
    // KNOWN_UNREACHABLE_PAIRS.len()` so this list cannot silently drift out
    // of sync with the const it is meant to cover -- adding a
    // `REPAIR_PAIRS` entry without a matching `RankCase` here fails loudly
    // instead of quietly under-covering the gate.
    //
    // **Pre-existing dead entry found while building this gate (not
    // introduced by this batch, out of scope to fix here):**
    // `(WINDOWS_1252, GB18030)` cannot ever be confirmed by
    // `detect_mojibake`. Gate (c) requires
    // `EncodingDetector::guess` to equal `original` exactly, but chardetng
    // 0.1.17 has no distinct GB18030 candidate at all -- verified directly
    // against its source: `SINGLE_BYTE_DATA`/the double-byte candidate list
    // has only a `Gbk` variant, whose `encoding()` method literally
    // `return`s the `GBK` constant (`chardetng::lib::InnerCandidate::Gbk`'s
    // match arm), never `GB18030`. So `guess() == GB18030` can never be
    // true, for any input whatsoever -- the exact same structural-
    // unreachability shape as the already-documented `(WINDOWS_1251,
    // KOI8_R)` exclusion in `REPAIR_PAIRS`'s doc comment (chardetng has no
    // KOI8-R candidate either), just never previously caught because no
    // test exercised `detect_mojibake` -- as opposed to
    // `apply_mojibake_repair`, which has no chardetng gate at all -- for
    // this specific pair before this gate existed. Filed as a known,
    // non-urgent bug (see PR description) rather than fixed inline: fixing
    // it (drop the entry, or relax gate (c) for this one pair) is an
    // encoding-behavior change of its own, needing the same dual-gate
    // review this repo requires for `mojibake.rs`, not a drive-by edit
    // bundled into an unrelated batch.
    // ----------------------------------------------------------------

    /// `REPAIR_PAIRS` entries this gate deliberately excludes because
    /// `detect_mojibake` can structurally never surface them (see this
    /// module's discussion above) -- listed so the `cases.len()` assertion
    /// documents *why* it isn't `REPAIR_PAIRS.len()`, instead of just being
    /// a mysterious off-by-one.
    const KNOWN_UNREACHABLE_PAIRS: usize = 1; // (WINDOWS_1252, GB18030)

    struct RankCase {
        intermediate: &'static Encoding,
        original: &'static Encoding,
        fixture: &'static str,
    }

    /// Builds the canonical mojibake string for `case` the same way every
    /// `repairs_*` test above does (encode as `original`, mis-decode as
    /// `intermediate`), then asserts `detect_mojibake` ranks that exact
    /// pair first (`candidates[0]`).
    ///
    /// Tie-break note: when two pairs both legitimately recover the exact
    /// same text from the exact same mojibake sample (the documented
    /// KOI8-R/KOI8-U duplicate), `replacement_count`/`cjk_ratio` are
    /// identical for both, so `detect_mojibake`'s `sort_by` (a stable sort)
    /// leaves them in `REPAIR_PAIRS` iteration order -- the earlier-listed
    /// pair wins rank 0. This is relied on, not incidental: it is exactly
    /// why `(KOI8_R, WINDOWS_1251)` is listed before `(KOI8_U,
    /// WINDOWS_1251)` in `REPAIR_PAIRS`.
    fn assert_ranks_first(case: &RankCase) {
        let (bytes, _, unmappable) = case.original.encode(case.fixture);
        assert!(
            !unmappable,
            "fixture must be fully {}-encodable: {:?}",
            case.original.name(),
            case.fixture
        );
        let (mojibake, malformed) = case.intermediate.decode_without_bom_handling(&bytes);
        assert!(
            !malformed,
            "{} must decode the {} bytes cleanly: {:?}",
            case.intermediate.name(),
            case.original.name(),
            case.fixture
        );
        let mojibake = mojibake.into_owned();

        let candidates = detect_mojibake(mojibake.clone());
        let top = candidates.first().unwrap_or_else(|| {
            panic!(
                "expected at least one candidate for ({}, {}), got none; mojibake={mojibake:?}",
                case.intermediate.name(),
                case.original.name()
            )
        });
        assert_eq!(
            (top.intermediate.as_str(), top.original.as_str()),
            (case.intermediate.name(), case.original.name()),
            "expected ({}, {}) to rank first for its own canonical fixture, got {candidates:?}",
            case.intermediate.name(),
            case.original.name(),
        );
    }

    #[test]
    fn all_repair_pairs_rank_first_on_their_own_canonical_fixture() {
        let korean_text =
            "안녕하세요. 이것은 한국어 테스트 문장입니다. 데이터가 손상되면 안 됩니다.";
        let cases = [
            RankCase {
                intermediate: WINDOWS_1252,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1252,
                original: BIG5,
                fixture: BIG5_TEXT,
            },
            // (WINDOWS_1252, GB18030) deliberately omitted -- see
            // `KNOWN_UNREACHABLE_PAIRS`'s doc comment above.
            RankCase {
                intermediate: WINDOWS_1252,
                original: SHIFT_JIS,
                fixture: SHIFT_JIS_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1252,
                original: EUC_KR,
                fixture: korean_text,
            },
            RankCase {
                intermediate: WINDOWS_1252,
                original: EUC_JP,
                fixture: EUC_JP_TEXT,
            },
            RankCase {
                intermediate: BIG5,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: GBK,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: SHIFT_JIS,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: KOI8_R,
                original: WINDOWS_1251,
                fixture: RUSSIAN_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1251,
                original: UTF_8,
                fixture: WINDOWS1251_UTF8_RUSSIAN_TEXT,
            },
            RankCase {
                intermediate: EUC_KR,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: EUC_JP,
                original: UTF_8,
                fixture: LATIN1_SUPPLEMENT_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1250,
                original: UTF_8,
                fixture: WINDOWS1250_UTF8_POLISH_TEXT,
            },
            RankCase {
                intermediate: KOI8_U,
                original: WINDOWS_1251,
                fixture: KOI8U_WINDOWS1251_UKRAINIAN_TEXT,
            },
            // ROADMAP v0.9 Track B1.
            RankCase {
                intermediate: WINDOWS_1256,
                original: UTF_8,
                fixture: ARABIC_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1258,
                original: UTF_8,
                fixture: VIETNAMESE_TEXT,
            },
            RankCase {
                intermediate: WINDOWS_1253,
                original: UTF_8,
                fixture: GREEK_TEXT,
            },
        ];
        assert_eq!(
            cases.len(),
            REPAIR_PAIRS.len() - KNOWN_UNREACHABLE_PAIRS,
            "one RankCase per REPAIR_PAIRS entry, except the entries listed in \
             KNOWN_UNREACHABLE_PAIRS's doc comment -- update both together"
        );
        for case in &cases {
            assert_ranks_first(case);
        }
    }
}
