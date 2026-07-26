//! Streaming find/replace over an entire file on disk, for the read-only
//! large-file preview window (ARCHITECTURE.md's large-file mode): the
//! in-editor Find/Replace can't be used there because only a bounded
//! slice of the file is ever loaded, and saving that slice back would
//! destroy the rest of the file. This command instead streams the whole
//! file from disk in bounded chunks, decodes, replaces, re-encodes, and
//! writes to a same-directory temp file — atomically renamed over the
//! original only once at least one replacement was made — so memory use
//! stays flat (`O(CHUNK_BYTES)`) regardless of file size, and a crash or
//! error mid-run can never leave a half-written file (Track B,
//! ROADMAP.md).
//!
//! `encoding` is the file's own on-disk encoding (the frontend passes the
//! open document's already-detected `doc.encoding`) — used for both
//! decoding and re-encoding. This command never converts between
//! encodings; see [`stream_replace_in_file`]'s doc comment for the full
//! safety discipline.
//!
//! UTF-16 is deliberately rejected up front (see
//! [`stream_replace_in_file`]): `Encoding::new_encoder()` returns an
//! encoder for the encoding's *output encoding*, and per encoding_rs's own
//! docs, "the output encoding of UTF-16BE, UTF-16LE, and replacement is
//! UTF-8" — there is no real UTF-16 encoder. Calling it naively here would
//! silently write UTF-8 bytes into a file labeled UTF-16, corrupting it.
//! `chunk.rs` already excludes UTF-16 from large-file paging for a related
//! reason (line alignment needs code-unit-aware boundaries); this follows
//! the same precedent rather than hand-rolling a manual UTF-16 streaming
//! encoder the way `encoding::encode_utf16` does for the (non-streaming,
//! whole-buffer) save path.
//!
//! Case-insensitive matching (`case_sensitive: false`) is ASCII-only
//! (`[u8]::eq_ignore_ascii_case`): non-ASCII characters always compare
//! exactly, never folded. Full Unicode case folding can change a string's
//! byte length (e.g. German "ß" uppercases to "SS"), which would break
//! this module's byte-offset bookkeeping; restricting folding to ASCII
//! (where upper/lower always occupy exactly one byte each) sidesteps that
//! trap entirely rather than working around it.
//!
//! The per-chunk decode/encode primitives (`decode_chunk`/`encode_chunk`/
//! `read_chunk`/`CHUNK_BYTES`) now live in `streamcodec.rs`, shared with
//! `streamconvert.rs`'s streaming encoding-conversion command (ROADMAP.md
//! v0.4 Track B) — extracted the same way `fsguard.rs` was pulled out of
//! this module for a second caller. Only the search/replace-specific
//! looping and carry semantics (`run_replace_loop`, `replace_pass`) stay
//! here.
//!
//! ## Read-chunk byte-passthrough (issue #96, part 1/3)
//!
//! `encoding_rs`'s decode mapping for several legacy multi-byte encodings
//! (Big5, Shift_JIS and GBK among them) is not injective — more than one
//! on-disk byte sequence can decode to the same character, while `encode`
//! always emits only that character's single canonical byte sequence (see
//! `encoding.rs`'s round-trip contract doc comment). A naive whole-file
//! decode -> replace -> re-encode therefore risks silently canonicalizing
//! bytes the user never asked to touch, anywhere in the file, even when
//! the actual search matched only once. `run_replace_loop` narrows that
//! blast radius to read-chunk granularity: it copies a chunk's *raw*
//! bytes straight to the output — bypassing re-encoding, and therefore
//! bypassing any canonicalization, entirely — whenever the encoding is
//! stateless (ISO-2022-JP is excluded outright — see below) and all of
//! the following hold for that chunk:
//!
//! 1. **No match involvement**: the chunk's work buffer (this round's
//!    decoded text, plus anything carried in from the previous round)
//!    contains zero matches, and `replace_pass` leaves nothing unresolved
//!    to carry into the next round.
//! 2. **No carry-in**: the previous round didn't carry any unresolved
//!    match-candidate text into this round's work buffer.
//! 3. **No decoder pending on either edge**: this round's decode didn't
//!    consume any bytes the streaming `Decoder` had buffered internally
//!    from the *previous* chunk (entry pending), and this round's decode
//!    didn't itself leave an incomplete trailing character buffered for
//!    the *next* chunk (exit pending). Both directions matter — either
//!    one means this round's raw bytes alone no longer correspond 1:1 to
//!    this round's decoded text, so writing them verbatim would drop or
//!    duplicate bytes relative to the neighboring chunk.
//!
//! `encoding_rs`'s `Decoder` doesn't expose its internal pending-bytes
//! state directly, so condition 3 is checked with a self-sufficiency
//! probe (`chunk_is_decode_self_sufficient`) instead: decode this round's
//! raw bytes alone, from scratch, forced to finalize (`last: true`), and
//! require the result to match this round's real (streaming) decoded text
//! exactly, with no malformed sequences either. See that function's doc
//! comment for why this is a conservative (never-*unsafe*, only
//! potentially over-cautious) proxy. It costs one extra decode per chunk,
//! so — per its call site in `run_replace_loop` — it only ever runs after
//! the cheap conditions 1 and 2 already hold.
//!
//! Chunk 0 is unconditionally excluded from passthrough whenever a BOM
//! was written (`bom_len > 0`): `run_replace_loop` re-reads the file from
//! offset 0, so chunk 0's raw bytes still physically contain the BOM that
//! `stream_replace_in_file` already wrote once, verbatim, before the loop
//! started (see that function's own BOM doc comment) — passing chunk 0's
//! raw bytes through as well would duplicate it.
//!
//! **Stateful encodings are excluded from passthrough entirely.**
//! ISO-2022-JP — the one encoding in encoding_rs whose *encoder* carries
//! state across calls (a shift-mode flag deciding whether the next call
//! needs an escape sequence) — is reachable here via `encoding.rs`'s
//! chardetng auto-detection even though the frontend's own encoding
//! picker never offers it, and it always takes the full re-encode path.
//! The reason is subtle enough to spell out: conditions 1–3 above are
//! *text-level and decoder-level* guarantees, and even keeping the
//! shared encoder running every round (see the next paragraph) cannot
//! make passthrough safe for it. A passed-through chunk's raw bytes
//! carry their own trailing shift state, while the shared encoder's
//! state after encoding that same chunk's *text* is whatever its own
//! (discarded) output ended in — and the two can diverge: e.g. a raw
//! tail of `ESC(J` + letters ends the *file* in Roman mode, while the
//! decoded text (plain letters) leaves the *encoder* in ASCII mode. The
//! next chunk to be re-encoded then splices encoder-mode bytes onto a
//! file that is in a different mode, and the result can decode cleanly
//! into silently different text (an ASCII-mode `0x5C` backslash read in
//! Roman mode is "¥") — worse than the canonicalization this feature
//! exists to avoid. Re-encode output, by contrast, is shift-state
//! self-consistent end to end, so ISO-2022-JP simply keeps the exact
//! pre-passthrough behavior. See
//! `iso_2022_jp_is_excluded_from_passthrough_keeping_content_correct`,
//! the red-to-green regression built on exactly that construction.
//!
//! Every chunk is still *decoded* and *encoded* exactly as before,
//! regardless of the passthrough decision — only which byte buffer
//! actually gets written to `tmp` differs, and the encoder's return value
//! is still checked for `had_unmappable` every round. For the stateless
//! encodings passthrough actually applies to, the encoder state argument
//! is moot by definition; keeping the encode call unconditional anyway
//! preserves the unmappable-abort safety net's every-round coverage and
//! keeps the loop's shape identical on both paths.
//!
//! Scope, deliberately: this is chunk-granularity preservation, not
//! match-granularity. A chunk that contains an actual match is still
//! re-encoded in full, including any non-injective byte pair elsewhere in
//! that *same* chunk (see
//! `matching_chunk_still_canonicalizes_non_injective_pair_in_same_chunk`).
//! Narrowing further — so only the matched span itself is ever re-encoded
//! and every other byte in a matching chunk is preserved too — is left
//! for future work; issue #96 tracks it. `StreamReplaceReport`'s
//! `unmatched_region_reencoded` flag discloses whether a run swept any
//! zero-match chunk into re-encoding anyway (carry/pending-entangled with
//! a neighboring match, or chunk 0 excluded under a BOM) — a coarse,
//! honest signal reserved for a future informed-consent UI (issue #96
//! parts 2/3); no frontend reads it yet.

use crate::fsguard::Fingerprint;
use crate::streamcodec::{decode_chunk, encode_chunk, read_chunk, CHUNK_BYTES};
use encoding_rs::{Encoding, ISO_2022_JP, UTF_16BE, UTF_16LE};
use serde::Serialize;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamReplaceReport {
    pub replacements: u64,
    pub bytes_written: u64,
    /// True when at least one chunk containing zero search matches was
    /// still re-encoded rather than copied byte-identical to the output —
    /// i.e. some region the user did not ask to change may have had its
    /// on-disk byte representation canonicalized by one of `encoding_rs`'s
    /// non-injective legacy encoding mappings (see the module doc comment
    /// and issue #96). This can happen when a zero-match chunk is
    /// carry/decoder-pending-entangled with a neighboring chunk, or when
    /// it's chunk 0 of a file with a BOM. `false` means every re-encoded
    /// byte lies within a chunk that itself contained at least one actual
    /// match — the expected, minimal-scope case — and is always `false`
    /// when `replacements == 0` (the file is never touched at all then).
    /// Exposed for a future informed-consent UI (issue #96 parts 2/3); no
    /// frontend currently reads this field.
    pub unmatched_region_reencoded: bool,
}

/// Result of one [`replace_pass`] over a work buffer.
struct PassResult {
    /// The fully-resolved region with all matches replaced.
    out: String,
    /// Number of replacements made within `out`.
    count: u64,
    /// Byte index into the input from which text must be carried into the
    /// next round unprocessed (`input.len()` when everything resolved —
    /// always the case for a final pass). Guaranteed to lie on a char
    /// boundary of the input.
    carry_from: usize,
}

