// Command Palette (Mod+Shift+P; ROADMAP.md v0.6 C1): a fuzzy-searchable
// overlay over every dispatchable native-menu command, wrapping menu.rs's
// LABELS ids for discoverability -- no new capability. v1 lists every
// command with no per-command enabled/disabled filtering: menu.rs's own
// per-item enabled state (e.g. the truncated-tab-only Read-Only lock, or
// the empty-stack-gated Reopen Closed Tab) is not mirrored here, a
// documented trade-off (ROADMAP.md v0.6 C1's own acceptance criteria).
// Selecting a command in an invalid state (no active doc / truncated /
// read-only) is still safe by construction: main.ts's `dispatchMenuCommand`
// is the exact same function the native menu's `mojidori://menu` listener
// calls (see main.ts's wiring), so every guard already in that switch
// applies uniformly regardless of which UI triggered the id -- verified
// case-by-case as part of this change (see main.ts's switch, and the
// defensive no-active-doc guard added to its `print` case, the one bare
// case found).
import { installModal } from "./modal";
import { t } from "./i18n";
import type { PaletteCommand } from "./ipc";

export interface FuzzyMatch {
  /** Higher is better; only meaningful for ordering, not an absolute
   *  quality score. */
  score: number;
  /** Indices into `text` (UTF-16 code units, not code points -- see this
   *  module's own doc comment below) that matched, in ascending order. Not
   *  currently used to render highlighted characters, but kept as part of
   *  the match result since scoring already computes it -- a natural hook
   *  for that later. */
  indices: number[];
}

const CONSECUTIVE_RUN_WEIGHT = 1000;

/**
 * Case-insensitive subsequence fuzzy match: every character of `query`
 * must occur in `text` in order, though not necessarily adjacently (e.g.
 * "svas" matches "Save As…"). Returns `null` when `query` isn't a
 * subsequence of `text` at all; an empty `query` matches everything.
 *
 * Matching is greedy-leftmost -- each query character claims the earliest
 * position in `text` it can, scanning strictly after the previous
 * character's claim. This is a deliberate simplification (a "hand-rolled
 * subsequence fuzzy match", ROADMAP.md v0.6 C1) over an optimal subsequence
 * scorer, which would need dynamic programming to consider every possible
 * alignment; greedy-leftmost is simple, fast, and good enough for command
 * labels a few dozen characters long. It is not always optimal -- see
 * palette.test.ts's dedicated pin of this trade-off.
 *
 * Scoring rewards, in priority order: (1) consecutive matched characters
 * (a real substring run), weighted heavily enough
 * (`CONSECUTIVE_RUN_WEIGHT`) to dominate over (2) an earlier first-match
 * position, which only breaks ties among equal run counts.
 *
 * `indices` are UTF-16 code-unit offsets into `text`
 * (`String.prototype.indexOf`'s own unit), not Unicode scalar values --
 * mirrors this codebase's existing UTF-16-code-unit column convention
 * (e.g. statusbar.ts's cursor column). Command labels across this app's
 * four locales never contain characters outside the Basic Multilingual
 * Plane, so this never actually diverges from a code-point offset in
 * practice.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (query === "") return { score: 0, indices: [] };
  const hay = text.toLowerCase();
  const indices: number[] = [];
  let searchFrom = 0;
  for (const ch of query.toLowerCase()) {
    const found = hay.indexOf(ch, searchFrom);
    if (found === -1) return null;
    indices.push(found);
    searchFrom = found + 1;
  }
  let consecutivePairs = 0;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) consecutivePairs++;
  }
  return { score: consecutivePairs * CONSECUTIVE_RUN_WEIGHT - indices[0], indices };
}

export interface PaletteMatch extends PaletteCommand {
  match: FuzzyMatch;
}

/**
 * Filter `commands` to those whose label fuzzy-matches `query` (see
 * `fuzzyMatch`), sorted by match score descending. Ties keep `commands`'
 * original relative order (`Array.prototype.sort` is a stable sort). An
 * empty query matches every command (all scores equal, so the stable sort
 * leaves them in their original order) -- mirrors quickopen.ts
 * `filterRecent`'s empty-query behavior. Unlike `filterRecent`, there is no
 * result cap: the command set is small and fixed (LABELS, minus containers
 * -- about 50 entries), unlike an open-ended recent-files history, so
 * capping would only ever risk hiding a real match; the list scrolls
 * instead (styles.css `.palette-list`).
 */
export function filterAndSortCommands(
  commands: PaletteCommand[],
  query: string,
): PaletteMatch[] {
  const matches: PaletteMatch[] = [];
  for (const command of commands) {
    const match = fuzzyMatch(command.label, query);
    if (match) matches.push({ ...command, match });
  }
  matches.sort((a, b) => b.match.score - a.match.score);
  return matches;
}

/** Clamp `selected` back into `[0, length)` (0 for an empty list) after the
 *  list's length changes -- e.g. a query narrowing the match set out from
 *  under the previously selected index. */
export function clampSelectedIndex(selected: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(selected, 0), length - 1);
}

/** Move `current` by `direction` (+1/-1), clamped at both ends with no
 *  wraparound -- mirrors quickopen.ts's ArrowUp/ArrowDown handling
 *  exactly. */
export function moveSelection(current: number, direction: 1 | -1, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(current + direction, 0), length - 1);
}

/**
 * Show the Command Palette overlay: type to fuzzy-filter `commands`, arrow
 * keys to move the selection, Enter or click to run, Escape or an
 * away-click to dismiss. Structurally mirrors quickopen.ts's
 * `showQuickOpen` almost exactly (overlay/panel/input/list, the same
 * close/onAway/render shape) -- this is the same UI pattern with a
 * different data source, not a new one, so it stays DOM-untested like
 * quickopen.ts/goto.ts/confirm.ts (only the pure logic above is
 * unit-tested). `onRun` is called with the chosen command's id *after* the
 * overlay is already closed (same ordering as quickopen.ts), so a command
 * that itself opens another dialog never finds the palette still in the
 * DOM.
 */
export function showPalette(
  commands: PaletteCommand[],
  onRun: (id: string) => void,
): void {
  if (document.querySelector(".palette-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay";
  const panel = document.createElement("div");
  panel.className = "palette-panel";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t("palette.searchPlaceholder");
  panel.appendChild(input);

  const list = document.createElement("ul");
  list.className = "palette-list";
  panel.appendChild(list);

  let filtered: PaletteMatch[] = [];
  let selected = 0;

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const run = (id: string): void => {
    close();
    onRun(id);
  };

  const render = (): void => {
    filtered = filterAndSortCommands(commands, input.value);
    selected = clampSelectedIndex(selected, filtered.length);
    list.replaceChildren();
    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = t("palette.noResults");
      list.appendChild(empty);
      return;
    }
    filtered.forEach((entry, index) => {
      const item = document.createElement("li");
      item.className = index === selected ? "palette-item selected" : "palette-item";
      item.textContent = entry.label;
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => run(entry.id));
      list.appendChild(item);
    });
  };

  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selected = moveSelection(selected, 1, filtered.length);
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selected = moveSelection(selected, -1, filtered.length);
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = filtered[selected];
      if (pick) run(pick.id);
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { label: t("modal.commandPalette") });
  render();
  input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
