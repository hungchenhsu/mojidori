// Pure core for "find/replace in selection" (ROADMAP.md v0.7 Track C)
// [danger]: CodeMirror 6's @codemirror/search has no concept of scoping
// Replace/Replace All to the current selection — its `replaceNext`/
// `replaceAll` commands (node_modules/@codemirror/search) always operate on
// the whole document. This module reimplements just enough of
// @codemirror/search's own matching and replacement semantics, scoped to a
// set of selection ranges, as a plain `(docText, ranges, query) => result`
// function with zero CodeMirror dependency — editor.ts is the only module
// allowed to import CodeMirror (see its own header comment), and the thin
// `EditorHandle.replaceInSelection`/`replaceAllInSelection` binding there is
// the only caller of the matching/replacement functions below. 100%
// vitest-covered here (replacescope.test.ts), which also drives the *real*
// @codemirror/search commands against an unattached `EditorView` (a live
// EditorView works fine with no `parent`/DOM measure pass — see that file's
// header) to empirically pin this module's output against CM6's own
// whole-document replace for every case where the two should agree.
//
// One exception to "editor.ts is the only caller": `buildReplaceScopeResultMessage`
// near the bottom of this file (ROADMAP.md v0.9 C2, issue #292's optional
// follow-up) is also imported directly by main.ts's `dispatchMenuCommand`.
// It is a plain string-formatting function with no CodeMirror dependency of
// its own — it only reads `ReplaceScopeResult`'s counts and `i18n.ts`'s
// dictionary — so this does not reopen the CodeMirror-isolation boundary the
// rest of the module exists to enforce; it lives here rather than in its own
// file because it is one small pure function over this module's own result
// type, and main.ts has no vitest coverage of its own for pure helpers to
// live in (see CLAUDE.md's Definition of done #3).
//
// Plain-string matching (issue #292) is a direct port of
// @codemirror/search's own `SearchCursor` scanning automaton, NFKD
// normalization included — see `stringMatchesInRange` below for the
// line-by-line correspondence with
// node_modules/@codemirror/search/dist/index.js.
//
// A note on the `dist/index.js:NNN` citations throughout this file: they
// refer to @codemirror/search / @codemirror/state 6.7.1, the versions this
// app currently resolves to. Line numbers in a bundled `dist` file drift
// between releases, so treat them as a fast way to find the code, not as a
// contract — the surrounding quotes of the upstream source are what
// actually identify it, and the differential tests in replacescope.test.ts
// (which run against whatever version is installed, not against these
// numbers) are what actually enforce agreement.
//
// Two consequences of that port are worth stating up front, because both
// are inherited from upstream *on purpose* and neither is a bug to fix
// here:
//
// 1. Only `precise` matches are replaceable — a match is `precise` when
//    the original-text range `[from, to)` covers exactly the content the
//    match consumed, with no unmatched original text pulled in on either
//    side (`NormalizedMatch`'s doc comment is the authoritative definition;
//    the obvious intuitive phrasings, upstream's own docstring included,
//    are wrong in a corner this module has a test for). The everyday case
//    is a query covering only part of one character's expansion — query
//    "f" against a "ﬁ" U+FB01 ligature, which NFKD-expands to "fi" — which
//    comes back `precise: false`, and `to` would otherwise swallow the
//    ligature's whole "i" half as well.
//    CM6's own commands never replace those: `replaceAll` pushes a
//    change only `if (precise)` (dist/index.js:956-959) and `replaceNext`
//    skips straight past an imprecise match (dist/index.js:925-927). This
//    module does the same, so the find panel's highlight — which marks
//    *every* match, precise or not (`StringQuery.highlight`,
//    dist/index.js:672-676) — can still show something that neither this
//    module nor CM6's own whole-document Replace All will touch. That
//    residual gap is CM6's own, identical in both, and is what
//    `ReplaceScopeResult.skippedNonPrecise` (ROADMAP.md v0.9 C2, issue
//    #292's optional follow-up) counts and `buildReplaceScopeResultMessage`
//    surfaces to the user, rather than leaving it invisible.
// 2. Canonical reordering is not handled, because upstream does not
//    handle it: the document is normalized one code point at a time,
//    which cannot reorder combining marks by canonical combining class,
//    while the query is normalized as one whole string, which can. So a
//    document containing "e" + U+0301 + U+0316 does not match a query of
//    that exact same three-code-point sequence — in CM6 either. Pinned by
//    test; replicating upstream's per-code-point scan is precisely what
//    guarantees the two agree, and "fixing" it by normalizing the whole
//    document at once would create a *new* divergence in the opposite
//    direction (matching more than CM6 does).
//
// Remaining deliberate divergence from @codemirror/search's own
// SearchCursor (string/non-regexp search only — RegExpCursor is matched
// faithfully, see below):
//
// - Word-boundary categorization (`wholeWord`) is done per Unicode code
//   point, not per extended grapheme cluster the way CM6's `charBefore`/
//   `charAfter` (`findClusterBreak`) do. This only differs from CM6 when a
//   match boundary sits directly adjacent to a combining-mark cluster, and
//   is the same simplification level the rest of this codebase already
//   accepts elsewhere (e.g. editor.ts's `characterBeforeCursor` also reads
//   a single code point, not a grapheme cluster).
//
// Regexp search has neither issue: @codemirror/search's RegExpCursor runs
// the raw JS RegExp engine directly against undecomposed text (no
// normalization), and this module does the same — `new RegExp(pattern,
// flags)` against the full `docText` — with the *same* "gmu" + "i" flags
// CM6 itself uses (`baseFlags` in node_modules/@codemirror/search).
//
// Scanning model: each range is searched independently (a fresh scan/regex
// reset to that range's own `from`), not as a continuation of whatever scan
// state a previous range left behind. For regexp mode this is provably
// equivalent to "scan the whole document once, keep only matches fully
// contained in a range" for every match that a whole-document scan would
// actually accept (a match spanning outside all ranges is never kept
// either way); it can only differ from a continuous whole-document scan in
// the far corner of a *rejected* candidate (crosses a range boundary, or
// fails `wholeWord`) landing so as to change where the *next* candidate is
// tried — see replacescope.test.ts for the cases this was checked against.
// Per-range independence was chosen deliberately over a whole-document scan
// for both simplicity (no need to track "which range am I in" mid-scan)
// and cost (bounded by selected text, not document size). One direct
// consequence: two ranges that touch (e.g. `[0, 1]` and `[1, 2]`) each scan
// right up to and including the shared point, so a zero-length regexp match
// sitting exactly there is a legitimate candidate for both — see
// `replaceAllInSelection`'s doc comment for how ownership of that shared
// candidate is resolved (issue #300).
import { t } from "./i18n";

export interface ReplaceRange {
  readonly from: number;
  readonly to: number;
}

/** Mirrors the subset of @codemirror/search's `SearchQuery` fields this
 *  module needs — plain data, not a live CM6 object, so the binding layer
 *  (editor.ts) is the only place that ever touches the real `SearchQuery`
 *  (via `getSearchQuery(state)`) and unwraps it into this shape. `search` is
 *  the *raw* text exactly as `SearchQuery.search` holds it (never
 *  pre-unquoted by the caller) — this module does the unquoting itself (see
 *  `matchesInRange`), the same way `@codemirror/search` does for both of its
 *  `QueryType` implementations: `StringQuery` searches with `spec.unquoted`
 *  (`\n`/`\r`/`\t`/`\\` escapes resolved) while `RegExpQuery` searches with
 *  the raw `spec.search` pattern unchanged (verified from source: `stringCursor`
 *  passes `spec.unquoted` to `SearchCursor`, `regexpCursor` passes `spec.search`
 *  to `RegExpCursor`). Does not model `SearchQuery.literal` (which would
 *  disable unquoting entirely): the built-in search panel this app uses has
 *  no UI to set it, so a real query read from `getSearchQuery` never has it
 *  either — `literal` is always false, so unquoting always applies. */
export interface ReplaceScopeQuery {
  readonly search: string;
  readonly replace: string;
  readonly regexp: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord?: boolean;
}

