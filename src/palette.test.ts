import { describe, expect, it } from "vitest";
import {
  clampSelectedIndex,
  filterAndSortCommands,
  formatAccelerator,
  fuzzyMatch,
  highlightRuns,
  moveSelection,
  showPalette,
} from "./palette";
import type { PaletteCommand } from "./ipc";

describe("fuzzyMatch", () => {
  it("matches an empty query against everything with score 0", () => {
    expect(fuzzyMatch("Save As…", "")).toEqual({ score: 0, indices: [] });
  });

  it("matches case-insensitively", () => {
    expect(fuzzyMatch("UPPERCASE", "upper")).not.toBeNull();
    expect(fuzzyMatch("lowercase", "LOWER")).not.toBeNull();
  });

  it("matches CJK label text", () => {
    expect(fuzzyMatch("儲存", "儲")).not.toBeNull();
    expect(fuzzyMatch("儲存", "存")).toEqual({ score: -1, indices: [1] });
  });

  it("returns null when query is not a subsequence of text", () => {
    expect(fuzzyMatch("Save", "xyz")).toBeNull();
    // Right letters, wrong order: 'v' would have to be found after 'e'.
    expect(fuzzyMatch("Save", "eva")).toBeNull();
  });

  it("returns the matched positions in text", () => {
    expect(fuzzyMatch("Save", "sa")).toEqual({ score: 1000, indices: [0, 1] });
  });

  it("scores a contiguous run higher than a scattered match of the same query", () => {
    const contiguous = fuzzyMatch("cat", "cat");
    const scattered = fuzzyMatch("coat", "cat");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!.score).toBeGreaterThan(scattered!.score);
  });

  it("prefers an earlier match when consecutive-run counts are equal", () => {
    const early = fuzzyMatch("cat food", "cat");
    const late = fuzzyMatch("my cat", "cat");
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(early!.score).toBeGreaterThan(late!.score);
  });

  it("is greedy-leftmost, not a globally optimal alignment (documented simplification)", () => {
    // A DP-based optimal scorer would prefer the fully-contiguous "abc" at
    // the end (positions 2,3,4); greedy-leftmost claims the earliest 'a'
    // and 'b' (positions 0,1) first, forcing 'c' to match late and
    // non-consecutively. Pinning this documented trade-off rather than
    // hiding it.
    expect(fuzzyMatch("ababc", "abc")).toEqual({ score: 1000, indices: [0, 1, 4] });
  });
});

const COMMANDS: PaletteCommand[] = [
  { id: "save", label: "Save", accelerator: "CmdOrCtrl+S" },
  { id: "save_as", label: "Save As…", accelerator: null },
  { id: "find", label: "Find and Replace…", accelerator: null },
  { id: "sort_lines", label: "Sort Lines", accelerator: null },
];

