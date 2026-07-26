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
// the only caller. 100% vitest-covered here (replacescope.test.ts), which
// also drives the *real* @codemirror/search commands against an unattached
// `EditorView` (a live EditorView works fine with no `parent`/DOM measure
// pass — see that file's header) to empirically pin this module's output
// against CM6's own whole-document replace for every case where the two
// should agree.
//
// Deliberate, documented divergences from @codemirror/search's own
// SearchCursor (string/non-regexp search only — RegExpCursor is matched
// faithfully, see below):
//
// 1. No NFKD normalization. @codemirror/search's SearchCursor always runs
//    both the query and the document through `.normalize("NFKD")` before
//    comparing (verified from source: `basicNormalize`), so e.g. a
//    precomposed "é" (U+00E9) in the query can match a decomposed "e" +
//    combining acute (U+0065 U+0301) in the document — and adversarial
//    review confirmed such matches come back `precise: true`, so CM6's
//    own full-document replaceAll DOES replace them (same for
//    compatibility ligatures: query "fi" replaces a "ﬁ" U+FB01 in the
//    doc). This module does exact UTF-16 substring comparison instead
//    (case-folded via `toLowerCase()` when case-insensitive), so on
//    documents whose text is normalized differently from the query it
//    replaces strictly FEWER matches than CM6's full-document replace.
//    The divergence is one-directional and safe — no text outside an
//    exact match is ever touched — but it is user-observable: the find
//    panel's highlight (which shares CM6's normalizing cursor) can mark
//    a match inside the selection that an in-selection replace then
//    silently skips. Tracked as a known limitation (see the GitHub
//    issue referenced in the PR that introduced this module) rather
//    than hidden; matching CM6's normalization here would mean porting
//    its position-mapping table for expanded normalized forms, which is
//    exactly the byte-vs-char bookkeeping complexity this pure module
//    exists to avoid.
// 2. Word-boundary categorization (`wholeWord`) is done per Unicode code
//    point, not per extended grapheme cluster the way CM6's `charBefore`/
//    `charAfter` (`findClusterBreak`) do. This only differs from CM6 when a
//    match boundary sits directly adjacent to a combining-mark cluster,
//    same order of rarity as point 1, and the same simplification level
//    the rest of this codebase already accepts elsewhere (e.g. editor.ts's
//    `characterBeforeCursor` also reads a single code point, not a
//    grapheme cluster).
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
 * Every non-overlapping plain-string match of `search` within `[range.from,
 * range.to)` — scan bounded to the range (see module header's "per-range
 * independent" note), case-folded via `toLowerCase()` when `!caseSensitive`
 * (comparing fixed-`search.length`-wide windows of the *original* text,
 * never a lower-cased copy of the whole range: lower-casing can change a
 * character's length — e.g. U+0130 "İ".toLowerCase() is two UTF-16 units —
 * which would silently misalign offsets for everything after it if the
 * whole haystack were lower-cased up front and indexed into).
 *
 * A candidate whose content matches but fails `wholeWord` does not consume
 * `search.length` characters of progress — the scan retries starting just
 * one code point later, so an accepted match can still start inside what
 * looked like (but wasn't) a rejected one. This mirrors
 * @codemirror/search's `SearchCursor`, which advances its scan position one
 * code point at a time regardless of whether a candidate at that position
 * panned out (see the module header point 1's `precise`/normalization
 * aside — that's the one place this module's scan genuinely can't match
 * SearchCursor's; this accept/reject-advance behavior is not affected by
 * it and is replicated exactly).
 */
function stringMatchesInRange(
  docText: string,
  range: ReplaceRange,
  search: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): FoundMatch[] {
  const matches: FoundMatch[] = [];
  const needleLen = search.length;
  // Defense in depth, not currently reachable via this module's exported
  // functions (both already return before this point when `query.search
  // === ""` — see `replaceAllInSelection`/`replaceInSelection`): without
  // it, an empty needle would make `pos` never advance in the loop below
  // (every zero-length window trivially equals "") and hang forever.
  if (needleLen === 0) return matches;
  const needleCmp = caseSensitive ? search : search.toLowerCase();
  let pos = range.from;
  while (pos + needleLen <= range.to) {
    const window = docText.slice(pos, pos + needleLen);
    const windowCmp = caseSensitive ? window : window.toLowerCase();
    const contentMatches = windowCmp === needleCmp;
    if (contentMatches && (!wholeWord || isWordBoundaryOk(docText, pos, pos + needleLen))) {
      matches.push({ from: pos, to: pos + needleLen, matched: window });
      pos += needleLen;
    } else {
      pos += codePointAt(docText, pos).length;
    }
  }
  return matches;
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
  re.lastIndex = range.from;
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
    re.lastIndex = to > from ? to : from + 1; // always advance, accepted or not
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
  // on `seedLastAcceptedTo`; plain-string mode has no zero-length matches
  // to guard against (see stringMatchesInRange's "defense in depth" note),
  // so this is simply ignored there.
  seedLastAcceptedTo = -1,
): FoundMatch[] {
  if (query.regexp) {
    if (!compiledRegExp) return [];
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
    return regexMatchesInRange(docText, range, compiledRegExp, seedLastAcceptedTo, wholeWordTest);
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
  if (query.search === "") return { edits: [], ranges: [...ranges] };
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
  for (const range of ranges) {
    if (range.from === range.to) {
      ownership.push({ ownsLeadingBoundary: false, ownsTrailingBoundary: false });
      continue;
    }
    const seed = range.from === previousRangeTo ? previousRangeLastAcceptedTo : -1;
    const matches = matchesInRange(docText, range, query, compiled, seed);
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
  return { edits, ranges: mappedRanges };
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
 */
export function replaceInSelection(
  docText: string,
  ranges: readonly ReplaceRange[],
  query: ReplaceScopeQuery,
): ReplaceScopeResult {
  if (query.search === "") return { edits: [], ranges: [...ranges] };
  const compiled = query.regexp ? buildRegExp(query) : null;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.from === range.to) continue;
    const [first] = matchesInRange(docText, range, query, compiled);
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
    return { edits, ranges: mappedRanges };
  }
  return { edits: [], ranges: [...ranges] };
}