/** One CodeMirror-style change: replace `[from, to)` with `insert`. Field
 *  names match `@codemirror/state`'s `ChangeSpec` shape exactly (not by
 *  coincidence) so the binding layer can hand `result.edits` straight to
 *  `view.dispatch({ changes: result.edits })` with no remapping. */
export interface ReplaceEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface ReplaceScopeResult {
  /** In ascending, non-overlapping order, in *original* `docText`
   *  coordinates — exactly what a single `view.dispatch({ changes })` call
   *  expects (CM6 maps an array of changes through each other internally;
   *  it does not want them pre-shifted). Empty when nothing matched, or
   *  when every given range was empty (see the module header's "no CM6
   *  import" note and this file's `replaceAllInSelection` docs for the
   *  empty-selection no-op rule). */
  readonly edits: readonly ReplaceEdit[];
  /**
   * `ranges`, mapped through `edits` to their *post-edit* positions —
   * exactly what CM6's own `Transaction.selection` field expects when
   * dispatched alongside `changes` (selection coordinates for a
   * transaction that also carries changes are always post-edit). Each
   * range still spans "the same content, replaced" rather than collapsing
   * to a point: a range that contained two matches, one growing the text
   * and one shrinking it, comes back sized to fit the range's original
   * unmatched content plus both replacements — so pressing "Replace All in
   * Selection" again on the result (after the binding layer re-applies
   * this as the live selection) finds only genuinely new matches, not the
   * ones just replaced, and still knows the boundaries of "the selection"
   * to search within.
   */
  readonly ranges: readonly ReplaceRange[];
  /**
   * How many additional matches, across every scanned range, were found by
   * the NFKD-normalizing scan but not replaced because they were not
   * `precise` (see `NormalizedMatch`'s doc comment on `stringMatchesInRange`
   * for what `precise` means) — the same matches CM6's own find-panel
   * highlight would show (`StringQuery.highlight` marks every match) but its
   * whole-document Replace/Replace All would silently skip, exactly as this
   * module's `edits` do (see the module header's point 1). Always `0` in
   * regexp mode: `RegExpCursor` never normalizes at all, so there is no
   * precise/imprecise distinction to skip on (see the module header's
   * "Regexp search has neither issue" paragraph).
   *
   * Counted, not just detected: every range actually scanned contributes its
   * own imprecise-match count, including a range whose scan found this and
   * nothing else (see `stringMatchesInRange`) and — for `replaceInSelection`
   * only — every range scanned on the way to the one range whose first
   * match was actually replaced (ranges after that one are never scanned,
   * the same way CM6's own `replaceNext` never looks past the match it took).
   * `main.ts`'s `dispatchMenuCommand` uses this to decide whether to show
   * `buildReplaceScopeResultMessage`'s disclosure at all (ROADMAP.md v0.9
   * C2): a value of `0` is the ordinary, fully-silent case; a positive value
   * means at least one on-screen highlighted match was not touched, which is
   * the one case worth interrupting the user about.
   */
  readonly skippedNonPrecise: number;
}

/** @codemirror/search always applies this to the replace text (see
 *  `expandReplacement`) and, in plain-string mode only, to the search text
 *  too (see `matchesInRange`) unless `SearchQuery.literal` is set (see the
 *  `ReplaceScopeQuery` doc comment for why this module never sets it):
 *  backslash escapes for newline, carriage return, tab, and a literal
 *  backslash, so typing `\n` in the Find field (plain-string mode) or the
 *  Replace field (either mode) matches/inserts an actual newline. Mirrors
 *  `SearchQuery.unquote` exactly (node_modules/@codemirror/search). Never
 *  applied to a regexp search pattern — see `matchesInRange`. */
function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch: string) =>
    ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\",
  );
}

/** A single match found by `matchesInRange`. `matched`/`groups` are only
 *  meaningful for regexp mode's `$`-substitution (see `expandReplacement`);
 *  string-mode matches still populate `matched` (harmless) but never read
 *  `groups`, since plain-string replace text is never `$`-expanded (see
 *  `expandReplacement`'s early return). */
interface FoundMatch {
  readonly from: number;
  readonly to: number;
  readonly matched: string;
  readonly groups?: readonly (string | undefined)[];
}

/** The result of scanning one range for matches: the replaceable matches
 *  themselves, plus (plain-string mode only — see `matchesInRange`) how many
 *  additional matches were found but skipped for not being `precise`
 *  (ROADMAP.md v0.9 C2). Shared return shape for `stringMatchesInRange` and
 *  `regexMatchesInRange` via `matchesInRange`, so every caller of
 *  `matchesInRange` gets the skipped count for free regardless of mode. */
interface RangeScanResult {
  readonly matches: FoundMatch[];
  readonly skippedNonPrecise: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The single Unicode code point ending at `pos` (i.e. immediately before
 *  it), surrogate-pair aware — `""` at `pos <= 0` (nothing before the start
 *  of `text`). Mirrors editor.ts's `characterBeforeCursor` windowing, just
 *  without the cursor-specific line-start clamp that function also has
 *  (word-boundary categorization here has no reason to stop at a line
 *  break — @codemirror/search's own `charBefore`/`charAfter` don't either). */
function codePointBefore(text: string, pos: number): string {
  if (pos <= 0) return "";
  if (
    pos >= 2 &&
    isLowSurrogate(text.charCodeAt(pos - 1)) &&
    isHighSurrogate(text.charCodeAt(pos - 2))
  ) {
    return text.slice(pos - 2, pos);
  }
  return text.slice(pos - 1, pos);
}

/** The single Unicode code point starting at `pos`, surrogate-pair aware —
 *  `""` at `pos >= text.length` (nothing left). */
function codePointAt(text: string, pos: number): string {
  if (pos >= text.length) return "";
  if (
    isHighSurrogate(text.charCodeAt(pos)) &&
    pos + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(pos + 1))
  ) {
    return text.slice(pos, pos + 2);
  }
  return text.slice(pos, pos + 1);
}

/**
 * How many UTF-16 code units the single code point starting at `pos`
 * occupies, never reading at or past `limit`. Mirrors the
 * `codePointSize(codePointAt(buffer, bufferPos))` pair @codemirror/search's
 * `SearchCursor.peek`/`nextOverlapping` use
 * (node_modules/@codemirror/search/dist/index.js:50-60, :85;
 * `codePointAt`/`codePointSize` live in
 * node_modules/@codemirror/state/dist/index.js:583-606): a high surrogate
 * with no low surrogate available *within the region being scanned* counts
 * as one unit, exactly as upstream's `pos + 1 == str.length` guard does at
 * the end of its own buffer.
 *
 * Upstream's "buffer" is one line chunk of the searched region rather than
 * the whole region, which makes no difference here: a surrogate pair can
 * never straddle a line break (the character after a chunk is always `\n`
 * or `\r`, never a low surrogate), so the only boundary where the guard can
 * actually change the answer is the searched region's own end — which is
 * what `limit` is.
 *
 * **Always returns at least 1**, which is the termination guarantee for
 * `stringMatchesInRange`'s scan loop: every iteration advances the scan
 * position by this value, so the loop cannot stall on a lone surrogate, on
 * an astral character at a range edge, or on a code point whose normalized
 * form is empty (issue #327's family of zero-length/no-progress hangs).
 */
function codePointSizeAt(text: string, pos: number, limit: number): number {
  return pos + 1 < limit &&
    isHighSurrogate(text.charCodeAt(pos)) &&
    isLowSurrogate(text.charCodeAt(pos + 1))
    ? 2
    : 1;
}

