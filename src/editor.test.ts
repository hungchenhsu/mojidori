// Pure logic behind the EOL invisible-character marks (src/editor.ts). The
// rest of editor.ts wraps a live CodeMirror EditorView, which needs a real
// (or convincingly faked) layout engine to test meaningfully — this file
// covers what's reachable without one: which character offsets get an EOL
// mark. See CLAUDE.md "Frontend logic that doesn't need the WebView".
import { history, moveLineDown as cmMoveLineDown, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import { EditorView, highlightSpecialChars } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { describe, expect, it, vi } from "vitest";
import {
  createEditor,
  characterBeforeCursor,
  detectIndentationOf,
  eolMarkPositions,
  INDENT_DETECTION_SAMPLE_LINES,
  indentGuideLevels,
  isNonNfcOf,
  joinLinesSpanInDoc,
  lineSpanForSelectionInDoc,
  suspiciousCharCountOf,
  textStatsOf,
  trimTrailingWhitespaceOf,
} from "./editor";
import { detectIndentation } from "./indentdetect";
import { lineSpanForSelection, trimTrailingWhitespace } from "./lineops";
import { scanSuspiciousChars, SUSPICIOUS_CHARS_PATTERN } from "./suspiciouschars";
import { countTextStats } from "./textstats";

describe("eolMarkPositions", () => {
  it("returns no positions for an empty document", () => {
    const doc = Text.of([""]);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([]);
  });

  it("returns no positions for a single line with no trailing newline", () => {
    const doc = Text.of(["abc"]);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([]);
  });

  it("marks every line end except the last when the file has no trailing newline", () => {
    // "a\nb\nc" -> lines ["a", "b", "c"], no trailing newline.
    const doc = Text.of(["a", "b", "c"]);
    expect(doc.lines).toBe(3);
    // Line 1 ends at offset 1 ("a"), line 2 ends at offset 3 ("a\nb"); line
    // 3 ("c") is the last line and has no trailing newline, so it's unmarked.
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([1, 3]);
  });

  it("marks the second-to-last line too when the file ends with a trailing newline", () => {
    // "a\nb\n" -> CM6 represents this as lines ["a", "b", ""]: the trailing
    // newline produces an empty final line, which itself has no newline
    // after it and so is correctly left unmarked.
    const doc = Text.of(["a", "b", ""]);
    expect(doc.lines).toBe(3);
    expect(eolMarkPositions(doc, 0, doc.length)).toEqual([1, 3]);
  });

  it("restricts marks to the given [from, to] range (visible-range perf path)", () => {
    const doc = Text.of(["a", "b", "c", "d"]);
    // Only ask about the middle of the document (covering lines 2-3).
    const from = doc.line(2).from;
    const to = doc.line(3).to;
    expect(eolMarkPositions(doc, from, to)).toEqual([doc.line(2).to, doc.line(3).to]);
  });
});

// Pure logic behind indent-guide vertical lines (ROADMAP.md Track C /
// issue #74). Like eolMarkPositions above, this is the reachable-without-a-
// live-EditorView slice of editor.ts's indent-guide feature — the
// ViewPlugin that turns this into decorations needs a real layout engine
// and is exercised manually instead (see CLAUDE.md "Frontend logic that
// doesn't need the WebView").
describe("indentGuideLevels", () => {
  it("returns 0 for an empty line", () => {
    expect(indentGuideLevels("", 4)).toBe(0);
  });

  it("returns 0 for an all-whitespace (blank) line of spaces, even if it would otherwise span a full level", () => {
    // Design decision: blank lines never get a guide in this first
    // version (no context-extension through them) — see the doc comment
    // on indentGuideLevels in editor.ts.
    expect(indentGuideLevels("        ", 4)).toBe(0);
  });

  it("returns 0 for an all-whitespace (blank) line of tabs", () => {
    expect(indentGuideLevels("\t\t", 4)).toBe(0);
  });

  it("returns 0 when the line has no leading whitespace", () => {
    expect(indentGuideLevels("foo", 4)).toBe(0);
  });

  it("returns 0 when leading spaces are fewer than one tabSize (not a full level)", () => {
    expect(indentGuideLevels("  foo", 4)).toBe(0);
  });

  it("returns 1 for exactly one tabSize of leading spaces", () => {
    expect(indentGuideLevels("    foo", 4)).toBe(1);
  });

  it("returns 2 for exactly two tabSizes of leading spaces", () => {
    expect(indentGuideLevels("        foo", 4)).toBe(2);
  });

  it("floors a partial extra column beyond a full level, rather than rounding up", () => {
    // 5 leading spaces at tabSize 4 is one full level plus one leftover
    // column, which isn't enough for a second guide.
    expect(indentGuideLevels("     foo", 4)).toBe(1);
  });

  it("counts a single leading tab as exactly one level, regardless of tabSize", () => {
    expect(indentGuideLevels("\tfoo", 4)).toBe(1);
    expect(indentGuideLevels("\tfoo", 2)).toBe(1);
  });

  it("counts multiple leading tabs as that many levels", () => {
    expect(indentGuideLevels("\t\tfoo", 4)).toBe(2);
  });

  it("expands a tab to the next tab stop, not a fixed width, when mixed with spaces", () => {
    // 3 spaces then a tab then 3 more spaces, tabSize 4: the tab only
    // needs to advance one column (3 -> 4) to reach the next stop, so the
    // leading whitespace is 7 columns wide (floor(7/4) = 1 level) — not
    // 10, which is what you'd get by naively treating every tab as a
    // fixed +tabSize regardless of the column it starts at (that wrong
    // algorithm would floor(10/4) to 2 levels instead).
    expect(indentGuideLevels("   \t   x", 4)).toBe(1);
  });

  it("changes level count with tabSize for the same text", () => {
    expect(indentGuideLevels("        foo", 2)).toBe(4);
    expect(indentGuideLevels("        foo", 4)).toBe(2);
  });

  it("ignores whitespace that isn't leading (interior/trailing content is irrelevant)", () => {
    expect(indentGuideLevels("    foo   ", 4)).toBe(1);
  });
});

/**
 * Builds the CM6 `Text` a live buffer would have for `text`, the same way
 * `EditorState.create({ doc: text })` does internally: split on "\n", hand
 * the line array to `Text.of`. Local to this file's oracle-equivalence
 * checks below, which need a `Text` for `lineSpanForSelectionInDoc` and the
 * plain string it was built from for `lineSpanForSelection` (lineops.ts) —
 * both from the exact same document.
 */
function toDoc(text: string): Text {
  return Text.of(text.split("\n"));
}

// Oracle-equivalence coverage for issue #107: `EditorHandle.transformLines`
// used to call lineops.ts's `lineSpanForSelection` (a pure string function)
// against `state.doc.toString()`, materializing the whole document just to
// compute two offsets. `lineSpanForSelectionInDoc` (editor.ts) answers the
// same question straight from `state.doc` via `Text.lineAt`, with no
// materialization — but "no materialization" is only a safe change if it
// produces identical `{ from, to }` results to the string version it
// replaces, for every case that version handles, including the issue #99 /
// PR #106 to-1 regression it was built to fix. `lineSpanForSelection`
// itself is kept around (not deleted) specifically to serve as that
// reference oracle here, rather than being inlined away now that
// `transformLines` no longer calls it — see both functions' doc comments.
describe("lineSpanForSelectionInDoc (oracle: must match lineops.ts's lineSpanForSelection)", () => {
  it("agrees on issue #99: selection's exclusive end at column 1 of the next line stops before that line", () => {
    // "b\na\nc": selecting [0, 2) highlights "b" plus its newline, ending
    // exactly at the start of line 2 ("a") — the core regression case.
    const text = "b\na\nc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees when a selection ends mid-line: expands to that line's full extent", () => {
    const text = "bbb\naaa";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees on a multi-line selection ending mid-line on a later line", () => {
    // to - 1 (6) is inside line 3 ("cc"), so the span covers all three
    // lines, through the end of the document.
    const text = "aa\nbb\ncc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 7)).toEqual(lineSpanForSelection(text, 0, 7));
  });

  it("agrees on a multi-line selection whose exclusive end lands at a later line's start, stopping one line short", () => {
    // Same text; to === 6 is column 1 of line 3, so the span covers only
    // lines 1-2 — the multi-line generalization of the issue #99 case.
    const text = "aa\nbb\ncc";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees on the last line when the document has no trailing newline", () => {
    const text = "a\nb";
    expect(lineSpanForSelectionInDoc(toDoc(text), 2, 3)).toEqual(lineSpanForSelection(text, 2, 3));
  });

  it("agrees that a following empty line is excluded the same way a following non-empty one is", () => {
    const text = "a\n\nb";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 2)).toEqual(lineSpanForSelection(text, 0, 2));
  });

  it("agrees that a selection inside a leading empty line does not spill into line 2", () => {
    const text = "\nfoo";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 1)).toEqual(lineSpanForSelection(text, 0, 1));
  });

  it("agrees on a single-line file with no newline at all: the span is the whole document", () => {
    const text = "only";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 4)).toEqual(lineSpanForSelection(text, 0, 4));
  });

  it("agrees on a whole-file selection spanning every line of a multi-line document", () => {
    const text = "xx\nyyy";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees on a whole-file selection when the document ends with a trailing newline", () => {
    const text = "a\nb\nc\n";
    expect(lineSpanForSelectionInDoc(toDoc(text), 0, 6)).toEqual(lineSpanForSelection(text, 0, 6));
  });

  it("agrees that reaching exactly the end of a document with a trailing newline does not pull in the trailing empty line", () => {
    // "a\nb\n" is lines ["a", "b", ""]; selecting [2, 4) is "b" plus its
    // own trailing newline, ending exactly at doc.length. to - 1 (3) is
    // the offset of that final "\n" itself, which both implementations
    // must resolve to line 2 ("b"), not the empty line 3 after it.
    const text = "a\nb\n";
    expect(lineSpanForSelectionInDoc(toDoc(text), 2, 4)).toEqual(lineSpanForSelection(text, 2, 4));
  });

  it("agrees that both throw for an empty selection (cursor), at the start, middle, and end of the document", () => {
    // transformLines never calls either function for an empty selection
    // (a cursor gets the whole document instead — see editor.ts), but the
    // two must still fail the same way if ever misused, per both
    // functions' doc comments.
    const text = "aa\nbb\ncc";
    const doc = toDoc(text);
    for (const pos of [0, 4, text.length]) {
      expect(() => lineSpanForSelectionInDoc(doc, pos, pos)).toThrow();
      expect(() => lineSpanForSelection(text, pos, pos)).toThrow();
    }
  });
});