describe("filterAndSortCommands", () => {
  it("returns everything for an empty query, in original order", () => {
    expect(filterAndSortCommands(COMMANDS, "").map((c) => c.id)).toEqual([
      "save",
      "save_as",
      "find",
      "sort_lines",
    ]);
  });

  it("filters to only fuzzy-matching labels", () => {
    expect(filterAndSortCommands(COMMANDS, "sort").map((c) => c.id)).toEqual(["sort_lines"]);
  });

  it("excludes commands whose label doesn't fuzzy-match at all", () => {
    expect(filterAndSortCommands(COMMANDS, "xyz")).toEqual([]);
  });

  it("carries the match info alongside id/label", () => {
    const [entry] = filterAndSortCommands(COMMANDS, "sort");
    expect(entry).toMatchObject({ id: "sort_lines", label: "Sort Lines", accelerator: null });
    expect(entry.match.indices).toEqual([0, 1, 2, 3]);
  });

  it("sorts matches by score, best first", () => {
    const commands: PaletteCommand[] = [
      { id: "b", label: "coat", accelerator: null },
      { id: "a", label: "cat", accelerator: null },
      { id: "c", label: "dog", accelerator: null },
    ];
    expect(filterAndSortCommands(commands, "cat").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps original relative order for equal scores (stable sort)", () => {
    const commands: PaletteCommand[] = [
      { id: "first", label: "Save", accelerator: null },
      { id: "second", label: "Save As…", accelerator: null },
    ];
    // Both greedy-leftmost-match "sa" at positions [0,1] -- genuinely tied
    // scores, so this pins the stable-sort tie-break rather than an actual
    // scoring difference.
    expect(filterAndSortCommands(commands, "sa").map((c) => c.id)).toEqual(["first", "second"]);
    const reversed: PaletteCommand[] = [commands[1], commands[0]];
    expect(filterAndSortCommands(reversed, "sa").map((c) => c.id)).toEqual(["second", "first"]);
  });
});

describe("moveSelection", () => {
  it("moves down within bounds", () => {
    expect(moveSelection(0, 1, 5)).toBe(1);
  });

  it("moves up within bounds", () => {
    expect(moveSelection(2, -1, 5)).toBe(1);
  });

  it("clamps at the bottom (no wraparound)", () => {
    expect(moveSelection(4, 1, 5)).toBe(4);
  });

  it("clamps at the top (no wraparound)", () => {
    expect(moveSelection(0, -1, 5)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(0, -1, 0)).toBe(0);
  });
});

describe("clampSelectedIndex", () => {
  it("leaves an in-range index unchanged", () => {
    expect(clampSelectedIndex(2, 5)).toBe(2);
  });

  it("clamps down to the new last index when the list shrinks", () => {
    expect(clampSelectedIndex(4, 2)).toBe(1);
  });

  it("clamps negative to 0", () => {
    expect(clampSelectedIndex(-1, 5)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(clampSelectedIndex(3, 0)).toBe(0);
  });
});

describe("formatAccelerator", () => {
  it("prints macOS symbols in the system modifier order", () => {
    expect(formatAccelerator("CmdOrCtrl+Shift+F", true)).toBe("⇧⌘F");
    expect(formatAccelerator("CmdOrCtrl+Alt+P", true)).toBe("⌥⌘P");
    expect(formatAccelerator("Alt+Z", true)).toBe("⌥Z");
    expect(formatAccelerator("CmdOrCtrl+,", true)).toBe("⌘,");
    expect(formatAccelerator("CmdOrCtrl+=", true)).toBe("⌘=");
    expect(formatAccelerator("Ctrl+Shift+Tab", true)).toBe("⌃⇧Tab");
  });

  it("prints Ctrl/Alt/Shift words elsewhere", () => {
    expect(formatAccelerator("CmdOrCtrl+Shift+F", false)).toBe("Ctrl+Shift+F");
    expect(formatAccelerator("CmdOrCtrl+Alt+P", false)).toBe("Ctrl+Alt+P");
    expect(formatAccelerator("Alt+Z", false)).toBe("Alt+Z");
    expect(formatAccelerator("CmdOrCtrl+-", false)).toBe("Ctrl+-");
  });
});

describe("highlightRuns", () => {
  it("groups matched and unmatched characters into runs", () => {
    expect(highlightRuns("Save As", [0, 1, 5])).toEqual([
      { text: "Sa", matched: true },
      { text: "ve ", matched: false },
      { text: "A", matched: true },
      { text: "s", matched: false },
    ]);
    expect(highlightRuns("Save", [])).toEqual([{ text: "Save", matched: false }]);
  });
});

describe("showPalette rendering", () => {
  it("shows shortcut hints, highlights matches, and exposes a listbox", () => {
    showPalette(COMMANDS, () => {});
    try {
      const input = document.querySelector<HTMLInputElement>(".palette-panel input")!;
      const list = document.querySelector<HTMLElement>(".palette-list")!;
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.getAttribute("aria-controls")).toBe(list.id);
      expect(list.getAttribute("role")).toBe("listbox");

      const items = [...list.querySelectorAll<HTMLElement>(".palette-item")];
      expect(items.map((i) => i.getAttribute("role"))).toEqual(["option", "option", "option", "option"]);
      expect(items[0].getAttribute("aria-selected")).toBe("true");
      expect(input.getAttribute("aria-activedescendant")).toBe(items[0].id);
      expect(items[0].querySelector(".palette-shortcut")?.textContent).toMatch(/S$/);
      expect(items[1].querySelector(".palette-shortcut")).toBeNull();

      input.value = "sl";
      input.dispatchEvent(new Event("input"));
      const [only] = [...list.querySelectorAll<HTMLElement>(".palette-item")];
      expect([...only.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["S", "L"]);

      input.value = "zzz";
      input.dispatchEvent(new Event("input"));
      const status = document.querySelector<HTMLElement>(".palette-empty")!;
      expect(status.getAttribute("role")).toBe("status");
      expect(status.hidden).toBe(false);
      expect(status.textContent).toBe("No matching commands");
      expect(list.hidden).toBe(true);
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(input.hasAttribute("aria-activedescendant")).toBe(false);

      input.value = "";
      input.dispatchEvent(new Event("input"));
      expect(status.hidden).toBe(true);
      expect(list.hidden).toBe(false);
      expect(input.getAttribute("aria-expanded")).toBe("true");
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("moves aria-activedescendant with the arrow keys", () => {
    showPalette(COMMANDS, () => {});
    try {
      const input = document.querySelector<HTMLInputElement>(".palette-panel input")!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      const items = document.querySelectorAll<HTMLElement>(".palette-item");
      expect(input.getAttribute("aria-activedescendant")).toBe(items[1].id);
      expect(items[1].getAttribute("aria-selected")).toBe("true");
    } finally {
      document.body.innerHTML = "";
    }
  });
});
