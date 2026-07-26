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
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { replaceAll, replaceNext, search, setSearchQuery, SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import {
  replaceAllInSelection,
  replaceInSelection,
  type ReplaceEdit,
  type ReplaceRange,
  type ReplaceScopeQuery,
  type ReplaceScopeResult,
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

  it("boundary de-dup only suppresses a match the preceding range actually emitted, not any candidate at the same position (Codex PR #318 review)", () => {
    // Counterexample from PR #318's review: an earlier version of the
    // problem-one fix keyed the de-dup purely on position (`match.from ===
    // previousRangeTo`), assuming a shared boundary was always already
    // handled by the preceding range. That assumption is false here: doc
    // "ab", ranges [0,1] and [1,2], pattern "ab|(?=b)". The first range's
    // only raw candidate is the alternation's "ab" branch (spanning [0,2)),
    // which crosses range [0,1]'s own end and is rejected outright — the
    // first range's scan (see regexMatchesInRange's "always advance past a
    // rejected candidate too" note) jumps straight past position 1 without
    // ever emitting a match there. The second range [1,2] then legitimately
    // finds the "(?=b)" lookahead's empty match at position 1 — a genuinely
    // new match, not a duplicate of anything the first range produced.
    // Position-only de-dup incorrectly discarded it, turning the whole call
    // into a no-op; this pins that it must be kept.
    const docText = "ab";
    const query: ReplaceScopeQuery = { search: "ab|(?=b)", replace: "Y", regexp: true, caseSensitive: true };
    const ranges: ReplaceRange[] = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ];
    const result = replaceAllInSelection(docText, ranges, query);
    expect(result.edits).toEqual([{ from: 1, to: 1, insert: "Y" }]);
    expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe("aYb");
  });

  /** True when `ranges` are ascending and non-overlapping — the invariant
   *  `ReplaceScopeResult.ranges` must hold for `EditorSelection.create` to
   *  preserve every range as a distinct multi-cursor selection rather than
   *  merging touching-or-overlapping ones together (see
   *  `EditorSelection.normalized` in node_modules/@codemirror/state). */
  function rangesAreNonOverlapping(ranges: readonly ReplaceRange[]): boolean {
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].from < ranges[i - 1].to) return false;
    }
    return true;
  }

  it("Codex PR #318 round 2: mapped ranges for adjacent ranges sharing a claimed boundary must not overlap", () => {
    // Second-round finding: the round-1 fix correctly gives the shared
    // boundary match's *edit* to the earlier range ([0,1] owns the match at
    // position 1, not [1,2]), but the *range mapping* still used the same
    // generic "start"/"end" association for every range regardless of who
    // actually owns which boundary match — so both [0,1]'s mapped `to` and
    // [1,2]'s mapped `from` independently grew/shrank around the *same*
    // shared insertion, producing overlapping ranges ([0,3] and [2,5]).
    // Feeding those through `EditorSelection.create` (as `editor.ts`'s
    // `dispatchScopedReplace` does) silently merges them back into a single
    // selection, losing the multi-range scope the caller asked for.
    const docText = "ab";
    const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
    const ranges: ReplaceRange[] = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ];
    const result = replaceAllInSelection(docText, ranges, query);
    expect(rangesAreNonOverlapping(result.ranges)).toBe(true);
    const selection = EditorSelection.create(
      result.ranges.map((r) => EditorSelection.range(r.from, r.to)),
      0,
    );
    // Two distinct ranges must survive; a merge (the bug) collapses this to 1.
    expect(selection.ranges.length).toBe(result.ranges.length);
    expect(result.ranges.length).toBe(2);
  });

  it("Codex PR #318 round 2: same non-overlap requirement for the ab|(?=b) counterexample above (an owning range that finds nothing at all)", () => {
    // The "boundary de-dup only suppresses..." test above already checks
    // `result.edits`; this checks that its `result.ranges` also stay
    // non-overlapping. Range [0,1] finds *no* match at all (its only raw
    // candidate crosses the boundary and is rejected), so it must not
    // inherit any part of [1,2]'s legitimately-owned replacement either.
    const docText = "ab";
    const query: ReplaceScopeQuery = { search: "ab|(?=b)", replace: "Y", regexp: true, caseSensitive: true };
    const ranges: ReplaceRange[] = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ];
    const result = replaceAllInSelection(docText, ranges, query);
    expect(rangesAreNonOverlapping(result.ranges)).toBe(true);
    const selection = EditorSelection.create(
      result.ranges.map((r) => EditorSelection.range(r.from, r.to)),
      0,
    );
    expect(selection.ranges.length).toBe(2);
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

  it("replaceInSelection's start-boundary handling of a zero-length match matches CM6's own repeated replaceNext, quirk and all (Codex PR #318 review)", () => {
    // PR #318's review raised a second finding: replacing a zero-length
    // match sitting at a range's own start keeps that position (rather than
    // advancing past it), which — for a pattern that matches empty
    // everywhere with no "x" in the doc — means repeated
    // "Replace in Selection" calls insert at the same offset (0) forever
    // instead of stepping to offsets 1, 2, .... This is real, but it is not
    // a divergence from `@codemirror/search`: driving CM6's own live
    // `replaceNext` command repeatedly, on the exact same document and
    // query, produces the identical "stuck at offset 0, insert accumulates"
    // behavior (verified below against a real `EditorView`) — a consequence
    // of `RegExpQuery.nextMatch` building a *fresh* `RegExpCursor` on every
    // call (node_modules/@codemirror/search), whose zero-length-match
    // dedup state (`this.value` seeded to `{from:-1,to:-1}`) never carries
    // over between calls, so the same offset-0 empty match is "new" again
    // every time. `replaceInSelection`'s own doc comment already commits to
    // "the same way @codemirror/search's own (whole-document) Replace
    // button steps through the document" — matching this quirk (not
    // "fixing" it to advance, which the CM6-comparison test below shows
    // would be the actual divergence) is what that contract requires.
    const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
    const docText = "ab";

    // Ground truth: CM6's own repeated replaceNext on an unattached view.
    const cm6Log: string[] = [];
    const state = EditorState.create({ doc: docText, extensions: [search()] });
    const view = new EditorView({ state });
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: query.search, replace: query.replace, regexp: true })),
    });
    for (let i = 0; i < 4; i++) {
      replaceNext(view);
      cm6Log.push(`${view.state.doc.toString()}|${view.state.selection.main.from}-${view.state.selection.main.to}`);
    }
    view.destroy();

    // This module's replaceInSelection, stepped the same number of times,
    // each step's result fed back in as the next call's docText/ranges
    // (mirrors the "repeated calls step through matches" test above).
    const coreLog: string[] = [];
    let coreDocText = docText;
    let ranges: readonly ReplaceRange[] = [{ from: 0, to: 2 }];
    for (let i = 0; i < 4; i++) {
      const step = replaceInSelection(coreDocText, ranges, query);
      coreDocText = applyEditsViaCodeMirrorState(coreDocText, step.edits);
      ranges = step.ranges;
      const main = ranges[0];
      coreLog.push(`${coreDocText}|${main.from}-${main.from}`);
    }

    // Both are stuck accumulating "Y" at the very front, never advancing
    // past offset 0 — the CM6-faithful (if pathological) outcome for this
    // query, which has no "x" anywhere to give the scan real progress.
    expect(cm6Log).toEqual(["Yab|0-0", "YYab|0-0", "YYYab|0-0", "YYYYab|0-0"]);
    expect(coreDocText).toBe("YYYYab");
    expect(ranges[0].from).toBe(0);
  });
});