// ROADMAP.md v0.6 C2 Join Lines: unlike lineSpanForSelectionInDoc above
// (which transformLines uses, and which throws on an empty selection since
// transformLines gives a cursor its own whole-document meaning instead),
// joinLinesSpanInDoc must handle an empty selection directly -- Join Lines'
// no-selection default is "current line plus the next one", not "whole
// document" (mainstream editor convention: VS Code, Sublime Text, Emacs).
// A selection confined to a single line degenerates the same way a cursor
// does, for the same reason; only a selection already spanning two or more
// lines is left as-is. Same to-1 (issue #99) convention as
// lineSpanForSelectionInDoc throughout, so the "aa\nbb\ncc" fixture and its
// {from:0,to:5} boundary result are reused directly from that suite above.
describe("joinLinesSpanInDoc", () => {
  const text = "aa\nbb\ncc"; // line1 "aa" [0,2), line2 "bb" [3,5), line3 "cc" [6,8)

  it("extends a cursor (empty selection) on a non-last line to include the next line", () => {
    expect(joinLinesSpanInDoc(toDoc(text), 0, 0)).toEqual({ from: 0, to: 5 });
  });

  it("returns null for a cursor already on the document's last line -- nothing to join with", () => {
    expect(joinLinesSpanInDoc(toDoc(text), 6, 6)).toBeNull();
  });

  it("degenerates a selection confined to a single, non-last line the same way an empty selection does", () => {
    // [0, 2) selects exactly line 1's text ("aa"), no more.
    expect(joinLinesSpanInDoc(toDoc(text), 0, 2)).toEqual({ from: 0, to: 5 });
  });

  it("returns null for a selection confined to the document's last line", () => {
    // [6, 8) selects exactly line 3's text ("cc"), no more.
    expect(joinLinesSpanInDoc(toDoc(text), 6, 8)).toBeNull();
  });

  it("leaves a selection already spanning two lines as-is, without pulling in a third", () => {
    expect(joinLinesSpanInDoc(toDoc(text), 0, 5)).toEqual({ from: 0, to: 5 });
  });

  it("leaves a selection already spanning every line as-is", () => {
    expect(joinLinesSpanInDoc(toDoc(text), 0, 8)).toEqual({ from: 0, to: 8 });
  });

  it("honors the to-1 convention (issue #99): an exclusive end at column 1 of a later line stops one line short, not three", () => {
    // to === 6 is column 1 of line 3; a naive doc.lineAt(to) would wrongly
    // pull line 3 in too, matching lineSpanForSelectionInDoc's own
    // regression case for the identical input (see the suite above).
    expect(joinLinesSpanInDoc(toDoc(text), 0, 6)).toEqual({ from: 0, to: 5 });
  });

  it("still finds a next line for a cursor on the last line WITH content when the document ends in a trailing newline", () => {
    // "aa\nbb\n" is CM6 lines ["aa", "bb", ""] -- a genuine (if empty)
    // third line, unlike lineops.ts's string-based splitLines, which folds
    // a trailing newline into a boolean flag instead of a phantom line
    // (see that function's doc comment). Structurally there IS a next
    // line here, so this must not return null; whether joining onto an
    // empty line is actually worth doing is lineops.ts's joinLines' call
    // once it sees the sliced text, not this function's.
    const trailing = "aa\nbb\n";
    expect(joinLinesSpanInDoc(toDoc(trailing), 3, 3)).toEqual({ from: 3, to: 6 });
  });

  it("returns null for a cursor on the trailing empty line itself", () => {
    const trailing = "aa\nbb\n";
    expect(joinLinesSpanInDoc(toDoc(trailing), 6, 6)).toBeNull();
  });
});

