// Minimal "Go to Line" prompt. Accepts either a bare line number ("123")
// or "line:column" ("123:45") — see parseGoToInput below for the exact
// grammar this input box accepts.
import { installModal } from "./modal";
import { t } from "./i18n";

/** Parsed result of a Go to Line input. `column` is `null` when the input
 *  named only a line (a bare "123", or "123:" with an empty column) —
 *  callers treat that the same as the pre-existing line-only behavior
 *  (jump to line start). Both `line` and `column` are 1-based, matching
 *  statusbar.ts's Ln/Col display (see editor.ts's `updateListener`:
 *  `head - line.from + 1` computes the same 1-based column from a 0-based
 *  offset into the line). */
export interface GoToTarget {
  line: number;
  column: number | null;
}

// Line is required; an optional ":column" suffix may be a bare trailing
// colon (empty column, e.g. "123:") or a colon followed by digits
// ("123:45"). A colon with no leading line ("`:45`"), empty input, or any
// non-digit character anywhere simply fails to match.
const GOTO_INPUT_PATTERN = /^(\d+)(?::(\d+)?)?$/;

/** Parse a Go to Line input box value into a target, or `null` if the
 *  input is invalid: empty, non-numeric, a bare ":column" with no line, a
 *  zero or negative line/column, or a number so large it overflows to
 *  `Infinity`. Surrounding whitespace is trimmed first; anything else the
 *  regex doesn't recognize (stray characters, extra colons) is invalid
 *  rather than leniently truncated. */
export function parseGoToInput(value: string): GoToTarget | null {
  const match = GOTO_INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const line = Number.parseInt(match[1], 10);
  if (!Number.isFinite(line) || line <= 0) return null;
  if (match[2] === undefined) return { line, column: null };
  const column = Number.parseInt(match[2], 10);
  if (!Number.isFinite(column) || column <= 0) return null;
  return { line, column };
}

export function showGoToLine(
  onGo: (line: number, column: number | null) => void,
): void {
  if (document.querySelector(".goto-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "goto-overlay";
  const panel = document.createElement("div");
  panel.className = "goto-panel";

  const input = document.createElement("input");
  input.type = "text";
  // Not "numeric": the "line:column" syntax needs a colon, which numeric
  // virtual keyboards on mobile/tablet WebViews typically don't offer.
  input.inputMode = "text";
  input.placeholder = t("goto.placeholder");
  panel.appendChild(input);

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = parseGoToInput(input.value);
      close();
      if (target) onGo(target.line, target.column);
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { label: t("modal.goToLine") });
  input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
