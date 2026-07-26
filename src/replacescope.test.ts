// Core coverage for src/replacescope.ts (ROADMAP.md v0.7 Track C
// "find/replace in selection" [danger]). Two kinds of test here:
//
// 1. Direct unit tests of the scoped-specific semantics (empty selection,
//    multiple ranges, crossing a range boundary, offset bookkeeping) — CM6
//    has no equivalent operation to compare these against, since scoping
//    replace to a selection is exactly the capability CM6 lacks.
// 2. "Consistency with @codemirror/search" tests, which drive the *real*
//    replaceAll/replaceNext commands (from the actual `@codemirror/search`
//    package this app ships) against an unattached `EditorView` — no
//    `parent` element, so no DOM layout pass is ever triggered, which is
//    why this works fine in plain jsdom (confirmed empirically before
//    writing this file: an unattached view's `dispatch` runs its state
//    update synchronously with no measure/layout step). Using a single
//    range spanning the whole document makes `replaceAllInSelection`
//    directly comparable to CM6's own whole-document `replaceAll`, since a
//    match can never cross a "boundary" that is the entire document.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { replaceAll, replaceNext, search, setSearchQuery, SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import {
  replaceAllInSelection,
  replaceInSelection,
  type ReplaceEdit,
  type ReplaceRange,
  type ReplaceScopeQuery,
} from "./replacescope";

/** Reconstruct the post-edit text from `edits` (ascending, non-overlapping,
 *  original-`docText` coordinates) — the same composition
 *  `view.dispatch({ changes: edits })` performs, done here in plain
 *  strings so tests can assert on the resulting text directly. */
function applyEdits(docText: string, edits: readonly ReplaceEdit[]): string {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += docText.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return result + docText.slice(cursor);
}

/** The same reconstruction as `applyEdits`, but via a real
 *  `@codemirror/state` transaction (`EditorState.update({ changes })`) —
 *  exactly what `editor.ts`'s `dispatchScopedReplace` hands `view.dispatch`
 *  in production. Used where the point of a test is specifically to pin
 *  down `@codemirror/state`'s own behavior on `edits` (issue #300: whether
 *  it accepts/collapses/duplicates touching zero-length changes), not just
 *  this file's own string-splicing reimplementation of the same idea. */
function applyEditsViaCodeMirrorState(docText: string, edits: readonly ReplaceEdit[]): string {
  const state = EditorState.create({ doc: docText });
  return state.update({ changes: edits.map((e) => ({ ...e })) }).state.doc.toString();
}

const wholeDoc = (text: string): ReplaceRange[] => [{ from: 0, to: text.length }];

/** Build a real CM6 EditorState with the search extension, set `query` as
 *  the live SearchQuery, run CM6's own `replaceAll` command against an
 *  unattached EditorView (see this file's header), and return the
 *  resulting document text — the ground truth this module's own
 *  whole-document-equivalent output must agree with. */
function cm6ReplaceAllWholeDoc(
  docText: string,
  query: ConstructorParameters<typeof SearchQuery>[0],
): string {
  const state = EditorState.create({ doc: docText, extensions: [search()] });
  const view = new EditorView({ state });
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery(query)) });
  replaceAll(view);
  const result = view.state.doc.toString();
  view.destroy();
  return result;
}