// ROADMAP.md Track C multi-cursor: unlike everything above, this needs no
// live EditorView — `EditorState.create`/`state.update` are pure and need
// no layout engine, so the actual mechanism Mod-d (`selectNextOccurrence`)
// and Mod-Shift-l (`selectSelectionMatches`, both @codemirror/search,
// already in basicSetup's searchKeymap) rely on is directly testable: a
// transaction's selection only keeps more than one range when
// `EditorState.allowMultipleSelections` is on, per @codemirror/state's
// own `EditorState.applyTransaction` (`tr.newSelection` vs
// `tr.newSelection.asSingle()`). `createEditor`'s extensions always start
// with `basicSetup` (see editor.ts), which is what actually turns this on
// for the app — verified from source, not assumed (basicSetup's own
// module includes `EditorState.allowMultipleSelections.of(true)`).
describe("allowMultipleSelections (ROADMAP.md Track C multi-cursor)", () => {
  // Two ranges a command like selectNextOccurrence would dispatch after
  // matching a second "abc" in "abc abc abc".
  const twoRanges = EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]);

  it("collapses a multi-range selection to just the main range when the extension is absent", () => {
    // Baseline with no extensions at all: this is what would silently
    // defeat Mod-d/Mod-Shift-l if createEditor's extensions ever stopped
    // including basicSetup (or some other source of this facet).
    const state = EditorState.create({ doc: "abc abc abc" });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(1);
  });

  it("keeps every range once allowMultipleSelections is on", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(2);
  });

  it("is already on via basicSetup, the extension bundle createEditor always includes", () => {
    const state = EditorState.create({ doc: "abc abc abc", extensions: [basicSetup] });
    const tr = state.update({ selection: twoRanges });
    expect(tr.state.selection.ranges.length).toBe(2);
  });
});

