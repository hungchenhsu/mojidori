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
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  replaceAll,
  replaceNext,
  search,
  SearchCursor,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Runs `replaceAllInSelection(docText, ranges, query)` in a *separate* Node
 * child process — the formalized version of the manual esbuild-plus-
 * subprocess reproduction used to confirm issue #320 both hung before the
 * fix and terminated after it (PR #327's own review): an in-process
 * regression test here, even wrapped in Vitest's own per-test `timeout`
 * option, is not actually bounded — a genuine infinite loop in this
 * module's scanning loop is fully synchronous and never yields to the
 * event loop, so Vitest's timeout (which relies on the event loop to fire)
 * never gets a turn either (confirmed empirically while fixing this issue:
 * reverting the fix made the whole Vitest *worker* hang past 20 seconds,
 * not just one test). `execFileSync`'s own `timeout` option has Node itself
 * send `killSignal` to the child if it runs too long, which works the same
 * way on macOS and Windows CI alike (unlike shell `timeout`/`gtimeout`,
 * which aren't both available there), turning a real regression into an
 * explicit, fast test failure instead of a hung worker.
 *
 * Bundling `replacescope.ts` with esbuild also happens *inside* the child
 * process, not here, and deliberately so: esbuild's own internal
 * environment sanity check (`new TextEncoder().encode("") instanceof
 * Uint8Array`) fails outright under this file's jsdom environment (needed
 * here for the "consistency with CM6" tests' `EditorView`) — merely
 * importing the `esbuild` package throws at its own module-load time under
 * jsdom, before any of its functions are even called. Spawning one plain
 * `node` child that does both the bundling and the run keeps every bit of
 * esbuild usage confined to a process with no jsdom in it at all, and
 * means the deadline this function enforces covers the *entire*
 * hang-risking sequence (bundle once, then run), not just the run half.
 */
function runReplaceAllInSelectionInChildProcess(
  docText: string,
  ranges: readonly ReplaceRange[],
  query: ReplaceScopeQuery,
  timeoutMs: number,
): ReplaceScopeResult {
  const dir = mkdtempSync(join(tmpdir(), "replacescope-child-"));
  try {
    // `import.meta.url` isn't a plain `file://` URL under Vitest (Vite
    // serves test files through its own module graph), so it can't be
    // turned back into a real filesystem path here. `process.cwd()` is
    // reliable instead: `npm test`/`vitest run` (both locally and in CI —
    // see .github/workflows/ci.yml) are always invoked from the project
    // root, which is what makes "<root>/src/replacescope.ts" and
    // "<root>/node_modules/esbuild" below correct on every platform this
    // runs on.
    const projectRoot = process.cwd();
    const modulePath = join(projectRoot, "src", "replacescope.ts");
    const driverPath = join(dir, "driver.mjs");
    const bundlePath = join(dir, "bundle.cjs");
    const buildAndRunPath = join(dir, "build-and-run.cjs");
    writeFileSync(
      driverPath,
      [
        `import { replaceAllInSelection } from ${JSON.stringify(modulePath)};`,
        `const result = replaceAllInSelection(${JSON.stringify(docText)}, ${JSON.stringify(ranges)}, ${JSON.stringify(query)});`,
        `process.stdout.write(JSON.stringify(result));`,
      ].join("\n"),
    );
    writeFileSync(
      buildAndRunPath,
      [
        // Absolute path, not a bare "esbuild" specifier: this script's own
        // location (a temp directory) has no node_modules of its own to
        // resolve a bare specifier against.
        `const esbuild = require(${JSON.stringify(join(projectRoot, "node_modules", "esbuild"))});`,
        // replacescope.ts has zero imports of its own (see its module
        // header — "zero CodeMirror dependency"), so this bundle is just
        // that one file's TS stripped to plain JS; no external resolution
        // to worry about.
        `esbuild.buildSync({`,
        `  entryPoints: [${JSON.stringify(driverPath)}],`,
        `  bundle: true,`,
        `  platform: "node",`,
        `  format: "cjs",`,
        `  outfile: ${JSON.stringify(bundlePath)},`,
        `  logLevel: "silent",`,
        `});`,
        `require(${JSON.stringify(bundlePath)});`,
      ].join("\n"),
    );
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [buildAndRunPath], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { signal?: string | null; killed?: boolean };
      if (failure.killed || failure.signal) {
        throw new Error(
          `replaceAllInSelection did not return within ${timeoutMs}ms in a child process ` +
            `(killed by ${failure.signal ?? "timeout"}) — this looks like an infinite-loop ` +
            `regression of issue #320, not a normal test failure.`,
        );
      }
      throw error;
    }
    return JSON.parse(stdout) as ReplaceScopeResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // each other, and the position never moves. The first test below checks
  // that premise directly against `RegExp` (no hang risk at all — it's a
  // single `exec` call, not this module's scanning loop, so an ordinary
  // in-process `it` with a short timeout is fine). The second test is the
  // actual regression guard for the infinite loop itself, and — per PR
  // #327's own review — genuinely needs to run out-of-process: a real
  // regression here is a synchronous loop that never yields to the event
  // loop, so Vitest's own per-test `timeout` cannot enforce anything
  // against it (confirmed while fixing this issue: reverting the fix made
  // the whole Vitest *worker* hang past 20 seconds, not just one test).
  // See `runReplaceAllInSelectionInChildProcess`'s own doc comment above
  // for how that test actually gets a bound this bug class can't defeat.
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
      // Deliberately out-of-process (see runReplaceAllInSelectionInChildProcess's
      // doc comment): a real regression here is a synchronous infinite
      // loop, which an in-process call could not be bounded against.
      const result = runReplaceAllInSelectionInChildProcess(docText, [{ from: 0, to: 2 }], query, 5000);
      expect(result.edits).toEqual([
        { from: 0, to: 0, insert: "Y" },
        { from: 2, to: 2, insert: "Y" },
      ]);
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(expected);
    },
    // Generous outer Vitest timeout: covers esbuild bundling plus Node
    // process startup, on top of the 5000ms deadline `execFileSync` itself
    // enforces on the child — that inner deadline is the real regression
    // guard; this outer one is just slack for slower CI runners (Windows
    // in particular), not a substitute for it.
    15000,
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

describe("issue #292: NFKD normalized-equivalent matches must be replaced, exactly like CM6's own replaceAll", () => {
  // Every literal below is written with explicit \u escapes on purpose: the
  // whole point of these three cases is *which* UTF-16 encoding of the same
  // visible text sits in the document versus the query, which a source file
  // full of pre-rendered "\u00e9" glyphs cannot express unambiguously.
  const PRECOMPOSED_E_ACUTE = "\u00e9"; // é, one code point
  const DECOMPOSED_E_ACUTE = "e\u0301"; // e + COMBINING ACUTE ACCENT, two code points
  const LIGATURE_FI = "\ufb01"; // ﬁ, LATIN SMALL LIGATURE FI (NFKD -> "fi")

  function coreWholeDoc(docText: string, query: ReplaceScopeQuery): string {
    return applyEdits(docText, replaceAllInSelection(docText, wholeDoc(docText), query).edits);
  }

  it("issue example 1: decomposed e-acute in the document, precomposed in the query", () => {
    const docText = `caf${DECOMPOSED_E_ACUTE} latte`;
    const query: ReplaceScopeQuery = {
      search: `caf${PRECOMPOSED_E_ACUTE}`,
      replace: "TEA",
      regexp: false,
      caseSensitive: true,
    };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(expected).toBe("TEA latte"); // hand-derived: CM6's own replaceAll does replace it
    expect(coreWholeDoc(docText, query)).toBe(expected);
  });

  it("issue example 2: precomposed e-acute in the document, decomposed in the query", () => {
    const docText = `caf${PRECOMPOSED_E_ACUTE} latte`;
    const query: ReplaceScopeQuery = {
      search: `caf${DECOMPOSED_E_ACUTE}`,
      replace: "TEA",
      regexp: false,
      caseSensitive: true,
    };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(expected).toBe("TEA latte");
    expect(coreWholeDoc(docText, query)).toBe(expected);
  });

  it("issue example 3: compatibility ligature in the document, plain \"fi\" in the query", () => {
    const docText = `${LIGATURE_FI}sh and chips`;
    const query: ReplaceScopeQuery = { search: "fi", replace: "FI", regexp: false, caseSensitive: true };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(expected).toBe("FIsh and chips");
    expect(coreWholeDoc(docText, query)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// issue #292 differential harness: the *real* SearchCursor as ground truth
// ---------------------------------------------------------------------------
//
// Every character below is written as an explicit escape, never as a
// pre-rendered glyph. That is not stylistic: the entire subject matter is
// *which* UTF-16 encoding of the same visible text sits in the document
// versus the query, and a source file (or any tool that touches one) can
// silently renormalize a literal and turn a real assertion into a tautology.

/** U+00E9 LATIN SMALL LETTER E WITH ACUTE, one code point. */
const E_ACUTE_PRECOMPOSED = "\u00e9";
/** U+0301 COMBINING ACUTE ACCENT, canonical combining class 230. */
const COMBINING_ACUTE = "\u0301";
/** U+0316 COMBINING GRAVE ACCENT BELOW, ccc 220 - a *lower* class than the
 *  acute, so NFKD of a whole string canonically reorders it to come first. */
const COMBINING_GRAVE_BELOW = "\u0316";
/** "e" + U+0301, two code points rendering as the same glyph as
 *  `E_ACUTE_PRECOMPOSED`. */
const E_ACUTE_DECOMPOSED = "e" + COMBINING_ACUTE;
/** U+FB01 LATIN SMALL LIGATURE FI: one code point whose NFKD is the two
 *  ASCII letters "fi", so a query can match half of it (imprecisely). */
const LIGATURE_FI = "\ufb01";
/** U+1D400 MATHEMATICAL BOLD CAPITAL A: astral (two UTF-16 units), NFKD "A". */
const MATH_BOLD_A = "\u{1D400}";
/** U+212A KELVIN SIGN: a compatibility *singleton*, NFKD is the ASCII "K". */
const KELVIN_SIGN = "\u212a";
/** U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE: one code unit that grows
 *  under both operations - its NFKD is "I" + U+0307 COMBINING DOT ABOVE, and
 *  its lowercase is "i" + U+0307. (It is *not* a normalization-order
 *  discriminator, despite being an obvious candidate: both compositions land
 *  on the same "i" + U+0307. See `MODIFIER_CAPITAL_A` for one that is.) */
const DOTTED_CAPITAL_I = "\u0130";
/** "i" + U+0307 - exactly `DOTTED_CAPITAL_I.toLowerCase()`. */
const DOTTED_I_LOWERCASED = "i\u0307";
/** U+1D160 MUSICAL SYMBOL EIGHTH NOTE: astral, and its NFKD is *longer* than
 *  itself (U+1D158 U+1D165 U+1D16E) while sharing its own leading surrogate
 *  unit (0xD834). That combination is what lets a match start on a *low*
 *  surrogate while still being reported `precise` - see the surrogate-split
 *  test below. U+1D400 cannot reach that state: its NFKD only shrinks. */
const MUSICAL_EIGHTH_NOTE = "\u{1D160}";
/** U+1D2C MODIFIER LETTER CAPITAL A: has no lowercase mapping of its own,
 *  but its NFKD is the ASCII "A", which does - so the two possible
 *  compositions of NFKD and case folding give different answers for it.
 *  The discriminating case for normalization order. */
const MODIFIER_CAPITAL_A = "\u1d2c";
/** U+5B57, an ordinary NFKD-invariant CJK word character. */
const CJK_CHAR = "\u5b57";

/**
 * Every match the real `SearchCursor` (the class this module's plain-string
 * scan is a port of - see `replacescope.ts`'s `stringMatchesInRange`) finds
 * inside `[range.from, range.to)`, filtered to the `precise` ones: exactly
 * the set CM6's own `replaceAll` would replace if that range were the whole
 * document (`replaceAll` pushes a change only `if (precise)`).
 *
 * `SearchCursor`'s constructor takes an arbitrary `from`/`to`, which is what
 * makes this usable as ground truth for a *sub*-range too, not just for a
 * whole-document comparison: no re-derivation of "what a whole-document scan
 * would have found, intersected with the range" is needed (and none would be
 * trustworthy, since where a scan starts is part of its semantics).
 *
 * The `normalize` argument mirrors `stringCursor`'s own
 * (`spec.caseSensitive ? undefined : x => x.toLowerCase()`); `SearchCursor`
 * composes NFKD around it itself. Deliberately no `test` argument: the
 * sweeps using this run with `wholeWord: false`, and word-boundary agreement
 * is checked against the real `replaceAll` command instead (see the sweeps'
 * own comments).
 */
function cm6MatchesInRange(
  docText: string,
  range: ReplaceRange,
  search: string,
  caseSensitive: boolean,
): { from: number; to: number; precise: boolean }[] {
  const cursor = new SearchCursor(
    Text.of(docText.split("\n")),
    search,
    range.from,
    range.to,
    caseSensitive ? undefined : (x: string) => x.toLowerCase(),
  );
  const out: { from: number; to: number; precise: boolean }[] = [];
  while (!cursor.next().done) out.push({ ...cursor.value });
  return out;
}

/** `cm6MatchesInRange` filtered to the replaceable (`precise`) matches, with
 *  the flag dropped so it compares directly against `editBoundaries`. */
function cm6PreciseMatchesInRange(
  docText: string,
  range: ReplaceRange,
  search: string,
  caseSensitive: boolean,
): { from: number; to: number }[] {
  return cm6MatchesInRange(docText, range, search, caseSensitive)
    .filter((m) => m.precise)
    .map((m) => ({ from: m.from, to: m.to }));
}

/** `edits` reduced to just their match boundaries, for comparison against
 *  `cm6PreciseMatchesInRange` - in plain-string mode every edit is exactly
 *  one replaced match, so the two are directly comparable. */
function editBoundaries(edits: readonly ReplaceEdit[]): { from: number; to: number }[] {
  return edits.map((e) => ({ from: e.from, to: e.to }));
}

/** Deterministic PRNG (mulberry32) so a sweep failure is reproducible from
 *  its seed alone - a random sweep that cannot be replayed is not a
 *  regression test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("issue #292 differential property sweep: plain-string matching is @codemirror/search's own NFKD scan", () => {
  // Per the rule this module already lives by (PR #318: "same class of hole
  // caught twice -> switch to exhaustive/differential defense"), the NFKD
  // port is not merged on hand-written fixtures. These sweeps assert, over
  // randomly generated NFKD-heavy corpora, two properties against the *real*
  // upstream code:
  //
  //   (A) the module's replaced-match set for an arbitrary range is exactly
  //       the real `SearchCursor`'s `precise` match set for that same range;
  //   (B) applying the module's edits for a whole-document range reproduces
  //       the real `replaceAll` command's resulting document exactly.
  //
  // (A) pins the automaton (including which matches are skipped as
  // imprecise) at match-boundary granularity, for sub-ranges as well as the
  // whole document. (B) pins the end-to-end result through
  // `expandReplacement` and a real @codemirror/state transaction, which is
  // also what enforces "edits are ascending and non-overlapping": a real
  // transaction throws on either violation rather than silently coping.

  // Characters chosen so every NFKD behavior class this port has to get right
  // is reachable inside a short random string: precomposed vs decomposed
  // e-acute, a compatibility ligature whose expansion is two ASCII letters a
  // query can match half of, a compatibility singleton, an astral
  // compatibility decomposition, the dotted capital I whose lowercase is
  // longer than itself, bare combining marks of two different combining
  // classes (so canonical reordering is reachable), plus ordinary ASCII and
  // CJK. No backslashes anywhere, so `SearchQuery.unquoted` - what
  // `stringCursor` actually searches with - is identical to `search` and can
  // be handed straight to `cm6PreciseMatchesInRange`; unquoting itself is
  // covered by the issue #299 tests above.
  const NFKD_ALPHABET = [
    "a",
    "b",
    " ",
    E_ACUTE_PRECOMPOSED,
    E_ACUTE_DECOMPOSED,
    COMBINING_ACUTE,
    COMBINING_GRAVE_BELOW,
    LIGATURE_FI,
    "f",
    "i",
    MATH_BOLD_A,
    "A",
    CJK_CHAR,
    DOTTED_CAPITAL_I,
    KELVIN_SIGN,
    "K",
    MODIFIER_CAPITAL_A,
    MUSICAL_EIGHTH_NOTE,
    // A line break, so `cm6MatchesInRange`'s `Text.of(docText.split("\n"))`
    // actually produces a multi-chunk document. Upstream's SearchCursor
    // iterates the searched region one *line* at a time, and this module
    // scans the flat string instead; without a newline in the corpus that
    // equivalence argument (see `codePointSizeAt`'s doc comment) would never
    // be exercised at all.
    "\n",
  ];
  // The same corpus minus everything carrying a combining mark: with
  // `wholeWord` on, this module categorizes word boundaries per code point
  // while CM6 uses extended grapheme clusters (the one divergence still
  // documented in replacescope.ts's header), and a combining mark sitting on
  // a match boundary is exactly where the two are allowed to disagree. Every
  // other NFKD behavior class above survives into this subset.
  const NFKD_ALPHABET_NO_COMBINING = NFKD_ALPHABET.filter(
    (c) => c !== COMBINING_ACUTE && c !== COMBINING_GRAVE_BELOW && c !== E_ACUTE_DECOMPOSED,
  );

  function randomString(rand: () => number, alphabet: string[], maxChars: number): string {
    const count = 1 + Math.floor(rand() * maxChars);
    let out = "";
    for (let i = 0; i < count; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  }

  /** Positions a real CodeMirror selection boundary could occupy: any offset
   *  that is not the low half of a surrogate pair (the same rule the PR #318
   *  partition sweep uses). */
  function codePointAlignedPositions(text: string): number[] {
    const out: number[] = [];
    for (let i = 0; i <= text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      out.push(i);
    }
    return out;
  }

  /** A query drawn so that it actually stands a chance of hitting the
   *  document: a random code-point-aligned slice of `docText`, usually
   *  re-encoded into a *different* Unicode normal form. This is what makes
   *  normalized-but-not-byte-identical matches - the entire subject of issue
   *  #292 - common in the corpus rather than a rare coincidence of two
   *  independent random draws. Returns null when the document is too short
   *  to slice, so the caller can fall back to a free-form random query.
   *  (Both kinds are kept: free-form queries are what exercise the
   *  no-match and partial-overlap paths.) */
  function randomRelatedQuery(rand: () => number, docText: string): string | null {
    const positions = codePointAlignedPositions(docText);
    const startIndex = Math.floor(rand() * (positions.length - 1));
    const from = positions[startIndex];
    const candidateEnds = positions.slice(startIndex + 1, startIndex + 4);
    if (candidateEnds.length === 0) return null;
    const to = candidateEnds[Math.floor(rand() * candidateEnds.length)];
    const slice = docText.slice(from, to);
    const forms = ["NFC", "NFD", "NFKC", "NFKD"] as const;
    const pick = Math.floor(rand() * 5);
    return pick === 4 ? slice : slice.normalize(forms[pick]);
  }

  /** A query built to cover only part of one document code point's
   *  normalized expansion: take a code point from the document, expand it,
   *  and keep a proper substring of that expansion. Such queries are the
   *  main - though not the only - way to reach `precise: false` matches, the
   *  ones CM6 finds and highlights but never replaces, so this generator
   *  manufactures the most safety-critical state in this PR (replace vs
   *  skip) on purpose instead of waiting for two independent random draws to
   *  collide into it. It is not a characterization of `precise`: a proper
   *  substring of an expansion can still be matched precisely, when the
   *  expansion units it skips happen to correspond one-to-one with original
   *  units the match's `from` also excludes (see the low-surrogate test
   *  below, and `NormalizedMatch`'s doc comment in replacescope.ts for the
   *  authoritative definition). Returns null when the document has no code
   *  point that expands at all. */
  function randomImpreciseQuery(rand: () => number, docText: string): string | null {
    const starts = codePointAlignedPositions(docText).filter((p) => p < docText.length);
    if (starts.length === 0) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const from = starts[Math.floor(rand() * starts.length)];
      const size =
        from + 1 < docText.length &&
        docText.charCodeAt(from) >= 0xd800 &&
        docText.charCodeAt(from) <= 0xdbff &&
        docText.charCodeAt(from + 1) >= 0xdc00 &&
        docText.charCodeAt(from + 1) <= 0xdfff
          ? 2
          : 1;
      const original = docText.slice(from, from + size);
      const expansion =
        rand() < 0.5 ? original.normalize("NFKD") : original.normalize("NFKD").toLowerCase();
      if (expansion.length < 2) continue;
      // A proper, non-empty substring of the expansion: strictly shorter than
      // the whole thing, so it can never cover the code point completely.
      const cut = 1 + Math.floor(rand() * (expansion.length - 1));
      return rand() < 0.5 ? expansion.slice(0, cut) : expansion.slice(expansion.length - cut);
    }
    return null;
  }

  function randomQuery(rand: () => number, docText: string, alphabet: string[]): string {
    const roll = rand();
    const drawn =
      roll < 0.2
        ? randomImpreciseQuery(rand, docText)
        : roll < 0.75
          ? randomRelatedQuery(rand, docText)
          : null;
    return drawn !== null && drawn !== "" ? drawn : randomString(rand, alphabet, 3);
  }

  function randomRange(rand: () => number, text: string): ReplaceRange {
    const positions = codePointAlignedPositions(text);
    const a = positions[Math.floor(rand() * positions.length)];
    const b = positions[Math.floor(rand() * positions.length)];
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }

  /** A range whose endpoints may land *inside* an astral character's
   *  surrogate pair. A real CodeMirror selection never does this, so these
   *  are defense in depth rather than a user-reachable case - but a scan
   *  that read the code point at a range's edge without honoring the edge
   *  would produce an edit reaching past the selection, which is the one
   *  thing this module must never do. Upstream is bounded by
   *  `Text.iterRange`, which cuts at the raw offset, so it is still exact
   *  ground truth here. */
  function randomUnalignedRange(rand: () => number, text: string): ReplaceRange {
    const a = Math.floor(rand() * (text.length + 1));
    const b = Math.floor(rand() * (text.length + 1));
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }

  function expectAscendingNonOverlappingInsideRanges(
    result: ReplaceScopeResult,
    ranges: readonly ReplaceRange[],
  ): void {
    let previousTo = -1;
    for (const edit of result.edits) {
      expect(edit.from).toBeLessThan(edit.to); // a plain-string match is never zero-length
      expect(edit.from).toBeGreaterThanOrEqual(previousTo);
      previousTo = edit.to;
      // Every match lies fully inside one of the scanned ranges - the
      // invariant the whole "replace in *selection*" contract rests on.
      expect(ranges.some((r) => edit.from >= r.from && edit.to <= r.to)).toBe(true);
    }
  }

  it("(A) replaced-match set equals the real SearchCursor's precise match set, for whole-document and sub-ranges alike", () => {
    const rand = mulberry32(0x292a);
    let casesChecked = 0;
    const reached = {
      withPreciseMatch: 0,
      withMultipleMatches: 0,
      withImpreciseMatch: 0,
      withNormalizationOnlyMatch: 0,
      withAstralMatch: 0,
    };
    for (let iteration = 0; iteration < 3000; iteration++) {
      const docText = randomString(rand, NFKD_ALPHABET, 6);
      const searchText = randomQuery(rand, docText, NFKD_ALPHABET);
      const caseSensitive = rand() < 0.5;
      const query: ReplaceScopeQuery = {
        search: searchText,
        replace: "Z",
        regexp: false,
        caseSensitive,
        wholeWord: false,
      };
      const ranges: ReplaceRange[] = [
        { from: 0, to: docText.length },
        randomRange(rand, docText),
        randomRange(rand, docText),
        randomUnalignedRange(rand, docText),
      ];
      for (const range of ranges) {
        casesChecked++;
        const upstream = cm6MatchesInRange(docText, range, searchText, caseSensitive);
        const upstreamPrecise = upstream.filter((m) => m.precise);
        const result = replaceAllInSelection(docText, [range], query);
        expect(editBoundaries(result.edits)).toEqual(
          upstreamPrecise.map((m) => ({ from: m.from, to: m.to })),
        );
        expectAscendingNonOverlappingInsideRanges(result, [range]);

        // Tally which *interesting* states this corpus actually reached.
        if (upstreamPrecise.length > 0) reached.withPreciseMatch++;
        if (upstreamPrecise.length > 1) reached.withMultipleMatches++;
        if (upstream.some((m) => !m.precise)) reached.withImpreciseMatch++;
        // A match whose raw document text is not the query itself: found
        // only because of normalization. This is the state issue #292 is
        // about, and a corpus that never reaches it proves nothing.
        if (upstreamPrecise.some((m) => docText.slice(m.from, m.to) !== searchText)) {
          reached.withNormalizationOnlyMatch++;
        }
        if (upstreamPrecise.some((m) => /[\ud800-\udbff]/.test(docText.slice(m.from, m.to)))) {
          reached.withAstralMatch++;
        }
      }
    }
    expect(casesChecked).toBe(12000);
    // A sweep that only ever compares "no matches" against "no matches" is
    // decorative. These floors are what keep it honest: they fail if a future
    // change to the corpus, the alphabet, or the query generator stops
    // reaching the states the port actually has to get right. Values are well
    // below what the seeded generator currently produces, so they assert
    // "still reached", not "reached exactly this often".
    expect(reached.withPreciseMatch).toBeGreaterThan(2000);
    expect(reached.withMultipleMatches).toBeGreaterThan(200);
    expect(reached.withImpreciseMatch).toBeGreaterThan(250);
    expect(reached.withNormalizationOnlyMatch).toBeGreaterThan(500);
    expect(reached.withAstralMatch).toBeGreaterThan(150);
  });

  it("(A') a multi-range selection is exactly the concatenation of the real SearchCursor's precise matches per range", () => {
    // Pins this module's "each range is scanned independently" model (see
    // replacescope.ts's header) against upstream directly: an independently
    // bounded `SearchCursor` per range is precisely what that model claims to
    // be equivalent to, so the whole multi-range result must equal the
    // concatenation - no cross-range scan state, no duplicate at a shared
    // boundary, no match lost between two ranges.
    const rand = mulberry32(0x292b);
    let casesChecked = 0;
    for (let iteration = 0; iteration < 1500; iteration++) {
      const docText = randomString(rand, NFKD_ALPHABET, 8);
      const searchText = randomQuery(rand, docText, NFKD_ALPHABET);
      const caseSensitive = rand() < 0.5;
      const query: ReplaceScopeQuery = {
        search: searchText,
        replace: "Z",
        regexp: false,
        caseSensitive,
        wholeWord: false,
      };
      const positions = codePointAlignedPositions(docText);
      const cut = positions[Math.floor(rand() * positions.length)];
      const ranges: ReplaceRange[] = [
        { from: 0, to: cut },
        { from: cut, to: docText.length },
      ];
      casesChecked++;
      const result = replaceAllInSelection(docText, ranges, query);
      const expected = ranges.flatMap((r) =>
        cm6PreciseMatchesInRange(docText, r, searchText, caseSensitive),
      );
      expect(editBoundaries(result.edits)).toEqual(expected);
      expectAscendingNonOverlappingInsideRanges(result, ranges);
      // A real transaction is the authority on "ascending and
      // non-overlapping": it throws outright on either violation.
      expect(() => applyEditsViaCodeMirrorState(docText, result.edits)).not.toThrow();
    }
    expect(casesChecked).toBe(1500);
  });

  it("(A'') replaceInSelection replaces exactly the first precise match the real SearchCursor reports in the first range that has one", () => {
    // `replaceInSelection` has its own match-selection path (first range with
    // any match, earliest match in it) that the (A)/(A') sweeps never touch -
    // they only drive `replaceAllInSelection`. Without this, the single-match
    // command's interaction with `precise` gating rests on three hand-written
    // negative assertions.
    const rand = mulberry32(0x292e);
    let casesChecked = 0;
    let casesWithAnEdit = 0;
    for (let iteration = 0; iteration < 2000; iteration++) {
      const docText = randomString(rand, NFKD_ALPHABET, 8);
      const searchText = randomQuery(rand, docText, NFKD_ALPHABET);
      const caseSensitive = rand() < 0.5;
      const query: ReplaceScopeQuery = {
        search: searchText,
        replace: "Z",
        regexp: false,
        caseSensitive,
        wholeWord: false,
      };
      const positions = codePointAlignedPositions(docText);
      const cut = positions[Math.floor(rand() * positions.length)];
      const ranges: ReplaceRange[] = [
        { from: 0, to: cut },
        { from: cut, to: docText.length },
      ];
      casesChecked++;
      const result = replaceInSelection(docText, ranges, query);
      // Ground truth: the first range (in order) that has a precise match,
      // and that range's earliest precise match.
      let expected: { from: number; to: number } | null = null;
      for (const r of ranges) {
        if (r.from === r.to) continue;
        const [first] = cm6PreciseMatchesInRange(docText, r, searchText, caseSensitive);
        if (first) {
          expected = first;
          break;
        }
      }
      if (expected === null) {
        expect(result.edits).toEqual([]);
      } else {
        casesWithAnEdit++;
        expect(result.edits).toEqual([{ from: expected.from, to: expected.to, insert: "Z" }]);
      }
    }
    expect(casesChecked).toBe(2000);
    expect(casesWithAnEdit).toBeGreaterThan(400);
  });

  it("(B) whole-document edits reproduce the real replaceAll command's document exactly", () => {
    const rand = mulberry32(0x292c);
    let casesChecked = 0;
    for (let iteration = 0; iteration < 600; iteration++) {
      const docText = randomString(rand, NFKD_ALPHABET, 6);
      const searchText = randomQuery(rand, docText, NFKD_ALPHABET);
      const query: ReplaceScopeQuery = {
        search: searchText,
        replace: "<Z>",
        regexp: false,
        caseSensitive: rand() < 0.5,
        wholeWord: false,
      };
      casesChecked++;
      const result = replaceAllInSelection(docText, wholeDoc(docText), query);
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(
        cm6ReplaceAllWholeDoc(docText, query),
      );
    }
    expect(casesChecked).toBe(600);
  });

  it("(B') whole-document edits reproduce the real replaceAll command with wholeWord on too (combining-mark-free corpus - see the documented grapheme-cluster divergence)", () => {
    const rand = mulberry32(0x292d);
    let casesChecked = 0;
    for (let iteration = 0; iteration < 600; iteration++) {
      const docText = randomString(rand, NFKD_ALPHABET_NO_COMBINING, 6);
      const searchText = randomQuery(rand, docText, NFKD_ALPHABET_NO_COMBINING);
      const query: ReplaceScopeQuery = {
        search: searchText,
        replace: "<Z>",
        regexp: false,
        caseSensitive: rand() < 0.5,
        wholeWord: true,
      };
      casesChecked++;
      const result = replaceAllInSelection(docText, wholeDoc(docText), query);
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(
        cm6ReplaceAllWholeDoc(docText, query),
      );
    }
    expect(casesChecked).toBe(600);
  });
});

describe("issue #292: inherited upstream semantics that must NOT be 'fixed'", () => {
  function coreWholeDoc(docText: string, query: ReplaceScopeQuery): string {
    return applyEdits(docText, replaceAllInSelection(docText, wholeDoc(docText), query).edits);
  }

  it("an imprecise match (the query covers only part of a ligature's expansion) is skipped, exactly as CM6's own replaceAll skips it", () => {
    const docText = LIGATURE_FI + "sh"; // the ligature NFKD-expands to "fi"
    const query: ReplaceScopeQuery = { search: "f", replace: "X", regexp: false, caseSensitive: true };
    // Ground truth from the real cursor: the match exists, but is imprecise.
    const cursor = new SearchCursor(Text.of([docText]), "f", 0, docText.length);
    cursor.next();
    expect(cursor.done).toBe(false);
    expect(cursor.value).toEqual({ from: 0, to: 1, precise: false });
    // ...so neither CM6's own replaceAll nor this module touches it.
    expect(cm6ReplaceAllWholeDoc(docText, query)).toBe(docText);
    expect(coreWholeDoc(docText, query)).toBe(docText);
    expect(replaceAllInSelection(docText, wholeDoc(docText), query).edits).toEqual([]);
    // Same rule for the single-match command, mirroring replaceNext's own
    // "skip straight past an imprecise match" branch.
    expect(replaceInSelection(docText, wholeDoc(docText), query).edits).toEqual([]);
  });

  it("canonical reordering is deliberately NOT handled, because upstream does not handle it (do not 'fix' this)", () => {
    // The query is normalized as one whole string, which canonically reorders
    // its combining marks (the grave-below has a lower combining class than
    // the acute, so it sorts first); the document is normalized one code
    // point at a time, which cannot reorder anything. So a document holding
    // this exact sequence does not match a query of the exact same sequence -
    // in CM6 either. Porting upstream's per-code-point scan is what makes the
    // two agree; normalizing the whole document at once would match MORE than
    // CM6 does, which is a new divergence, not a fix.
    const misordered = "e" + COMBINING_ACUTE + COMBINING_GRAVE_BELOW;
    const query: ReplaceScopeQuery = {
      search: misordered,
      replace: "X",
      regexp: false,
      caseSensitive: true,
    };
    expect(
      cm6PreciseMatchesInRange(misordered, { from: 0, to: misordered.length }, misordered, true),
    ).toEqual([]);
    expect(cm6ReplaceAllWholeDoc(misordered, query)).toBe(misordered);
    expect(coreWholeDoc(misordered, query)).toBe(misordered);
    // The canonically-ordered sequence, by contrast, matches itself in both.
    const ordered = "e" + COMBINING_GRAVE_BELOW + COMBINING_ACUTE;
    const orderedQuery: ReplaceScopeQuery = { ...query, search: ordered };
    expect(cm6ReplaceAllWholeDoc(ordered, orderedQuery)).toBe("X");
    expect(coreWholeDoc(ordered, orderedQuery)).toBe("X");
  });

  it("NFKD is applied before case folding, never the reverse (U+1D2C is the discriminating case)", () => {
    // The two compositions are not interchangeable, and this is the cheapest
    // proof: U+1D2C has no lowercase mapping of its own, but the "A" its NFKD
    // produces does.
    expect(MODIFIER_CAPITAL_A.normalize("NFKD")).toBe("A");
    expect(MODIFIER_CAPITAL_A.toLowerCase()).toBe(MODIFIER_CAPITAL_A); // unchanged
    expect(MODIFIER_CAPITAL_A.normalize("NFKD").toLowerCase()).toBe("a"); // upstream's order
    expect(MODIFIER_CAPITAL_A.toLowerCase().normalize("NFKD")).toBe("A"); // the reverse
    // So a case-insensitive search for "a" matches it under upstream's order
    // and would silently stop matching under the reverse one. CM6's find
    // panel is on the correct order, so getting this backwards is exactly the
    // "highlighted but never replaced" divergence issue #292 is about.
    const docText = MODIFIER_CAPITAL_A + "x";
    const lower: ReplaceScopeQuery = {
      search: "a",
      replace: "Y",
      regexp: false,
      caseSensitive: false,
    };
    expect(cm6PreciseMatchesInRange(docText, { from: 0, to: docText.length }, "a", false)).toEqual([
      { from: 0, to: 1 },
    ]);
    expect(cm6ReplaceAllWholeDoc(docText, lower)).toBe("Yx");
    expect(coreWholeDoc(docText, lower)).toBe("Yx");
    // Case-*sensitive* "a" finds nothing (NFKD alone yields "A"), while
    // case-sensitive "A" does match - so the folding really is a separate,
    // second step rather than something baked into the NFKD pass.
    const lowerCaseSensitive: ReplaceScopeQuery = { ...lower, caseSensitive: true };
    expect(cm6ReplaceAllWholeDoc(docText, lowerCaseSensitive)).toBe(docText);
    expect(coreWholeDoc(docText, lowerCaseSensitive)).toBe(docText);
    const upperCaseSensitive: ReplaceScopeQuery = { ...lower, search: "A", caseSensitive: true };
    expect(cm6ReplaceAllWholeDoc(docText, upperCaseSensitive)).toBe("Yx");
    expect(coreWholeDoc(docText, upperCaseSensitive)).toBe("Yx");
  });

  it("case folding can change a code point's length, so nothing may index into a pre-folded copy (U+0130)", () => {
    // U+0130's NFKD is *not* a no-op (it decomposes to "I" + U+0307, checked
    // here rather than assumed), and its case folding makes it longer still.
    // A scan that lower-cased the document up front and indexed into the
    // result would misalign every offset after it; the automaton never does,
    // because it normalizes one original code point at a time and takes match
    // boundaries from the original text only.
    expect(DOTTED_CAPITAL_I.length).toBe(1);
    expect(DOTTED_CAPITAL_I.normalize("NFKD")).toBe("I\u0307");
    expect(DOTTED_CAPITAL_I.toLowerCase()).toBe(DOTTED_I_LOWERCASED);
    expect(DOTTED_I_LOWERCASED.length).toBe(2);
    const docText = DOTTED_CAPITAL_I + "x";
    // A case-insensitive query of "i" covers only the first half of the
    // expansion -> imprecise -> skipped by CM6 and by this module alike.
    const partial: ReplaceScopeQuery = {
      search: "i",
      replace: "Y",
      regexp: false,
      caseSensitive: false,
    };
    expect(cm6ReplaceAllWholeDoc(docText, partial)).toBe(docText);
    expect(coreWholeDoc(docText, partial)).toBe(docText);
    // The full expansion is precise, and the replaced span is the *original*
    // single code unit - offsets stay in original-document coordinates even
    // though the match was two units long after folding.
    const full: ReplaceScopeQuery = { ...partial, search: DOTTED_I_LOWERCASED };
    expect(cm6ReplaceAllWholeDoc(docText, full)).toBe("Yx");
    expect(coreWholeDoc(docText, full)).toBe("Yx");
    expect(replaceAllInSelection(docText, wholeDoc(docText), full).edits).toEqual([
      { from: 0, to: 1, insert: "Y" },
    ]);
  });
});

describe("issue #292: scoping, replacement text, and termination for the NFKD scan", () => {
  function coreWholeDoc(docText: string, query: ReplaceScopeQuery): string {
    return applyEdits(docText, replaceAllInSelection(docText, wholeDoc(docText), query).edits);
  }

  it("a normalized match only partly inside the selection is not replaced (the scan is bounded by the range, not by a sliced-out substring)", () => {
    const docText = "x" + LIGATURE_FI + "sh"; // the ligature at offset 1 matches the query "fi"
    const query: ReplaceScopeQuery = { search: "fi", replace: "FI", regexp: false, caseSensitive: true };
    // Selecting the ligature itself: replaced.
    expect(applyEdits(docText, replaceAllInSelection(docText, [{ from: 1, to: 2 }], query).edits)).toBe(
      "xFIsh",
    );
    // Selecting from *after* the ligature: the match's own start is outside
    // the selection, so nothing is replaced - and the real SearchCursor
    // bounded to the same range agrees.
    expect(cm6PreciseMatchesInRange(docText, { from: 2, to: docText.length }, "fi", true)).toEqual([]);
    expect(replaceAllInSelection(docText, [{ from: 2, to: docText.length }], query).edits).toEqual([]);
    // Selecting up to *before* the ligature: same.
    expect(cm6PreciseMatchesInRange(docText, { from: 0, to: 1 }, "fi", true)).toEqual([]);
    expect(replaceAllInSelection(docText, [{ from: 0, to: 1 }], query).edits).toEqual([]);
  });

  it("wholeWord adjacency for a normalized match is judged against the real surrounding document, not the selection's edges", () => {
    const docText = "a" + LIGATURE_FI + "sh"; // the ligature is embedded inside a word
    const query: ReplaceScopeQuery = {
      search: "fi",
      replace: "FI",
      regexp: false,
      caseSensitive: true,
      wholeWord: true,
    };
    // Even with the selection starting exactly at the ligature, the character
    // *before* it (outside the selection) is a word character, so wholeWord
    // rejects the match - the same answer CM6's own whole-document replaceAll
    // gives.
    expect(cm6ReplaceAllWholeDoc(docText, query)).toBe(docText);
    expect(replaceAllInSelection(docText, [{ from: 1, to: 2 }], query).edits).toEqual([]);
    // Standalone, the same ligature is a whole word and is replaced.
    const standalone = "a " + LIGATURE_FI + " sh";
    expect(coreWholeDoc(standalone, query)).toBe(cm6ReplaceAllWholeDoc(standalone, query));
    expect(coreWholeDoc(standalone, query)).toBe("a FI sh");
  });

  it("plain-string replace text is never $-expanded, and a match's own text is the original document slice (not the query)", () => {
    // Two separate points, both about `expandReplacement`'s string-mode path.
    // First: "$&"/"$1" stay literal for a plain-string search, exactly as
    // `StringQuery.getReplacement` does no substitution at all - and that
    // must not change just because the match was found via normalization.
    const docText = "caf" + E_ACUTE_DECOMPOSED; // 5 UTF-16 units
    const query: ReplaceScopeQuery = {
      search: "caf" + E_ACUTE_PRECOMPOSED, // 4 UTF-16 units
      replace: "[$&|$1]",
      regexp: false,
      caseSensitive: true,
    };
    const expected = cm6ReplaceAllWholeDoc(docText, query);
    expect(expected).toBe("[$&|$1]");
    expect(coreWholeDoc(docText, query)).toBe(expected);
    // Second: the edit removes the *document's* five code units (the
    // decomposed form), not the query's four - so what a `$&`-style expansion
    // would ever quote is the original text, never the query or its
    // normalized form.
    const { edits } = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(edits).toEqual([{ from: 0, to: 5, insert: "[$&|$1]" }]);
    expect(docText.slice(edits[0].from, edits[0].to)).toBe(docText);
    expect(docText.slice(edits[0].from, edits[0].to)).not.toBe(query.search);
  });

  it("no Unicode code point normalizes into a strict extension of itself, so a plain-string match can never be zero-length", () => {
    // This is the assumption `replaceAllInSelection`'s zero-length-boundary
    // `ownership` bookkeeping rests on: with plain-string matches guaranteed
    // non-empty, `mapPosition`'s `zeroLengthAtPosPrecedes` decision stays a
    // regexp-only concern and needs no normalization awareness.
    //
    // A zero-length match would require a code point's would-be match start
    // to advance all the way to that code point's own end, which happens only
    // while the normalized form still matches the original unit for unit - so
    // it needs a normalization that is a strict *extension* of the original
    // (same leading units, more of them). Checked exhaustively rather than
    // argued, over every code point and both normalizers this module builds,
    // so a future Unicode revision that introduced such a character would
    // fail here instead of silently producing empty edits. Costs ~100ms.
    const offenders: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates handled below
      const original = String.fromCodePoint(code);
      const decomposed = original.normalize("NFKD");
      const folded = decomposed.toLowerCase();
      for (const normalized of [decomposed, folded]) {
        if (
          normalized.length > original.length &&
          normalized.slice(0, original.length) === original
        ) {
          offenders.push("U+" + code.toString(16).toUpperCase());
        }
      }
    }
    expect(offenders).toEqual([]);
    // Lone (unpaired) surrogates are read as single units by the scan, so
    // they need the same guarantee.
    const surrogateOffenders: string[] = [];
    for (let code = 0xd800; code <= 0xdfff; code++) {
      const original = String.fromCharCode(code);
      const decomposed = original.normalize("NFKD");
      for (const normalized of [decomposed, decomposed.toLowerCase()]) {
        if (normalized.length > 1 && normalized[0] === original) {
          surrogateOffenders.push("U+" + code.toString(16).toUpperCase());
        }
      }
    }
    expect(surrogateOffenders).toEqual([]);
  });

  it("an empty search is still a no-op (defense in depth for a query whose normalized form has no length)", () => {
    const docText = LIGATURE_FI + "sh";
    const query: ReplaceScopeQuery = { search: "", replace: "X", regexp: false, caseSensitive: true };
    expect(replaceAllInSelection(docText, wholeDoc(docText), query).edits).toEqual([]);
    expect(replaceInSelection(docText, wholeDoc(docText), query).edits).toEqual([]);
  });

  it("terminates on a lone (unpaired) high surrogate and on an astral character at a range edge", () => {
    // `codePointSizeAt` must always report at least one UTF-16 unit, or the
    // scan loop stalls - the same family of no-progress hang as issues #320
    // and #327, reachable here through a different door (a code point whose
    // second half is missing, or is outside the scanned range).
    const docText = "a\ud800b" + MATH_BOLD_A + "c";
    const query: ReplaceScopeQuery = { search: "b", replace: "Y", regexp: false, caseSensitive: true };
    expect(coreWholeDoc(docText, query)).toBe(cm6ReplaceAllWholeDoc(docText, query));
    // A range whose end falls between an astral character's two halves can
    // never come from a real CodeMirror selection, but the scan must still
    // terminate if one is ever constructed: the high surrogate is then
    // treated as a single unit, exactly as upstream's own end-of-buffer guard
    // does.
    const astralSplit = { from: 0, to: 4 }; // cuts MATH_BOLD_A (at [3, 5)) in half
    expect(replaceAllInSelection(docText, [astralSplit], query).edits).toEqual([
      { from: 2, to: 3, insert: "Y" },
    ]);
  });

  it("a range ending mid-surrogate never yields an edit reaching past it (the scan's code-point read is bounded by the range, not by the document)", () => {
    // MATH_BOLD_A occupies [0, 2) and NFKD-expands to "A". Reading it as a
    // whole code point while scanning a range that ends at offset 1 would
    // produce a match spanning [0, 2) - an edit reaching one unit *outside*
    // the selection. The real SearchCursor, bounded by `Text.iterRange`, sees
    // only the lone high surrogate there and finds nothing; so must this.
    const docText = MATH_BOLD_A + "x";
    const query: ReplaceScopeQuery = { search: "A", replace: "Y", regexp: false, caseSensitive: true };
    const cutInHalf = { from: 0, to: 1 };
    expect(cm6PreciseMatchesInRange(docText, cutInHalf, "A", true)).toEqual([]);
    expect(replaceAllInSelection(docText, [cutInHalf], query).edits).toEqual([]);
    expect(replaceInSelection(docText, [cutInHalf], query).edits).toEqual([]);
    // With the whole character selected, it is replaced as usual.
    const whole = { from: 0, to: 2 };
    expect(cm6PreciseMatchesInRange(docText, whole, "A", true)).toEqual([{ from: 0, to: 2 }]);
    expect(replaceAllInSelection(docText, [whole], query).edits).toEqual([
      { from: 0, to: 2, insert: "Y" },
    ]);
  });

  it("a precise match can begin on a low surrogate, and this module splits the pair exactly where CM6 does (inherited, not diverged)", () => {
    // `precise` means the original-text range `[from, to)` covers exactly
    // the content the match consumed, pulling in no unmatched original text
    // on either side (see `NormalizedMatch` in replacescope.ts for the
    // authoritative definition). It does NOT mean "code-point aligned", and
    // it does NOT mean "did not start part-way through an expansion" - this
    // case is the counterexample to that second, tempting reading, and to
    // upstream's own docstring. U+1D160's NFKD is longer than itself AND
    // shares its own leading surrogate unit, so a query beginning with a
    // lone low surrogate starts a match at normalized offset 1 of 6 -
    // part-way through the expansion - and is still reported `precise: true`:
    // the single expansion unit it skipped (0xD834) is identical to the
    // original unit at offset 0, which `from = 1` excludes and nothing else,
    // so the range still covers exactly what was matched. Replacing it
    // leaves an unpaired surrogate.
    //
    // This is pinned rather than fixed: CM6's own whole-document Replace All
    // produces the identical edit (asserted below against the real cursor and
    // the real command), and this PR's contract is exact parity with it. It
    // requires the user to get a lone low surrogate into the Find field.
    const docText = MUSICAL_EIGHTH_NOTE + "x";
    const expansion = MUSICAL_EIGHTH_NOTE.normalize("NFKD");
    expect(expansion.length).toBe(6); // longer than the 2-unit original
    expect(expansion.charCodeAt(0)).toBe(MUSICAL_EIGHTH_NOTE.charCodeAt(0)); // shared lead unit
    const searchText = expansion.slice(1); // starts with a lone low surrogate
    // Upstream reports it, precise, starting at offset 1 - mid-surrogate.
    expect(cm6MatchesInRange(docText, { from: 0, to: docText.length }, searchText, true)).toEqual([
      { from: 1, to: 2, precise: true },
    ]);
    const query: ReplaceScopeQuery = {
      search: searchText,
      replace: "Z",
      regexp: false,
      caseSensitive: true,
    };
    const result = replaceAllInSelection(docText, wholeDoc(docText), query);
    expect(result.edits).toEqual([{ from: 1, to: 2, insert: "Z" }]);
    // Byte-for-byte agreement with the real replaceAll command, including the
    // unpaired high surrogate both of them leave behind.
    const ours = applyEditsViaCodeMirrorState(docText, result.edits);
    expect(ours).toBe(cm6ReplaceAllWholeDoc(docText, query));
    expect(ours.charCodeAt(0)).toBe(0xd834);
    expect(ours.charCodeAt(1)).toBe("Z".charCodeAt(0)); // the pair really is split
  });

  it(
    "a range reaching past the end of the document terminates instead of hanging",
    () => {
      // `range.to > docText.length` used to make the scan's slice come back
      // empty, so the position never advanced and the loop spun forever -
      // the #320/#327 no-progress family again, reachable through a bad
      // range rather than a bad character. Not reachable from the app
      // (editor.ts always passes live selection ranges against the matching
      // document), but this module is a pure function and its contract
      // should not be "pre-validate the range or the process hangs".
      //
      // Out-of-process for the same reason as the issue #320 test above: a
      // regression is a synchronous loop that Vitest's own timeout cannot
      // interrupt.
      const docText = "ab";
      const query: ReplaceScopeQuery = {
        search: "a",
        replace: "Z",
        regexp: false,
        caseSensitive: true,
      };
      const result = runReplaceAllInSelectionInChildProcess(
        docText,
        [{ from: 0, to: 5 }], // past the end of a 2-character document
        query,
        5000,
      );
      expect(result.edits).toEqual([{ from: 0, to: 1, insert: "Z" }]);
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe("Zb");
    },
    15000,
  );

  it(
    "replaceAllInSelection terminates out-of-process on an NFKD-heavy astral/combining document",
    () => {
      // Same out-of-process discipline as the issue #320 regression test
      // above (see `runReplaceAllInSelectionInChildProcess`'s doc comment): a
      // stalled scan is a synchronous loop Vitest's own timeout cannot
      // interrupt, so the bound has to come from outside the process.
      const docText =
        MATH_BOLD_A +
        LIGATURE_FI +
        E_ACUTE_DECOMPOSED +
        DOTTED_CAPITAL_I +
        KELVIN_SIGN +
        "\ud800" +
        MATH_BOLD_A;
      const query: ReplaceScopeQuery = {
        search: "A",
        replace: "Y",
        regexp: false,
        caseSensitive: false,
      };
      const result = runReplaceAllInSelectionInChildProcess(
        docText,
        [{ from: 0, to: docText.length }],
        query,
        5000,
      );
      expect(applyEditsViaCodeMirrorState(docText, result.edits)).toBe(
        cm6ReplaceAllWholeDoc(docText, query),
      );
    },
    15000,
  );
});