describe("replaceAllInSelection", () => {
  it("replaces only matches within the given sub-range, leaving the rest of the document untouched", () => {
    const docText = "cat cat cat";
    const query: ReplaceScopeQuery = { search: "cat", replace: "dog", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, [{ from: 4, to: 7 }], query);
    expect(result.edits).toEqual([{ from: 4, to: 7, insert: "dog" }]);
    expect(applyEdits(docText, result.edits)).toBe("cat dog cat");
    expect(result.ranges).toEqual([{ from: 4, to: 7 }]);
  });

  it("is a no-op for an empty selection (a plain cursor, nothing selected)", () => {
    const docText = "hello hello";
    const query: ReplaceScopeQuery = { search: "hello", replace: "hi", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, [{ from: 5, to: 5 }], query);
    expect(result.edits).toEqual([]);
    expect(result.ranges).toEqual([{ from: 5, to: 5 }]);
  });

  it("replaces each range independently; an empty range never blocks a sibling range", () => {
    const docText = "cat cat";
    const query: ReplaceScopeQuery = { search: "cat", replace: "dog", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(
      docText,
      [
        { from: 0, to: 0 }, // empty cursor before the first "cat" — must contribute nothing
        { from: 4, to: 7 }, // the second "cat"
      ],
      query,
    );
    expect(result.edits).toEqual([{ from: 4, to: 7, insert: "dog" }]);
    expect(applyEdits(docText, result.edits)).toBe("cat dog");
    // The empty range is untouched (still empty, still at its original
    // position — the edit happens entirely after it); the non-empty range
    // keeps its own bounds since "dog" is the same length as "cat".
    expect(result.ranges).toEqual([
      { from: 0, to: 0 },
      { from: 4, to: 7 },
    ]);
  });

  it("does not replace a match that crosses a range's boundary, but does replace one that exactly fits it", () => {
    const docText = "abcdef";
    const query: ReplaceScopeQuery = { search: "cd", replace: "X", regexp: false, caseSensitive: true };
    // "cd" is at [2, 4); a range ending at 3 cuts through the middle of it.
    const crossing = replaceAllInSelection(docText, [{ from: 0, to: 3 }], query);
    expect(crossing.edits).toEqual([]);
    // A range ending exactly at 4 fully contains the same match.
    const contained = replaceAllInSelection(docText, [{ from: 0, to: 4 }], query);
    expect(contained.edits).toEqual([{ from: 2, to: 4, insert: "X" }]);
  });

  it("offset bookkeeping: a replacement longer than the match grows every later match's position and the range", () => {
    const docText = "a-a-a";
    const query: ReplaceScopeQuery = { search: "a", replace: "XYZ", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([
      { from: 0, to: 1, insert: "XYZ" },
      { from: 2, to: 3, insert: "XYZ" },
      { from: 4, to: 5, insert: "XYZ" },
    ]);
    const finalText = applyEdits(docText, result.edits);
    expect(finalText).toBe("XYZ-XYZ-XYZ");
    // The range grows to bound the whole rewritten document (repeatable:
    // the binding layer can run this again on `result.ranges` and it still
    // correctly delimits "the selection").
    expect(result.ranges).toEqual([{ from: 0, to: finalText.length }]);
  });

  it("offset bookkeeping: a replacement shorter than the match shrinks every later match's position and the range", () => {
    const docText = "foo-foo-foo";
    const query: ReplaceScopeQuery = { search: "foo", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([
      { from: 0, to: 3, insert: "X" },
      { from: 4, to: 7, insert: "X" },
      { from: 8, to: 11, insert: "X" },
    ]);
    const finalText = applyEdits(docText, result.edits);
    expect(finalText).toBe("X-X-X");
    expect(result.ranges).toEqual([{ from: 0, to: finalText.length }]);
  });

  it("is a no-op for an empty search query, mirroring @codemirror/search's own SearchQuery.valid", () => {
    const query: ReplaceScopeQuery = { search: "", replace: "x", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection("abc", wholeDoc("abc"), query);
    expect(result.edits).toEqual([]);
  });

  it("is a no-op for a syntactically invalid regexp pattern, mirroring @codemirror/search's validRegExp gate", () => {
    const query: ReplaceScopeQuery = { search: "(unclosed", replace: "x", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection("abc", wholeDoc("abc"), query);
    expect(result.edits).toEqual([]);
  });

  it("scans surrogate pairs (astral characters) as whole units, never splitting one mid-match-attempt", () => {
    const docText = "\u{1F600}cat\u{1F600}cat"; // "😀cat😀cat"
    const query: ReplaceScopeQuery = { search: "cat", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([
      { from: 2, to: 5, insert: "X" },
      { from: 7, to: 10, insert: "X" },
    ]);
    expect(applyEdits(docText, result.edits)).toBe("\u{1F600}X\u{1F600}X");
  });

  it("wholeWord: an emoji neighbor (not a word character) still counts as a valid boundary", () => {
    const docText = "\u{1F600}cat";
    const query: ReplaceScopeQuery = {
      search: "cat",
      replace: "X",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("\u{1F600}X");
  });

  it("wholeWord rejects a match embedded in a longer word but still finds a later standalone occurrence", () => {
    const docText = "concat cat";
    const query: ReplaceScopeQuery = {
      search: "cat",
      replace: "X",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    // "concat"'s embedded "cat" (positions 3-6) is rejected; the standalone
    // "cat" at the end (7-10) is accepted.
    expect(result.edits).toEqual([{ from: 7, to: 10, insert: "X" }]);
    expect(applyEdits(docText, result.edits)).toBe("concat X");
  });
});

describe("replaceInSelection", () => {
  it("replaces only the first match, in the first range that contains one", () => {
    const docText = "xx yy";
    const query: ReplaceScopeQuery = { search: "yy", replace: "Z", regexp: false, caseSensitive: true };
    const result = replaceInSelection(
      docText,
      [
        { from: 0, to: 2 }, // "xx" — no match here, must be skipped
        { from: 3, to: 5 }, // "yy" — the match
      ],
      query,
    );
    expect(result.edits).toEqual([{ from: 3, to: 5, insert: "Z" }]);
    expect(applyEdits(docText, result.edits)).toBe("xx Z");
    // The first (unmatched) range is untouched; the second shrinks by 1
    // ("yy" -> "Z").
    expect(result.ranges).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 4 },
    ]);
  });

  it("is a no-op for an empty selection", () => {
    const query: ReplaceScopeQuery = { search: "a", replace: "b", regexp: false, caseSensitive: true };
    const result = replaceInSelection("aaa", [{ from: 1, to: 1 }], query);
    expect(result.edits).toEqual([]);
    expect(result.ranges).toEqual([{ from: 1, to: 1 }]);
  });

  it("leaves edits empty and ranges unchanged when no range contains any match", () => {
    const query: ReplaceScopeQuery = { search: "zzz", replace: "b", regexp: false, caseSensitive: true };
    const ranges = [{ from: 0, to: 3 }];
    const result = replaceInSelection("aaa", ranges, query);
    expect(result.edits).toEqual([]);
    expect(result.ranges).toEqual(ranges);
  });

  it("repeated calls step through a range's matches one at a time, feeding each call's ranges back in", () => {
    // Mirrors how the CM6 binding is meant to be used repeatedly: each
    // step's `result.ranges` becomes the live selection for the next call,
    // and (as here) each step's rewritten text becomes the next docText —
    // "replace in selection, repeatable" (see ReplaceScopeResult.ranges's
    // doc comment).
    const query: ReplaceScopeQuery = { search: "aa", replace: "B", regexp: false, caseSensitive: true };

    let docText = "aa aa aa";
    let ranges: readonly ReplaceRange[] = [{ from: 0, to: 8 }];

    let step = replaceInSelection(docText, ranges, query);
    expect(step.edits).toEqual([{ from: 0, to: 2, insert: "B" }]);
    docText = applyEdits(docText, step.edits);
    ranges = step.ranges;
    expect(docText).toBe("B aa aa");
    expect(ranges).toEqual([{ from: 0, to: 7 }]);

    step = replaceInSelection(docText, ranges, query);
    expect(step.edits).toEqual([{ from: 2, to: 4, insert: "B" }]);
    docText = applyEdits(docText, step.edits);
    ranges = step.ranges;
    expect(docText).toBe("B B aa");
    expect(ranges).toEqual([{ from: 0, to: 6 }]);

    step = replaceInSelection(docText, ranges, query);
    expect(step.edits).toEqual([{ from: 4, to: 6, insert: "B" }]);
    docText = applyEdits(docText, step.edits);
    ranges = step.ranges;
    expect(docText).toBe("B B B");
    expect(ranges).toEqual([{ from: 0, to: 5 }]);

    // Exhausted: no more "aa" left anywhere in the (now fully replaced)
    // selection.
    step = replaceInSelection(docText, ranges, query);
    expect(step.edits).toEqual([]);
    expect(step.ranges).toEqual(ranges);
  });
});

describe("wholeWord and regexp-scan branch coverage not exercised above", () => {
  it("regexp mode respects wholeWord too (not just plain-string mode)", () => {
    const query: ReplaceScopeQuery = {
      search: "c.t",
      replace: "X",
      regexp: true,
      caseSensitive: true,
      wholeWord: true,
    };
    const docText = "concat cat";
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    // "c.t" would also match "cat" embedded in "concat" (positions 3-6);
    // wholeWord rejects it, same as the plain-string case.
    expect(result.edits).toEqual([{ from: 7, to: 10, insert: "X" }]);
    expect(applyEdits(docText, result.edits)).toBe("concat X");
  });

  it("a zero-length regexp match always passes wholeWord (can't split a word by itself)", () => {
    const query: ReplaceScopeQuery = {
      search: "x*",
      replace: "-",
      regexp: true,
      caseSensitive: true,
      wholeWord: true,
    };
    // No "x" anywhere, so every match is zero-length; wholeWord must not
    // filter any of them out (a non-zero-length wholeWord check would
    // reject *every* position here, since letters surround every gap).
    const result = replaceAllInSelection("ab", wholeDoc("ab"), query);
    expect(result.edits.length).toBeGreaterThan(0);
  });

  it("wholeWord: a match whose own first character is not a word character is still a valid start boundary", () => {
    // "-y" starts with a non-word character, so `atStart` (the match's own
    // first character) is "other", not "word" — exercises the branch where
    // `beforeStart` IS a word char but the OR still passes via `atStart`.
    // The character right after the match ("!") is also non-word, so the
    // end boundary passes independently and doesn't confound this case.
    const query: ReplaceScopeQuery = {
      search: "-y",
      replace: "Z",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    const result = replaceAllInSelection("a-y!", wholeDoc("a-y!"), query);
    expect(result.edits).toEqual([{ from: 1, to: 3, insert: "Z" }]);
    expect(applyEdits("a-y!", result.edits)).toBe("aZ!");
  });

  it("codePointAt reads a surrogate pair immediately after a match as one unit (afterEnd boundary check)", () => {
    const query: ReplaceScopeQuery = {
      search: "cat",
      replace: "X",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    const docText = "cat\u{1F600}"; // "cat" immediately followed by an emoji
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    // The emoji is not a word character, so it's a valid end boundary.
    expect(applyEdits(docText, result.edits)).toBe("X\u{1F600}");
  });

  it("a regexp match starting beyond the range's end stops the scan (from > range.to)", () => {
    const docText = "ab-cd-ab";
    const query: ReplaceScopeQuery = { search: "ab", replace: "Z", regexp: true, caseSensitive: true };
    // Only the first "ab" (0-2) is within [0, 3); the second "ab" (6-8)
    // starts well past the range and must not be found or replaced.
    const result = replaceAllInSelection(docText, [{ from: 0, to: 3 }], query);
    expect(result.edits).toEqual([{ from: 0, to: 2, insert: "Z" }]);
  });

  it("$<n> falls back to a shorter, valid group prefix plus literal trailing digits", () => {
    // "$12" with only 2 groups: n=12 is out of range, shrinks to n=1
    // (valid), leaving "2" as literal trailing text — same greedy-then-
    // shrink probe @codemirror/search's own getReplacement uses.
    const query: ReplaceScopeQuery = { search: "(a)(b)", replace: "$12", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection("ab", wholeDoc("ab"), query);
    expect(applyEdits("ab", result.edits)).toBe("a2");
  });
});

describe("$-substitution and escape unquoting (regexp and plain-string replace text)", () => {
  it("regexp mode: $& is the whole match, $1/$2 are capture groups", () => {
    const query: ReplaceScopeQuery = {
      search: "(\\w+)=(\\d+)",
      replace: "[$&] $2=$1",
      regexp: true,
      caseSensitive: true,
    };
    const result = replaceAllInSelection("foo=1", wholeDoc("foo=1"), query);
    expect(applyEdits("foo=1", result.edits)).toBe("[foo=1] 1=foo");
  });

  it("regexp mode: a group number beyond the match's own group count stays literal", () => {
    const query: ReplaceScopeQuery = { search: "(a)", replace: "[$9]", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection("a", wholeDoc("a"), query);
    expect(applyEdits("a", result.edits)).toBe("[$9]");
  });

  it("regexp mode: a non-participating optional group renders as the literal text 'undefined' (matches CM6)", () => {
    const query: ReplaceScopeQuery = { search: "(a)|(b)", replace: "[$1]", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection("b", wholeDoc("b"), query);
    expect(applyEdits("b", result.edits)).toBe("[undefined]");
  });

  it("regexp mode: $$ is a literal dollar sign, $0 is not a group token and stays literal", () => {
    const query: ReplaceScopeQuery = { search: "x", replace: "$$1 $0", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection("x", wholeDoc("x"), query);
    expect(applyEdits("x", result.edits)).toBe("$1 $0");
  });

  it("plain-string mode never expands $ tokens, even when the search itself is a regexp-like string", () => {
    const query: ReplaceScopeQuery = { search: "x", replace: "$1 $& $$", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection("x", wholeDoc("x"), query);
    expect(applyEdits("x", result.edits)).toBe("$1 $& $$");
  });

  it("unquotes \\n \\r \\t \\\\ in the replace text in both regexp and plain-string mode", () => {
    const stringMode: ReplaceScopeQuery = {
      search: "x",
      replace: "a\\nb\\tc\\\\d",
      regexp: false,
      caseSensitive: true,
    };
    expect(applyEdits("x", replaceAllInSelection("x", wholeDoc("x"), stringMode).edits)).toBe(
      "a\nb\tc\\d",
    );
    const regexMode: ReplaceScopeQuery = { search: "x", replace: "a\\rb", regexp: true, caseSensitive: true };
    expect(applyEdits("x", replaceAllInSelection("x", wholeDoc("x"), regexMode).edits)).toBe("a\rb");
  });
});

describe("issue #299: plain-string search text is unquoted, regexp search text is not", () => {
  // Reproduces the issue exactly: doc "a\nb\n" (real newlines), query
  // `search: "\\n"` (two literal characters: backslash, "n"), plain-string
  // mode. CM6's own SearchQuery.unquoted turns that into an actual newline
  // before searching (see the SearchQuery constructor in
  // node_modules/@codemirror/search) — this must find both newlines and
  // actually replace them, not silently no-op.
  it("plain-string \\n matches and replaces a real newline", () => {
    const docText = "a\nb\n";
    const query: ReplaceScopeQuery = { search: "\\n", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([
      { from: 1, to: 2, insert: "X" },
      { from: 3, to: 4, insert: "X" },
    ]);
    expect(applyEdits(docText, result.edits)).toBe("aXbX");
  });

  it("plain-string \\r matches and replaces a real carriage return", () => {
    const docText = "a\rb";
    const query: ReplaceScopeQuery = { search: "\\r", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("aXb");
  });

  it("plain-string \\t matches and replaces a real tab", () => {
    const docText = "a\tb";
    const query: ReplaceScopeQuery = { search: "\\t", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("aXb");
  });

  it("plain-string \\\\ (escaped backslash) matches and replaces a real literal backslash", () => {
    const docText = "a\\b";
    const query: ReplaceScopeQuery = { search: "\\\\", replace: "X", regexp: false, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("aXb");
  });

  it("regexp mode keeps the raw pattern: \\n in a regexp searches for an actual newline via RegExp semantics, not this module's unquote", () => {
    // Sanity check that regexp mode is untouched by the plain-string fix:
    // "\n" is already a valid RegExp escape for a newline with no help from
    // `unquote`, so this must keep working exactly as before.
    const docText = "a\nb";
    const query: ReplaceScopeQuery = { search: "\\n", replace: "X", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("aXb");
  });

  it("regexp mode must NOT unquote the pattern itself: a real regexp escape like \\d stays a digit class, not literal 'd'", () => {
    const docText = "a1b";
    const query: ReplaceScopeQuery = { search: "\\d", replace: "X", regexp: true, caseSensitive: true };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe("aXb");
  });

  it("plain-string search unquoting matches CM6's own whole-document replaceAll on the same input", () => {
    const docText = "a\nb\n";
    const query: ReplaceScopeQuery = { search: "\\n", replace: "X", regexp: false, caseSensitive: true };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(applyEdits(docText, result.edits)).toBe(expected);
    expect(expected).toBe("aXbX");
  });
});

describe("issue #300: zero-length regexp match boundary ownership and range mapping", () => {
  it("problem one: adjacent ranges sharing a zero-length match boundary do not double-insert", () => {
    // Exact repro from the issue: doc "ab", ranges [0,1] and [1,2] (touching
    // at position 1), pattern "x*" (matches zero-length everywhere, since
    // there's no "x"). Before the fix, both ranges independently accepted
    // the match at the shared boundary (position 1), producing two
    // identical `{ from: 1, to: 1, insert: "Y" }` edits; applying that via
    // @codemirror/state gave "YaYYbY" (the "Y" at the boundary duplicated).
    const docText = "ab";
    const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
    const ranges: ReplaceRange[] = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ];
    const result = replaceAllInSelection(docText, ranges, query);
    // Exactly one edit at the shared boundary, not two.
    expect(result.edits).toEqual([
      { from: 0, to: 0, insert: "Y" },
      { from: 1, to: 1, insert: "Y" },
      { from: 2, to: 2, insert: "Y" },
    ]);
    expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe("YaYbY");
    expect(applyEdits(docText, result.edits)).toBe("YaYbY");
  });

  it("problem one, applied via @codemirror/state directly: the un-deduped edit list from before the fix really does duplicate the insert (regression pin)", () => {
    // Pins the exact "before" behavior this fix removes: two identical
    // zero-length edits at the same position, run through a real
    // @codemirror/state transaction, insert the text twice. This is what
    // proves the fix (which now never produces this edit list) is
    // necessary, independent of this module's own `applyEdits` helper.
    const buggyEdits: ReplaceEdit[] = [
      { from: 0, to: 0, insert: "Y" },
      { from: 1, to: 1, insert: "Y" },
      { from: 1, to: 1, insert: "Y" },
      { from: 2, to: 2, insert: "Y" },
    ];
    expect(applyEditsViaCodeMirrorState("ab", buggyEdits)).toBe("YaYYbY");
  });

  it("problem two: a single range spanning the whole match set maps its start/end to include every boundary match", () => {
    // Exact repro from the issue: doc "ab", one range [0, 2] (the whole
    // document as a single selection), same "x* -> Y" query. The core finds
    // three zero-length matches (positions 0, 1, 2). The range's mapped
    // `from`/`to` must bound *all three* insertions (the range "spans the
    // same content, replaced" per `ReplaceScopeResult.ranges`'s contract),
    // not exclude the one sitting exactly at the range's own start.
    const docText = "ab";
    const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
    const range: ReplaceRange = { from: 0, to: 2 };
    const result = replaceAllInSelection(docText, [range], query);
    expect(result.edits).toEqual([
      { from: 0, to: 0, insert: "Y" },
      { from: 1, to: 1, insert: "Y" },
      { from: 2, to: 2, insert: "Y" },
    ]);
    const finalText = applyEditsViaCodeMirrorState(docText, result.edits);
    expect(finalText).toBe("YaYbY");
    // Old (buggy) mapping produced { from: 1, to: 5 } — excluding the
    // leading "Y". The range must now cover the entire rewritten text.
    expect(result.ranges).toEqual([{ from: 0, to: finalText.length }]);
  });

  it("mapPosition's start/end distinction does not change any pre-existing non-zero-length-match behavior", () => {
    // Regression guard: for ordinary (non-zero-length) matches, "start" and
    // "end" mapping must still agree with the pre-fix single-rule behavior
    // (already covered by the "offset bookkeeping" tests above); this just
    // re-confirms it for a match sitting exactly at a range's own start.
    const docText = "catdog";
    const query: ReplaceScopeQuery = { search: "cat", replace: "XYZ", regexp: false, caseSensitive: true };
    // The match [0,3) starts exactly at the range's own start (0).
    const result = replaceAllInSelection(docText, [{ from: 0, to: 6 }], query);
    expect(result.edits).toEqual([{ from: 0, to: 3, insert: "XYZ" }]);
    const finalText = applyEditsViaCodeMirrorState(docText, result.edits);
    expect(finalText).toBe("XYZdog");
    expect(result.ranges).toEqual([{ from: 0, to: finalText.length }]);
  });
});

describe("consistency with @codemirror/search's own whole-document replace", () => {
  function coreResult(docText: string, query: ReplaceScopeQuery): string {
    return applyEdits(docText, replaceAllInSelection(docText, wholeDoc(docText), query).edits);
  }

  it("agrees with CM6 on a plain case-sensitive replace", () => {
    const query: ReplaceScopeQuery = { search: "cat", replace: "dog", regexp: false, caseSensitive: true };
    const docText = "cat concat cats cat";
    expect(coreResult(docText, query)).toBe(cm6ReplaceAllWholeDoc(docText, query));
  });

  it("agrees with CM6 on a case-insensitive replace", () => {
    const query: ReplaceScopeQuery = { search: "cat", replace: "dog", regexp: false, caseSensitive: false };
    const docText = "Cat CAT cat CaT";
    expect(coreResult(docText, query)).toBe(cm6ReplaceAllWholeDoc(docText, query));
  });

  it("agrees with CM6 on a whole-word replace mixing standalone and embedded occurrences", () => {
    const query: ReplaceScopeQuery = {
      search: "cat",
      replace: "X",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    const docText = "cat concat cats cat";
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(coreResult(docText, query)).toBe(expected);
    // Hand-derived independently (see this module's PR description): only
    // the two standalone "cat"s (start and end) qualify.
    expect(expected).toBe("X concat cats X");
  });

  it("agrees with CM6 on case-insensitive whole-word replace", () => {
    const query: ReplaceScopeQuery = {
      search: "cat",
      replace: "dog",
      regexp: false,
      caseSensitive: false,
      wholeWord: true,
    };
    const docText = "Cat cats CAT scatter";
    expect(coreResult(docText, query)).toBe(cm6ReplaceAllWholeDoc(docText, query));
  });

  it("agrees with CM6 on mixed growth/shrink deltas across matches in one pass", () => {
    // "aaaaa" (5 chars) -> "ZZZ" (3, shrinks); "b" (1 char) -> "ZZZ" (3,
    // grows) — both directions in the same replaceAll pass.
    const query: ReplaceScopeQuery = {
      search: "aaaaa|b",
      replace: "ZZZ",
      regexp: true,
      caseSensitive: true,
    };
    const docText = "aaaaa-b-aaaaa";
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(coreResult(docText, query)).toBe(expected);
    expect(expected).toBe("ZZZ-ZZZ-ZZZ");
  });

  it("agrees with CM6 that the regexp 'u' flag treats a surrogate pair as one character for '.'", () => {
    const query: ReplaceScopeQuery = { search: ".", replace: "X", regexp: true, caseSensitive: true };
    const docText = "\u{1F600}"; // one astral character, two UTF-16 units
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(coreResult(docText, query)).toBe(expected);
    expect(expected).toBe("X"); // not "XX" — a split surrogate pair would over-match
  });

  it("agrees with CM6 on a trailing zero-length regexp match at the very end of the document", () => {
    const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
    const docText = "abc";
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(coreResult(docText, query)).toBe(expected);
  });

  it("agrees with CM6's replaceNext on which match gets replaced first", () => {
    // replaceNext's first call (from a cursor with no active match) only
    // moves the selection to the first match; the second call performs the
    // actual replace. replaceInSelection has no such two-step dance (it
    // always replaces the first match it finds), so this compares its
    // single call against CM6's second call.
    const docText = "cat cat cat";
    const query = { search: "cat", replace: "dog" };
    const state = EditorState.create({ doc: docText, extensions: [search()] });
    const view = new EditorView({ state });
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(query)) });
    replaceNext(view); // moves selection onto the first match
    replaceNext(view); // now actually replaces it
    const expected = view.state.doc.toString();
    view.destroy();

    const scoped: ReplaceScopeQuery = { ...query, regexp: false, caseSensitive: true };
    const onlyFirst = applyEdits(
      docText,
      replaceInSelection(docText, wholeDoc(docText), scoped).edits,
    );
    expect(onlyFirst).toBe(expected);
    expect(expected).toBe("dog cat cat"); // hand-derived: only the first "cat" is replaced
  });
});