// ROADMAP.md v0.4 Track C per-tab read-only mode. editor.ts's setReadOnly
// (see createEditor) reconfigures a dedicated Compartment between `[]` and
// `[EditorState.readOnly.of(true), EditorView.editable.of(false)]` — the
// exact same extension pair newBuffer already applies fixed at construction
// for a truncated large-file preview. This suite doesn't exercise setReadOnly
// itself (that needs a live EditorView + DOM parent, which this file's other
// suites also avoid — see the module header), but pins the CM6-level
// assumption the whole design leans on: a plain Compartment reconfigure is
// enough to flip `state.readOnly`, and CM6's own line-operation commands
// (moveLineUp/moveLineDown/copyLineDown/deleteLine — every one of them
// reachable outside the Edit menu's own runLineOperation guard via
// basicSetup's default keymap, see editor.ts's moveLineUp doc comment) look
// at `state.readOnly` themselves and no-op without ever calling dispatch —
// verified from source (@codemirror/commands `moveLine`), not assumed.
describe("read-only via Compartment reconfigure (ROADMAP.md v0.4 Track C)", () => {
  const READ_ONLY_ON = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

  it("state.readOnly is true once the compartment holds the read-only extensions", () => {
    const readOnly = new Compartment();
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    expect(state.readOnly).toBe(true);
  });

  it("a CM6 command (moveLineDown) self-no-ops and never dispatches once read-only", () => {
    const readOnly = new Compartment();
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    const dispatch = vi.fn();
    const ran = cmMoveLineDown({ state, dispatch });
    expect(ran).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("the same command runs normally once the compartment reconfigures back to empty", () => {
    const readOnly = new Compartment();
    const lockedState = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: [readOnly.of(READ_ONLY_ON)],
    });
    const lifted = lockedState.update({ effects: readOnly.reconfigure([]) }).state;
    expect(lifted.readOnly).toBe(false);
    const dispatch = vi.fn();
    const ran = cmMoveLineDown({ state: lifted, dispatch });
    expect(ran).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// ROADMAP.md v0.4 Track C word/char/line count status-bar segment. Unlike
// eolMarkPositions/indentGuideLevels above (pure functions over a Text or
// plain string), textStatsOf reads a full EditorBuffer (EditorState),
// including its selection — but EditorState.create needs no live view or
// layout engine either, so this is fully reachable here without a WebView.
describe("textStatsOf", () => {
  it("reports whole-document stats when the selection is a single empty cursor", () => {
    const state = EditorState.create({ doc: "hello world\nsecond line" });
    const result = textStatsOf(state);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual(countTextStats("hello world\nsecond line"));
  });

  it("agrees with countTextStats for CJK-mixed whole-document content", () => {
    const text = "Hello 你好世界\nこんにちは안녕\nlast line";
    const state = EditorState.create({ doc: text });
    expect(textStatsOf(state).stats).toEqual(countTextStats(text));
  });

  it("reports selection stats (not whole-document) for a single non-empty range", () => {
    const state = EditorState.create({ doc: "hello world" });
    const withSelection = state.update({
      selection: EditorSelection.single(0, 5), // "hello"
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    expect(result.stats).toEqual({ chars: 5, words: 1, lines: 1 });
  });

  it("sums stats across every non-empty range for a multi-cursor selection", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    // Select the first and third "abc" (3 chars, 1 word each).
    const withSelection = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 11),
      ]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    // "lines" sums per-range too, per spec ("多選取時加總所有 ranges") — each
    // range independently spans 1 line here, even though both ranges sit
    // on the *same* physical line of a single-line document, so the total
    // is 2, not the 1 distinct line actually touched. Deliberate: see
    // textStatsOf's doc comment in editor.ts.
    expect(result.stats).toEqual({ chars: 6, words: 2, lines: 2 });
  });

  it("ignores empty ranges mixed in with a non-empty one (multi-cursor, only one range has a selection)", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const withSelection = state.update({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3), // "abc" selected
        EditorSelection.cursor(8), // bare cursor, no selection
      ]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    expect(result.stats).toEqual({ chars: 3, words: 1, lines: 1 });
  });

  it("treats every range being empty (multiple bare cursors) as no selection", () => {
    const state = EditorState.create({
      doc: "abc abc abc",
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    const withSelection = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(8)]),
    }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual(countTextStats("abc abc abc"));
  });

  it("does not count a selection's own trailing newline as spanning a further line", () => {
    // "AAA\nBBB": selecting through "AAA\n" only (issue #99-style boundary).
    const state = EditorState.create({ doc: "AAA\nBBB" });
    const withSelection = state.update({ selection: EditorSelection.single(0, 4) }).state;
    const result = textStatsOf(withSelection);
    expect(result.stats).toEqual({ chars: 4, words: 1, lines: 1 });
  });

  it("handles an empty document (0 chars, 0 words, 1 line)", () => {
    const state = EditorState.create({ doc: "" });
    const result = textStatsOf(state);
    expect(result.selected).toBe(false);
    expect(result.stats).toEqual({ chars: 0, words: 0, lines: 1 });
  });

  it("walks a document large enough to span many internal Text leaves/nodes", () => {
    // TextLeaf caps at 32 lines per node (@codemirror/state's own
    // Tree.Branch) before TextNode.from/TextLeaf.split kicks in — a
    // 200-line document forces textStatsOf's Text.iterRange walk across
    // multiple internal chunks, not just one small leaf.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} 你好`);
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    expect(textStatsOf(state).stats).toEqual(countTextStats(text));
  });

  it("computes selection stats correctly across a many-leaf document (mid-tree range)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} 你好`);
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    // Select from partway into line 50 through partway into line 150.
    const from = state.doc.line(50).from + 2;
    const to = state.doc.line(150).from + 2;
    const withSelection = state.update({ selection: EditorSelection.single(from, to) }).state;
    const result = textStatsOf(withSelection);
    expect(result.selected).toBe(true);
    // Oracle: the number of lines a selection touches is lineAt(to-1) minus
    // lineAt(from) inclusive — the same to-1 convention
    // lineSpanForSelectionInDoc uses to resolve a selection's end line
    // (issue #99), which finishRangeTextStats is designed to match.
    expect(result.stats.lines).toBe(
      state.doc.lineAt(to - 1).number - state.doc.lineAt(from).number + 1,
    );
  });
});

// ROADMAP.md v0.4 Track A invisible/ambiguous character audit status-bar
// count. Like textStatsOf above, EditorState.create needs no live view or
// layout engine, so the Text.iterRange chunk-walk is fully reachable here.
describe("suspiciousCharCountOf", () => {
  it("is 0 for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(suspiciousCharCountOf(state)).toBe(0);
  });

  it("is 0 for ordinary text with no curated characters", () => {
    const state = EditorState.create({ doc: "hello world\n你好，世界" });
    expect(suspiciousCharCountOf(state)).toBe(0);
  });

  it("counts curated characters across categories in one small document", () => {
    // "a" + RLO (bidi) + "\n" + "b" + ZWSP (zeroWidth) + NBSP (whitespace)
    const text = `a${String.fromCharCode(0x202e)}\nb${String.fromCharCode(0x200b)}${String.fromCharCode(0x00a0)}`;
    const state = EditorState.create({ doc: text });
    expect(suspiciousCharCountOf(state)).toBe(3);
  });

  it("walks a document large enough to span many internal Text leaves/nodes", () => {
    // Same technique as textStatsOf's own many-leaf test above (TextLeaf
    // caps at 32 lines per node) — one curated character (alternating
    // category) on every 10th line, forcing the Text.iterRange walk across
    // multiple internal chunks and proving per-chunk counts sum correctly
    // rather than dropping or double-counting anything at a chunk boundary.
    const curated = [0x202e, 0x200b, 0x00a0]; // RLO, ZWSP, NBSP
    const lines = Array.from({ length: 200 }, (_, i) =>
      i % 10 === 0 ? `line ${i} ${String.fromCharCode(curated[i % curated.length])}` : `line ${i}`,
    );
    const text = lines.join("\n");
    const state = EditorState.create({ doc: text });
    // Oracle: scanSuspiciousChars's own whole-string scan (suspiciouschars.ts),
    // independent of the Text.iterRange chunking being exercised here —
    // mirrors textStatsOf's many-leaf test comparing against countTextStats.
    expect(suspiciousCharCountOf(state)).toBe(scanSuspiciousChars(text).length);
    expect(suspiciousCharCountOf(state)).toBe(20); // sanity: one per 10th line, 200/10
  });
});