/**
 * `pos`, nudged forward if it sits on the low surrogate of an astral
 * character's surrogate pair — mirrors @codemirror/search's own
 * `toCharEnd` (node_modules/@codemirror/search) exactly, minus its
 * per-line chunking (irrelevant here: this module always scans the full
 * `docText` string directly, and a surrogate pair never spans a line
 * break). This is not optional cosmetic surrogate-awareness: it is the fix
 * for issue #320, a P1 infinite loop. `new RegExp(pattern, "...u...")`
 * (this module always sets the `u` flag — see `buildRegExp`) refuses to
 * begin a match strictly inside a surrogate pair; V8 silently corrects
 * `lastIndex` back to that code point's own start before matching, so
 * setting `lastIndex` to a mid-surrogate position and expecting the scan
 * to have advanced is simply wrong — the *next* `exec` call returns the
 * *same* match again at the same `index`, and a caller that only ever
 * advances `lastIndex` by one more UTF-16 code unit each time (as
 * `regexMatchesInRange`'s zero-length case used to, before this fix) can
 * never get past it: `lastIndex` keeps landing back on the same
 * mid-surrogate position it was already corrected away from, forever.
 * Used everywhere this module sets `re.lastIndex` to a position that
 * isn't already guaranteed code-point-aligned (a raw regex match's own
 * `index`/end always is, straight from the engine — only a position *this
 * module itself computes*, like a zero-length match's "one past here", is
 * ever at risk).
 */
function toCharEnd(text: string, pos: number): number {
  while (pos < text.length && isLowSurrogate(text.charCodeAt(pos))) pos++;
  return pos;
}

type CharCategory = "word" | "space" | "other";

/** Mirrors @codemirror/state's default `charCategorizer` (no custom
 *  `EditorState.wordChars` — this app never configures one): whitespace,
 *  else a Unicode letter/number/underscore is a word character, else
 *  "other". `""` (off the start/end of the text — see `codePointBefore`/
 *  `codePointAt`) counts as space, the same way CM6's own categorizer does
 *  for an empty string — this is what makes the start/end of the document
 *  act as a word boundary below. */
function categoryOf(ch: string): CharCategory {
  if (!/\S/u.test(ch)) return "space";
  return /[\p{Alphabetic}\p{Number}_]/u.test(ch) ? "word" : "other";
}

/**
 * Whether a match spanning `[from, to)` satisfies `wholeWord`: neither edge
 * may sit strictly inside a run of word characters. A zero-length match
 * always passes (mirrors @codemirror/search's `regexpWordTest`: `!match[0]
 * .length || ...`) — an empty match can't "split a word" by itself.
 * Otherwise, for each edge, the test passes when *at least one* of the two
 * characters straddling it is not a word character (equivalent to "the two
 * sides differ, or neither is a word char" — see this module's header for
 * why grapheme-cluster precision is not attempted). Mirrors
 * @codemirror/search's `stringWordTest`/`regexpWordTest` exactly, modulo
 * the code-point-vs-grapheme-cluster granularity documented in the module
 * header.
 */
function isWordBoundaryOk(text: string, from: number, to: number): boolean {
  if (from === to) return true;
  const beforeStart = categoryOf(codePointBefore(text, from));
  const atStart = categoryOf(codePointAt(text, from));
  const beforeEnd = categoryOf(codePointBefore(text, to));
  const afterEnd = categoryOf(codePointAt(text, to));
  const startOk = beforeStart !== "word" || atStart !== "word";
  const endOk = afterEnd !== "word" || beforeEnd !== "word";
  return startOk && endOk;
}

/**
 * @codemirror/search's own text normalization for plain-string search:
 * NFKD first, case-fold second, in exactly that order
 * (node_modules/@codemirror/search/dist/index.js:5-6 `basicNormalize = x =>
 * x.normalize("NFKD")`, and :47 `this.normalize = normalize ? x =>
 * normalize(basicNormalize(x)) : basicNormalize`, where the `normalize`
 * argument `stringCursor` passes for a case-insensitive query is
 * `x => x.toLowerCase()`, :615).
 *
 * The order is load-bearing, not incidental. U+1D2C (MODIFIER LETTER
 * CAPITAL A) is a case that tells the two apart, verified rather than
 * assumed: it has no lowercase mapping of its own, but its NFKD is the
 * ASCII "A", which does. So `toLowerCase(NFKD(U+1D2C))` is `"a"` while
 * `NFKD(toLowerCase(U+1D2C))` is `"A"` — with the order reversed, a
 * case-insensitive search for "a" would stop matching it, and CM6's find
 * panel (which is on the correct order) would highlight a match this
 * module then refused to replace, which is the exact class of divergence
 * issue #292 is about. 120 BMP code points behave this way; U+1D2C is
 * simply the tidiest, and `replacescope.test.ts` pins it behaviorally.
 *
 * (U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE is a tempting example and
 * is *not* one: contrary to what one might assume, its NFKD is not a no-op
 * — it decomposes to "I" + U+0307 — and both composition orders happen to
 * land on the same "i" + U+0307. It is still worth knowing about for a
 * different reason: case folding changes its length, which is why nothing
 * in this module may index into a pre-lower-cased copy of the document.)
 *
 * Upstream guards `basicNormalize` on `typeof String.prototype.normalize ==
 * "function"` for ancient runtimes; this app's WebViews (WKWebView /
 * WebView2, both Tier 1) and its Node/vitest environment all have it
 * unconditionally, the same reasoning `buildRegExp` applies to the `u` flag.
 */
function nfkdNormalizerFor(caseSensitive: boolean): (text: string) => string {
  return caseSensitive
    ? (text: string) => text.normalize("NFKD")
    : (text: string) => text.normalize("NFKD").toLowerCase();
}

/** One in-flight partial match inside `stringMatchesInRange`'s automaton,
 *  mirroring the entries of `SearchCursor.matches`
 *  (node_modules/@codemirror/search/dist/index.js:42, pushed at :126,
 *  advanced in place at :113). `index` is how many code units of the
 *  normalized query have been consumed so far and is deliberately mutable —
 *  upstream advances it in place rather than replacing the object. */
interface PartialMatch {
  readonly from: number;
  index: number;
  readonly precise: boolean;
}

/**
 * A completed match, before `precise` filtering.
 *
 * `precise` is the authoritative definition for this whole module, so state
 * it by mechanism rather than by intuition — the intuitive phrasings are all
 * subtly wrong, including upstream's own docstring ("set to false if the
 * match starts or ends _inside_ a character that, when normalized, expands
 * to multiple characters"), which the U+1D160 case in `stringMatchesInRange`
 * contradicts.
 *
 * `precise` is `posPrecise && endPrecise`, and what it certifies is that the
 * original-text range `[from, to)` covers **exactly** the content the match
 * consumed — no original text on either side that the match did not actually
 * match. (That is upstream's own second sentence: an imprecise match's
 * "`from`-`to` range covers content that isn't part of the actual match".
 * Its first sentence — "starts or ends _inside_ a character that expands" —
 * is the part that does not survive the U+1D160 case.) The two halves:
 *
 * - `posPrecise` stays true only while the normalized expansion, read left
 *   to right, is still unit-for-unit identical to the original code point's
 *   own leading units. While that holds, the expansion units *skipped*
 *   before the match's start correspond one-to-one to original units also
 *   skipped, so `from` excludes exactly them and nothing more. At the first
 *   divergence that correspondence is gone and the flag drops, for that
 *   start position and every later one within this code point.
 * - `endPrecise` is true only on the final unit of the expansion, i.e. the
 *   match ran to the end of this code point, so `to` (always the code
 *   point's own end) adds no unmatched trailing content. This is what makes
 *   query "f" against a "ﬁ" ligature imprecise: `to` would cover the whole
 *   ligature while the match is only its first half.
 *
 * It does **not** mean the match began at the start of an expansion, and it
 * does **not** mean the endpoints are code point aligned — an original-text
 * UTF-16 offset can still sit between an astral character's two surrogates,
 * which is exactly the U+1D160 case pinned in replacescope.test.ts.
 */
interface NormalizedMatch {
  readonly from: number;
  readonly to: number;
  readonly precise: boolean;
}

