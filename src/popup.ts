// Minimal single-instance popup menu anchored above a status bar control.
export interface MenuItem {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  action?: () => void;
  /** Render `label` as a non-interactive section header (e.g. the encoding
   *  picker's Unicode/East Asian/… groups) instead of a clickable item.
   *  `checked` / `disabled` / `action` are ignored when this is true.
   *  Optional and defaulting to falsy, so every pre-existing `showMenu`
   *  caller (line-ending menu, decode-warning menu, the top-level encoding
   *  menu, etc.) needs no changes. */
  header?: boolean;
  /** Muted trailing text rendered after `label` (e.g. "latin1" — the alias
   *  a filter query matched rather than the label itself; see
   *  encodings.ts's matchedEncodingAlias). Only meaningful to
   *  showFilterableMenu's callers — plain `showMenu` items never set this
   *  today, but it's on the shared shape so both renderers draw from the
   *  same MenuItem list rather than needing parallel item types. */
  hint?: string;
}

interface OpenMenu {
  el: HTMLElement;
  onAway: (event: MouseEvent) => void;
  onKey: (event: KeyboardEvent) => void;
  /** What had focus when the menu opened (usually the editor; the anchor
   *  button where clicking focuses buttons). */
  restoreTo: HTMLElement | null;
}

let current: OpenMenu | null = null;

/** Close the open menu. If that left focus on nothing (the focused filter
 *  input or item went away with it), focus returns to what had it before
 *  the menu opened — synchronously, before an item's action runs, so a
 *  modal that action opens records the right element to restore to on its
 *  own close (modal.ts installModal). */
export function closeMenu(): void {
  if (!current) return;
  const { restoreTo } = current;
  document.removeEventListener("mousedown", current.onAway);
  document.removeEventListener("keydown", current.onKey);
  current.el.remove();
  current = null;
  const active = document.activeElement;
  if ((active === null || active === document.body) && restoreTo?.isConnected) {
    restoreTo.focus();
  }
}

/** Builds one item's DOM node — a non-interactive header `<div>`, or a
 *  clickable `.popup-item` `<button>` with its check column, label, and
 *  optional trailing `hint`. Shared by showMenu's static item list and
 *  showFilterableMenu's per-keystroke re-rendered one, so both draw
 *  identical markup/behavior from the same MenuItem shape. A click always
 *  closes the (single, module-level) open menu before running the item's
 *  own `action` — correct for either caller, since only one of showMenu /
 *  showFilterableMenu is ever open at a time (both funnel through
 *  `current`). */
function buildItemElement(item: MenuItem): HTMLElement {
  if (item.header) {
    const headerEl = document.createElement("div");
    headerEl.className = "popup-section-header";
    headerEl.setAttribute("role", "presentation");
    headerEl.textContent = item.label;
    return headerEl;
  }

  const button = document.createElement("button");
  button.className = "popup-item";
  button.disabled = item.disabled ?? false;
  // ARIA menu items, reached with the arrow keys (see wireMenuKeys) rather
  // than one Tab stop each.
  button.tabIndex = -1;
  if (item.checked === undefined) {
    button.setAttribute("role", "menuitem");
  } else {
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(item.checked));
  }

  const check = document.createElement("span");
  check.className = "popup-check";
  check.textContent = item.checked ? "✓" : "";
  button.appendChild(check);

  const label = document.createElement("span");
  label.textContent = item.label;
  button.appendChild(label);

  if (item.hint) {
    const hint = document.createElement("span");
    hint.className = "popup-item-hint";
    hint.textContent = item.hint;
    button.appendChild(hint);
  }

  button.addEventListener("click", () => {
    // Belt-and-suspenders alongside the native `disabled` attribute set
    // above (which already suppresses the browser's own click dispatch on
    // a disabled button in every real WebView/jsdom): an explicit guard
    // here doesn't depend on that platform behavior being uniform.
    if (item.disabled) return;
    closeMenu();
    item.action?.();
  });
  return button;
}

/** Positions fixed-position element `el` (already appended to
 *  `document.body`, so `el.offsetWidth` reflects its real rendered size)
 *  against `anchor` — shared by showMenu and showFilterableMenu so both
 *  open on the same side-with-more-room logic. See showMenu's original
 *  inline comment (preserved below) for why the up-vs-down choice exists. */
function positionElement(el: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;

  // Every pre-existing caller anchors to a status-bar control near the
  // bottom of the window, where opening upward (bottom-anchored, growing
  // toward the top) is correct and is all this once did unconditionally.
  // A trigger nearer the top of the window instead — e.g. the tab-strip
  // context menu (main.ts's showTabContextMenu) — needs the opposite: open
  // downward from the anchor's own bottom edge, or the menu would render
  // with its top edge above the viewport's own top edge (bottom-anchored
  // position math with no explicit `top` grows upward from the anchor with
  // no lower bound). Picking whichever side has more room keeps every
  // existing caller's behavior byte-for-byte unchanged (they all have more
  // room above than below) while making the container correct for a new
  // top-anchored caller too.
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow > spaceAbove) {
    el.style.top = `${rect.bottom + 6}px`;
  } else {
    el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  }
}

