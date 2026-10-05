import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenu, showFilterableMenu, showMenu } from "./popup";

function anchor(): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

describe("showMenu", () => {
  afterEach(() => {
    closeMenu();
    document.body.innerHTML = "";
  });

  it("renders a header-less item list exactly as before: one clickable .popup-item button per entry", () => {
    const action = vi.fn();
    showMenu(anchor(), [
      { label: "Alpha", action },
      { label: "Beta", checked: true },
      { label: "Gamma", disabled: true },
    ]);
    const menu = document.querySelector(".popup-menu");
    expect(menu).not.toBeNull();
    const buttons = menu!.querySelectorAll("button.popup-item");
    expect(buttons).toHaveLength(3);
    expect(menu!.querySelectorAll(".popup-section-header")).toHaveLength(0);

    (buttons[0] as HTMLButtonElement).click();
    expect(action).toHaveBeenCalledOnce();
    // Clicking an item closes the menu, same as before this change.
    expect(document.querySelector(".popup-menu")).toBeNull();
  });

  it("preserves item order, interleaving section headers with items as given", () => {
    showMenu(anchor(), [
      { label: "Group A", header: true },
      { label: "A1" },
      { label: "A2" },
      { label: "Group B", header: true },
      { label: "B1" },
    ]);
    const menu = document.querySelector(".popup-menu")!;
    const rendered = Array.from(menu.children).map((el) =>
      el.classList.contains("popup-section-header") ? `H:${el.textContent}` : el.textContent,
    );
    expect(rendered).toEqual(["H:Group A", "A1", "A2", "H:Group B", "B1"]);
  });

  it("renders a header as a non-button <div>, not counted among clickable items", () => {
    showMenu(anchor(), [
      { label: "Group A", header: true },
      { label: "Item 1" },
    ]);
    const menu = document.querySelector(".popup-menu")!;
    const header = menu.querySelector(".popup-section-header");
    expect(header).not.toBeNull();
    expect(header!.tagName).toBe("DIV");
    expect(header!.textContent).toBe("Group A");
    expect(menu.querySelectorAll("button.popup-item")).toHaveLength(1);
    expect(header!.classList.contains("popup-item")).toBe(false);
  });

  it("never invokes a header's action and never closes the menu when a header is clicked", () => {
    // A header carrying an action/checked/disabled defensively exercises
    // that showMenu ignores all of it for header items, not just that no
    // caller happens to set them today.
    const headerAction = vi.fn();
    showMenu(anchor(), [
      { label: "Group A", header: true, action: headerAction, checked: true, disabled: true },
      { label: "Item 1" },
    ]);
    const header = document.querySelector(".popup-section-header") as HTMLElement;
    header.click();
    expect(headerAction).not.toHaveBeenCalled();
    // A real item click closes the menu (see the first test); a header
    // click must not, since it isn't a menu action at all.
    expect(document.querySelector(".popup-menu")).not.toBeNull();
  });

  it("gives a header no check column and no tabindex, so it sits outside the check/keyboard-focus model real items use", () => {
    showMenu(anchor(), [{ label: "Group A", header: true }]);
    const header = document.querySelector(".popup-section-header") as HTMLElement;
    expect(header.querySelector(".popup-check")).toBeNull();
    expect(header.hasAttribute("tabindex")).toBe(false);
    expect(header.hasAttribute("disabled")).toBe(false);
  });

  // Tab context menu (ROADMAP.md Track C) is the first real caller of a
  // disabled *item* (as opposed to a header) — Copy Path / Reveal in
  // Finder(Explorer) are disabled for untitled tabs. This locks down the
  // contract main.ts's showTabContextMenu relies on: a disabled item's
  // action never runs on click, and clicking it never closes the menu
  // (matching a real click on any other disabled control, and distinct
  // from a header, which also never closes the menu but for a different
  // reason — see "never invokes a header's action" above).
  it("disables an item: the button element carries `disabled`, and clicking it never invokes the action or closes the menu", () => {
    const action = vi.fn();
    showMenu(anchor(), [
      { label: "Enabled", action: vi.fn() },
      { label: "Disabled", disabled: true, action },
    ]);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".popup-menu button.popup-item");
    const disabledButton = buttons[1];
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.textContent).toContain("Disabled");

    disabledButton.click();
    expect(action).not.toHaveBeenCalled();
    expect(document.querySelector(".popup-menu")).not.toBeNull();
  });

  it("leaves an item enabled (no `disabled` attribute) when `disabled` is omitted or false", () => {
    showMenu(anchor(), [{ label: "A" }, { label: "B", disabled: false }]);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".popup-menu button.popup-item");
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(false);
  });
});