/**
 * One step of @codemirror/search's matching automaton: feed a single code
 * unit `code` of some original code point's normalized expansion to every
 * in-flight partial match, and start a new partial when it could begin one.
 * A verbatim port of `SearchCursor.match`
 * (node_modules/@codemirror/search/dist/index.js:104-130), including the
 * details that look like accidents and are not:
 *
 * - A partial that fails to advance is dropped (`keep` stays false, the
 *   entry is spliced out) — including the one that just *completed*, which
 *   is what makes the scan non-overlapping.
 * - `pos`/`posPrecise` describe where this code unit's own would-be match
 *   *start* is, `end`/`endPrecise` where the current original code point
 *   ends; a completed match takes `from` from whichever partial completed
 *   (or `pos`, for a one-code-unit query) and `to` always from `end`. A
 *   match's `to` is therefore always an original code point boundary. Its
 *   `from` is **not** guaranteed to be one — see `stringMatchesInRange`'s
 *   note on `matchStart`, which can advance *into* a code point while
 *   `posPrecise` is still true. What the downstream offset bookkeeping
 *   (`mapPosition`/`mapRangeEndpoints`/`expandReplacement`) actually needs
 *   is only that these are plain `docText` offsets in the original
 *   coordinate system, which they are; nothing downstream inspects
 *   surrogate alignment.
 * - `wholeWordTest` is applied here, at completion, and only nulls out the
 *   *result* — the partial it came from has already been spliced out and is
 *   not restored. Upstream does exactly this (`this.test` at :128-129), so
 *   a word-boundary rejection does not restart or rewind the scan; the
 *   other still-live partials are what keep overlapping candidates alive.
 *   (This is the same "weave the test into the accept decision rather than
 *   filtering results afterwards" discipline `regexMatchesInRange` needs
 *   for its own reasons — see PR #318 round 3.)
 * - When two partials complete on the same code unit, the last one wins,
 *   exactly as upstream's plain assignment to `match` does.
 */
function matchNormalizedChar(
  partials: PartialMatch[],
  query: string,
  code: number,
  pos: number,
  posPrecise: boolean,
  end: number,
  endPrecise: boolean,
  wholeWordTest: ((from: number, to: number) => boolean) | undefined,
): NormalizedMatch | null {
  let match: NormalizedMatch | null = null;
  for (let i = 0; i < partials.length; ) {
    const partial = partials[i];
    let keep = false;
    if (query.charCodeAt(partial.index) === code) {
      if (partial.index === query.length - 1) {
        match = { from: partial.from, to: end, precise: endPrecise && partial.precise };
      } else {
        partial.index++;
        keep = true;
      }
    }
    if (keep) i++;
    else partials.splice(i, 1);
  }
  if (query.charCodeAt(0) === code) {
    if (query.length === 1) match = { from: pos, to: end, precise: posPrecise && endPrecise };
    else partials.push({ from: pos, index: 1, precise: posPrecise });
  }
  if (match && wholeWordTest && !wholeWordTest(match.from, match.to)) match = null;
  return match;
}

/**
 * Every *replaceable* non-overlapping plain-string match of `search` within
 * `[range.from, range.to)`, using @codemirror/search's own NFKD-normalizing
 * scan (issue #292). A port of `SearchCursor.nextOverlapping` driven the
 * way `StringQuery.matchAll` drives it — `while (!cursor.next().done)`,
 * where `next()` clears the in-flight partial matches before resuming
 * (node_modules/@codemirror/search/dist/index.js:67-71 and :77-103,
 * :663-670) — with
 * upstream's own `precise` filter from `replaceAll` (:956-959) applied to
 * the result, so what comes back is exactly the set of matches CM6's own
 * whole-document Replace All would replace if `range` were the whole
 * document. `replacescope.test.ts` pins that equivalence differentially
 * against the real `SearchCursor` and the real `replaceAll`, not just
 * against hand-written fixtures.
 *
 * The scan runs in *original `docText` coordinates* throughout, bounded by
 * `range.to`; it never slices the range out into its own string, which
 * would put the automaton in local coordinates and force an offset
 * translation on every match (exactly the bookkeeping the port exists to
 * avoid). `docText.slice` is used only to read the single code point under
 * the scan and to materialize a completed match's text — never to relocate
 * the search.
 *
 * Two structural properties the callers depend on, both inherited from the
 * automaton rather than enforced afterwards:
 *
 * - **Matches come back strictly ascending and non-overlapping.** After a
 *   match completes, the partial list is cleared and the outer scan resumes
 *   at the code point boundary the match ended on (upstream's `next()` +
 *   `bufferPos`), so the next match's `from` is at or after the previous
 *   match's `to`. Non-`precise` matches are filtered out of the *result*
 *   but still consume the scan exactly as they do upstream — dropping them
 *   earlier would let a later match overlap one CM6 had already consumed.
 * - **Every match is fully inside the range**: `from` comes from a partial
 *   started at or after `range.from`, and `to` is always the end of a code
 *   point the scan read without crossing `range.to` (see `codePointSizeAt`).
 * - `to` is always an original code point boundary. **`from` is not
 *   necessarily one**, and saying otherwise would be wrong: `matchStart`
 *   below advances *within* the current code point for as long as the
 *   normalized expansion still matches the original unit for unit, so for
 *   an astral character whose NFKD begins with its own high surrogate
 *   (U+1D160 is one: its NFKD is U+1D158 U+1D165 U+1D16E, all sharing the
 *   0xD834 lead unit), a `precise: true` match can begin on the *low*
 *   surrogate. Replacing it then leaves an unpaired surrogate behind. Note
 *   that such a match does start part-way through the expansion (at
 *   normalized offset 1 of 6) and is still `precise` — see
 *   `matchNormalizedChar` for what `precise` actually tracks. This is
 *   upstream's behavior exactly — CM6's own whole-document Replace All
 *   produces the identical edit, verified against the real `SearchCursor`
 *   and pinned by test — so it is inherited here rather than diverged
 *   from, on the same principle as the other inherited quirks above. It
 *   needs a query that itself begins with a lone low surrogate to trigger.
 * - **No match is ever zero-length** (`from < to` always), which is what
 *   lets `replaceAllInSelection`'s zero-length-boundary `ownership`
 *   bookkeeping and `mapPosition`'s `zeroLengthAtPosPrecedes` decision stay
 *   a regexp-only concern. A zero-length match would need a code point's
 *   would-be match start (`matchStart` below) to advance all the way to
 *   that code point's own end, which requires its normalized form to be a
 *   strict *extension* of the original code point (same leading units, more
 *   of them). No Unicode code point normalizes that way, under either
 *   normalizer this module builds — checked exhaustively over all 1,114,112
 *   code points rather than assumed, and pinned by a test in
 *   replacescope.test.ts so a future Unicode revision cannot quietly break
 *   the assumption.
 *
 * Termination: the outer loop advances by `str.length`, and `str` is one
 * code point read from *inside* the clamped `limit` below, so it is always
 * at least one unit long — that, not `codePointSizeAt`'s return value on
 * its own, is what guarantees progress. (The clamp is load-bearing for
 * exactly this reason: past the end of `docText` the slice would be empty
 * and the scan would spin. See the comment on `limit`.) Given progress, the
 * loop terminates regardless of what NFKD does to a code point — expand it,
 * leave it alone, or, per the `norm.length` guard (upstream :87), produce
 * nothing at all. A query whose normalized form is empty returns no matches
 * instead of scanning, mirroring upstream's behavior for an empty query
 * (`query.charCodeAt(0)` is `NaN`, which never equals any code unit) while
 * making the reason explicit rather than incidental.
 *
 * Cost: O(range length x query length) in the worst case, with one
 * `String.prototype.normalize` call per code point scanned. Ordinary prose
 * is roughly 3x the old exact-substring scan (~50ms for a 1 MB selection);
 * highly repetitive text with a long query is the bad shape (200k repeats
 * of one character with a 2000-character query takes ~2s). This is CM6's
 * own asymptotic behavior — its whole-document Replace All pays the same
 * on the same input — and this module is additionally bounded by the
 * selection rather than the document, but it does run synchronously on the
 * WebView's main thread.
 *
 * Alongside the replaceable matches, also counts every match this scan found
 * but did not push because it was not `precise` (ROADMAP.md v0.9 C2, issue
 * #292's optional follow-up) — the same count the "matches come back
 * strictly ascending" bullet above already relies on being tracked
 * (`partials` is cleared, and the scan resumes, for an imprecise match too,
 * exactly like a precise one). Counting is a pure side observation of the
 * existing `found.precise` branch below; it changes no control flow and
 * therefore cannot change which matches are replaced — see this file's
 * `replaceAllInSelection`/`replaceInSelection` doc comments for the
 * hard-constraint that the replace-relevant differential property sweeps in
 * replacescope.test.ts (which predate this counter) still pin `edits`
 * byte-for-byte against the real `SearchCursor`/`replaceAll`.
 */
