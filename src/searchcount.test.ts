// Search match counter (src/editor.ts `countSearchMatches`,
// `searchCountLabel`, and the panel plugin that renders them).
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countSearchMatches,
  createEditor,
  SEARCH_COUNT_MAX_DOC,
  searchCountLabel,
} from "./editor";
import { cm6Phrases } from "./editor-phrases";

function stateWith(doc: string, anchor = 0, head = anchor, locale: "en" | "zh-TW" = "en") {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: EditorState.phrases.of(cm6Phrases(locale)),
  });
}

describe("countSearchMatches", () => {
  it("returns null for an empty or invalid query", () => {
    const state = stateWith("abc");
    expect(countSearchMatches(state, new SearchQuery({ search: "" }))).toBeNull();
    expect(
      countSearchMatches(state, new SearchQuery({ search: "(", regexp: true })),
    ).toBeNull();
  });

  it("lists every match in document order", () => {
    const state = stateWith("ab ab AB");
    const count = countSearchMatches(state, new SearchQuery({ search: "ab" }))!;
    expect(count.ranges).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 8 },
    ]);
    expect(count.capped).toBe(false);
    const cased = countSearchMatches(
      state,
      new SearchQuery({ search: "ab", caseSensitive: true }),
    )!;
    expect(cased.ranges).toHaveLength(2);
  });

  it("counts zero-length regex matches the way find-next steps through them", () => {
    const state = stateWith("ab\ncd");
    const starts = countSearchMatches(state, new SearchQuery({ search: "^", regexp: true }))!;
    expect(starts.ranges).toEqual([
      { from: 0, to: 0 },
      { from: 3, to: 3 },
    ]);
    // A caret sitting on a zero-length match counts as "on" it, matching
    // where CodeMirror's own find-next would leave the selection.
    expect(searchCountLabel(stateWith("ab\ncd", 3), starts)).toBe("2 of 2");
  });

  it("honors whole-word matching", () => {
    const state = stateWith("cat catalog cat");
    const count = countSearchMatches(state, new SearchQuery({ search: "cat", wholeWord: true }))!;
    expect(count.ranges).toEqual([
      { from: 0, to: 3 },
      { from: 12, to: 15 },
    ]);
  });

  it("stops at the cap and reports it", () => {
    const state = stateWith("x".repeat(10));
    const count = countSearchMatches(state, new SearchQuery({ search: "x" }), 4)!;
    expect(count.ranges).toHaveLength(4);
    expect(count.capped).toBe(true);
    // Exactly `cap` matches is not capped.
    const exact = countSearchMatches(stateWith("xxxx"), new SearchQuery({ search: "x" }), 4)!;
    expect(exact.capped).toBe(false);
  });
});

describe("searchCountLabel", () => {
  const query = new SearchQuery({ search: "ab" });

  it("shows the position when the selection is exactly a match", () => {
    for (const [from, expected] of [[0, "1 of 3"], [3, "2 of 3"], [6, "3 of 3"]] as const) {
      const state = stateWith("ab ab ab", from, from + 2);
      expect(searchCountLabel(state, countSearchMatches(state, query)!)).toBe(expected);
    }
  });

  it("shows the total when the selection is not a match", () => {
    // Cursor at a match start but not selecting it, and a partial overlap.
    for (const [anchor, head] of [[0, 0], [0, 1], [1, 3]] as const) {
      const state = stateWith("ab ab ab", anchor, head);
      expect(searchCountLabel(state, countSearchMatches(state, query)!)).toBe("3 matches");
    }
  });

  it("uses the singular, empty, and capped forms", () => {
    const one = stateWith("ab");
    expect(searchCountLabel(one, countSearchMatches(one, query)!)).toBe("1 match");
    const none = stateWith("zz");
    expect(searchCountLabel(none, countSearchMatches(none, query)!)).toBe("No matches");
    const many = stateWith("x".repeat(10), 1, 2);
    const capped = countSearchMatches(many, new SearchQuery({ search: "x" }), 4)!;
    expect(searchCountLabel(many, capped)).toBe("2 of 4+");
    const cappedAway = stateWith("x".repeat(10), 9, 10);
    expect(
      searchCountLabel(cappedAway, countSearchMatches(cappedAway, new SearchQuery({ search: "x" }), 4)!),
    ).toBe("4+ matches");
  });

  it("is localized through the editor phrases", () => {
    const state = stateWith("ab ab", 3, 5, "zh-TW");
    expect(searchCountLabel(state, countSearchMatches(state, query)!)).toBe("第 2 / 2 筆");
    const none = stateWith("zz", 0, 0, "zh-TW");
    expect(searchCountLabel(none, countSearchMatches(none, query)!)).toBe("無符合項目");
  });
});