// ROADMAP.md v0.4 Track A Unicode normalization [danger].
describe("isNonNfcOf", () => {
  it("is false for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(isNonNfcOf(state)).toBe(false);
  });

  it("is false for ordinary already-NFC text (ASCII and CJK)", () => {
    const state = EditorState.create({ doc: "hello world\n中文編碼偵測測試" });
    expect(isNonNfcOf(state)).toBe(false);
  });

  // NFD/NFC fixtures below spell "cafe" plus an accented "e" via
  // explicit \u escapes rather than a literal accented character in
  // source: a bare literal risks silently being whichever Unicode
  // normalization form it happens to get typed as, defeating the point
  // of pinning one specific form.
  const NFD_CAFE = "cafe" + "\u0301"; // "e" + combining acute accent (NFD)
  const NFC_CAFE = "cafe\u0301".normalize("NFC"); // precomposed U+00E9 (NFC)

  it("is true for a decomposed (NFD) combining sequence", () => {
    const state = EditorState.create({ doc: NFD_CAFE });
    expect(isNonNfcOf(state)).toBe(true);
  });

  it("is false once the same content is precomposed", () => {
    const state = EditorState.create({ doc: NFC_CAFE });
    expect(isNonNfcOf(state)).toBe(false);
  });

  /**
   * `isNonNfcOf` must still find a decomposed sequence correctly once the
   * document spans multiple internal `Text` leaves (`TextLeaf` caps at 32
   * lines per node — same technique `suspiciousCharCountOf`'s own many-leaf
   * test above uses), proving the chunk-by-chunk walk doesn't drop or
   * misjudge anything just because `Text.iter()` enumerates many chunks
   * rather than one. This does not (and — per `isNfcChunked`'s doc comment —
   * cannot) exercise a combining sequence actually split *across* a chunk
   * boundary: CM6's chunk boundaries are always real line breaks, and a
   * combining mark right after a "\n" never composes with the previous
   * line's last character (verified: `("e\n" + "́").normalize("NFC")`
   * is a no-op) — so placing the decomposed sequence on its own line, far
   * from line 1, is what actually exercises "found deep inside a multi-leaf
   * document", not a boundary split. The chunk-boundary-splitting hazard
   * itself is exercised directly on `isNfcChunked` with hand-built chunk
   * arrays in normalize.test.ts, where a chunk source that isn't
   * line-aligned is possible to construct at all.
   */
  it("still detects a decomposed sequence deep inside a document spanning many internal Text leaves", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[75] = NFD_CAFE; // "e" + combining acute, on a line past the first leaf
    const state = EditorState.create({ doc: lines.join("\n") });
    expect(isNonNfcOf(state)).toBe(true);
  });
});

// Pins the CM6-level assumption editor.ts's `suspiciousCharsExtension`
// leans on (see its doc comment in editor.ts): overlaying a curated
// `addSpecialChars` pattern alongside basicSetup's own bare
// `highlightSpecialChars()` must never hit @codemirror/state's
// `combineConfig` "Config merge conflict" error. Reconstructs the same
// overlay shape independently via publicly exported pieces (CM6's own
// `highlightSpecialChars` plus suspiciouschars.ts's exported pattern)
// rather than importing editor.ts's private `suspiciousCharsExtension`
// constant — same "verify the real CM6 mechanism, don't just trust a
// private implementation detail" approach as the read-only and
// allowMultipleSelections suites above, which need a live EditorView to
// go further than this (this file's header comment), so — like those —
// this only proves the state-level assumption, not the rendered pixels.
describe("suspicious-chars highlightSpecialChars overlay (ROADMAP.md v0.4 Track A)", () => {
  it("does not throw a facet merge conflict when layered alongside basicSetup's own highlightSpecialChars", () => {
    expect(() =>
      EditorState.create({
        doc: "hello",
        extensions: [basicSetup, highlightSpecialChars({ addSpecialChars: SUSPICIOUS_CHARS_PATTERN })],
      }),
    ).not.toThrow();
  });
});