function stringMatchesInRange(
  docText: string,
  range: ReplaceRange,
  search: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): RangeScanResult {
  const matches: FoundMatch[] = [];
  let skippedNonPrecise = 0;
  const normalize = nfkdNormalizerFor(caseSensitive);
  // The query is normalized as one whole string, the document one code
  // point at a time — upstream does the same (:48 vs :86), and that
  // asymmetry is the origin of the canonical-reordering limitation
  // documented in the module header. Deliberately preserved.
  const query = normalize(search);
  if (query.length === 0) return { matches, skippedNonPrecise };
  const wholeWordTest = wholeWord
    ? (from: number, to: number) => isWordBoundaryOk(docText, from, to)
    : undefined;
  const partials: PartialMatch[] = [];
  // Clamped to the document, not taken on trust from the caller. Without
  // this, a range reaching past the end of `docText` (`range.to >
  // docText.length`) makes `docText.slice(start, start + 1)` return `""`
  // once the scan passes the end: `pos` then never advances, `norm.length`
  // is 0 so the `continue` below fires every time, and the loop spins
  // forever — a synchronous hang, the same failure mode as issues #320 and
  // #327. The in-app caller (editor.ts's `dispatchScopedReplace`) always
  // passes live selection ranges against the matching document, so this is
  // not reachable through the app today; it is guarded here anyway because
  // this module is a pure function whose contract should not include "and
  // the caller must pre-validate the range or the process hangs". Pinned by
  // an out-of-process test in replacescope.test.ts.
  const limit = Math.min(range.to, docText.length);
  let pos = Math.max(range.from, 0);
  while (pos < limit) {
    const start = pos;
    const str = docText.slice(start, start + codePointSizeAt(docText, start, limit));
    // Advanced past the whole code point *before* its expansion is walked,
    // exactly as upstream does (:84-85) — which is why `end` below is the
    // position after the entire code point, never a position inside it.
    pos = start + str.length;
    const norm = normalize(str);
    // Upstream's `if (norm.length)` guard (:87). Defense in depth, and
    // deliberately not claimed as tested: no Unicode code point currently
    // normalizes to nothing, so a mutation of this line survives the test
    // suite. It stays because it is load-bearing if one ever did — without
    // it the inner loop's `i === norm.length - 1` termination check becomes
    // `i === -1`, which is never true, and the scan spins forever on that
    // one code point (the same no-progress shape as issues #320 and #327).
    if (norm.length === 0) continue;
    for (let i = 0, matchStart = start, posPrecise = true; ; i++) {
      const code = norm.charCodeAt(i);
      const found = matchNormalizedChar(
        partials,
        query,
        code,
        matchStart,
        posPrecise,
        pos,
        i === norm.length - 1,
        wholeWordTest,
      );
      if (found) {
        // Upstream's `replaceAll` filter (:956-959): an imprecise match is
        // reported by the cursor but never replaced. It still consumed the
        // scan, so the partial list is cleared either way (upstream's
        // `next()`, :67-70).
        if (found.precise) {
          matches.push({
            from: found.from,
            to: found.to,
            // The *original* text, not the query and not its normalized
            // form: any future `$&`-style expansion (see
            // `expandReplacement`) must quote what is actually being
            // removed from the document, which for a normalized match is
            // not the same string as the query.
            matched: docText.slice(found.from, found.to),
          });
        } else {
          skippedNonPrecise++;
        }
        partials.length = 0;
        break;
      }
      if (i === norm.length - 1) break;
      // Upstream :97-100 verbatim: a would-be match start may advance
      // *within* this code point only while the expansion is still
      // identical to the original text; the first divergence makes every
      // later start position imprecise.
      if (posPrecise && i < str.length && str.charCodeAt(i) === code) matchStart++;
      else posPrecise = false;
    }
  }
  return { matches, skippedNonPrecise };
}

/**
 * Every match of a precompiled regexp within `[range.from, range.to)`,
 * scanning `docText` (not a substring) so lookahead/lookbehind/`^`/`$`
 * (with the `m` flag CM6 itself always sets — see `buildRegExp`) see real
 * surrounding content, but resetting `lastIndex` to `range.from` (see
 * module header's "per-range independent" note rather than continuing a
 * whole-document scan across ranges).
 *
 * `re.lastIndex` is advanced past *every* raw regex match, whether or not
 * it ends up accepted (`to <= range.to`) — mirrors @codemirror/search's
 * `RegExpCursor.next`, which sets `matchPos` to the raw match's end before
 * ever checking whether the match should be kept, so a match straddling
 * the range's end boundary still consumes exactly the same span of the
 * scan as it would in a whole-document search, rather than this function
 * inventing its own retry offset for a rejected candidate.
 *
 * The scan tries a candidate starting *at* `range.to` too (`from >
 * range.to`, not `>=`, is what stops it), not just up to but excluding it:
 * @codemirror/search's own `RegExpCursor.next` keeps scanning while
 * `matchPos <= this.to`, so a zero-length match sitting exactly at the
 * range's exclusive end (e.g. pattern `x*` with no `x` in the text) is
 * still found and accepted (`to === range.to <= range.to`) — verified
 * against a real whole-document `replaceAll` in replacescope.test.ts,
 * where `range.to` is `docText.length` and CM6 unambiguously includes that
 * trailing zero-length match.
 *
 * A zero-length candidate is rejected outright when it sits at or before
 * the end of the *last accepted* match (`lastAcceptedTo`, seeded by the
 * caller — see `seedLastAcceptedTo` below and `matchesInRange`) — mirroring
 * `RegExpCursor.next`'s own guard verbatim (node_modules/@codemirror/search:
 * `(from < to || from > this.value.to)`, where `this.value` is the
 * cursor's last accepted match and starts as `{from: -1, to: -1}`, hence
 * this function's own default). Without this, a pattern like `a*` on doc
 * `"a"` would (and, before this fix, did) find the real match `"a"` at
 * `[0, 1)` *and* a separate, spurious zero-length match immediately after
 * it at `[1, 1)` — CM6's own cursor never produces that second match once
 * a non-empty match has already been accepted ending at the same position,
 * so replacing both inserted the replacement text twice in a row where
 * CM6 inserts it once (caught by replacescope.test.ts's exhaustive
 * small-input sweep, PR #318). A non-zero-length candidate is never
 * subject to this guard (`from < to` short-circuits it, matching CM6's
 * `||`), and `lastAcceptedTo` only ever advances on a match this function
 * actually keeps (pushes) — a candidate rejected for crossing `range.to`
 * never updates it, so it can't suppress a later, in-range candidate
 * purely because of an out-of-scope rejection.
 *
 * `seedLastAcceptedTo` lets the *same* guard span two touching ranges (see
 * `matchesInRange`/`replaceAllInSelection`): scanning each range with an
 * independent, always-`-1` `lastAcceptedTo` would let a range whose scan
 * starts exactly where the *previous* range's last accepted match ended
 * re-discover a "new" zero-length match at that shared point — the same
 * class of spurious repeat as the `"a*"` example above, just straddling a
 * range boundary instead of sitting inside one range. Passing the
 * preceding touching range's own final `lastAcceptedTo` forward makes two
 * touching ranges behave exactly like one continuous scan for this guard's
 * purposes, without actually merging their scans (each still resets
 * `lastIndex` independently — see the module header).
 *
 * `wholeWordTest`, when given (regexp mode's `wholeWord` — see
 * `matchesInRange`), must be checked *before* a candidate updates
 * `lastAcceptedTo`, not filtered out of the results afterwards: mirrors
 * `RegExpCursor.next`'s own combined accept condition verbatim,
 * `(from < to || from > this.value.to) && (!this.test || this.test(from,
 * to, match))` — `this.value` (this function's `lastAcceptedTo`) only ever
 * updates when *both* halves pass, so a candidate the word-boundary test
 * rejects can never poison the guard against a later, genuinely-accepted
 * zero-length match. Filtering `wholeWord` as a separate pass over
 * already-accepted raw matches (an earlier version of this function did
 * exactly that) gets this wrong: e.g. pattern `a|(?=b)` with `wholeWord` on doc
 * `"ab"` — the `"a"` branch matches `[0, 1)` first and, filtered
 * afterwards, would already have set `lastAcceptedTo = 1` by the time the
 * word-boundary test later rejects it (both of `"a"`'s neighbors, `a` and
 * `b`, are word characters, so it fails `isWordBoundaryOk`) — which then
 * wrongly suppresses the very next candidate, the `(?=b)` lookahead's
 * legitimate zero-length match at position 1, as a "spurious repeat" of a
 * match that was never actually kept. Weaving the test into the same
 * accept condition that updates `lastAcceptedTo` (as here) keeps this
 * function's internal state exactly in sync with which matches it actually
 * returns, the same invariant `wholeWord`-free scanning already relies on.
 */