/** Wires `el` up as the single open menu: away-click and Escape both close
 *  it (via the shared `closeMenu`), deferred by a tick so the same click
 *  that opened the menu doesn't immediately register as an away-click.
 *  Shared by showMenu and showFilterableMenu. */
function registerOpenMenu(el: HTMLElement): void {
  const onAway = (event: MouseEvent) => {
    if (!el.contains(event.target as Node)) closeMenu();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeMenu();
  };
  const active = document.activeElement;
  const restoreTo =
    active instanceof HTMLElement && active !== document.body && !el.contains(active)
      ? active
      : null;
  current = { el, onAway, onKey, restoreTo };
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}

/** The menu's operable items, in order. */
function enabledItems(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button.popup-item")].filter(
    (button) => !button.disabled,
  );
}

/** Arrow-key navigation within `list` (ARIA menu pattern): Up/Down move
 *  between enabled items, wrapping; Home/End jump to the ends. Enter and
 *  Space activate the focused item natively (it's a <button>). `onTopEdge`
 *  runs instead of wrapping when ArrowUp is pressed on the first item —
 *  the filterable menu uses it to return to its filter field. */
function wireMenuKeys(list: HTMLElement, onTopEdge?: () => void): void {
  list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledItems(list);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowUp" && index <= 0 && onTopEdge) {
      onTopEdge();
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next].focus();
  });
}

export function showMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const el = document.createElement("div");
  el.className = "popup-menu";
  el.setAttribute("role", "menu");
  for (const item of items) el.appendChild(buildItemElement(item));

  document.body.appendChild(el);
  positionElement(el, anchor);
  registerOpenMenu(el);
  wireMenuKeys(el);
  // Keyboard users start inside the menu; focus returns on close
  // (closeMenu).
  enabledItems(el)[0]?.focus();
}

/**
 * Filterable variant of showMenu (ROADMAP.md v0.7 Track C encoding-picker
 * alias search): a text input above the item list, live-recomputing the
 * list on every keystroke via `getItems(query)` — the caller owns all
 * matching logic (e.g. encodings.ts's filterEncodingChoices/
 * matchedEncodingAlias); this module stays domain-agnostic, same as
 * showMenu itself. Investigated first: showMenu has no filter mechanism at
 * all today (a plain click list, no input), so this is new, not an
 * extension of an existing one — see encodings.ts's ENCODING_ALIASES doc
 * comment for the fuller investigation note.
 *
 * Deliberately anchored/positioned like showMenu (via the same
 * positionElement/registerOpenMenu), not a centered modal overlay like
 * palette.ts's showPalette/quickopen.ts's showQuickOpen — the encoding
 * picker is a status-bar-anchored dropdown today, and swapping that for a
 * full-screen overlay would be a bigger UX change than "add a filter"
 * calls for. Trade-off accepted for the same reason: no arrow-key
 * navigation / Enter-to-select like the palette/quickopen overlays have —
 * showMenu's items were always mouse-click-only, and adding keyboard
 * selection here would be a second new interaction model in one PR rather
 * than the minimal filter this was scoped as.
 *
 * `getItems` is called once up front with an empty query (so the picker
 * opens showing the full unfiltered list, not an empty one) and again on
 * every `input` event; only the list portion re-renders, so the input
 * itself is never recreated and keeps focus/cursor position across
 * keystrokes (same technique as palette.ts's own render()).
 */
export function showFilterableMenu(
  anchor: HTMLElement,
  options: {
    /** Localized placeholder text — this module has no i18n dependency of
     *  its own, callers pass already-translated strings (mirrors
     *  showMenu's items already carrying pre-translated labels). */
    placeholder: string;
    /** Localized text shown in place of the list when `getItems` returns
     *  an empty array (the "no match" fallback). */
    emptyText: string;
    getItems: (query: string) => MenuItem[];
  },
): void {
  closeMenu();
  const el = document.createElement("div");
  el.className = "popup-filter-menu";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "popup-filter-input";
  input.placeholder = options.placeholder;
  el.appendChild(input);

  const listEl = document.createElement("div");
  listEl.className = "popup-filter-list";
  listEl.id = "popup-filter-list";
  listEl.setAttribute("role", "menu");
  el.appendChild(listEl);
  input.setAttribute("aria-controls", listEl.id);
  input.setAttribute("aria-label", options.placeholder);

  const renderList = (query: string): void => {
    listEl.replaceChildren();
    const items = options.getItems(query);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "popup-filter-empty";
      empty.textContent = options.emptyText;
      listEl.appendChild(empty);
      return;
    }
    for (const item of items) listEl.appendChild(buildItemElement(item));
  };

  input.addEventListener("input", () => renderList(input.value));
  // ArrowDown from the filter field enters the list; ArrowUp on the first
  // item comes back up to it.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const first = enabledItems(listEl)[0];
    if (!first) return;
    event.preventDefault();
    first.focus();
  });
  wireMenuKeys(listEl, () => input.focus());

  document.body.appendChild(el);
  renderList("");
  positionElement(el, anchor);
  registerOpenMenu(el);
  input.focus();
}
