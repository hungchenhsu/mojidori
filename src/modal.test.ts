// Shared modal accessibility (src/modal.ts): dialog semantics, the Tab
// focus trap, and focus restoration when the overlay leaves the DOM.
import { afterEach, describe, expect, it } from "vitest";
import { showCloseConfirm } from "./confirm";
import { installModal, tabbableIn } from "./modal";

function flushObservers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function tab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function buildModal(html: string): { overlay: HTMLElement; dialog: HTMLElement } {
  const overlay = document.createElement("div");
  const dialog = document.createElement("div");
  dialog.innerHTML = html;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return { overlay, dialog };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tabbableIn", () => {
  it("skips disabled, hidden, and tabindex=-1 controls and collapses radio groups", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button id="a">a</button>
      <button disabled>x</button>
      <div hidden><button>y</button></div>
      <button tabindex="-1">z</button>
      <input type="hidden" />
      <input type="radio" name="g" value="1" id="r1" />
      <input type="radio" name="g" value="2" id="r2" checked />
      <input type="radio" name="h" value="1" id="h1" />
      <input type="radio" name="h" value="2" id="h2" />
      <select id="s"></select>
      <div tabindex="0" id="d"></div>`;
    expect(tabbableIn(root).map((el) => el.id)).toEqual(["a", "r2", "h1", "s", "d"]);
  });
});

describe("installModal", () => {
  it("applies dialog semantics and names", () => {
    const { overlay, dialog } = buildModal(`<p id="t">Title</p><p>Body</p>`);
    const body = dialog.querySelectorAll("p")[1] as HTMLElement;
    installModal(overlay, dialog, {
      role: "alertdialog",
      labelledBy: dialog.querySelector<HTMLElement>("#t")!,
      describedBy: body,
    });
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("t");
    expect(body.id).not.toBe("");
    expect(dialog.getAttribute("aria-describedby")).toBe(body.id);

    const second = buildModal("<button>x</button>");
    installModal(second.overlay, second.dialog, { label: "Go to Line" });
    expect(second.dialog.getAttribute("role")).toBe("dialog");
    expect(second.dialog.getAttribute("aria-label")).toBe("Go to Line");
  });

  it("wraps Tab and Shift+Tab within the dialog", () => {
    const { overlay, dialog } = buildModal(
      `<input id="first" /><button id="mid">m</button><button id="last">l</button>`,
    );
    installModal(overlay, dialog);
    const first = dialog.querySelector<HTMLElement>("#first")!;
    const mid = dialog.querySelector<HTMLElement>("#mid")!;
    const last = dialog.querySelector<HTMLElement>("#last")!;

    last.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // In the middle, the browser's own Tab order is left alone.
    mid.focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(tab(true).defaultPrevented).toBe(false);
  });

  it("pulls focus back into the dialog when it has escaped", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const { overlay, dialog } = buildModal(`<button id="a">a</button><button id="b">b</button>`);
    installModal(overlay, dialog);
    outside.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    outside.focus();
    tab(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("keeps Tab inert in a dialog with nothing to focus", () => {
    const { overlay, dialog } = buildModal(`<p>Working…</p>`);
    installModal(overlay, dialog);
    expect(tab().defaultPrevented).toBe(true);
  });

  it("lets only the topmost modal trap Tab", () => {
    const lower = buildModal(`<button id="l1">1</button><button id="l2">2</button>`);
    installModal(lower.overlay, lower.dialog);
    const upper = buildModal(`<button id="u1">1</button><button id="u2">2</button>`);
    installModal(upper.overlay, upper.dialog);
    upper.dialog.querySelector<HTMLElement>("#u2")!.focus();
    tab();
    expect(document.activeElement?.id).toBe("u1");
  });

  it("restores focus to the previously focused element on removal", async () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    const { overlay, dialog } = buildModal(`<button id="a">a</button>`);
    installModal(overlay, dialog);
    dialog.querySelector<HTMLElement>("#a")!.focus();
    overlay.remove();
    await flushObservers();
    expect(document.activeElement).toBe(editor);
    // The trap is gone with the overlay.
    expect(tab().defaultPrevented).toBe(false);
  });

  it("does not override focus the closing code moved deliberately", async () => {
    const editor = document.createElement("textarea");
    const other = document.createElement("button");
    document.body.append(editor, other);
    editor.focus();
    const { overlay, dialog } = buildModal(`<button>a</button>`);
    installModal(overlay, dialog);
    overlay.remove();
    other.focus();
    await flushObservers();
    expect(document.activeElement).toBe(other);
  });

  it("does not restore to an element that has since left the document", async () => {
    const editor = document.createElement("textarea");
    document.body.appendChild(editor);
    editor.focus();
    const { overlay, dialog } = buildModal(`<button>a</button>`);
    installModal(overlay, dialog);
    editor.remove();
    overlay.remove();
    await flushObservers();
    expect(document.activeElement).toBe(document.body);
  });

  it("is wired into the confirm dialogs", async () => {
    const choice = showCloseConfirm("notes.txt");
    const dialog = document.querySelector<HTMLElement>(".confirm-dialog")!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toContain(
      "notes.txt",
    );
    dialog.querySelector<HTMLButtonElement>(".confirm-primary")!.click();
    await expect(choice).resolves.toBe("save");
  });
});