function regexMatchesInRange(
  docText: string,
  range: ReplaceRange,
  re: RegExp,
  seedLastAcceptedTo = -1,
  wholeWordTest?: (from: number, to: number) => boolean,
): FoundMatch[] {
  const matches: FoundMatch[] = [];
  re.lastIndex = toCharEnd(docText, range.from);
  let lastAcceptedTo = seedLastAcceptedTo;
  for (;;) {
    const m = re.exec(docText);
    if (!m) break;
    const from = m.index;
    const to = from + m[0].length;
    if (from > range.to) break; // scanned past the range: nothing more here
    const isSpuriousZeroLengthRepeat = from === to && from <= lastAcceptedTo;
    const passesWholeWord = !wholeWordTest || wholeWordTest(from, to);
    if (to <= range.to && !isSpuriousZeroLengthRepeat && passesWholeWord) {
      matches.push({ from, to, matched: m[0], groups: Array.from(m) });
      lastAcceptedTo = to;
    }
    // always advance, accepted or not — toCharEnd (issue #320) is what
    // makes this actually move forward when `from` sits right before an
    // astral character: `from + 1` alone can land mid-surrogate, which the
    // `u`-flag RegExp below silently corrects back to `from`, an infinite
    // loop with no toCharEnd call to push it past the low surrogate.
    re.lastIndex = to > from ? to : toCharEnd(docText, from + 1);
  }
  return matches;
}

/** @codemirror/search's own regexp flags (`baseFlags` in
 *  node_modules/@codemirror/search: `"gm" + (unicode-supported ? "u" :
 *  "")`, unconditionally — every runtime this app ships on supports the
 *  `u` flag) plus `i` when the query is case-insensitive. `m` (multiline)
 *  makes `^`/`$` match at line boundaries, not just document start/end; `u`
 *  makes the regexp Unicode-aware (surrogate pairs as single units, `\p{}`
 *  classes valid). `null` for a syntactically invalid pattern — mirrors
 *  @codemirror/search's `SearchQuery.valid` (via `validRegExp`), which
 *  keeps CM6 from ever attempting the search at all in that case; this
 *  module's callers treat `null` the same way (zero matches), whether or
 *  not the binding layer already filtered on `SearchQuery.valid` upstream. */
function buildRegExp(query: ReplaceScopeQuery): RegExp | null {
  try {
    return new RegExp(query.search, "gmu" + (query.caseSensitive ? "" : "i"));
  } catch {
    return null;
  }
}

function matchesInRange(
  docText: string,
  range: ReplaceRange,
  query: ReplaceScopeQuery,
  compiledRegExp: RegExp | null,
  // Only meaningful in regexp mode — see regexMatchesInRange's doc comment
  // on `seedLastAcceptedTo`; plain-string mode has no zero-length matches to
  // guard against (see stringMatchesInRange's structural-properties list,
  // where that is proven rather than assumed), so this is simply ignored
  // there.
  seedLastAcceptedTo = -1,
): RangeScanResult {
  if (query.regexp) {
    // Regexp mode never normalizes at all (see the module header's "Regexp
    // search has neither issue" paragraph) — there is no precise/imprecise
    // distinction for `RegExpCursor` to disagree with this module on, so
    // `skippedNonPrecise` is unconditionally `0` here, not derived from
    // anything upstream reports.
    if (!compiledRegExp) return { matches: [], skippedNonPrecise: 0 };
    // wholeWord must be woven into the scan itself, not filtered out of its
    // results afterwards — see regexMatchesInRange's doc comment on
    // `wholeWordTest` for why a post-hoc filter here can wrongly suppress a
    // later, legitimate zero-length match (PR #318's third round of
    // review). `re.lastIndex` still advances past a raw match
    // unconditionally either way (see regexMatchesInRange's own doc
    // comment on that point) — only the accept/`lastAcceptedTo` decision
    // depends on this test, never the scan's continuation.
    const wholeWordTest = query.wholeWord
      ? (from: number, to: number) => isWordBoundaryOk(docText, from, to)
      : undefined;
    return {
      matches: regexMatchesInRange(docText, range, compiledRegExp, seedLastAcceptedTo, wholeWordTest),
      skippedNonPrecise: 0,
    };
  }
  // Plain-string mode searches with the *unquoted* text (see `unquote` and
  // the `ReplaceScopeQuery` doc comment): @codemirror/search's own
  // `stringCursor` builds its `SearchCursor` from `spec.unquoted`, not
  // `spec.search`, so a query like `\n` (two characters: backslash, "n")
  // must search for an actual newline, not the two literal characters —
  // matching the built-in search panel's find/highlight behavior, which
  // otherwise silently disagrees with what "Replace (All) in Selection"
  // replaces. `buildRegExp` above is unaffected: `new RegExp(query.search,
  // ...)` intentionally keeps the raw pattern (`regexpCursor` builds its
  // `RegExpCursor` from `spec.search`, not `spec.unquoted`).
  return stringMatchesInRange(
    docText,
    range,
    unquote(query.search),
    query.caseSensitive,
    !!query.wholeWord,
  );
}

/**
 * The replacement text for one match, following @codemirror/search's own
 * `getReplacement` expansion rules exactly (RegExpQuery/StringQuery in
 * node_modules/@codemirror/search) so a scoped replace and a whole-document
 * replace of the same match always produce the same inserted text:
 *
 * - Non-regexp search: the replace text, unquoted (see `unquote`), used
 *   verbatim — @codemirror/search's `StringQuery.getReplacement` does *no*
 *   `$`-substitution at all, so a literal "$1" in the Replace field for a
 *   plain-string search stays exactly "$1", never expands.
 * - Regexp search: unquoted, then `$&`/`$$`/`$<n>` are expanded — `$&` is
 *   the whole match, `$$` is a literal `$`, and `$<n>` (greedily the
 *   longest valid group number, same left-to-right-shrinking probe
 *   `RegExpQuery.getReplacement` uses) is capture group `n`. A group number
 *   at or above the match's own group count is left as literal text
 *   (`$9` in a pattern with only 2 groups stays "$9"). A group that exists
 *   but did not participate in the match (an unmatched alternative, e.g.
 *   `(a)|(b)` matching "b") stringifies as the literal text "undefined" —
 *   this looks like a wart, but it is @codemirror/search's own real
 *   behavior (verified against a live CM6 `SearchQuery.getReplacement` via
 *   `replaceAll`; see replacescope.test.ts), and matching it exactly is the
 *   whole point of this function.
 */
function expandReplacement(query: ReplaceScopeQuery, match: FoundMatch): string {
  const unquoted = unquote(query.replace);
  if (!query.regexp || !match.groups) return unquoted;
  const groups = match.groups;
  return unquoted.replace(/\$([$&]|\d+)/g, (whole: string, token: string) => {
    if (token === "&") return match.matched;
    if (token === "$") return "$";
    for (let len = token.length; len > 0; len--) {
      const n = Number(token.slice(0, len));
      if (n > 0 && n < groups.length) {
        return String(groups[n]) + token.slice(len);
      }
    }
    return whole;
  });
}

