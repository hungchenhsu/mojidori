import { EditorState } from "@codemirror/state";
import { getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditor } from "./editor";
import { cm6Phrases } from "./editor-phrases";

describe("CodeMirror phrases", () => {
  it.each(["zh-TW", "ja", "zh-CN"] as const)(
    "%s covers the same exact keys and preserves announcement placeholders",
    (locale) => {
      const phrases = cm6Phrases(locale);
      expect(Object.keys(phrases).sort()).toEqual(Object.keys(cm6Phrases("zh-TW")).sort());
      for (const [key, text] of Object.entries(phrases)) {
        expect(text.trim()).not.toBe("");
        expect(text.match(/\$/g)?.length ?? 0).toBe(key.match(/\$/g)?.length ?? 0);
      }
    },
  );

  it("uses translated search/fold strings and substitutes counts through the real phrase API", () => {
    const ja = EditorState.create({ extensions: EditorState.phrases.of(cm6Phrases("ja")) });
    expect(ja.phrase("Find")).toBe("検索");
    expect(ja.phrase("Fold line")).toBe("行を折りたたむ");
    expect(ja.phrase("replaced match on line $", 12)).toBe("12 行目の一致を置換しました");

    const zhCN = EditorState.create({ extensions: EditorState.phrases.of(cm6Phrases("zh-CN")) });
    expect(zhCN.phrase("Replace")).toBe("替换");
    expect(zhCN.phrase("Unfold line")).toBe("展开此行");
    expect(zhCN.phrase("replaced $ matches", 3)).toBe("已替换 3 个匹配项");
  });

  it("updates an open search panel through the editor without losing its query", () => {
    const parent = document.createElement("div");
    const editor = createEditor(parent, () => {}, () => {}, () => {}, () => {});
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
    try {
      editor.setLocale("ja");
      editor.openSearch();
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "needle", replace: "replacement" })),
      });
      for (const [locale, expected] of [
        ["ja", "検索"], ["zh-CN", "查找"], ["zh-TW", "尋找"], ["en", "Find"],
      ] as const) {
        editor.setLocale(locale);
        const input = parent.querySelector<HTMLInputElement>('input[name="search"]')!;
        expect(input.placeholder).toBe(expected);
        expect(input.getAttribute("aria-label")).toBe(expected);
        expect(input.value).toBe("needle");
        expect(getSearchQuery(view.state).replace).toBe("replacement");
      }
    } finally {
      view.destroy();
    }
  });
});
