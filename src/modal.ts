// Shared modal-dialog accessibility for the app's DOM overlays (confirm
// dialogs, Go to Line, palettes, Find in Files, ...). Each overlay module
// still owns its own markup, keyboard shortcuts, and close paths; this only
// adds what every modal needs and none had consistently:
//   - dialog semantics: role, aria-modal, and an accessible name;
//   - a focus trap: Tab / Shift+Tab cycle within the dialog instead of
//     escaping into the editor behind the overlay, and Ctrl+Tab is held
//     back from switching the editor tab behind it;
//   - focus restoration: when the overlay leaves the DOM, focus returns to
//     whatever was focused before it opened — unless the closing code
//     already moved focus somewhere deliberately (e.g. Go to Line focusing
//     the editor at the target line).
// Detecting the removal with a MutationObserver means none of the many
// existing close paths (buttons, Escape, Enter, away-clicks, async
// completions) need to remember to call a cleanup function.

interface OpenModal {
  overlay: HTMLElement;
  restoreTo: HTMLElement | null;
}

/** Every installed modal whose observer hasn't torn it down yet. */
const openModals = new Set<OpenModal>();

export interface ModalOptions {
  /** "alertdialog" for confirmations that interrupt with a question. */
  role?: "dialog" | "alertdialog";
  /** Element whose text names the dialog (gets an id if it lacks one). */
  labelledBy?: HTMLElement;
  /** Accessible name when there is no visible title element. */
  label?: string;
  /** Element whose text describes the dialog (e.g. a confirm message). */
  describedBy?: HTMLElement;
}

const FOCUSABLE =
  'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])';

let nextId = 0;

function ensureId(el: HTMLElement): string {
  if (!el.id) el.id = `modal-ref-${++nextId}`;
  return el.id;
}

/** Elements Tab can actually land on inside `root`, in DOM order. Radios
 *  count once per group (the checked one, or the first if none is), which
 *  is how browsers sequence them. Exported for unit testing. */
export function tabbableIn(root: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = [];
  const radioGroups = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.tabIndex < 0) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    if (el.closest("[hidden], [inert]")) continue;
    if (el instanceof HTMLInputElement && el.type === "hidden") continue;
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
      if (radioGroups.has(el.name)) continue;
      const group = [
        ...root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].filter((r) => r.name === el.name);
      const representative = group.find((r) => r.checked) ?? group[0];
      radioGroups.add(el.name);
      result.push(representative);
      continue;
    }
    result.push(el);
  }
  return result;
}

/**
 * Make `dialog` (inside `overlay`) an accessible modal. Call right after
 * the overlay is attached to the document and before focusing its initial
 * control, so the restore target is whatever was focused before the modal
 * appeared. If the caller hasn't focused anything inside by the end of the
 * current task, the first tabbable control (or the dialog itself) gets
 * focus.
 */
export function installModal(
  overlay: HTMLElement,
  dialog: HTMLElement,
  options: ModalOptions = {},
): void {
  dialog.setAttribute("role", options.role ?? "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (options.labelledBy) {
    dialog.setAttribute("aria-labelledby", ensureId(options.labelledBy));
  } else if (options.label) {
    dialog.setAttribute("aria-label", options.label);
  }
  if (options.describedBy) {
    dialog.setAttribute("aria-describedby", ensureId(options.describedBy));
  }

  let previous =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null;
  // A modal opened by another modal's action (e.g. a Command Palette
  // command) arrives after that modal already left the DOM, so focus sits
  // on body. Inherit the departed modal's restore target instead of losing
  // it; its own observer will then see focus already placed and stand down.
  if (!previous) {
    for (const open of openModals) {
      if (!open.overlay.isConnected && open.restoreTo?.isConnected) {
        previous = open.restoreTo;
      }
    }
  }
  const entry: OpenModal = { overlay, restoreTo: previous };
  openModals.add(entry);

  // Move focus in if the caller doesn't within this task: keystrokes must
  // never keep reaching the editor behind an aria-modal dialog. Callers
  // that focus synchronously (most) are unaffected; ones that focus later
  // (setTimeout) simply move focus again.
  queueMicrotask(() => {
    if (!overlay.isConnected) return;
    const active = document.activeElement;
    if (active instanceof Node && dialog.contains(active)) return;
    const target = tabbableIn(dialog)[0];
    if (target) {
      target.focus();
    } else {
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      dialog.focus();
    }
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    // Only the topmost modal traps Tab (a confirm can open over a panel).
    const modals = document.querySelectorAll('[aria-modal="true"]');
    if (modals[modals.length - 1] !== dialog) return;
    // Ctrl+Tab cycles editor tabs (main.ts's window listener), which would
    // swap the document and move focus into the editor behind the dialog.
    // Swallow it here, in the capture phase, so it never gets that far.
    // Alt+Tab belongs to the OS.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.altKey) return;
    const items = tabbableIn(dialog);
    const active = document.activeElement;
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  const observer = new MutationObserver(() => {
    if (overlay.isConnected) return;
    observer.disconnect();
    openModals.delete(entry);
    document.removeEventListener("keydown", onKeyDown, true);
    const focusLost =
      document.activeElement === null || document.activeElement === document.body;
    if (focusLost && previous?.isConnected) previous.focus();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