// ROADMAP.md v0.4 Track A character inspector: the Unicode code point
// immediately before the cursor (Backspace-would-delete semantics — see
// characterBeforeCursor's doc comment in editor.ts for why a line start
// returns null instead of reaching across the previous line's newline).
// Like textStatsOf above, EditorState.create needs no live view.
describe("characterBeforeCursor", () => {
  it("returns null for an empty document (cursor at the only, empty line)", () => {
    const state = EditorState.create({ doc: "" });
    expect(characterBeforeCursor(state)).toBeNull();
  });

  it("returns null when the cursor sits at the very start of the document", () => {
    const state = EditorState.create({ doc: "abc" }); // default cursor is 0
    expect(characterBeforeCursor(state)).toBeNull();
  });

  it("returns null at the start of a later line, not the previous line's newline", () => {
    const state = EditorState.create({ doc: "abc\ndef" });
    const pos = state.doc.line(2).from; // start of "def"
    const withCursor = state.update({ selection: EditorSelection.cursor(pos) }).state;
    expect(characterBeforeCursor(withCursor)).toBeNull();
  });

  it("returns the single character immediately before the cursor, not the one after it", () => {
    const state = EditorState.create({ doc: "AB" });
    const withCursor = state.update({ selection: EditorSelection.cursor(1) }).state; // between A and B
    expect(characterBeforeCursor(withCursor)).toBe("A");
  });

  it("returns the last character before the cursor at the end of the document", () => {
    const state = EditorState.create({ doc: "AB" });
    const withCursor = state.update({ selection: EditorSelection.cursor(2) }).state;
    expect(characterBeforeCursor(withCursor)).toBe("B");
  });

  it("returns a CJK character (multi-byte in UTF-8, one UTF-16 unit) whole", () => {
    const state = EditorState.create({ doc: "中" });
    const withCursor = state.update({ selection: EditorSelection.cursor(1) }).state;
    expect(characterBeforeCursor(withCursor)).toBe("中");
  });

  it("assembles a surrogate pair into the one code point it represents, not half of it", () => {
    // U+1F600 GRINNING FACE is 2 UTF-16 code units in a JS string.
    const emoji = "\u{1F600}";
    const state = EditorState.create({ doc: `x${emoji}` });
    expect(state.doc.length).toBe(3); // "x" + 2 surrogate code units
    const withCursor = state.update({ selection: EditorSelection.cursor(3) }).state;
    const result = characterBeforeCursor(withCursor);
    expect(result).toBe(emoji);
    expect(result?.codePointAt(0)).toBe(0x1f600);
  });

  it("does not pull a surrogate pair's high half across a line start", () => {
    // A supplementary character can never actually straddle a line break,
    // but this pins that the line-start short-circuit still fires even
    // when the immediately preceding line ends in one, rather than the
    // 2-code-unit lookback window accidentally reaching across the
    // boundary into the previous line's content.
    const emoji = "\u{1F600}";
    const state = EditorState.create({ doc: `${emoji}\ny` });
    const pos = state.doc.line(2).from;
    const withCursor = state.update({ selection: EditorSelection.cursor(pos) }).state;
    expect(characterBeforeCursor(withCursor)).toBeNull();
  });
});

// ROADMAP.md v0.4 Track C indentation tools: the CM6-facing sampling
// wrapper around indentdetect.ts's pure `detectIndentation`. Like
// textStatsOf/suspiciousCharCountOf above, EditorState.create needs no live
// view, so the `Text.iterLines` sampling walk is fully reachable here. The
// classification heuristic itself (mode of adjacent depth diffs, tabs vs.
// spaces vs. mixed vs. none) is exhaustively covered in indentdetect.test.ts
// against plain string arrays — this suite only proves the wrapper samples
// a live buffer's lines correctly and agrees with that oracle, plus the
// sample-limit boundary itself.
describe("detectIndentationOf", () => {
  it("agrees with detectIndentation for ordinary space-indented content", () => {
    const text = "function foo() {\n    return 1;\n}";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state)).toEqual(detectIndentation(text.split("\n")));
    expect(detectIndentationOf(state)).toEqual({ kind: "spaces", width: 4 });
  });

  it("agrees with detectIndentation for tab-indented content", () => {
    const text = "function foo() {\n\treturn 1;\n}";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state)).toEqual({ kind: "tabs" });
  });

  it("reports none for an empty document", () => {
    const state = EditorState.create({ doc: "" });
    expect(detectIndentationOf(state)).toEqual({ kind: "none" });
  });

  it("honors an explicit sampleLimit smaller than the document, ignoring later lines entirely", () => {
    // First 2 lines are consistently 2-space indented; a later tab-indented
    // line would flip the result to "mixed" if it were ever sampled —
    // passing sampleLimit=2 must exclude it.
    const text = "a\n  b\na2\n\tc";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state, 2)).toEqual({ kind: "spaces", width: 2 });
    // Sanity: without the limit (or a large enough one), the later line
    // does change the answer, proving the limit is actually doing something.
    expect(detectIndentationOf(state, 4)).toEqual({ kind: "mixed" });
    expect(detectIndentation(text.split("\n"))).toEqual({ kind: "mixed" });
  });

  it("defaults to sampling only the first 1000 lines of a much larger document", () => {
    // Lines 1-1000: consistent 2-space indentation (a clean "spaces" file).
    // Lines 1001+: tab-indented instead. If the default sample window were
    // larger than 1000 (or unbounded), those later tab-indented lines would
    // flip the result to "mixed" (spaces and tabs both present) — the
    // default must stop exactly at 1000 and never see them.
    const head = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? "a" : "  b"));
    const tail = Array.from({ length: 50 }, () => "\tc");
    const text = [...head, ...tail].join("\n");
    const state = EditorState.create({ doc: text });
    expect(state.doc.lines).toBe(1050);
    expect(INDENT_DETECTION_SAMPLE_LINES).toBe(1000);
    expect(detectIndentationOf(state)).toEqual({ kind: "spaces", width: 2 });
    // Sanity: a large-enough explicit sample does see the tab-indented
    // tail and correctly flips to "mixed", proving the boundary is real
    // and not just a coincidental match.
    expect(detectIndentationOf(state, 1050)).toEqual({ kind: "mixed" });
  });

  it("uses the whole document when it has fewer lines than the sample limit", () => {
    const text = "a\n  b\nc";
    const state = EditorState.create({ doc: text });
    expect(detectIndentationOf(state, 1000)).toEqual(detectIndentationOf(state, 3));
  });
});