/**
 * Map one `docText` offset through `edits` (ascending, non-overlapping, in
 * *original*-`docText` coordinates — exactly the shape `edits` is built in
 * below) to its position after every edit has been applied.
 *
 * Every edit that is *not* a zero-length edit sitting exactly at `pos` maps
 * unambiguously: an edit whose own `to` is at or before `pos`, and whose
 * `from` is strictly before `pos` (automatically true once `to <= pos` for
 * any non-empty edit, since `from < to`), has already fully happened "to
 * the left" of `pos`, so its net length change (`insert.length - (to -
 * from)`) shifts `pos` forward past it.
 *
 * A zero-length edit sitting exactly *at* `pos` (`edit.from === edit.to ===
 * pos`) is the one genuinely ambiguous case, because it could belong to
 * either side of `pos` — this is where `zeroLengthAtPosPrecedes` decides:
 * `true` shifts `pos` past it (excluded, "already happened"); `false`
 * leaves `pos` where it is (included, "still ahead"). Callers must pass
 * `true` exactly when the edit is *not* owned by whichever
 * `ReplaceScopeResult.ranges` boundary `pos` represents, and `false` when it
 * *is* owned by it — see `mapRangeEndpoints`, the only caller, for how
 * ownership is determined. Passing the wrong value for an edit a *different*
 * range legitimately owns is exactly issue #300 "problem two" (a range
 * excluding its own boundary match) and PR #318's second-round finding (two
 * adjacent ranges each independently claiming the *same* shared-boundary
 * insertion, producing overlapping mapped ranges) rolled into one: the fix
 * for both is that this decision must be made per range, from actual
 * ownership, never from a blanket "always inside" or "always outside" rule.
 *
 * The first edit that does not precede `pos`, and every edit after it, are
 * irrelevant: ascending + non-overlapping guarantees every later edit is
 * even further from `pos`, so the loop can stop there.
 */
function mapPosition(pos: number, edits: readonly ReplaceEdit[], zeroLengthAtPosPrecedes: boolean): number {
  let delta = 0;
  for (const edit of edits) {
    const isZeroLengthAtPos = edit.from === pos && edit.to === pos;
    const precedesPos = isZeroLengthAtPos ? zeroLengthAtPosPrecedes : edit.from < pos && edit.to <= pos;
    if (!precedesPos) break;
    delta += edit.insert.length - (edit.to - edit.from);
  }
  return pos + delta;
}

/**
 * Map one range's `from`/`to` through `edits`, given which of a possible
 * zero-length match sitting exactly at each of its own two boundaries this
 * *specific* range owns (see `mapPosition`'s doc comment on why ownership,
 * not a blanket rule, is what must decide this). `ownsLeadingBoundary`/
 * `ownsTrailingBoundary` are only ever consulted when an edit actually sits
 * exactly at `range.from`/`range.to` respectively — irrelevant (and safe to
 * pass `false`) otherwise, including for every non-zero-length match.
 *
 * `from` excludes ("shifts past") a zero-length edit at its own position
 * when this range does *not* own it (`!ownsLeadingBoundary`) — it belongs to
 * whatever earlier range does own it — and keeps it included when this range
 * does. `to` is the mirror image: it includes ("shifts past") a zero-length
 * edit at its own position only when this range *does* own it
 * (`ownsTrailingBoundary`); otherwise that edit belongs to a later range and
 * must not be swallowed into this one.
 */
function mapRangeEndpoints(
  range: ReplaceRange,
  edits: readonly ReplaceEdit[],
  ownsLeadingBoundary: boolean,
  ownsTrailingBoundary: boolean,
): ReplaceRange {
  return {
    from: mapPosition(range.from, edits, !ownsLeadingBoundary),
    to: mapPosition(range.to, edits, ownsTrailingBoundary),
  };
}

/**
 * Replace every match of `query` found within `ranges`, across every range
 * (ROADMAP.md v0.7 Track C "Replace All in Selection"; CM6's own
 * `replaceAll`, scoped). Each range is searched and replaced independently
 * (see the module header); a match that starts inside one range but ends
 * outside it (crosses the range boundary) is never replaced, matching
 * across ranges included: two adjacent selection ranges never "merge" a
 * boundary-straddling match between them.
 *
 * An empty range (`from === to`, a plain cursor with nothing selected) is
 * always a no-op for that range: it contributes zero edits regardless of
 * `query`, and is excluded before any matching is even attempted — this is
 * the explicit "empty selection -> no-op" rule (the binding layer may beep
 * or simply do nothing when the *overall* result has zero edits; this
 * module makes no UI decision either way). With multiple ranges (CM6
 * multi-cursor selections), each is still replaced independently even when
 * some are empty and others are not — an empty range never blocks or
 * affects its siblings.
 *
 * An empty `query.search` (@codemirror/search's own `SearchQuery.valid` is
 * always false for one — see `buildRegExp`'s doc comment) or, in regexp
 * mode, a syntactically invalid pattern both produce zero edits, the same
 * "nothing to do" outcome CM6 itself has for either case.
 *
 * A *zero-length* regexp match sitting exactly on the shared boundary
 * between two touching ranges (e.g. `[0, 1]` and `[1, 2]`, pattern `x*`
 * matching at position 1) would otherwise be found twice: `regexMatchesInRange`
 * legitimately includes a match at a range's own `to` (see its doc
 * comment), and the next range's independent scan (see the module header)
 * starts right back at that same position and would find the identical
 * match again. This is prevented at the source, not by de-duping
 * afterwards: `regexMatchesInRange`'s own `seedLastAcceptedTo` guard (the
 * same one that stops a single range from re-finding a spurious
 * zero-length match immediately after a real one — see that function's
 * doc comment) is seeded, for a range whose `from` exactly equals the
 * immediately preceding non-empty range's `to`, with that preceding
 * range's own final accepted-match end. Two touching ranges scanned this
 * way behave exactly like one continuous scan for this guard's purposes,
 * so the later range's scan simply never produces the duplicate candidate
 * in the first place — nothing to filter out after the fact.
 *
 * Crucially, the earlier range does not always *find* a match at its own
 * `to` in the first place — a longer candidate starting before the
 * boundary can cross it and get rejected outright, consuming the scan
 * position without ever producing (or seeding) anything there (see
 * `regexMatchesInRange`'s doc comment on `re.lastIndex` advancing past a
 * rejected candidate too). For example, pattern `ab|(?=b)` on doc `"ab"`
 * with ranges `[0, 1]` and `[1, 2]`: the first range's only raw candidate
 * is `"ab"` itself (spanning `[0, 2)`), which crosses `range.to` and is
 * rejected — the first range emits *nothing*, so the seed it passes
 * forward is the default `-1` — while the second range's scan legitimately
 * finds the `(?=b)` lookahead's empty match at position 1, unaffected by a
 * seed that never claimed that position. An earlier version of this code
 * instead de-duped `edits` after the fact, keyed only on position, which
 * had to be corrected once to stop discarding this exact genuine match
 * (see git history) — seeding the scan itself instead of filtering its
 * output afterwards is what makes the two mechanisms (this one, and
 * `regexMatchesInRange`'s within-one-range guard) provably the same rule
 * applied consistently, rather than two separate rules that can disagree.
 *
 * That same source-of-truth — which range's own scan actually accepted a
 * match at its own `from`/`to` — also decides which range's *mapped
 * `ranges` entry* (`mapRangeEndpoints`, below) is allowed to grow around a
 * zero-length match sitting at that boundary (PR #318's second round of
 * review): a range whose own scan didn't accept a match at its own `from`
 * must not have its mapped `from` shift around one anyway, or two adjacent
 * ranges can each end up claiming the same shared insertion in their
 * mapped output, producing overlapping ranges (e.g. `[0, 3]` and `[2, 5]`
 * for the `x*` example above, instead of the correct touching-not-overlapping
 * `[0, 3]` and `[3, 5]`) — silently merged back into one selection by
 * `EditorSelection.create` on the binding side, losing the multi-range
 * scope the caller asked for.
 */