describe("PR #318 property sweep: zero-length-boundary family locked down exhaustively", () => {
  // This exact family of bugs (zero-length regexp matches at range
  // boundaries) has now been caught multiple times in review on the same
  // PR: duplicate edits at a shared boundary, a mapped range excluding its
  // own leading match, mapped ranges overlapping because ownership of a
  // boundary match wasn't threaded through to the range mapping, and (found
  // by an earlier, broader version of *this* sweep) a spurious extra
  // zero-length match immediately after a real one, both within one range
  // and straddling two touching ones. Per the "same class of hole caught
  // twice -> switch to exhaustive defense" lesson, this sweeps every way a
  // handful of short documents can be cut into contiguous, touching ranges
  // (exactly the family all of those findings came from), for several
  // patterns chosen to produce zero-length matches under different
  // conditions, and checks the invariants the whole ownership contract
  // exists to guarantee.
  // Includes astral (surrogate-pair) documents (issue #320): "😀" alone,
  // one buried in ASCII on each side, and two adjacent astral characters
  // back to back — so a code-point boundary can fall immediately before,
  // immediately after, or between two astral characters, exercising every
  // place `regexMatchesInRange`'s `toCharEnd`-based advance (see its doc
  // comment) has to get right, not just the single-character minimal repro.
  const docTexts = [
    "a",
    "ab",
    "aab",
    "aba",
    "abab",
    "baa",
    "\u{1F600}",
    "a\u{1F600}b",
    "\u{1F600}\u{1F600}",
    "\u{1F600}a",
  ];

  // Patterns that can *only* ever produce a zero-length match, for every
  // document here (no "x" in any doc's alphabet; "(?=a)" is a pure
  // zero-width lookahead assertion). These are the patterns invariant (c)
  // below applies to: cutting the document anywhere can never split a
  // *real*, multi-character match the whole-document scan would have kept,
  // so every contiguous partition is guaranteed to agree with CM6's own
  // whole-document `replaceAll` exactly.
  const alwaysZeroLengthPatterns = ["x*", "(?=a)"];
  // Patterns that mix zero-length matches with a real, multi-character
  // alternative ("a*" can match more than one "a"; "ab|(?=b)" and
  // "a*|(?=b)" both have a non-zero-length branch). Cutting the document
  // exactly where such a real match would otherwise span *legitimately*
  // makes a per-range scan diverge from the whole-document result — that
  // is this module's own pre-existing, documented, and separately-tested
  // "a match that crosses a range's boundary is never replaced" rule (see
  // the "does not replace a match that crosses a range's boundary..." test
  // above), not a bug invariant (c) should police. These patterns are only
  // checked against invariants (a) and (b), which hold unconditionally
  // regardless of how a document is cut.
  const mixedLengthPatterns = ["a*", "ab|(?=b)", "a*|(?=b)"];

  /** Every way to cut `text` into one or more contiguous, touching
   *  sub-ranges, restricted to *code-point-aligned* cut points (issue
   *  #320): a cut at a position whose own char code is a low surrogate
   *  would split an astral character's surrogate pair in half, which a
   *  real CM6 selection can never do either (CodeMirror positions are
   *  always at least UTF-16-code-point boundaries) — so, same as
   *  `allContiguousPartitions`'s previous ASCII-only version, every
   *  subset of the valid interior cut points is one partition (the empty
   *  subset is "the whole range as one piece"). For a document with no
   *  astral characters this is identical to treating every interior
   *  integer position as a valid cut (nothing to skip), so this is a pure
   *  generalization, not a behavior change for the pre-existing ASCII
   *  cases. */
  function allContiguousPartitions(text: string): ReplaceRange[][] {
    const length = text.length;
    const interior: number[] = [];
    for (let i = 1; i < length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xdc00 && code <= 0xdfff) continue; // low surrogate: mid-astral-character, never a valid cut
      interior.push(i);
    }
    const partitions: ReplaceRange[][] = [];
    for (let mask = 0; mask < 2 ** interior.length; mask++) {
      const cuts = interior.filter((_, i) => (mask & (1 << i)) !== 0);
      const bounds = [0, ...cuts, length];
      const ranges: ReplaceRange[] = [];
      for (let i = 0; i < bounds.length - 1; i++) ranges.push({ from: bounds[i], to: bounds[i + 1] });
      partitions.push(ranges);
    }
    return partitions;
  }

  /** (a) no two edits at the same `[from, to)` — a shared boundary match is
   *  never double-counted; (b) mapped ranges come back ascending and
   *  non-overlapping, so `EditorSelection.create` never silently merges two
   *  of them. Checked for every pattern, regardless of whether it can
   *  produce a non-zero-length match. */
  function expectNoDuplicateEditsAndNonOverlappingRanges(result: ReplaceScopeResult): void {
    const seen = new Set<string>();
    for (const edit of result.edits) {
      const key = `${edit.from}-${edit.to}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    for (let i = 0; i < result.ranges.length; i++) {
      expect(result.ranges[i].from).toBeLessThanOrEqual(result.ranges[i].to);
      if (i > 0) expect(result.ranges[i].from).toBeGreaterThanOrEqual(result.ranges[i - 1].to);
    }
    const selection = EditorSelection.create(
      result.ranges.map((r) => EditorSelection.range(r.from, r.to)),
      0,
    );
    expect(selection.ranges.length).toBe(result.ranges.length);
  }

  // wholeWord on/off, run alongside the CM6 whole-doc comparison group:
  // zero-length matches always pass wholeWord trivially (see
  // isWordBoundaryOk's own doc comment), so this dimension should never
  // change anything for `alwaysZeroLengthPatterns` — locking that in too.
  const wholeWordOptions = [false, true];

  it("always-zero-length patterns: no duplicate edits, non-overlapping ranges, and CM6 whole-doc agreement across every contiguous partition and wholeWord setting", () => {
    let casesChecked = 0;
    for (const docText of docTexts) {
      for (const search of alwaysZeroLengthPatterns) {
        for (const wholeWord of wholeWordOptions) {
          const query: ReplaceScopeQuery = { search, replace: "Y", regexp: true, caseSensitive: true, wholeWord };
          const expectedWholeDocText = cm6ReplaceAllWholeDoc(docText, query);
          for (const ranges of allContiguousPartitions(docText)) {
            casesChecked++;
            const result = replaceAllInSelection(docText, ranges, query);
            expectNoDuplicateEditsAndNonOverlappingRanges(result);
            // (c) these partitions always cover the whole document with no
            // gaps, and this pattern can never produce a real match a range
            // split could legitimately break up, so applying `edits` via a
            // real @codemirror/state transaction must reproduce CM6's own
            // whole-document replaceAll exactly, no matter how the document
            // was cut into ranges or whether wholeWord is on.
            expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(expectedWholeDocText);
          }
        }
      }
    }
    // Guards against the generators silently producing zero useful cases.
    expect(casesChecked).toBeGreaterThan(80);
  });

  it("mixed zero/non-zero-length patterns: no duplicate edits and non-overlapping ranges across every contiguous partition and wholeWord setting (CM6 whole-doc agreement not required — see this module's own boundary-crossing rule)", () => {
    let casesChecked = 0;
    for (const docText of docTexts) {
      for (const search of mixedLengthPatterns) {
        for (const wholeWord of wholeWordOptions) {
          const query: ReplaceScopeQuery = { search, replace: "Y", regexp: true, caseSensitive: true, wholeWord };
          for (const ranges of allContiguousPartitions(docText)) {
            casesChecked++;
            expectNoDuplicateEditsAndNonOverlappingRanges(replaceAllInSelection(docText, ranges, query));
          }
        }
      }
    }
    expect(casesChecked).toBeGreaterThan(120);
  });

  it("mixed zero/non-zero-length patterns with wholeWord on a single whole-document range: must still agree with CM6 exactly (PR #318 round 3 — wholeWord/lastAcceptedTo interaction)", () => {
    // Unlike the partition sweep above, a *single* range spanning the whole
    // document has no "range split crosses a real match" divergence source
    // at all (see this file's header on why `wholeDoc(docText)` is directly
    // comparable to CM6's own whole-document replaceAll) — so for this
    // narrower case, wholeWord + a pattern with a real, wholeWord-rejectable
    // branch must still match CM6 exactly. This is what actually exercises
    // PR #318's third-round finding: `regexMatchesInRange`'s zero-length
    // guard must not be poisoned by a candidate wholeWord is about to
    // reject.
    let casesChecked = 0;
    for (const docText of docTexts) {
      for (const search of mixedLengthPatterns) {
        for (const wholeWord of wholeWordOptions) {
          casesChecked++;
          const query: ReplaceScopeQuery = { search, replace: "Y", regexp: true, caseSensitive: true, wholeWord };
          const expectedWholeDocText = cm6ReplaceAllWholeDoc(docText, query);
          const result = replaceAllInSelection(docText, wholeDoc(docText), query);
          expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(expectedWholeDocText);
        }
      }
    }
    expect(casesChecked).toBeGreaterThan(20);
  });
});

describe("PR #318 round 3: wholeWord must not poison the zero-length-repeat guard for a match it rejects", () => {
  it("exact repro: pattern 'a|(?=b)' with wholeWord on doc \"ab\" still finds the lookahead's legitimate zero-length match", () => {
    // Codex's exact reproduction: doc "ab", pattern "a|(?=b)", wholeWord on,
    // whole document selected. The "a" branch matches [0, 1) first, but
    // wholeWord rejects it (both neighbors, "a" itself and "b", are word
    // characters). An earlier version of this module filtered wholeWord
    // *after* scanning, so the (already-rejected) "a" candidate had already
    // set the zero-length-repeat guard's `lastAcceptedTo = 1`, wrongly
    // suppressing the very next candidate — the "(?=b)" lookahead's
    // legitimate empty match at position 1 — and turning the whole call
    // into a no-op. CM6 itself weaves the wholeWord test into the same
    // accept condition that updates its own guard, so it never has this
    // problem; this pins that this module now matches.
    const docText = "ab";
    const query: ReplaceScopeQuery = {
      search: "a|(?=b)",
      replace: "Y",
      regexp: true,
      caseSensitive: true,
      wholeWord: true,
    };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(expected).toBe("aYb"); // only the lookahead at position 1 survives wholeWord; "a" is rejected

    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([{ from: 1, to: 1, insert: "Y" }]);
    expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(expected);
  });
});

describe("issue #320: zero-length regexp match must not infinite-loop on an astral character", () => {
  // Exact minimal repro from the issue: `regexMatchesInRange`'s zero-length
  // advance was `re.lastIndex = from + 1` — a fixed one-UTF-16-code-unit
  // step. For an astral character (surrogate pair, two UTF-16 units per
  // Unicode code point), `from + 1` can land exactly between the high and
  // low surrogate. V8's Unicode (`u` flag) RegExp — which this module
  // always uses (see `buildRegExp`) — refuses to start a match there and
  // silently corrects `lastIndex` back to the code point's own start
  // (verified against a real `RegExp.prototype.exec` call below), so
  // `re.exec` returns the *same* zero-length match again, forever: this
  // loop's `re.lastIndex = from + 1` line and V8's own correction fight
  // each other, and the position never moves. A bounded per-test timeout
  // (short — this must return well within it) is the regression guard: if
  // this class of bug ever comes back, the test fails on a timeout instead
  // of hanging the whole suite (or, in production, the UI thread — see the
  // issue's severity note).
  it(
    "V8 corrects a mid-surrogate lastIndex back to the code point start (sanity-checks the bug's premise directly against RegExp, no module code involved)",
    () => {
      const re = /x*/gmu;
      re.lastIndex = 1; // between 😀's high and low surrogate (a 2-code-unit pair at [0, 2))
      const m = re.exec("\u{1F600}");
      expect(m).not.toBeNull();
      // V8 refuses to match starting mid-surrogate and silently corrects
      // back to 0 — the exact mechanism the issue describes, independent of
      // anything this module does.
      expect(m?.index).toBe(0);
    },
    2000,
  );

  it(
    "replaceAllInSelection terminates (and matches CM6) for the issue's exact minimal repro: zero-length pattern over a single astral character",
    () => {
      const docText = "\u{1F600}"; // "😀", one code point, two UTF-16 units
      const query: ReplaceScopeQuery = { search: "x*", replace: "Y", regexp: true, caseSensitive: true };
      const expected = cm6ReplaceAllWholeDoc(docText, query);
      const result = replaceAllInSelection(docText, [{ from: 0, to: 2 }], query);
      expect(result.edits).toEqual([
        { from: 0, to: 0, insert: "Y" },
        { from: 2, to: 2, insert: "Y" },
      ]);
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(expected);
    },
    2000,
  );
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