// ROADMAP.md v0.7 Track C "trim trailing whitespace on save". Like
// textStatsOf/isNonNfcOf/detectIndentationOf above, trimTrailingWhitespaceOf
// operates on a detached EditorState via `.update()` rather than a live
// EditorView, so it's fully reachable here without a WebView — including
// the undo-history behavior, since `EditorState.update()` runs through the
// exact same transaction pipeline `view.dispatch()` does (see that
// function's own doc comment in editor.ts for the full design rationale).
// `EditorHandle.trimTrailingWhitespaceForSave` (the live-view wrapper
// main.ts's runSaveFlow actually calls) shares this same change-list
// computation and is not separately covered here, for the same reason
// transformLines/transformSelection/replaceContent aren't: it needs a real
// layout engine to test meaningfully (see this file's own header comment).
describe("trimTrailingWhitespaceOf", () => {
  it("returns the exact same buffer reference when there is nothing to trim", () => {
    const state = EditorState.create({ doc: "hello\nworld" });
    expect(trimTrailingWhitespaceOf(state)).toBe(state);
  });

  it("trims trailing spaces/tabs from every line, agreeing with lineops.trimTrailingWhitespace", () => {
    const text = "foo   \nbar\t\t\nbaz \t \nclean\n   \nlast  ";
    const state = EditorState.create({ doc: text });
    const trimmed = trimTrailingWhitespaceOf(state);
    expect(trimmed.doc.toString()).toBe(trimTrailingWhitespace(text));
    expect(trimmed).not.toBe(state);
  });

  // (e) mixed line endings / whitespace-only / clean lines in one pass.
  describe("mixed content", () => {
    it("trims a mix of trailing spaces, tabs, a whitespace-only line, and clean lines in one pass", () => {
      const text = "a  \nb\nc\t\n   \nd \t";
      const trimmed = trimTrailingWhitespaceOf(EditorState.create({ doc: text }));
      expect(trimmed.doc.toString()).toBe("a\nb\nc\n\nd");
      expect(trimmed.doc.toString()).toBe(trimTrailingWhitespace(text));
    });

    // Unlike lineops.test.ts's own "stray \r" case, there is no CM6-level
    // equivalent to test here: EditorState.create's line splitter
    // (@codemirror/state's DefaultSplit, /\r\n?|\n/) already treats "\r\n"
    // as a single line break at construction time, so a CM6 `Text` can
    // never actually hold a trailing "\r" as line content in the first
    // place — trimTrailingWhitespaceOf never sees one to (not) touch. The
    // defensive rule is meaningful only for lineops.ts's plain-string
    // trimTrailingWhitespace/trailingWhitespaceSpans, already covered in
    // lineops.test.ts.
  });

  // (d) caret stability: CM6's default change-mapping (assoc: -1) is relied
  // on rather than hand-rolled, per computeTrimChanges's per-line-span
  // design — these tests verify it actually behaves as documented rather
  // than assuming it.
  describe("caret stability", () => {
    it("leaves a cursor on an untouched line at exactly the same offset", () => {
      const state = EditorState.create({
        doc: "clean\nfoo   \nbar",
        selection: { anchor: 2 }, // inside "clean", a line with nothing to trim
      });
      const trimmed = trimTrailingWhitespaceOf(state);
      expect(trimmed.selection.main.head).toBe(2);
    });

    it("shifts a cursor on a later, untouched line by exactly what was removed before it", () => {
      // "foo   \nbar", cursor at the "b" of "bar" (offset 7). The 3-space
      // run removed before it shifts it back to offset 4 — still
      // immediately before "bar".
      const state = EditorState.create({ doc: "foo   \nbar", selection: { anchor: 7 } });
      const trimmed = trimTrailingWhitespaceOf(state);
      expect(trimmed.doc.toString()).toBe("foo\nbar");
      expect(trimmed.selection.main.head).toBe(4);
      expect(trimmed.doc.sliceString(trimmed.selection.main.head)).toBe("bar");
    });

    it("collapses a cursor anywhere inside a trimmed run onto the line's new end", () => {
      // "foo   \nbar": "foo" is [0,3), the trimmed run is [3,6).
      const text = "foo   \nbar";
      for (const pos of [3, 4, 5, 6]) {
        const state = EditorState.create({ doc: text, selection: { anchor: pos } });
        const trimmed = trimTrailingWhitespaceOf(state);
        expect(trimmed.doc.toString()).toBe("foo\nbar");
        expect(trimmed.selection.main.head).toBe(3);
      }
    });

    it("collapses a cursor inside a whitespace-only line onto that now-empty line's start", () => {
      // "a\n   \nb": the whole middle line [2,5) is the trimmed run.
      const text = "a\n   \nb";
      for (const pos of [2, 3, 4, 5]) {
        const state = EditorState.create({ doc: text, selection: { anchor: pos } });
        const trimmed = trimTrailingWhitespaceOf(state);
        expect(trimmed.doc.toString()).toBe("a\n\nb");
        expect(trimmed.selection.main.head).toBe(2);
      }
    });
  });

  // (c) undo semantics. See trimTrailingWhitespaceOf's own doc comment in
  // editor.ts for the full trade-off analysis (verified against
  // node_modules/@codemirror/commands/dist/index.js): isolateHistory
  // deliberately makes trim its own, deterministic undo step rather than
  // relying on CM6's default timing/adjacency-dependent merge heuristic.
  describe("undo semantics", () => {
    /** Runs CM6's `undo` command against `state` (requires the `history()`
     *  extension) and returns the resulting state — fails the test via the
     *  `ok` assertion if there was nothing left to undo, so callers don't
     *  need to separately check it. */
    function applyUndo(state: EditorState): EditorState {
      let result: EditorState | null = null;
      const ok = undo({
        state,
        dispatch: (tr) => {
          result = tr.state;
        },
      });
      expect(ok).toBe(true);
      return result as unknown as EditorState;
    }

    it("addToHistory:false would be wrong: it must not be how this is implemented, since Undo has to be able to reach the pre-trim buffer at all", () => {
      // Sanity/documentation check on the CM6 primitive itself (not on
      // trimTrailingWhitespaceOf, which never sets this annotation): a
      // transaction with addToHistory=false changes the document but is
      // never recorded, so Undo has nothing to pop back to — pinned here
      // so the contrast with isolateHistory below is verified, not assumed.
      const state = EditorState.create({ doc: "hello", extensions: [history()] });
      const noHistory = state.update({
        changes: { from: 5, insert: "   " },
        annotations: Transaction.addToHistory.of(false),
      }).state;
      expect(noHistory.doc.toString()).toBe("hello   ");
      expect(undoDepth(noHistory)).toBe(0);
      expect(undo({ state: noHistory, dispatch: () => {} })).toBe(false);
    });

    it("one Undo after trim restores the pre-trim buffer with the user's last edit intact; a second Undo then removes that edit", () => {
      const original = EditorState.create({
        doc: "hello  \nworld",
        extensions: [history()],
      });
      // The user's last real edit before Save: append "!" to "world".
      const edited = original.update({
        changes: { from: original.doc.length, insert: "!" },
        annotations: Transaction.userEvent.of("input.type"),
      }).state;
      expect(edited.doc.toString()).toBe("hello  \nworld!");

      const trimmed = trimTrailingWhitespaceOf(edited);
      expect(trimmed.doc.toString()).toBe("hello\nworld!");
      // Two distinct steps on the undo stack: the edit, then the trim —
      // never merged into one.
      expect(undoDepth(trimmed)).toBe(2);

      const afterFirstUndo = applyUndo(trimmed);
      expect(afterFirstUndo.doc.toString()).toBe("hello  \nworld!");

      const afterSecondUndo = applyUndo(afterFirstUndo);
      expect(afterSecondUndo.doc.toString()).toBe("hello  \nworld");
    });

    it("never merges with the preceding edit even when it is immediate and spatially adjacent", () => {
      // The scenario most likely to trip CM6's default merge heuristic
      // (isAdjacent + newGroupDelay): the trimmed run is typed by the same
      // "user edit" transaction, with zero elapsed time before the trim
      // that follows it. isolateHistory must still keep them separate.
      const original = EditorState.create({ doc: "hello", extensions: [history()] });
      const edited = original.update({
        changes: { from: 5, insert: "   " },
        annotations: Transaction.userEvent.of("input.type"),
      }).state;
      const trimmed = trimTrailingWhitespaceOf(edited);
      expect(trimmed.doc.toString()).toBe("hello");
      expect(undoDepth(trimmed)).toBe(2);

      const afterFirstUndo = applyUndo(trimmed);
      expect(afterFirstUndo.doc.toString()).toBe("hello   ");
      const afterSecondUndo = applyUndo(afterFirstUndo);
      expect(afterSecondUndo.doc.toString()).toBe("hello");
    });

    it("a no-op trim (already clean) leaves the undo stack untouched", () => {
      const original = EditorState.create({ doc: "hello", extensions: [history()] });
      const edited = original.update({
        changes: { from: 5, insert: "!" },
        annotations: Transaction.userEvent.of("input.type"),
      }).state;
      expect(undoDepth(edited)).toBe(1);
      const trimmed = trimTrailingWhitespaceOf(edited);
      expect(trimmed).toBe(edited); // no transaction dispatched at all
      expect(undoDepth(trimmed)).toBe(1);
    });
  });
});