export function replaceAllInSelection(
  docText: string,
  ranges: readonly ReplaceRange[],
  query: ReplaceScopeQuery,
): ReplaceScopeResult {
  if (query.search === "") return { edits: [], ranges: [...ranges], skippedNonPrecise: 0 };
  const compiled = query.regexp ? buildRegExp(query) : null;
  const edits: ReplaceEdit[] = [];
  // Per-range ownership of a match sitting exactly at that range's own
  // `from`/`to` (see this function's doc comment and `mapRangeEndpoints`)
  // — computed directly from what each range's own scan actually accepted,
  // never inferred separately afterwards.
  const ownership: { ownsLeadingBoundary: boolean; ownsTrailingBoundary: boolean }[] = [];
  // The immediately preceding non-empty range's own `to`, and the
  // zero-length-guard seed to carry forward into the next range's scan
  // when it touches that `to` exactly — see this function's doc comment.
  let previousRangeTo: number | null = null;
  let previousRangeLastAcceptedTo = -1;
  // Summed across every non-empty range's own scan (ROADMAP.md v0.9 C2) —
  // see `ReplaceScopeResult.skippedNonPrecise`'s doc comment.
  let skippedNonPrecise = 0;
  for (const range of ranges) {
    if (range.from === range.to) {
      ownership.push({ ownsLeadingBoundary: false, ownsTrailingBoundary: false });
      continue;
    }
    const seed = range.from === previousRangeTo ? previousRangeLastAcceptedTo : -1;
    const { matches, skippedNonPrecise: rangeSkipped } = matchesInRange(
      docText,
      range,
      query,
      compiled,
      seed,
    );
    skippedNonPrecise += rangeSkipped;
    for (const match of matches) {
      edits.push({ from: match.from, to: match.to, insert: expandReplacement(query, match) });
    }
    const firstMatch = matches[0];
    const lastMatch = matches[matches.length - 1];
    ownership.push({
      ownsLeadingBoundary: firstMatch !== undefined && firstMatch.from === range.from,
      ownsTrailingBoundary:
        lastMatch !== undefined && lastMatch.from === lastMatch.to && lastMatch.to === range.to,
    });
    previousRangeTo = range.to;
    previousRangeLastAcceptedTo = lastMatch?.to ?? -1;
  }
  const mappedRanges = ranges.map((range, i) =>
    mapRangeEndpoints(range, edits, ownership[i].ownsLeadingBoundary, ownership[i].ownsTrailingBoundary),
  );
  return { edits, ranges: mappedRanges, skippedNonPrecise };
}

/**
 * Replace just the first match of `query` found within `ranges` — the
 * first range (in the given, ascending order — CM6 selection ranges are
 * always kept in ascending, non-overlapping order) that contains any match
 * at all, and within that range, the earliest one (ROADMAP.md v0.7 Track C
 * "Replace in Selection"). Every other range is left untouched apart from
 * the position shift the one replacement's length change gives it (see
 * `ReplaceScopeResult.ranges`'s doc comment) — a following invocation with
 * the returned `ranges` as the new selection finds the *next* match in
 * document order, so repeated "Replace in Selection" steps through a
 * selection's matches one at a time, the same way @codemirror/search's own
 * (whole-document) Replace button steps through the document.
 *
 * Same empty-range and empty/invalid-query no-op rules as
 * `replaceAllInSelection` above; when no range contains any match at all,
 * this returns zero edits and `ranges` unchanged.
 *
 * A pattern that matches zero-length at *every* position (e.g. `x*` with
 * no literal `x` anywhere in the document) is a known corner case where
 * "steps through matches one at a time" does not mean "advances to a new
 * offset each call": `mapRangeEndpoints`'s ownership-aware mapping
 * deliberately keeps a zero-length match's own position inside the range
 * that owns it (the one whose scan actually found it) rather than shifting
 * past it, so a range whose only available match sits at its own start
 * re-finds that same offset on the next call too, repeatedly inserting
 * there. This is not a divergence introduced by this module — driving
 * CM6's own live `replaceNext` command repeatedly against the same
 * document and query produces the identical "stuck at the same offset"
 * behavior (`RegExpQuery.nextMatch` builds a fresh `RegExpCursor` per call,
 * whose zero-length-match dedup state never carries over — verified in
 * replacescope.test.ts), so matching it is what this function's own "the
 * same way @codemirror/search's own... Replace button steps through the
 * document" contract (above) requires.
 *
 * Exactly one range ever owns the single edit this function produces (the
 * one range whose own `matchesInRange` call found `first`) — every other
 * range's mapped `from`/`to` must treat a zero-length edit that happens to
 * sit at its own boundary as *not* its own (see `mapRangeEndpoints`), the
 * same ownership discipline `replaceAllInSelection` uses for the shared
 * boundary between two ranges (PR #318's second round of review), so an
 * untouched neighboring range never grows to swallow a match that was
 * actually replaced in a different range.
 *
 * `skippedNonPrecise` (ROADMAP.md v0.9 C2) only ever reflects ranges this
 * function actually scanned: every range up to and including the one whose
 * first match was replaced, in order — never the ranges after it, which are
 * never reached once a match is found (mirroring @codemirror/search's own
 * `replaceNext`, which never looks past the match it takes either). A range
 * with zero replaceable matches still contributes its own count here, since
 * `matchesInRange` is called on it in full before moving to the next range.
 */
export function replaceInSelection(
  docText: string,
  ranges: readonly ReplaceRange[],
  query: ReplaceScopeQuery,
): ReplaceScopeResult {
  if (query.search === "") return { edits: [], ranges: [...ranges], skippedNonPrecise: 0 };
  const compiled = query.regexp ? buildRegExp(query) : null;
  let skippedNonPrecise = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.from === range.to) continue;
    const { matches, skippedNonPrecise: rangeSkipped } = matchesInRange(
      docText,
      range,
      query,
      compiled,
    );
    skippedNonPrecise += rangeSkipped;
    const [first] = matches;
    if (!first) continue;
    const edits: ReplaceEdit[] = [
      { from: first.from, to: first.to, insert: expandReplacement(query, first) },
    ];
    const isZeroLength = first.from === first.to;
    const mappedRanges = ranges.map((r, j) =>
      mapRangeEndpoints(
        r,
        edits,
        /* ownsLeadingBoundary */ j === i && isZeroLength && first.from === r.from,
        /* ownsTrailingBoundary */ j === i && isZeroLength && first.to === r.to,
      ),
    );
    return { edits, ranges: mappedRanges, skippedNonPrecise };
  }
  return { edits: [], ranges: [...ranges], skippedNonPrecise };
}

/**
 * The result message for a scoped Replace/Replace All (ROADMAP.md v0.9 C2,
 * issue #292's optional follow-up) — split out from the DOM-driving
 * `dispatchMenuCommand` in main.ts so it's vitest-covered without a WebView
 * (mirrors streamreplace.ts's `buildStreamReplaceResultMessage` /
 * lossysave.ts's `buildLossySaveDialogContent`).
 *
 * Deliberately called by main.ts only when `skippedNonPrecise > 0` — this
 * function itself has no opinion on that gating and will happily format a
 * "0 skipped" sentence, but the caller never asks it to: an ordinary,
 * fully-precise Replace/Replace All (the overwhelming common case) stays
 * exactly as silent as it was before this feature existed, matching every
 * other Line-Operations-style command in this app, none of which confirm an
 * ordinary success with a dialog. Only the presence of a genuine
 * divergence — an on-screen highlighted match (CM6's find-panel highlight
 * marks every match, precise or not) that this command did not touch — is
 * judged worth interrupting the user about. This is a deliberate departure
 * from a plain "always report both counts" design; see this PR's
 * description for the reasoning.
 */
export function buildReplaceScopeResultMessage(replaced: number, skippedNonPrecise: number): string {
  return t("dialog.replaceScopeResultMessage", replaced, skippedNonPrecise);
}