// Positioning (main.ts's status-bar pickers anchor near the bottom of the
// window; the tab-strip context menu — ROADMAP.md Track C — anchors near
// the top). jsdom's getBoundingClientRect() is all-zero by default, so
// each case here stubs the anchor's own rect explicitly (same technique as
// tabs.test.ts's stubRect) rather than relying on real layout.
describe("showMenu positioning", () => {
  function stubAnchorRect(el: HTMLElement, top: number, bottom: number): void {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 110,
      width: 100,
      top,
      bottom,
      height: bottom - top,
      x: 10,
      y: top,
      toJSON() {
        return {};
      },
    } as DOMRect);
  }

  it("opens upward (bottom-anchored) when the anchor is near the bottom of the window — existing status-bar-picker behavior", () => {
    const el = anchor();
    stubAnchorRect(el, window.innerHeight - 30, window.innerHeight - 10);
    showMenu(el, [{ label: "Item" }]);
    const menu = document.querySelector(".popup-menu") as HTMLElement;
    // Original formula, unchanged for this (more room above) branch:
    // bottom = distance from the viewport's bottom edge up to 6px above
    // the anchor's own top edge.
    expect(menu.style.bottom).toBe(`${window.innerHeight - (window.innerHeight - 30) + 6}px`);
    expect(menu.style.top).toBe("");
  });

  it("opens downward (top-anchored) when the anchor is near the top of the window — tab-strip context menu", () => {
    const el = anchor();
    stubAnchorRect(el, 8, 40);
    showMenu(el, [{ label: "Item" }]);
    const menu = document.querySelector(".popup-menu") as HTMLElement;
    expect(menu.style.top).toBe(`${40 + 6}px`);
    expect(menu.style.bottom).toBe("");
  });
});

// showFilterableMenu (ROADMAP.md v0.7 Track C encoding-picker alias
// search): the filterable sibling of showMenu — same shared
// buildItemElement/positionElement/registerOpenMenu, plus a text input
// that re-invokes the caller's own getItems(query) on every keystroke. The
// caller (main.ts, backed by encodings.ts's filterEncodingChoices/
// matchedEncodingAlias) owns all matching logic; this module only renders
// whatever getItems returns, so these tests stay domain-agnostic (plain
// "Alpha"/"Beta" labels) exactly like showMenu's own tests above.
describe("showFilterableMenu", () => {
  afterEach(() => {
    closeMenu();
    document.body.innerHTML = "";
  });

  it("calls getItems('') up front and renders the unfiltered list, with the placeholder set on the input", () => {
    const getItems = vi.fn((query: string) =>
      query === "" ? [{ label: "Alpha" }, { label: "Beta" }] : [],
    );
    showFilterableMenu(anchor(), { placeholder: "Search…", emptyText: "No matches", getItems });

    expect(getItems).toHaveBeenCalledWith("");
    const input = document.querySelector<HTMLInputElement>(".popup-filter-input");
    expect(input).not.toBeNull();
    expect(input!.placeholder).toBe("Search…");
    expect(document.querySelectorAll(".popup-filter-list button.popup-item")).toHaveLength(2);
  });

  it("re-invokes getItems on every keystroke and re-renders the list, without recreating the input", () => {
    const getItems = vi.fn((query: string) =>
      query === "a" ? [{ label: "Alpha" }] : [{ label: "Alpha" }, { label: "Beta" }],
    );
    showFilterableMenu(anchor(), { placeholder: "Search…", emptyText: "No matches", getItems });
    const input = document.querySelector<HTMLInputElement>(".popup-filter-input")!;

    input.value = "a";
    input.dispatchEvent(new Event("input"));

    expect(getItems).toHaveBeenLastCalledWith("a");
    const buttons = document.querySelectorAll(".popup-filter-list button.popup-item");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain("Alpha");
    // Same input element survives the re-render — focus/cursor position
    // would otherwise reset on every keystroke.
    expect(document.querySelector(".popup-filter-input")).toBe(input);
  });

  it("shows emptyText in place of the list when getItems returns none — the no-match fallback", () => {
    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matching encoding",
      getItems: () => [],
    });
    const empty = document.querySelector(".popup-filter-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("No matching encoding");
    expect(document.querySelectorAll(".popup-filter-list button.popup-item")).toHaveLength(0);
  });

  it("clicking an item closes the menu and runs its action, same as showMenu", () => {
    const action = vi.fn();
    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matches",
      getItems: () => [{ label: "Windows-1252", action }],
    });
    const button = document.querySelector<HTMLButtonElement>(
      ".popup-filter-list button.popup-item",
    )!;
    button.click();
    expect(action).toHaveBeenCalledOnce();
    expect(document.querySelector(".popup-filter-menu")).toBeNull();
  });

  it("renders a header item as a non-clickable .popup-section-header, same as showMenu", () => {
    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matches",
      getItems: () => [
        { label: "Unicode", header: true },
        { label: "UTF-8", checked: true },
      ],
    });
    expect(document.querySelectorAll(".popup-filter-list .popup-section-header")).toHaveLength(1);
    expect(document.querySelectorAll(".popup-filter-list button.popup-item")).toHaveLength(1);
  });

  it("renders an item's hint as muted trailing text", () => {
    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matches",
      getItems: () => [{ label: "Big5 (Traditional Chinese)", hint: "cp950" }],
    });
    const hint = document.querySelector(".popup-item-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("cp950");
  });

  it("focuses the input on open, so typing filters immediately with no extra click", () => {
    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matches",
      getItems: () => [],
    });
    expect(document.activeElement).toBe(document.querySelector(".popup-filter-input"));
  });

  it("opening a showFilterableMenu closes an already-open showMenu, and vice versa — one shared open-menu instance", () => {
    showMenu(anchor(), [{ label: "Plain menu item" }]);
    expect(document.querySelector(".popup-menu")).not.toBeNull();

    showFilterableMenu(anchor(), {
      placeholder: "Search…",
      emptyText: "No matches",
      getItems: () => [],
    });
    expect(document.querySelector(".popup-menu")).toBeNull();
    expect(document.querySelector(".popup-filter-menu")).not.toBeNull();

    showMenu(anchor(), [{ label: "Another plain item" }]);
    expect(document.querySelector(".popup-filter-menu")).toBeNull();
    expect(document.querySelector(".popup-menu")).not.toBeNull();
  });
});