describe("search panel counter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(doc: string, truncated = false) {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createEditor(parent, () => {}, () => {}, () => {}, () => {});
    editor.swap(editor.newBuffer(doc, truncated));
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
    editor.openSearch();
    const label = () => parent.querySelector<HTMLElement>(".cm-search-count");
    const panel = () => parent.querySelector<HTMLElement>(".cm-panel.cm-search")!;
    return { editor, view, parent, label, panel };
  }

  it("renders the count after the debounce and tracks query changes", () => {
    const { view, label, panel, parent } = setup("one two one");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
      // Stale-until-recounted: nothing is shown before the debounce fires.
      expect(label()!.hidden).toBe(true);
      vi.runAllTimers();
      expect(label()!.hidden).toBe(false);
      expect(label()!.textContent).toBe("2 matches");
      expect(panel().dataset.matchState).toBe("some");
      const field = parent.querySelector('input[name="search"]')!;
      expect(field.getAttribute("aria-describedby")).toBe(label()!.id);
      expect(label()!.getAttribute("role")).toBe("status");
      expect(label()!.getAttribute("aria-atomic")).toBe("true");

      view.dispatch({ selection: { anchor: 8, head: 11 } });
      expect(label()!.textContent).toBe("2 of 2");

      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "zzz" })) });
      // The old query's count is never shown against the new query while
      // the recount is pending.
      expect(label()!.hidden).toBe(true);
      expect(panel().dataset.matchState).toBeUndefined();
      vi.runAllTimers();
      expect(label()!.textContent).toBe("No matches");
      expect(panel().dataset.matchState).toBe("none");

      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      vi.runAllTimers();
      expect(label()!.hidden).toBe(true);
      expect(panel().dataset.matchState).toBeUndefined();
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("ignores replacement-only edits", () => {
    const { view, label, parent } = setup("one two");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "zzz" })) });
      vi.runAllTimers();
      expect(label()!.textContent).toBe("No matches");
      const timers = vi.getTimerCount();
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "zzz", replace: "x" })),
      });
      expect(vi.getTimerCount()).toBe(timers);
      expect(label()!.hidden).toBe(false);
      expect(label()!.textContent).toBe("No matches");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("clears its pending recount when the view is destroyed", () => {
    const { view, parent } = setup("one");
    vi.runAllTimers();
    const before = vi.getTimerCount();
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    view.destroy();
    parent.remove();
    expect(vi.getTimerCount()).toBe(before);
  });

  it("recounts after document edits", () => {
    const { view, label, parent } = setup("one");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
      vi.runAllTimers();
      expect(label()!.textContent).toBe("1 match");
      view.dispatch({ changes: { from: 3, insert: " one one" } });
      vi.runAllTimers();
      expect(label()!.textContent).toBe("3 matches");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("stays hidden for a truncated large-file window", () => {
    const { view, label, parent } = setup("one one", true);
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
      vi.runAllTimers();
      expect(label()!.hidden).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("stays hidden above the document-size limit", () => {
    const { view, label, parent } = setup("one".padEnd(SEARCH_COUNT_MAX_DOC + 1, " "));
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
      vi.runAllTimers();
      expect(label()!.hidden).toBe(true);
      // Back under the limit, it counts again.
      view.dispatch({ changes: { from: 3, to: view.state.doc.length } });
      vi.runAllTimers();
      expect(label()!.textContent).toBe("1 match");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("still counts in a user-locked (not truncated) read-only buffer", () => {
    const { editor, view, label, parent } = setup("one one");
    try {
      editor.setReadOnly(true);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "one" })) });
      vi.runAllTimers();
      expect(label()!.textContent).toBe("2 matches");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("mirrors option checkboxes onto their chip labels", () => {
    const { view, panel, parent } = setup("abc");
    try {
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "a", caseSensitive: true })),
      });
      const caseLabel = panel().querySelector('input[name="case"]')!.parentElement!;
      const reLabel = panel().querySelector('input[name="re"]')!.parentElement!;
      expect(caseLabel.classList.contains("is-checked")).toBe(true);
      expect(reLabel.classList.contains("is-checked")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