/// One streaming pass of literal (non-regex) find/replace over `text`:
/// replaces every *resolvable* non-overlapping match left to right (the
/// same convention as `str::replace`) and reports where the unresolvable
/// tail begins. `case_sensitive: false` folds only the ASCII range
/// (`[u8]::eq_ignore_ascii_case`); see the module doc comment for why.
///
/// A match candidate (a position whose first byte matches `search`'s
/// first byte, exactly or ASCII-case-folded) is *resolvable* when the
/// full `search.len()`-byte window fits within `text` — every match is
/// exactly `search.len()` bytes, since both exact comparison and
/// ASCII-only folding are length-preserving. When a candidate's window
/// runs past the end of `text`:
///
/// - In a non-final pass (`is_final: false`), the missing tail may still
///   arrive with the next chunk, so the scan stops there: everything
///   before the candidate is resolved into `out`, and `carry_from` points
///   at the candidate so the caller re-presents `text[carry_from..]`
///   (plus the next chunk) in the next pass. Stopping at the *first* such
///   candidate is what makes the seam airtight: no candidate is ever
///   emitted as literal text while its window is still incomplete, so a
///   match can never lose its head to an earlier round — regardless of
///   whether it straddles the chunk seam itself or merely starts close to
///   it. (The obvious-looking alternative — splitting a fixed
///   `search.len() - 1` tail off first and searching only the prefix —
///   has a blind window: a match fully inside `text` that *starts* inside
///   the split-off region straddles the internal split and silently
///   escapes both the prefix search and the carry. See
///   `match_fully_inside_chunk_near_seam_is_found`, the regression lock
///   from the adversarial review that caught exactly that.)
/// - In a final pass (`is_final: true`), no more input is coming, so an
///   unfittable window can never complete: the candidate and everything
///   after it are literal text, and `carry_from` is `text.len()`.
///
/// `carry_from` is bounded: an unresolvable candidate sits within the
/// last `search.len() - 1` bytes of `text`, so the carried tail is
/// shorter than `search` — bounded by the (short, user-typed) search
/// string, not the chunk. (A search string longer than a whole chunk
/// degrades gracefully: the carry accumulates until a full window has
/// arrived, trading the flat-memory bound for correctness in a case no
/// interactive user hits.)
///
/// The byte-window scan (rather than a char-by-char one) is safe because
/// `search` is itself valid UTF-8: its first byte is never a UTF-8
/// continuation byte (0x80-0xBF), and `eq_ignore_ascii_case` only ever
/// folds ASCII bytes into other ASCII bytes (never into — or out of — a
/// continuation/lead byte). So every candidate position is a real char
/// boundary of `text` (also valid UTF-8) — which is also what guarantees
/// `carry_from` lands on one — and a full window match, by the same
/// argument applied to every byte in it, ends on one too. The loop below
/// never slices `text` mid-character.
///
/// Non-matching spans are located by scanning for a candidate first byte
/// and then bulk-copied with one `push_str`, rather than decoding and
/// pushing one character at a time: large filler stretches around a
/// handful of real matches (the common case for a big log file) are the
/// dominant cost otherwise, both for this module's own large-fixture tests
/// and — more importantly — for the actual multi-GB files this command
/// exists to serve.
fn replace_pass(
    text: &str,
    search: &str,
    replace: &str,
    case_sensitive: bool,
    is_final: bool,
) -> PassResult {
    let search_bytes = search.as_bytes();
    debug_assert!(
        !search_bytes.is_empty(),
        "search must be validated non-empty by the caller"
    );
    let slen = search_bytes.len();
    let first = search_bytes[0];
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut count = 0u64;
    let mut i = 0usize;

    while i < bytes.len() {
        let candidate = match bytes[i..].iter().position(|&b| {
            if case_sensitive {
                b == first
            } else {
                b.eq_ignore_ascii_case(&first)
            }
        }) {
            Some(rel) => i + rel,
            None => {
                // No possible match start in the rest: all resolved.
                out.push_str(&text[i..]);
                i = bytes.len();
                break;
            }
        };
        out.push_str(&text[i..candidate]);
        i = candidate;

        let window_end = i + slen;
        if window_end > bytes.len() {
            if is_final {
                // End of stream: this window can never complete, and no
                // later start could fit a full match either.
                out.push_str(&text[i..]);
                i = bytes.len();
            }
            // Non-final: stop here; text[i..] is carried into the next
            // round, where the window's missing tail will have arrived.
            break;
        }
        let window = &bytes[i..window_end];
        let matched = if case_sensitive {
            window == search_bytes
        } else {
            window.eq_ignore_ascii_case(search_bytes)
        };
        if matched {
            out.push_str(replace);
            count += 1;
            i = window_end;
        } else {
            let ch = text[i..]
                .chars()
                .next()
                .expect("i is a valid char boundary (see doc comment above)");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    PassResult {
        out,
        count,
        carry_from: i,
    }
}

/// Result of streaming a whole file through [`run_replace_loop`]: the
/// total replacement count, total bytes written (excluding any BOM prefix
/// the caller wrote to `tmp` beforehand), and whether any zero-match chunk
/// still had to be re-encoded rather than passed through byte-identical
/// (see the module doc comment's three passthrough conditions, and
/// [`StreamReplaceReport::unmatched_region_reencoded`], which this feeds
/// directly).
struct LoopOutcome {
    replacements: u64,
    bytes_written: u64,
    unmatched_region_reencoded: bool,
}

/// Whether `raw` — this round's exact, unmodified source bytes — can be
/// proven to decode in complete isolation from its neighboring chunks:
/// decoding it from scratch with a brand-new decoder, forced to finalize
/// (`last: true`), reproduces `decoded_text` (this round's actual
/// contribution, already produced by the real streaming `decoder` shared
/// across the whole [`run_replace_loop`] call) character-for-character,
/// with no malformed sequences reported either.
///
/// This is the cheapest available proxy for the fact that `encoding_rs`'s
/// streaming `Decoder` doesn't expose its internal pending-bytes state
/// (see the module doc comment). It catches both directions condition 3
/// needs, and it is conservative (can produce false negatives — an
/// unnecessary skip of an actually-safe chunk — but never a false
/// positive that would corrupt output):
///
/// - **Exit pending** (this round's raw bytes end with an incomplete
///   trailing character, deferred by the real decoder to combine with the
///   *next* chunk): forcing `last: true` on those same bytes here, in
///   isolation, always makes `encoding_rs` treat that incomplete tail as a
///   malformed sequence — this is deterministic per its own decode
///   algorithm, not a coincidence to rely on. `had_errors` is then `true`,
///   so this function returns `false` regardless of what the resulting
///   text looks like.
/// - **Entry pending** (this round's real decoded text *starts* with a
///   character completed using bytes the *previous* chunk's raw buffer
///   physically holds — bytes this round's `raw` never contains):
///   decoding `raw` alone starts cold, with no such prefix available. For
///   every encoding this module ever reaches (UTF-16 is rejected before
///   any of this runs), a byte sequence's role — lead vs. trail, valid
///   continuation vs. not — depends on where decoding starts, so a cold
///   start almost always either hits a malformed sequence at the very
///   first byte (caught the same way as above) or resynchronizes at a
///   different byte alignment than the real decode did. A misaligned
///   decode reproducing the *exact same* resulting string as the
///   correctly-aligned real decode, across however much of the chunk
///   follows, is not ruled out by construction, but is not achievable for
///   any of the encodings this module supports without deliberately
///   engineering the entire rest of the chunk byte-for-byte around the
///   coincidence — not something a real file can do by accident, and
///   conditions 1/2 already limit how much of the chunk this even applies
///   to. A false negative here — an entangled chunk that this happens to
///   still call self-sufficient — is not possible for a *different*
///   reason worth spelling out: if it happened, chunk K's raw bytes would
///   be written verbatim as if they were the whole of a character whose
///   completing bytes actually live in chunk K-1, but chunk K-1 has its
///   own, independent, fully deterministic exit-pending check (the first
///   bullet above) — so the pending bytes it drops from *its* own
///   decoded text are never separately written by K-1 either, since K-1's
///   own passthrough eligibility is decided the same way. The one thing
///   that would make this genuinely unsafe — chunk K-1 believing it
///   safely passed through the pending bytes while chunk K also silently
///   absorbed a misaligned reinterpretation of them — can't occur because
///   K-1's check is deterministic, not probabilistic.
///
/// A fresh decoder is constructed with [`Encoding::new_decoder_without_bom_handling`]
/// rather than the `_with_bom_removal` constructor `run_replace_loop`'s
/// own shared `decoder` uses: for every non-UTF-8/UTF-16 encoding this
/// module reaches, `encoding_rs`'s BOM-removal mode is already a no-op
/// (confirmed against its `BomHandling::Remove` source — it only ever
/// special-cases UTF-8/UTF-16BE/UTF-16LE), and for UTF-8, chunk 0 with a
/// real BOM is already excluded from ever reaching this function by the
/// `bom_len` check in `run_replace_loop`, while chunk 0 without a BOM (or
/// any later chunk) never needs BOM stripping either. So the two
/// constructors are behaviorally identical at every call site this
/// function is actually reached from; `without_bom_handling` is simply
/// simpler and additionally avoids a fresh, from-scratch decoder
/// mistaking genuine mid-file content that happens to start with a
/// BOM-like byte sequence (e.g. literal U+FEFF re-encoded to UTF-8's `EF
/// BB BF`) for a BOM — which would only ever cost a conservative false
/// negative here too, never a false positive, but is simplest to just not
/// have to reason about.
///
/// Scope precondition: everything above establishes that `raw` and this
/// round's decoded text correspond 1:1 in isolation — which equals "safe
/// to write `raw` verbatim" only for *stateless* encodings, where a byte
/// span's meaning never depends on preceding output. For a stateful
/// encoding (ISO-2022-JP), a chunk can pass this check and still be
/// unsafe to pass through, because its raw bytes' trailing *shift state*
/// must additionally agree with the shared encoder's state — a
/// file-level, cross-chunk property this per-chunk probe cannot see (see
/// the module doc comment's stateful-exclusion section). That's why
/// `run_replace_loop` gates passthrough on `enc != ISO_2022_JP` *before*
/// this check ever runs: under that gate, self-sufficiency here is
/// exactly segment-correctness.
fn chunk_is_decode_self_sufficient(enc: &'static Encoding, raw: &[u8], decoded_text: &str) -> bool {
    let mut fresh = enc.new_decoder_without_bom_handling();
    let (fresh_text, had_errors) = decode_chunk(&mut fresh, raw, true);
    !had_errors && fresh_text == decoded_text
}

/// Run the streaming decode -> replace -> encode loop, writing bytes to
/// `tmp` as they're produced. `search`/`replace` have already been
/// validated by the caller (non-empty search, both representable in
/// `enc`). `bom_len` is the length of the BOM prefix (0 if none) the
/// caller already wrote to `tmp` before calling this — see the module doc
/// comment for why it unconditionally excludes chunk 0 from passthrough.
///
/// The `carry` variable is the text-level companion to the `Decoder`'s own
/// internal byte-level carry: the decoder already handles a multi-byte
/// *character* split across a raw chunk boundary (that's what streaming
/// decoders are for), but a *match* of `search` can still straddle the
/// boundary between one chunk's decoded text and the next's. Each
/// non-final round therefore only resolves text up to the first match
/// candidate whose window hasn't fully arrived yet; that candidate and
/// everything after it are carried into the next round and re-presented
/// ahead of the next chunk's decoded text (see [`replace_pass`] for the
/// exact contract and why the carry is candidate-anchored rather than a
/// fixed-length tail). A match is never missed for falling near or across
/// a chunk seam (`match_spanning_chunk_boundary_is_found`,
/// `match_fully_inside_chunk_near_seam_is_found`).
///
/// Every round still decodes and encodes exactly as before; only the
/// *write* differs — this round's raw bytes are written verbatim, in
/// place of the encoder's own output, exactly when the encoding is
/// stateless (not ISO-2022-JP — see the module doc comment's
/// stateful-exclusion section), all three passthrough conditions from
/// the module doc comment hold, and this isn't chunk 0 of a BOM-prefixed
/// file. See `chunk_is_decode_self_sufficient` for condition 3 and the
/// module doc comment for why the encoder still runs unconditionally
/// either way.
fn run_replace_loop(
    source: &mut std::fs::File,
    tmp: &mut std::fs::File,
    enc: &'static Encoding,
    search: &str,
    replace: &str,
    case_sensitive: bool,
    bom_len: usize,
) -> Result<LoopOutcome, String> {
    let mut decoder = enc.new_decoder_with_bom_removal();
    let mut encoder = enc.new_encoder();
    let mut carry = String::new();
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut replacements = 0u64;
    let mut bytes_written = 0u64;
    let mut unmatched_region_reencoded = false;
    let mut is_first_chunk = true;
    // Passthrough is only sound for stateless encodings: ISO-2022-JP (the
    // one stateful encoder in encoding_rs) is excluded outright, because a
    // passed-through chunk's raw bytes carry their own trailing shift
    // state, which need not agree with the shared encoder's state after
    // encoding that same chunk's text -- a later re-encoded chunk would
    // then splice bytes onto a mode the file isn't actually in, silently
    // corrupting content (see the module doc comment and
    // `iso_2022_jp_is_excluded_from_passthrough_keeping_content_correct`).
    let stateless_encoding = enc != ISO_2022_JP;

    loop {
        let n = read_chunk(source, &mut buf).map_err(|e| format!("Failed to read: {e}"))?;
        let is_last = n < buf.len();
        let (decoded_text, had_errors) = decode_chunk(&mut decoder, &buf[..n], is_last);
        if had_errors {
            return Err(format!(
                "file does not decode cleanly as {}; aborted, file untouched",
                enc.name()
            ));
        }

        let carry_in_was_empty = carry.is_empty();
        let work = carry + &decoded_text;
        let pass = replace_pass(&work, search, replace, case_sensitive, is_last);
        replacements += pass.count;
        let no_match_and_no_carry_out = pass.count == 0 && pass.carry_from == work.len();

        // Condition 3 (decoder self-sufficiency) is the only expensive
        // check, so it only runs once the cheap ones (the stateless
        // gate, conditions 1/2, and the BOM exclusion) already hold —
        // see the module doc comment.
        let bom_excludes_this_chunk = is_first_chunk && bom_len > 0;
        let eligible_for_passthrough = stateless_encoding
            && !bom_excludes_this_chunk
            && no_match_and_no_carry_out
            && carry_in_was_empty
            && chunk_is_decode_self_sufficient(enc, &buf[..n], &decoded_text);

        // Always encode — even when the output is about to be discarded
        // in favor of the raw bytes below — to keep the encoder's own
        // internal state (and the unmappable safety net) covering every
        // round unconditionally; see the module doc comment.
        let (out_bytes, had_unmappable) = encode_chunk(&mut encoder, &pass.out, is_last);
        if had_unmappable {
            return Err(format!(
                "content does not re-encode cleanly as {}; aborted, file untouched",
                enc.name()
            ));
        }

        if eligible_for_passthrough {
            tmp.write_all(&buf[..n])
                .map_err(|e| format!("Failed to write temp file: {e}"))?;
            bytes_written += n as u64;
        } else {
            if pass.count == 0 {
                unmatched_region_reencoded = true;
            }
            tmp.write_all(&out_bytes)
                .map_err(|e| format!("Failed to write temp file: {e}"))?;
            bytes_written += out_bytes.len() as u64;
        }

        carry = work[pass.carry_from..].to_string();
        is_first_chunk = false;

        if is_last {
            debug_assert!(
                carry.is_empty(),
                "a final pass must resolve its entire input"
            );
            break;
        }
    }

    Ok(LoopOutcome {
        replacements,
        bytes_written,
        unmatched_region_reencoded,
    })
}

/// Captured once at the start of a long streaming operation and re-checked
/// immediately before the final commit (`rename`), so an external
/// replacement of the file mid-run (log rotation, a formatter, a sync tool
/// doing an atomic rename over the same path — see issue #94) is detected
/// and aborted instead of being silently overwritten by this command
/// finishing its read of the now-stale open handle. See
/// [`capture_fingerprint`] and [`verify_unchanged`]; the fingerprint type
/// itself and its cross-platform identity discussion now live in
/// `fsguard.rs`, shared with the regular save path (issue #113).
///
/// Captures `file`'s fingerprint from its already-open handle rather than
/// re-`stat`ing the path, so the snapshot is tied to the exact file this
/// command opened and can never be confused with whatever the path
/// happens to resolve to later (see [`Fingerprint::from_file`]).
fn capture_fingerprint(file: &std::fs::File) -> std::io::Result<Fingerprint> {
    Fingerprint::from_file(file)
}

/// Fail closed if the file at `path` is no longer the file described by
/// `original` (see [`Fingerprint::matches_path`]). Any mismatch — including
/// `path` no longer existing at all — is treated as "changed": there is no
/// case where proceeding anyway is the safe choice once the on-disk
/// contents can no longer be shown to be the ones this run started with.
/// An `Ok` here still leaves the irreducible stat-to-rename TOCTOU window
/// open — this guard narrows the race, it cannot close it (see point 6 of
/// [`stream_replace_in_file`]'s doc comment and issue #102).
fn verify_unchanged(path: &Path, original: &Fingerprint) -> Result<(), String> {
    if original.matches_path(path) {
        Ok(())
    } else {
        Err("file changed on disk during replace; aborted, your file was not modified".to_string())
    }
}

/// Search-and-replace across an entire file on disk, streamed in bounded
/// chunks so memory use stays flat regardless of file size. Backend for
/// the large-file preview window's "Replace in Large File…" command.
///
/// Safety discipline, in order:
///
/// 1. `search` must be non-empty and `encoding` must name a known,
///    non-UTF-16 encoding (see the module doc comment for why UTF-16 is
///    rejected) — checked before anything is read from disk.
/// 2. `replace` is encode-checked in isolation first: if it contains a
///    character `encoding` can't represent, this returns `Err` and never
///    touches the file — a replacement can never partially land.
/// 3. `search` is also encode-checked: if `encoding` can't represent it,
///    no sequence of bytes that round-trips through `encoding` (which is
///    what every byte of this file does, having already been saved in it)
///    can ever decode to text containing `search` — so this returns `Ok`
///    with zero replacements without reading the file at all, rather than
///    erroring.
/// 4. The source is streamed and decoded; any malformed byte sequence
///    aborts immediately (temp file discarded, original untouched) rather
///    than writing back a partially-repaired file — matching
///    ARCHITECTURE.md's "decode errors are surfaced, never silently
///    rendered as if the text were fine".
/// 5. Re-encoding is defensively checked too: `replace` was already
///    validated in step 2, and every unreplaced *character* came from
///    decoding this file's own bytes in `encoding`, so it is by
///    construction representable in `encoding` again — this check exists
///    for defense in depth, not because failure is expected. Any
///    unmappable output still aborts rather than ever writing a lossy
///    byte the caller didn't explicitly agree to (mirrors
///    `save_document`'s `allow_lossy` gate in `lib.rs`, just with no lossy
///    path offered here at all). Representable is not the same as
///    byte-identical, though: several legacy encodings (Big5, Shift_JIS
///    and GBK among them — see `encoding::encode`'s round-trip contract
///    note and issue #96 for the full analysis) are not injective, so an
///    unreplaced byte sequence can still come back out re-encoded to a
///    different, canonical byte sequence for the same character *within a
///    chunk that itself contains a match* — see
///    `matching_chunk_still_canonicalizes_non_injective_pair_in_same_chunk`.
///    A chunk with no match involvement at all is instead copied through
///    byte-for-byte untouched — see the module doc comment's three
///    passthrough conditions and `StreamReplaceReport::unmatched_region_reencoded`.
/// 6. Before that commit, the file at `path` is re-stat'd and compared
///    against the [`Fingerprint`] captured right after the source was
///    opened: if its size, mtime, or (Unix) inode identity no longer
///    match — including the file having been deleted outright — the temp
///    file is discarded and this returns `Err` without ever touching
///    `path`. This is what stops an external process that atomically
///    replaces the same path while a multi-GB stream is still in flight
///    (log rotation, a formatter, a sync tool) from having its newer
///    content silently overwritten once this command finally finishes
///    reading the now-stale open handle (issue #94). This narrows the race
///    to the microsecond-scale check-to-rename window rather than
///    eliminating it — no portable rename has an identity-conditional
///    variant — but that is a vast improvement over leaving the whole
///    multi-minute stream unguarded. See [`capture_fingerprint`] /
///    [`verify_unchanged`].
/// 7. Zero matches leaves the file completely untouched — no temp file
///    persists, no rename, `mtime` unchanged. Only a run with at least one
///    replacement commits: `sync_all`, the fingerprint check above, carry
///    over the resolved target's permissions, then `rename` over the
///    resolved target — the same atomic discipline as
///    `lib.rs::atomic_write_follow_symlinks`, just fed by a temp file
///    filled incrementally instead of from one in-memory buffer. `path` is
///    resolved past any destination symlink before the temp file is even
///    created (`resolve_write_destination`, same resolution
///    `atomic_write_follow_symlinks` uses), so the temp file lands in the
///    resolved target's directory and the final rename lands on that
///    target too — never on `path` itself when it names a symlink, so the
///    link survives (issue #301, streaming-path follow-up in PR #317's
///    third review round).
///
/// BOM handling: up to 3 bytes (the longest BOM any encoding here uses —
/// UTF-8's `EF BB BF`) are peeked from the source first. If they form a
/// BOM for `enc` specifically, those exact bytes are written verbatim as
/// the first bytes of the temp file, and the streaming decoder — always
/// constructed in BOM-*removal* mode regardless of whether a BOM was
/// actually found — strips them back out of the decoded text it produces
/// from the start of the stream, so the search/replace pass never sees
/// them. This mirrors `encoding::decode_with`'s `had_bom` computation
/// (BOM must match the *specific* requested encoding, not just look like
/// some BOM) applied at streaming granularity instead of to a whole
/// in-memory buffer.
#[tauri::command]
pub fn stream_replace_in_file(
    path: String,
    search: String,
    replace: String,
    encoding: String,
    case_sensitive: bool,
) -> Result<StreamReplaceReport, String> {
    if search.is_empty() {
        return Err("Search text must not be empty".to_string());
    }
    let enc = Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| format!("Unknown encoding label: {encoding}"))?;
    if enc == UTF_16LE || enc == UTF_16BE {
        return Err("Replace in Large File is not supported for UTF-16 files".to_string());
    }

    // Step 2: the replacement text must be representable, or nothing runs.
    let (_, replace_unmappable) = crate::encoding::encode(&replace, enc.name(), false)?;
    if replace_unmappable {
        return Err(format!(
            "replacement contains characters not representable in {}",
            enc.name()
        ));
    }
    // Step 3: an unrepresentable search string can never match anything
    // that was itself saved in this encoding.
    let (_, search_unmappable) = crate::encoding::encode(&search, enc.name(), false)?;
    if search_unmappable {
        return Ok(StreamReplaceReport {
            replacements: 0,
            bytes_written: 0,
            unmatched_region_reencoded: false,
        });
    }

    let path_ref = Path::new(&path);
    let mut source =
        std::fs::File::open(path_ref).map_err(|e| format!("Failed to read {path}: {e}"))?;
    // Captured immediately after opening, from this exact handle, so it
    // describes the file this command is about to spend a potentially
    // long time streaming — not whatever the path resolves to later.
    // Compared against a fresh stat of `path` right before commit (see the
    // `replacements > 0` arm below) to fail closed if anything external
    // replaced the file in between (issue #94).
    let fingerprint =
        capture_fingerprint(&source).map_err(|e| format!("Failed to read {path}: {e}"))?;

    let mut peek = [0u8; 3];
    let peek_n =
        read_chunk(&mut source, &mut peek).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let bom_len = Encoding::for_bom(&peek[..peek_n])
        .filter(|(bom_enc, _)| *bom_enc == enc)
        .map(|(_, len)| len)
        .unwrap_or(0);
    source
        .seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to read {path}: {e}"))?;

    // `path` is always a file the user chose to search-and-replace in,
    // never an internal app-state path, so this follows a destination
    // symlink the same way `atomic_write_follow_symlinks` does -- see
    // `resolve_write_destination`'s doc comment (issue #301, streaming-path
    // follow-up). `write_target` (not necessarily `path_ref`'s own
    // directory) is what `dir`/`file_name` -- and the final rename below --
    // must use, so the temp file and its destination stay on the same
    // filesystem even when `path` is a symlink pointing elsewhere.
    let (write_target, dir, file_name) = crate::resolve_write_destination(path_ref, true)
        .map_err(|e| format!("Failed to write {path}: {e}"))?;
    let (mut tmp_file, tmp_path) = crate::create_tmp_exclusive(&dir, &file_name)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    if bom_len > 0 {
        if let Err(e) = tmp_file.write_all(&peek[..bom_len]) {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to write temp file: {e}"));
        }
    }

    let outcome = run_replace_loop(
        &mut source,
        &mut tmp_file,
        enc,
        &search,
        &replace,
        case_sensitive,
        bom_len,
    );

    match outcome {
        Ok(LoopOutcome {
            replacements,
            bytes_written: loop_bytes,
            unmatched_region_reencoded,
        }) if replacements > 0 => {
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
            Ok(StreamReplaceReport {
                replacements,
                bytes_written: bom_len as u64 + loop_bytes,
                unmatched_region_reencoded,
            })
        }
        Ok(_) => {
            drop(tmp_file);
            let _ = std::fs::remove_file(&tmp_path);
            Ok(StreamReplaceReport {
                replacements: 0,
                bytes_written: 0,
                unmatched_region_reencoded: false,
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
    /// multi-second stream (see `replaces_in_big5_file_preserving_encoding`,
    /// which alone runs well over a minute) finishes first renames its own
    /// output over the file the other is still mid-stream reading. The
    /// second process's post-stream fingerprint recheck then correctly --
    /// but spuriously, from the test's perspective -- reports "file changed
    /// on disk", because it really did, just courtesy of a sibling test
    /// process rather than any genuine external actor. Confirmed by direct
    /// reproduction (issue #203) against the sibling large-fixture test in
    /// `streamconvert.rs`: running it as two concurrent processes reliably
    /// reproduced exactly this failure, with the "after" fingerprint's size
    /// and inode matching the other process's completed output
    /// byte-for-byte. PID alone is sufficient (no nanos/counter needed,
    /// unlike `tmp_candidate_path`'s in-process collision concern in
    /// `lib.rs`) because distinct OS processes never share a PID while both
    /// are alive.
    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mojidori-streamreplace-{name}-{}",
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

    /// Core red-to-green case: a >10 MiB UTF-8 file with a known marker
    /// planted near the head, middle, and tail — guaranteeing occurrences
    /// land in more than one 8 MiB streaming chunk — replaced and verified
    /// both by count and by full-content equality against an
    /// independently computed `str::replace` oracle (which also pins that
    /// every byte *outside* the matches is unchanged).
    #[test]
    fn replaces_across_whole_large_utf8_file() {
        let dir = fixture_dir("utf8-whole-file");
        let file = dir.join("big.log");

        let line = "the quick brown fox jumps over the lazy dog\n";
        let lines_needed = (11 * 1024 * 1024) / line.len();
        let marker_at = [10usize, lines_needed / 2, lines_needed - 10];
        let mut content = String::with_capacity(lines_needed * line.len() + 256);
        for i in 0..lines_needed {
            if marker_at.contains(&i) {
                content.push_str("NEEDLE_MARKER token here\n");
            } else {
                content.push_str(line);
            }
        }
        assert!(
            content.len() as u64 > crate::LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let expected_count = content.matches("NEEDLE_MARKER").count() as u64;
        assert_eq!(expected_count, 3, "fixture must plant exactly 3 markers");
        let expected = content.replace("NEEDLE_MARKER", "REPLACED_TOKEN_XYZ");

        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NEEDLE_MARKER".to_string(),
            "REPLACED_TOKEN_XYZ".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, expected_count);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, expected, "every match replaced, rest unchanged");
        assert_eq!(report.bytes_written, on_disk.len() as u64);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Same shape as the UTF-8 case but in Big5 (2 bytes/char): a single
    /// repeated CJK filler character makes it trivial to splice markers at
    /// exact character boundaries while reaching a realistic >10 MiB
    /// on-disk size. Verifies the file stays Big5, decodes cleanly, and
    /// its length accounts exactly for the 3 replaced regions.
    ///
    /// The fixture is built by encoding each *distinct short string* once
    /// (the filler unit, the marker, the replacement — all a handful of
    /// bytes) and then repeating/splicing raw bytes, rather than running
    /// `encoding::encode` over the full ~17 MiB of UTF-8 text. The two are
    /// byte-identical (repeating "測" and then encoding is the same as
    /// encoding "測" and then repeating the 2-byte result), but
    /// encoding_rs's Big5 encoder is dramatically slower per byte than a
    /// raw `Vec<u8>` repeat in an unoptimized (`cargo test`, no
    /// `--release`) build — encoding the full string here was measured at
    /// ~48s on its own, which would make this single test dominate the
    /// whole crate's `cargo test` runtime for no additional coverage.
    #[test]
    fn replaces_in_big5_file_preserving_encoding() {
        let dir = fixture_dir("big5-whole-file");
        let file = dir.join("big.txt");

        let (filler_unit, unmappable) = crate::encoding::encode("測", "Big5", false).unwrap();
        assert!(!unmappable);
        assert_eq!(filler_unit.len(), 2);
        let marker = "甲乙丙";
        let replacement = "丁戊己庚";
        let (marker_bytes, unmappable) = crate::encoding::encode(marker, "Big5", false).unwrap();
        assert!(!unmappable);
        let (replacement_bytes, unmappable) =
            crate::encoding::encode(replacement, "Big5", false).unwrap();
        assert!(!unmappable);

        let filler_bytes = filler_unit.repeat(5_600_000);
        let head = 300usize; // multiple of filler_unit.len() (2)
        let mid = ((filler_bytes.len() / 2) / 2) * 2;
        let tail = filler_bytes.len() - 300;

        let mut bytes = Vec::with_capacity(filler_bytes.len() + marker_bytes.len() * 3);
        bytes.extend_from_slice(&filler_bytes[..head]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[head..mid]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[mid..tail]);
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(&filler_bytes[tail..]);
        assert!(
            bytes.len() as u64 > crate::LARGE_FILE_THRESHOLD,
            "fixture must exceed the large-file threshold"
        );
        let (_, fixture_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(!fixture_malformed, "fixture must be well-formed Big5");
        std::fs::write(&file, &bytes).unwrap();

        let decoded_before = crate::encoding::decode_with(&bytes, "Big5").unwrap();
        assert!(!decoded_before.malformed);
        let expected_content = decoded_before.content.replace(marker, replacement);
        let expected_len = bytes.len() - 3 * marker_bytes.len() + 3 * replacement_bytes.len();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            marker.to_string(),
            replacement.to_string(),
            "Big5".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 3);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk.len(),
            expected_len,
            "byte length must reflect exactly the 3 replaced regions"
        );
        let decoded_after = crate::encoding::decode_with(&on_disk, "Big5").unwrap();
        assert!(!decoded_after.malformed);
        assert_eq!(decoded_after.content, expected_content);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The carry logic's do-or-die test: a pattern constructed so it
    /// straddles exactly the 8 MiB chunk boundary the source-read loop
    /// splits on. Before a correct carry, this pattern would be invisible
    /// to any single decode-and-search pass (half of it is in each raw
    /// chunk); after, it must be found exactly once.
    #[test]
    fn match_spanning_chunk_boundary_is_found() {
        let dir = fixture_dir("chunk-boundary");
        let file = dir.join("boundary.txt");

        let pattern = "BOUNDARY_MARKER_TOKEN";
        let half = pattern.len() / 2;
        let prefix_len = CHUNK_BYTES - half;
        let prefix = "a".repeat(prefix_len);
        let suffix = "b".repeat(4096);
        let content = format!("{prefix}{pattern}{suffix}");

        assert_eq!(&content[prefix_len..prefix_len + pattern.len()], pattern);
        assert!(
            prefix_len < CHUNK_BYTES && prefix_len + pattern.len() > CHUNK_BYTES,
            "the pattern must straddle the exact chunk boundary"
        );

        std::fs::write(&file, content.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            pattern.to_string(),
            "FOUND!".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(
            report.replacements, 1,
            "the boundary-spanning match must be found exactly once"
        );
        let expected = format!("{prefix}FOUND!{suffix}");
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, expected);

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adversarial-review finding (P1): the companion blind spot the test
    /// above cannot see. A match that lies *fully inside* one chunk but
    /// starts within the last `search.len() - 1` bytes of the emitted
    /// prefix straddles the internal prefix/carry split rather than the
    /// chunk seam itself. The N-1-character carry design silently missed
    /// it: the match's head was emitted as literal text (its window didn't
    /// fit inside the prefix), while the carry only preserved text from
    /// the split point onward — so the next round never saw the head, and
    /// the occurrence was skipped without any error, undercounting a
    /// "replace all" the user believes was complete.
    ///
    /// For a 21-byte search, the blind start offsets were
    /// `[CHUNK_BYTES - 40, CHUNK_BYTES - 21]` (start inside the prefix's
    /// last N-1 bytes, end at or before the seam). One marker per file —
    /// the window is only N-1 positions wide, so two markers can't both
    /// fit in it — planted at each edge and the middle of that window.
    /// Red against the split-first carry design; green with the
    /// resolvable-prefix pass (`replace_pass`), which never emits a
    /// candidate whose window hasn't fully arrived.
    #[test]
    fn match_fully_inside_chunk_near_seam_is_found() {
        let pattern = "BOUNDARY_MARKER_TOKEN";
        assert_eq!(pattern.len(), 21);
        // Offsets of the match start *before* the seam, spanning the old
        // design's whole blind window [2N-2, N] plus its midpoint.
        for offset in [40usize, 30, 21] {
            let dir = fixture_dir(&format!("near-seam-{offset}"));
            let file = dir.join("nearseam.txt");

            let start = CHUNK_BYTES - offset;
            let prefix = "a".repeat(start);
            let suffix = "b".repeat(4096);
            let content = format!("{prefix}{pattern}{suffix}");
            assert!(
                start + pattern.len() <= CHUNK_BYTES,
                "offset {offset}: the match must end at or before the seam \
                 (fully inside chunk 1)"
            );
            std::fs::write(&file, content.as_bytes()).unwrap();

            let report = stream_replace_in_file(
                file.to_string_lossy().into_owned(),
                pattern.to_string(),
                "FOUND!".to_string(),
                "UTF-8".to_string(),
                true,
            )
            .unwrap();

            assert_eq!(
                report.replacements, 1,
                "offset {offset}: a match fully inside the chunk, starting \
                 near the seam, must be found exactly once"
            );
            let on_disk = std::fs::read_to_string(&file).unwrap();
            assert_eq!(
                on_disk,
                format!("{prefix}FOUND!{suffix}"),
                "offset {offset}"
            );

            assert_no_leftover_tmp(&dir);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// Issue #301, streaming-path follow-up (PR #317 third review round):
    /// `stream_replace_in_file` used to rename its temp file directly onto
    /// `path`, so "Replace in Large File..." on a file opened through a
    /// symlink replaced the symlink itself with a regular file, leaving
    /// the real target untouched -- the large-file counterpart to the
    /// small-file Save bug issue #301 originally reported. Now that the
    /// commit path resolves through `resolve_write_destination` the same
    /// way `atomic_write_follow_symlinks` does, the link must survive and
    /// the target must receive the replaced content.
    #[cfg(unix)]
    #[test]
    fn stream_replace_in_file_through_symlink_updates_target_and_preserves_link() {
        use std::os::unix::fs::symlink;

        let dir = fixture_dir("through-symlink");
        let target = dir.join("target.txt");
        std::fs::write(&target, "hello NEEDLE world").unwrap();
        let link = dir.join("link.txt");
        symlink(&target, &link).unwrap();

        let report = stream_replace_in_file(
            link.to_string_lossy().into_owned(),
            "NEEDLE".to_string(),
            "REPLACED".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(report.replacements, 1);

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must still be a symlink after the replace, not a regular file"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "hello REPLACED world",
            "the target must hold the newly replaced content"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn zero_matches_leaves_file_untouched() {
        let dir = fixture_dir("zero-matches");
        let file = dir.join("plain.txt");
        std::fs::write(&file, "nothing to see here, no matches at all\n").unwrap();
        let before_bytes = std::fs::read(&file).unwrap();
        let before_mtime = std::fs::metadata(&file).unwrap().modified().unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NOT_PRESENT".to_string(),
            "X".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 0);
        assert_eq!(report.bytes_written, 0);
        let after_bytes = std::fs::read(&file).unwrap();
        let after_mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
        assert_eq!(after_bytes, before_bytes);
        assert_eq!(after_mtime, before_mtime, "mtime must not be disturbed");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A stray `0x80` byte is below Big5's lead-byte floor (0x81) and is
    /// not a valid trail byte either, so splicing it into otherwise-valid
    /// Big5 content guarantees a malformed-sequence decode error (mirrors
    /// encoding.rs's own
    /// `extension_preference_falls_back_when_decode_would_be_malformed`
    /// fixture). The abort must happen without ever touching the original
    /// file or leaving a temp file behind.
    #[test]
    fn malformed_file_aborts_untouched() {
        let dir = fixture_dir("malformed");
        let file = dir.join("bad.txt");

        let text = "正常的中文內容在這裡，這是一段測試文字。";
        let (mut bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        let insert_at = bytes.len() / 2;
        bytes.insert(insert_at, 0x80);
        let (_, big5_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(big5_malformed, "fixture must actually be malformed as Big5");

        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "中文".to_string(),
            "英文".to_string(),
            "Big5".to_string(),
            true,
        );

        assert!(result.is_err(), "malformed source must abort with Err");
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, bytes,
            "original bytes must be untouched after an abort"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_unmappable_in_target_encoding_errors() {
        let dir = fixture_dir("replace-unmappable");
        let file = dir.join("doc.txt");
        let text = "純中文內容，沒有問題。";
        let (bytes, unmappable) = crate::encoding::encode(text, "Big5", false).unwrap();
        assert!(!unmappable);
        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "中文".to_string(),
            "🚀 rocket".to_string(),
            "Big5".to_string(),
            true,
        );

        let err = result.expect_err("emoji replacement must be rejected for Big5");
        assert!(
            err.contains("not representable"),
            "error should explain why: {err}"
        );
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, bytes,
            "file must be untouched when the replacement is rejected"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bom_preserved_when_present() {
        let dir = fixture_dir("bom-preserved");
        let file = dir.join("withbom.txt");
        let text = "line one has a MARKER in it\nline two does not\nline three has a MARKER too\n";
        let (bytes, unmappable) = crate::encoding::encode(text, "UTF-8", true).unwrap();
        assert!(!unmappable);
        assert_eq!(&bytes[..3], [0xEF, 0xBB, 0xBF]);
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            "TOKEN".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 2);
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            &on_disk[..3],
            [0xEF, 0xBB, 0xBF],
            "BOM must survive the replace"
        );
        let decoded = crate::encoding::decode_auto(&on_disk);
        assert_eq!(decoded.encoding, "UTF-8");
        assert!(decoded.had_bom);
        assert_eq!(decoded.content, text.replace("MARKER", "TOKEN"));

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Deliberate scope decision, not an oversight (see the module doc
    /// comment): `Encoding::new_encoder()` has no real UTF-16 encoder, so
    /// this command must refuse UTF-16 outright rather than silently write
    /// UTF-8 bytes into a file labeled UTF-16.
    #[test]
    fn rejects_utf16_target_encoding() {
        let dir = fixture_dir("utf16-rejected");
        let file = dir.join("doc.txt");
        let (bytes, _) = crate::encoding::encode("hello world", "UTF-16LE", true).unwrap();
        std::fs::write(&file, &bytes).unwrap();

        let result = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "hello".to_string(),
            "hi".to_string(),
            "UTF-16LE".to_string(),
            true,
        );
        assert!(result.is_err());
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk, bytes, "rejected file must be untouched");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_must_not_be_empty() {
        let result = stream_replace_in_file(
            "/nonexistent/path/does/not/matter.txt".to_string(),
            String::new(),
            "x".to_string(),
            "UTF-8".to_string(),
            true,
        );
        assert!(result.is_err());
    }

    /// Small-scale contract tests for `replace_pass`, the unit the
    /// streaming loop's correctness rests on. Each simulated "next round"
    /// re-presents `text[carry_from..]` plus newly arrived text, exactly
    /// as `run_replace_loop` does.
    #[test]
    fn replace_pass_carries_from_unresolved_candidate() {
        // Non-final: a candidate ('A') whose window runs off the end must
        // not be emitted; everything before it resolves.
        let pass = replace_pass("xxxAB", "ABCD", "*", true, false);
        assert_eq!(pass.out, "xxx");
        assert_eq!(pass.count, 0);
        assert_eq!(pass.carry_from, 3);

        // Next round: carry + newly decoded text completes the match.
        let work = format!("{}{}", "AB", "CDyy");
        let pass = replace_pass(&work, "ABCD", "*", true, true);
        assert_eq!(pass.out, "*yy");
        assert_eq!(pass.count, 1);
        assert_eq!(pass.carry_from, work.len());

        // A match fully inside the text but starting within the last
        // search.len()-1 bytes must resolve in the same pass (the old
        // fixed-length-tail carry missed exactly this shape). The
        // trailing 'y' is no candidate ('A'), so it resolves too.
        let pass = replace_pass("xxABCDy", "ABCD", "*", true, false);
        assert_eq!(pass.out, "xx*y");
        assert_eq!(pass.count, 1);
        assert_eq!(pass.carry_from, 7);

        // Failed candidate at the very end, final pass: emitted literally.
        let pass = replace_pass("xxxAB", "ABCD", "*", true, true);
        assert_eq!(pass.out, "xxxAB");
        assert_eq!(pass.count, 0);
        assert_eq!(pass.carry_from, 5);

        // Case-insensitive candidate anchoring must use the same fold as
        // the window comparison: 'a' anchors a carry for search "AB".
        let pass = replace_pass("xxxa", "AB", "*", false, false);
        assert_eq!(pass.out, "xxx");
        assert_eq!(pass.carry_from, 3);

        // No candidate anywhere: everything resolves, empty carry.
        let pass = replace_pass("xxxx", "AB", "*", true, false);
        assert_eq!(pass.out, "xxxx");
        assert_eq!(pass.carry_from, 4);
    }

    /// `case_sensitive: false` exercised directly: ASCII letters fold
    /// regardless of case, but an adjacent non-ASCII character (Latin
    /// capital É) is never touched by the search or folded into a match.
    #[test]
    fn case_insensitive_ascii_match_ignores_case_but_not_unicode() {
        let dir = fixture_dir("case-insensitive");
        let file = dir.join("doc.txt");
        let text = "Hello world, HELLO again, hello café HELLO_CAFÉ done";
        std::fs::write(&file, text.as_bytes()).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "hello".to_string(),
            "hi".to_string(),
            "UTF-8".to_string(),
            false,
        )
        .unwrap();

        assert_eq!(report.replacements, 4);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, "hi world, hi again, hi café hi_CAFÉ done");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Happy-path pin for the fingerprint mechanism added for issue #94:
    /// an ordinary replace with no external interference must still
    /// succeed end-to-end through the real public command — the
    /// commit-time `verify_unchanged` check must not false-positive on a
    /// file nobody else touched.
    #[test]
    fn replace_succeeds_when_file_unchanged() {
        let dir = fixture_dir("fingerprint-happy-path");
        let file = dir.join("doc.txt");
        std::fs::write(&file, "alpha NEEDLE beta NEEDLE gamma\n").unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "NEEDLE".to_string(),
            "FOUND".to_string(),
            "UTF-8".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 2);
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, "alpha FOUND beta FOUND gamma\n");

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Core red-to-green regression for issue #94 (P1 data loss): a file
    /// externally replaced via atomic rename — the exact mechanism log
    /// rotation, formatters, and sync tools use — while a stream_replace
    /// run is (hypothetically) still in flight must be detected at
    /// commit time and must never be overwritten.
    ///
    /// `stream_replace_in_file` itself is synchronous end-to-end, so there
    /// is no real yield point to interleave an external rename mid-run
    /// without either (a) racing a background thread against it — flaky,
    /// since on a fast filesystem the whole streaming pass can complete
    /// before the race window opens — or (b) adding test-only
    /// instrumentation (a hook or a generic `Read` parameter) to
    /// `run_replace_loop` purely to enable this test, which is more
    /// production-code surface than a P1 fail-closed fix should carry.
    /// Both were rejected in favor of the approach the task's own design
    /// pre-approved: exercise `capture_fingerprint` /
    /// `verify_unchanged` — the exact two functions
    /// `stream_replace_in_file` calls at the start and right before
    /// `rename` — directly, against a *real* external rename (not a
    /// hand-constructed mismatch; that is covered separately by the
    /// `verify_unchanged_detects_*` tests below). This proves the
    /// detection logic is correct against the genuine OS-level mechanism.
    /// The remaining gap — that `stream_replace_in_file` actually calls
    /// these two functions at the right spots with the right arguments —
    /// is a few lines, directly readable in the diff, and is also
    /// covered indirectly: `replace_succeeds_when_file_unchanged` would
    /// fail if the wiring called `verify_unchanged` with a stale or wrong
    /// path/fingerprint.
    #[cfg(unix)]
    #[test]
    fn replace_aborts_when_file_replaced_during_operation() {
        let dir = fixture_dir("external-replace");
        let file = dir.join("target.txt");
        std::fs::write(&file, b"original content, unchanged\n").unwrap();

        // Mirrors stream_replace_in_file's own opening sequence: open the
        // source handle, then immediately capture its fingerprint.
        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = capture_fingerprint(&source).unwrap();

        // While the replace is (hypothetically) still streaming, another
        // process atomically replaces the same path — e.g. log rotation,
        // a formatter, a sync tool — via rename, exactly as issue #94
        // describes. `source` keeps referring to the original inode (Unix
        // fd semantics), which is precisely the hazard: naively finishing
        // the read and renaming the temp file over `path` would clobber
        // this newer content.
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
        let mut fingerprint = capture_fingerprint(&source).unwrap();

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
        let mut fingerprint = capture_fingerprint(&source).unwrap();

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
        let mut fingerprint = capture_fingerprint(&source).unwrap();

        fingerprint.identity = (
            fingerprint.identity.0,
            fingerprint.identity.1.wrapping_add(1),
        );

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Design point 2's other fail-closed case: the path disappearing
    /// entirely mid-run (not just being replaced) must also abort rather
    /// than proceed.
    #[test]
    fn verify_unchanged_detects_deleted_file() {
        let dir = fixture_dir("verify-deleted");
        let file = dir.join("doc.txt");
        std::fs::write(&file, b"hello").unwrap();
        let source = std::fs::File::open(&file).unwrap();
        let fingerprint = capture_fingerprint(&source).unwrap();

        std::fs::remove_file(&file).unwrap();

        assert!(verify_unchanged(&file, &fingerprint).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ------------------------------------------------------------------
    // Issue #96 (1/3): read-chunk byte-passthrough regression fixtures.
    // These reference only the existing public `stream_replace_in_file`
    // API (no new symbols), so they compile and run red against the
    // pre-fix code: the whole file is decode -> replace -> re-encoded
    // regardless of where the match falls, silently canonicalizing any
    // non-injective legacy byte pair anywhere in the file.
    // ------------------------------------------------------------------

    /// Core red-to-green regression: a chunk containing zero search
    /// matches must reach the output byte-for-byte identical to the
    /// source, even when it contains one of `encoding_rs`'s known
    /// non-injective Big5 byte pairs (`8E 69`, which decodes cleanly to
    /// "箸" but Big5's own encoder always re-emits "箸" as the different,
    /// canonical pair `BA E6` -- issue #96's direct verification). Before
    /// the fix, this command re-encodes the entire file regardless of
    /// where the match falls, so chunk 2 here would silently canonicalize.
    ///
    /// The fixture spans exactly two read chunks (`CHUNK_BYTES`): chunk 1
    /// is ASCII filler containing the one match, chunk 2 is ASCII filler
    /// with the `8E 69` pair spliced into its middle -- comfortably clear
    /// of both chunk ends, so it can never be split across a seam. The
    /// match and its same-length replacement keep chunk 1's re-encoded
    /// length identical to its source length, so chunk 2 lands at the same
    /// `CHUNK_BYTES` offset in both the original and the output, keeping
    /// the byte-for-byte comparison direct.
    #[test]
    fn nonmatching_chunk_with_non_injective_big5_pair_stays_byte_identical() {
        let dir = fixture_dir("big5-passthrough-nonmatching-chunk");
        let file = dir.join("big.txt");

        let pair_bytes: [u8; 2] = [0x8E, 0x69];
        let (decoded_pair, pair_malformed) =
            encoding_rs::BIG5.decode_without_bom_handling(&pair_bytes);
        assert!(!pair_malformed);
        assert_eq!(decoded_pair, "箸");
        let (reencoded_pair, pair_unmappable) =
            crate::encoding::encode(&decoded_pair, "Big5", false).unwrap();
        assert!(!pair_unmappable);
        assert_eq!(
            reencoded_pair,
            vec![0xBA, 0xE6],
            "8E 69 must still canonicalize to BA E6 in this encoding_rs \
             version, or this test's premise no longer holds"
        );

        let (marker_bytes, marker_unmappable) =
            crate::encoding::encode("甲乙丙", "Big5", false).unwrap();
        assert!(!marker_unmappable);
        let (replacement_bytes, replacement_unmappable) =
            crate::encoding::encode("丁戊己", "Big5", false).unwrap();
        assert!(!replacement_unmappable);
        assert_eq!(
            marker_bytes.len(),
            replacement_bytes.len(),
            "keep chunk 2's offset fixed at exactly CHUNK_BYTES"
        );

        let head_len = CHUNK_BYTES / 2;
        let tail_len = CHUNK_BYTES - head_len - marker_bytes.len();
        let mut chunk1 = Vec::with_capacity(CHUNK_BYTES);
        chunk1.extend(std::iter::repeat_n(b'x', head_len));
        chunk1.extend_from_slice(&marker_bytes);
        chunk1.extend(std::iter::repeat_n(b'x', tail_len));
        assert_eq!(chunk1.len(), CHUNK_BYTES);

        let chunk2_head = 2048usize;
        let chunk2_tail = 2048usize;
        let mut chunk2 = Vec::with_capacity(chunk2_head + pair_bytes.len() + chunk2_tail);
        chunk2.extend(std::iter::repeat_n(b'y', chunk2_head));
        chunk2.extend_from_slice(&pair_bytes);
        chunk2.extend(std::iter::repeat_n(b'y', chunk2_tail));
        assert!(chunk2.len() < CHUNK_BYTES);

        let mut bytes = Vec::with_capacity(chunk1.len() + chunk2.len());
        bytes.extend_from_slice(&chunk1);
        bytes.extend_from_slice(&chunk2);

        let (_, fixture_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(!fixture_malformed, "fixture must be well-formed Big5");
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "甲乙丙".to_string(),
            "丁戊己".to_string(),
            "Big5".to_string(),
            true,
        )
        .unwrap();

        assert_eq!(report.replacements, 1);
        assert!(
            !report.unmatched_region_reencoded,
            "chunk 2 has no match and must be reported as passed through, \
             not re-encoded"
        );
        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(on_disk.len(), bytes.len());

        let mut expected_chunk1 = Vec::with_capacity(CHUNK_BYTES);
        expected_chunk1.extend(std::iter::repeat_n(b'x', head_len));
        expected_chunk1.extend_from_slice(&replacement_bytes);
        expected_chunk1.extend(std::iter::repeat_n(b'x', tail_len));
        assert_eq!(
            &on_disk[..CHUNK_BYTES],
            &expected_chunk1[..],
            "matched chunk 1 must reflect the replacement"
        );

        // The crux of the fix: chunk 2 -- unmatched, containing the known
        // non-injective Big5 pair -- must be byte-for-byte identical to
        // the original. Before the fix this becomes BA E6.
        assert_eq!(
            &on_disk[CHUNK_BYTES..],
            &chunk2[..],
            "unmatched chunk 2 (containing Big5 8E 69) must be \
             byte-identical to the original"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Contract pin for the fix's deliberate scope limit: a chunk that
    /// *does* contain a match is still fully re-encoded, including any
    /// non-injective byte pair elsewhere in that same chunk -- passthrough
    /// only ever applies at chunk granularity to a chunk with zero match
    /// involvement (see the module doc comment). Match-level (rather than
    /// chunk-level) byte preservation is explicitly left as future work
    /// (issue #96).
    #[test]
    fn matching_chunk_still_canonicalizes_non_injective_pair_in_same_chunk() {
        let dir = fixture_dir("big5-same-chunk-canonicalizes");
        let file = dir.join("doc.txt");

        let pair_bytes: [u8; 2] = [0x8E, 0x69]; // 箸, canonicalizes to BA E6
        let (marker_bytes, marker_unmappable) =
            crate::encoding::encode("甲乙丙", "Big5", false).unwrap();
        assert!(!marker_unmappable);
        let (replacement_bytes, replacement_unmappable) =
            crate::encoding::encode("丁戊己", "Big5", false).unwrap();
        assert!(!replacement_unmappable);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&pair_bytes);
        bytes.extend_from_slice(b"filler ");
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend_from_slice(b" more filler");

        let (_, fixture_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(!fixture_malformed);
        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "甲乙丙".to_string(),
            "丁戊己".to_string(),
            "Big5".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(report.replacements, 1);
        assert!(
            !report.unmatched_region_reencoded,
            "the only chunk that exists contains the match itself, so \
             nothing *unmatched* was swept into re-encoding"
        );

        let on_disk = std::fs::read(&file).unwrap();
        let mut expected = Vec::new();
        expected.extend_from_slice(&[0xBA, 0xE6]); // canonicalized
        expected.extend_from_slice(b"filler ");
        expected.extend_from_slice(&replacement_bytes);
        expected.extend_from_slice(b" more filler");
        assert_eq!(
            on_disk, expected,
            "the whole matching chunk -- including the non-injective pair \
             -- is re-encoded and canonicalized; this is the accepted, \
             documented scope limit, not a bug"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adversarial-style regression for the decoder-pending condition: a
    /// known non-injective Big5 pair (`8E 69`) deliberately split so its
    /// lead byte is the very last byte of chunk 1's raw read and its trail
    /// byte is the very first byte of chunk 2's raw read. Neither chunk
    /// may passthrough (chunk 1 has decoder exit-pending, chunk 2 has
    /// decoder entry-pending), so both must fall back to normal
    /// re-encoding, and the result must match a whole-buffer decode ->
    /// replace -> re-encode oracle exactly: the split pair still
    /// canonicalizes to `BA E6` no matter which side of the seam it's
    /// read from. This is the case passthrough must never attempt, however
    /// tempting a naive "no match in either chunk" check might look.
    #[test]
    fn non_injective_pair_split_across_chunk_seam_falls_back_to_reencoding() {
        let dir = fixture_dir("big5-split-pair-seam");
        let file = dir.join("doc.txt");

        let (marker_bytes, marker_unmappable) =
            crate::encoding::encode("甲乙丙", "Big5", false).unwrap();
        assert!(!marker_unmappable);
        let (replacement_bytes, replacement_unmappable) =
            crate::encoding::encode("丁戊己", "Big5", false).unwrap();
        assert!(!replacement_unmappable);
        assert_eq!(marker_bytes.len(), replacement_bytes.len());

        // Chunk 1 (exactly CHUNK_BYTES): filler + one match, comfortably
        // clear of the seam, filler again, then a lone Big5 lead byte
        // (0x8E) as literally the chunk's last byte -- an incomplete
        // character sitting right at the chunk-read boundary.
        let head_len = CHUNK_BYTES / 2;
        let tail_len = CHUNK_BYTES - head_len - marker_bytes.len() - 1;
        let mut bytes = Vec::with_capacity(CHUNK_BYTES + 4096);
        bytes.extend(std::iter::repeat_n(b'x', head_len));
        bytes.extend_from_slice(&marker_bytes);
        bytes.extend(std::iter::repeat_n(b'x', tail_len));
        bytes.push(0x8E);
        assert_eq!(bytes.len(), CHUNK_BYTES);
        // Chunk 2: the pair's trail byte first, completing 箸 across the
        // seam, then plain filler, no match -- short of a full chunk so
        // it reads as the final round.
        bytes.push(0x69);
        bytes.extend(std::iter::repeat_n(b'y', 4096));

        let (_, fixture_malformed) = encoding_rs::BIG5.decode_without_bom_handling(&bytes);
        assert!(!fixture_malformed, "fixture must be well-formed Big5");
        std::fs::write(&file, &bytes).unwrap();

        let decoded_before = crate::encoding::decode_with(&bytes, "Big5").unwrap();
        assert!(!decoded_before.malformed);
        let expected_content = decoded_before.content.replace("甲乙丙", "丁戊己");
        let (expected_bytes, expected_unmappable) =
            crate::encoding::encode(&expected_content, "Big5", false).unwrap();
        assert!(!expected_unmappable);
        assert_ne!(
            expected_bytes, bytes,
            "the fixture's split pair must actually canonicalize on a \
             full re-encode, or this test doesn't exercise anything"
        );

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "甲乙丙".to_string(),
            "丁戊己".to_string(),
            "Big5".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(report.replacements, 1);

        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(
            on_disk, expected_bytes,
            "a character split exactly across the chunk-read seam must \
             still canonicalize via re-encoding on both sides -- \
             passthrough must never attempt this"
        );
        assert!(
            on_disk.windows(2).any(|w| w == [0xBA, 0xE6]),
            "the split pair must have been canonicalized to BA E6 \
             somewhere in the output"
        );
        assert!(
            !on_disk.windows(2).any(|w| w == [0x8E, 0x69]),
            "the original split-pair bytes must not survive verbatim"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Adversarial-review finding: `run_replace_loop` re-reads the file
    /// from offset 0, so chunk 0's raw bytes still physically include the
    /// BOM even though the BOM was already written once by
    /// `stream_replace_in_file` itself before the loop starts. If chunk 0
    /// were otherwise passthrough-eligible (no match, no carry,
    /// self-sufficient decode -- exactly what a BOM-prefixed file whose
    /// only match falls in a later chunk produces), naively passing its
    /// raw bytes through would duplicate the BOM. `bom_len > 0` must
    /// unconditionally exclude chunk 0 from passthrough regardless of the
    /// other conditions.
    #[test]
    fn bom_not_duplicated_when_first_chunk_has_no_match() {
        let dir = fixture_dir("bom-first-chunk-passthrough-excluded");
        let file = dir.join("doc.txt");

        let bom = [0xEFu8, 0xBBu8, 0xBFu8];
        let head_len = CHUNK_BYTES - bom.len();
        let mut bytes = Vec::with_capacity(CHUNK_BYTES + 4096);
        bytes.extend_from_slice(&bom);
        bytes.extend(std::iter::repeat_n(b'a', head_len));
        assert_eq!(
            bytes.len(),
            CHUNK_BYTES,
            "chunk 0 must be exactly one full read chunk, entirely \
             match-free"
        );
        bytes.extend_from_slice(b"MARKER");
        bytes.extend(std::iter::repeat_n(b'b', 1024));

        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            "TOKEN!".to_string(), // same length: keeps the length math simple
            "UTF-8".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(report.replacements, 1);

        let on_disk = std::fs::read(&file).unwrap();
        assert_eq!(&on_disk[..3], &bom, "exactly one BOM must open the file");
        assert_ne!(
            &on_disk[3..6],
            &bom,
            "the BOM must not be written a second time right after itself"
        );
        assert_eq!(
            on_disk.len(),
            bytes.len(),
            "no extra BOM bytes may have snuck in (MARKER -> TOKEN! is \
             length-preserving)"
        );

        let decoded = crate::encoding::decode_auto(&on_disk);
        assert_eq!(decoded.encoding, "UTF-8");
        assert!(decoded.had_bom);
        assert!(
            decoded.content.starts_with('a'),
            "no stray leading BOM character in the decoded text"
        );
        assert!(decoded.content.contains("TOKEN!"));
        assert!(!decoded.content.contains("MARKER"));

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Direct, fast unit coverage for the passthrough-eligibility helper
    /// itself, using all three of issue #96's directly-verified
    /// non-injective byte pairs (the large fixture tests above, for CI
    /// cost reasons, only exercise the full `stream_replace_in_file`
    /// pipeline for Big5). Each pair, decoded in complete isolation
    /// exactly as a lone, self-contained chunk would be, must be judged
    /// self-sufficient — and each pair's re-encoding must independently
    /// be confirmed to canonicalize to a *different* byte sequence, or
    /// this test (and the risk it documents) would be exercising nothing.
    #[test]
    fn chunk_is_decode_self_sufficient_for_all_three_known_non_injective_pairs() {
        let cases: &[(&'static Encoding, &[u8], &str, &[u8])] = &[
            (encoding_rs::BIG5, &[0x8E, 0x69], "箸", &[0xBA, 0xE6]),
            (encoding_rs::SHIFT_JIS, &[0x87, 0x90], "≒", &[0x81, 0xE0]),
            (encoding_rs::GBK, &[0xA2, 0xE3], "€", &[0x80]),
        ];
        for (enc, raw, expected_char, expected_reencoded) in cases {
            let mut decoder = enc.new_decoder_with_bom_removal();
            let (decoded_text, had_errors) = decode_chunk(&mut decoder, raw, true);
            assert!(!had_errors, "{}: must decode cleanly", enc.name());
            assert_eq!(decoded_text, *expected_char, "{}", enc.name());

            assert!(
                chunk_is_decode_self_sufficient(enc, raw, &decoded_text),
                "{}: an isolated, complete, non-split pair must be judged \
                 self-sufficient",
                enc.name()
            );

            let mut encoder = enc.new_encoder();
            let (reencoded, had_unmappable) = encode_chunk(&mut encoder, &decoded_text, true);
            assert!(!had_unmappable, "{}", enc.name());
            assert_eq!(
                &reencoded[..],
                *expected_reencoded,
                "{}: must still canonicalize on re-encode, or this test's \
                 premise no longer holds",
                enc.name()
            );
            assert_ne!(
                &reencoded[..],
                *raw,
                "{}: confirms passthrough is actually load-bearing here",
                enc.name()
            );
        }
    }

    /// Adversarial-review P1 regression (stateful-encoder shift-state
    /// mismatch): passthrough writes a chunk's *raw bytes*, whose trailing
    /// shift state (for ISO-2022-JP, the one stateful encoder in
    /// encoding_rs) can differ from the shared `Encoder`'s own state after
    /// encoding that same chunk's text -- so a later re-encoded chunk's
    /// bytes splice onto a mode the decoder isn't actually in at that
    /// point in the file.
    ///
    /// Construction note: the review's original sketch put a trailing
    /// `ESC(B` after a kanji (raw tail: ASCII mode; encoder after "...亜":
    /// JIS mode) with the next chunk opening on another escape -- but
    /// encoding_rs (per the WHATWG spec's output-flag rule, verified in
    /// its `iso_2022_jp.rs` source) treats an escape sequence immediately
    /// following another escape sequence as malformed, so that exact file
    /// can't exist as a clean fixture. The same root divergence has a
    /// fully well-formed variant via the *Roman* (`ESC(J`) mode instead:
    /// chunk 1 (exactly CHUNK_BYTES; no match; self-sufficient -- cold
    /// and streaming decodes agree) is ASCII filler whose tail switches
    /// to Roman mode for its last few 'a's. Roman-mode 'a' decodes as
    /// plain "a", so chunk 1's *decoded text* is pure ASCII and the
    /// shared encoder (which never enters Roman mode on its own) ends
    /// chunk 1 in *ASCII* mode -- while the raw bytes end in *Roman*
    /// mode. Chunk 2's decoded text starts with a backslash (`ESC(B \`
    /// in the raw file) and contains the match; the encoder, believing
    /// itself in ASCII mode, emits `\` as a bare `0x5C` with no mode
    /// switch. Spliced after chunk 1's raw bytes, that `0x5C` sits in
    /// Roman mode -- where it decodes, cleanly (`had_errors: false`), as
    /// "¥" (U+00A5). Silent corruption of content the user never
    /// touched. Red before ISO-2022-JP was excluded from passthrough;
    /// green after (it always takes the full re-encode path, whose
    /// output is shift-state self-consistent end to end -- exactly the
    /// pre-passthrough behavior).
    #[test]
    fn iso_2022_jp_is_excluded_from_passthrough_keeping_content_correct() {
        let dir = fixture_dir("iso2022jp-stateful-excluded");
        let file = dir.join("doc.txt");

        let esc_roman: [u8; 3] = [0x1B, 0x28, 0x4A]; // ESC ( J -> Roman mode
        let esc_ascii: [u8; 3] = [0x1B, 0x28, 0x42]; // ESC ( B -> ASCII mode

        // Chunk 1: exactly CHUNK_BYTES of what decodes to pure 'a'
        // filler, but whose raw tail is `ESC(J` + 8 Roman-mode 'a's --
        // leaving the raw byte stream in Roman mode while the decoded
        // text gives the encoder no reason to leave ASCII mode.
        let roman_tail_len = 8usize;
        let filler_len = CHUNK_BYTES - esc_roman.len() - roman_tail_len;
        let mut bytes = Vec::with_capacity(CHUNK_BYTES + 4096);
        bytes.extend(std::iter::repeat_n(b'a', filler_len));
        bytes.extend_from_slice(&esc_roman);
        bytes.extend(std::iter::repeat_n(b'a', roman_tail_len));
        assert_eq!(bytes.len(), CHUNK_BYTES);

        // Chunk 2: back to ASCII mode, then a backslash -- the character
        // whose byte (0x5C) means "\" in ASCII mode but "¥" in Roman
        // mode -- then the match.
        bytes.extend_from_slice(&esc_ascii);
        bytes.push(b'\\');
        bytes.extend_from_slice(b"MARKER");
        bytes.extend(std::iter::repeat_n(b'b', 1024));

        let (decoded_fixture, fixture_malformed) =
            encoding_rs::ISO_2022_JP.decode_without_bom_handling(&bytes);
        assert!(
            !fixture_malformed,
            "fixture must be well-formed ISO-2022-JP"
        );
        assert_eq!(decoded_fixture.matches('\\').count(), 1);
        assert_eq!(decoded_fixture.matches('¥').count(), 0);
        assert_eq!(decoded_fixture.matches("MARKER").count(), 1);
        let expected_content = decoded_fixture.replace("MARKER", "TOKEN!");

        std::fs::write(&file, &bytes).unwrap();

        let report = stream_replace_in_file(
            file.to_string_lossy().into_owned(),
            "MARKER".to_string(),
            "TOKEN!".to_string(),
            "ISO-2022-JP".to_string(),
            true,
        )
        .unwrap();
        assert_eq!(report.replacements, 1);

        let on_disk = std::fs::read(&file).unwrap();
        let decoded_after = crate::encoding::decode_with(&on_disk, "ISO-2022-JP").unwrap();
        assert!(!decoded_after.malformed);
        assert!(
            !decoded_after.content.contains('¥'),
            "the shift-state-mismatch corruption signature (an ASCII-mode \
             0x5C landing in raw Roman mode) must not appear"
        );
        assert_eq!(
            decoded_after.content, expected_content,
            "stateful ISO-2022-JP content must survive intact -- raw-tail \
             shift state and encoder shift state must never be spliced"
        );
        assert!(
            report.unmatched_region_reencoded,
            "chunk 1 has no match but must be honestly reported as \
             re-encoded (stateful encoding, passthrough never applies)"
        );

        assert_no_leftover_tmp(&dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The self-sufficiency check must not itself become a false-positive
    /// hazard: a byte sequence that's genuinely malformed on its own (not
    /// merely incomplete pending a neighbor) must be judged
    /// not-self-sufficient too, since `chunk_is_decode_self_sufficient` is
    /// only ever reached (via `run_replace_loop`'s short-circuit) after
    /// the real streaming decode of the same bytes already reported no
    /// errors -- but pinning the helper's own behavior directly, rather
    /// than only inferring it, keeps this contract honest in isolation.
    #[test]
    fn chunk_is_decode_self_sufficient_rejects_malformed_raw_bytes() {
        // 0x80 is below Big5's lead-byte floor and not a valid trail byte.
        assert!(!chunk_is_decode_self_sufficient(
            encoding_rs::BIG5,
            &[0x80],
            "",
        ));
    }

    /// And the mirror case: a lone, genuinely incomplete lead byte (no
    /// trail byte at all in `raw`) must also be rejected -- this is
    /// exactly condition 3's exit-pending case, pinned directly against
    /// the helper rather than only through the large split-seam fixture
    /// above.
    #[test]
    fn chunk_is_decode_self_sufficient_rejects_lone_incomplete_lead_byte() {
        assert!(!chunk_is_decode_self_sufficient(
            encoding_rs::BIG5,
            &[0x8E],
            "",
        ));
    }
}