describe("popup focus restoration", () => {
  afterEach(() => {
    closeMenu();
    document.body.innerHTML = "";
  });

  it("returns focus to the pre-menu element before an item's action runs", async () => {
    const { installModal } = await import("./modal");
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    let focusedDuringAction: Element | null = null;
    showFilterableMenu(anchor(), {
      placeholder: "Filter",
      emptyText: "None",
      getItems: () => [
        {
          label: "Compare",
          action: () => {
            focusedDuringAction = document.activeElement;
            // Like showComparePreview: a modal opened by the item.
            const overlay = document.createElement("div");
            const dialog = document.createElement("div");
            dialog.innerHTML = "<button>ok</button>";
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            installModal(overlay, dialog);
            setTimeout(() => overlay.remove(), 0);
          },
        },
      ],
    });
    // The filter input took focus; picking an item removes it.
    expect(document.activeElement?.className).toBe("popup-filter-input");
    document.querySelector<HTMLButtonElement>(".popup-item")!.click();
    expect(focusedDuringAction).toBe(editor);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(editor);
  });

  it("returns focus on Escape too", async () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    showFilterableMenu(anchor(), { placeholder: "", emptyText: "", getItems: () => [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.activeElement).toBe(editor);
  });
});

describe("popup keyboard navigation", () => {
  afterEach(() => {
    closeMenu();
    document.body.innerHTML = "";
  });

  const press = (key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    (document.activeElement as HTMLElement).dispatchEvent(event);
    return event;
  };

  it("is an ARIA menu that focuses its first enabled item and moves with the arrows", () => {
    const pick = vi.fn();
    showMenu(anchor(), [
      { label: "Section", header: true },
      { label: "Off", disabled: true },
      { label: "One", checked: false },
      { label: "Two", checked: true, action: pick },
      { label: "Three" },
    ]);
    const menu = document.querySelector<HTMLElement>(".popup-menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button.popup-item")];
    expect(items.map((b) => b.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitemradio",
      "menuitemradio",
      "menuitem",
    ]);
    expect(items[2].getAttribute("aria-checked")).toBe("true");
    expect(items.every((b) => b.tabIndex === -1)).toBe(true);

    // The disabled item is skipped everywhere.
    expect(document.activeElement).toBe(items[1]);
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[2]);
    press("ArrowDown");
    press("ArrowDown"); // wraps
    expect(document.activeElement).toBe(items[1]);
    press("ArrowUp"); // wraps backwards
    expect(document.activeElement).toBe(items[3]);
    press("Home");
    expect(document.activeElement).toBe(items[1]);
    press("End");
    expect(document.activeElement).toBe(items[3]);
    items[2].focus();
    items[2].click();
    expect(pick).toHaveBeenCalledOnce();
  });

  it("closes on Tab, returning focus to the opener", () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    showMenu(anchor(), [{ label: "One" }, { label: "Two" }]);
    expect(document.activeElement?.textContent).toContain("One");
    press("Tab");
    expect(document.querySelector(".popup-menu")).toBeNull();
    expect(document.activeElement).toBe(editor);
  });

  it("re-claims focus after the opening gesture's pointerup moved it away", () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    showMenu(anchor(), [{ label: "One" }, { label: "Two" }]);
    // A right-click's pointerup activates the tab, which focuses the editor.
    editor.focus();
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(document.activeElement?.textContent).toContain("One");
    // Only once: a later pointerup doesn't keep stealing focus.
    editor.focus();
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(document.activeElement).toBe(editor);
  });

  it("enters the filtered list with ArrowDown and returns to the field with ArrowUp", () => {
    showFilterableMenu(anchor(), {
      placeholder: "Filter encodings",
      emptyText: "None",
      getItems: () => [{ label: "UTF-8" }, { label: "Big5" }],
    });
    const input = document.querySelector<HTMLInputElement>(".popup-filter-input")!;
    const list = document.querySelector<HTMLElement>(".popup-filter-list")!;
    expect(list.getAttribute("role")).toBe("menu");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.getAttribute("aria-label")).toBe("Filter encodings");
    expect(document.activeElement).toBe(input);
    press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("UTF-8");
    press("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Big5");
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement).toBe(input);
  });
});
