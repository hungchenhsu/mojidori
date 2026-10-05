import { describe, expect, it, vi } from "vitest";
import { filterRecent, showQuickOpen } from "./quickopen";

const RECENT = [
  "/Users/me/notes/todo.txt",
  "/Users/me/logs/app-2026.log",
  "/Users/me/專案/設定檔.toml",
  "C:\\Users\\me\\readme.md",
];

describe("filterRecent", () => {
  it("returns everything for an empty query", () => {
    expect(filterRecent(RECENT, "")).toEqual(RECENT);
  });

  it("matches case-insensitively on the full path", () => {
    expect(filterRecent(RECENT, "TODO")).toEqual(["/Users/me/notes/todo.txt"]);
    expect(filterRecent(RECENT, "users\\")).toEqual(["C:\\Users\\me\\readme.md"]);
  });

  it("matches non-ASCII path segments", () => {
    expect(filterRecent(RECENT, "設定")).toEqual(["/Users/me/專案/設定檔.toml"]);
  });

  it("returns nothing when no path matches", () => {
    expect(filterRecent(RECENT, "missing")).toEqual([]);
  });

  it("caps results at max", () => {
    expect(filterRecent(RECENT, "", 2)).toEqual(RECENT.slice(0, 2));
  });
});

describe("showQuickOpen accessibility", () => {
  it("exposes a combobox/listbox whose active option follows the arrows", () => {
    const onPick = vi.fn();
    showQuickOpen(["/a/one.txt", "/b/two.md", "/c/three.rs"], onPick);
    try {
      const input = document.querySelector<HTMLInputElement>(".quickopen-panel input")!;
      const list = document.querySelector<HTMLElement>(".quickopen-list")!;
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.getAttribute("aria-controls")).toBe(list.id);
      expect(list.getAttribute("role")).toBe("listbox");
      const options = () => [...list.querySelectorAll<HTMLElement>("[role=option]")];
      expect(options()).toHaveLength(3);
      expect(input.getAttribute("aria-activedescendant")).toBe(options()[0].id);

      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(input.getAttribute("aria-activedescendant")).toBe(options()[1].id);
      expect(options()[1].getAttribute("aria-selected")).toBe("true");

      input.value = "zzz";
      input.dispatchEvent(new Event("input"));
      const status = document.querySelector<HTMLElement>(".quickopen-empty")!;
      expect(status.getAttribute("role")).toBe("status");
      expect(status.hidden).toBe(false);
      expect(list.hidden).toBe(true);
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(input.hasAttribute("aria-activedescendant")).toBe(false);

      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(onPick).not.toHaveBeenCalled();
    } finally {
      document.body.innerHTML = "";
    }
  });
});