describe("scoped Replace progression (#344)", () => {
  function setup(doc: string, replacement: string, regexp = false, search = "f") {
    const parent = document.createElement("div");
    const editor = createEditor(parent, () => {}, () => {}, () => {}, () => {});
    editor.swap(editor.newBuffer(doc).update({
      selection: EditorSelection.range(0, doc.length),
    }).state);
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
    editor.openSearch();
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search, replace: replacement, regexp })) });
    return { editor, view };
  }

  it.each(["f", "ff", "", "xyz"])("advances past replacement %j and discloses once", (replacement) => {
    const { editor, view } = setup("f f ﬁ", replacement);
    try {
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      expect(view.state.doc.toString()).toBe(`${replacement} f ﬁ`);
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      expect(view.state.doc.toString()).toBe(`${replacement} ${replacement} ﬁ`);
      expect(view.state.selection.main.to).toBe(view.state.doc.length);
      expect(editor.replaceInSelection()).toEqual({ replaced: 0, skippedNonPrecise: 1 });
      expect(editor.replaceInSelection()).toEqual({ replaced: 0, skippedNonPrecise: 0 });
    } finally { view.destroy(); }
  });

  it("advances through zero-length matches without splitting astral characters", () => {
    const { editor, view } = setup("😀a", "_", true, "(?=.)");
    try {
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      expect(editor.replaceInSelection()?.replaced).toBe(0);
      expect(view.state.doc.toString()).toBe("_😀_a");
    } finally { view.destroy(); }
  });

  it("resumes scanning at the boundary even when a match crosses it", () => {
    const { editor, view } = setup("aaaaaa", "a", false, "aa");
    try {
      editor.replaceInSelection();
      editor.replaceInSelection();
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      expect(view.state.doc.toString()).toBe("aaa");
      expect(editor.replaceInSelection()?.replaced).toBe(0);
    } finally { view.destroy(); }
  });

  it("progresses across multiple touching ranges with one boundary owner", () => {
    const { editor, view } = setup("ab", "_", true, "$|(?=b)");
    try {
      view.dispatch({ selection: EditorSelection.create([
        EditorSelection.range(0, 1), EditorSelection.range(1, 2),
      ], 1) });
      editor.replaceInSelection();
      expect(view.state.selection.mainIndex).toBe(1);
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("a_b_");
      expect(editor.replaceInSelection()?.replaced).toBe(0);
    } finally { view.destroy(); }
  });

  it("Replace All starts a fresh pass and read-only buffers reject replacements", () => {
    const { editor, view } = setup("f f", "ff");
    try {
      editor.replaceInSelection();
      expect(editor.replaceAllInSelection()?.replaced).toBe(3);
      expect(editor.replaceInSelection()?.replaced).toBe(1);
      editor.setReadOnly(true);
      const before = view.state.doc;
      expect(editor.replaceInSelection()).toBeUndefined();
      expect(editor.replaceAllInSelection()).toBeUndefined();
      expect(view.state.doc).toBe(before);
    } finally { view.destroy(); }
  });

  it("resets after manual selection, query changes, edits, undo, and tab switches", () => {
    const { editor, view } = setup("f f", "ff");
    try {
      editor.replaceInSelection();
      view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("fff f");
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "f", replace: "x" })) });
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("xff f");
      view.dispatch({ changes: { from: 0, to: 1, insert: "f" } });
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("xff f");
      undo(view);
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("xff f");
      const buffer = view.state;
      editor.swap(editor.newBuffer("other"));
      editor.swap(buffer);
      editor.replaceInSelection();
      expect(view.state.doc.toString()).toBe("xxf f");
    } finally { view.destroy(); }
  });
});
