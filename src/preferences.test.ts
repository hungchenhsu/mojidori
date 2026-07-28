// Preferences dialog Save button (src/preferences.ts showPreferencesDialog).
// Disk/IPC access goes through ./ipc and the native dialog plugin, both
// mocked here so this stays a pure DOM + state test — see CLAUDE.md
// "Frontend logic that doesn't need the WebView". Covers the v0.6 V2
// IPC-error-surfacing fix (audit #4): a failed savePreferences must not
// close the dialog as if the write succeeded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorHandle } from "./editor";
import type { Preferences } from "./ipc";

const loadPreferences = vi.fn<() => Promise<Preferences>>();
const savePreferences = vi.fn<(p: Preferences) => Promise<void>>();
const syncThemeMenu = vi.fn<(theme: string) => Promise<void>>();
const retitleMenu = vi.fn<(locale: string) => Promise<void>>();
const messageDialog = vi.fn<(msg: string, opts?: unknown) => Promise<void>>();

vi.mock("./ipc", () => ({
  loadPreferences: (...args: unknown[]) =>
    (loadPreferences as (...a: unknown[]) => unknown)(...args),
  savePreferences: (...args: unknown[]) =>
    (savePreferences as (...a: unknown[]) => unknown)(...args),
  syncThemeMenu: (...args: unknown[]) =>
    (syncThemeMenu as (...a: unknown[]) => unknown)(...args),
  retitleMenu: (...args: unknown[]) =>
    (retitleMenu as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) =>
    (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// preferences.ts is evaluated (same pattern as theme.test.ts).
import {
  adjustFontSize,
  initPreferences,
  showPreferencesDialog,
  toggleWordWrap,
} from "./preferences";

const fakeEditor = {
  setLineWrapping: vi.fn(),
  setShowInvisibles: vi.fn(),
  setIndentGuides: vi.fn(),
  setSuspiciousChars: vi.fn(),
  setLocale: vi.fn(),
} as unknown as EditorHandle;

function defaultPreferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    fontFamily: "",
    fontSize: 13,
    theme: "system",
    language: "system",
    defaultEncoding: "UTF-8",
    defaultBom: false,
    wordWrap: true,
    showInvisibles: false,
    indentGuides: true,
    suspiciousChars: true,
    indentWidth: 4,
    extensionEncodings: [],
    trimTrailingWhitespaceOnSave: false,
    ...overrides,
  };
}

// Lets a click handler's internal `await`s (savePreferences, then either
// close() or messageDialog()) settle before assertions run.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(async () => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
  loadPreferences.mockReset().mockResolvedValue(defaultPreferences());
  savePreferences.mockReset().mockResolvedValue(undefined);
  syncThemeMenu.mockReset().mockResolvedValue(undefined);
  retitleMenu.mockReset().mockResolvedValue(undefined);
  messageDialog.mockReset().mockResolvedValue(undefined);
  await initPreferences(fakeEditor);
});

describe("showPreferencesDialog Save button", () => {
  it("applies and persists on success, then closes the dialog", async () => {
    showPreferencesDialog();
    expect(document.querySelector(".prefs-overlay")).not.toBeNull();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".prefs-overlay")).toBeNull();
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and surfaces the error when the save fails", async () => {
    savePreferences.mockRejectedValue(new Error("disk full"));
    showPreferencesDialog();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // Not closed: a silent close here would tell the user the settings
    // were saved when the write actually failed.
    expect(document.querySelector(".prefs-overlay")).not.toBeNull();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog).toHaveBeenCalledWith(
      "Error: disk full",
      expect.objectContaining({ title: "Preferences save failed", kind: "error" }),
    );

    // Retrying (e.g. after fixing the underlying problem) still works from
    // the same, still-open dialog.
    savePreferences.mockResolvedValue(undefined);
    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();
    expect(document.querySelector(".prefs-overlay")).toBeNull();
  });

  it("still applies settings to the live UI even when persistence fails", async () => {
    savePreferences.mockRejectedValue(new Error("disk full"));
    showPreferencesDialog();

    const fontSizeInput = document.querySelector<HTMLInputElement>(
      ".prefs-dialog input[type='number']",
    )!;
    fontSizeInput.value = "20";
    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // applyAll() ran before the failed savePreferences — same "apply now,
    // persist best-effort" contract as the ambient toggles.
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe(
      "20px",
    );
  });

  it("does not touch syncThemeMenu's own best-effort failure handling", async () => {
    savePreferences.mockResolvedValue(undefined);
    syncThemeMenu.mockRejectedValue(new Error("menu unavailable"));
    showPreferencesDialog();

    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
    await flush();

    // syncThemeMenu's rejection stays swallowed by its own .catch(), not
    // routed through the new error path — only savePreferences failures
    // keep the dialog open.
    expect(document.querySelector(".prefs-overlay")).toBeNull();
    expect(messageDialog).not.toHaveBeenCalled();
  });

  // ROADMAP.md v0.7 Track C "trim trailing whitespace on save": the
  // Preferences dialog's own checkbox for the opt-in preference.
  describe("trim-trailing-whitespace-on-save checkbox", () => {
    // #303: the checkbox's documented scope limit (only active-tab saves
    // are trimmed, src/trimonsave.ts) must be visible in the dialog, not
    // just in code comments/docs.
    it("renders the scope-limit caption below the checkbox", async () => {
      showPreferencesDialog();
      const hint = document.querySelector(".prefs-row-hint");
      expect(hint).not.toBeNull();
      expect(hint!.textContent).toBe(
        "Only applies to a save whose document is still the active tab at the " +
          "moment of saving.",
      );
    });

    it("initializes unchecked, reflecting the default (false) preference", async () => {
      showPreferencesDialog();
      const checkbox = document.querySelector<HTMLInputElement>(
        ".prefs-dialog input[type='checkbox']",
      )!;
      expect(checkbox.checked).toBe(false);
    });

    it("reflects a loaded preference of true in the checkbox's initial state", async () => {
      loadPreferences.mockResolvedValue(
        defaultPreferences({ trimTrailingWhitespaceOnSave: true }),
      );
      await initPreferences(fakeEditor);
      showPreferencesDialog();
      const checkbox = document.querySelector<HTMLInputElement>(
        ".prefs-dialog input[type='checkbox']",
      )!;
      expect(checkbox.checked).toBe(true);
    });

    it("persists true once checked and saved", async () => {
      showPreferencesDialog();
      const checkbox = document.querySelector<HTMLInputElement>(
        ".prefs-dialog input[type='checkbox']",
      )!;
      checkbox.checked = true;

      document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
      await flush();

      expect(savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ trimTrailingWhitespaceOnSave: true }),
      );
    });

    it("persists false when left unchecked", async () => {
      showPreferencesDialog();

      document.querySelector<HTMLButtonElement>(".prefs-save")!.click();
      await flush();

      expect(savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ trimTrailingWhitespaceOnSave: false }),
      );
    });
  });
});

// v0.7 Track R: every savePreferences call site (the ambient toggles below
// and the dialog Save button above) is serialized through preferences.ts's
// prefsOps queue instead of firing IPC calls directly. Regression coverage
// for the same race PR #270 closed for recent files — see prefsOps's own
// doc comment in preferences.ts.
describe("prefsOps write serialization", () => {
  // A slow first write must not be overwritten on disk by a fast second
  // write: without a queue, both `savePreferences` calls fire concurrently
  // and whichever IPC response resolves first "wins" — here the second
  // (fresher) write would resolve fast while the first (staler) write is
  // still in flight, so an unserialized implementation lets the stale
  // write land last.
  it("a slow first write does not get overwritten by a fast second write", async () => {
    let resolveFirst!: () => void;
    savePreferences.mockImplementation(() => {
      if (savePreferences.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });

    adjustFontSize(1); // enqueues write #1 (slow), fontSize 13 -> 14
    toggleWordWrap(); // enqueues write #2 (fast), wordWrap true -> false

    // Let any (incorrectly) eager second call happen.
    await Promise.resolve();
    await Promise.resolve();
    expect(savePreferences).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(2);
    // Landed in enqueue order, so the final on-disk value (the second
    // call) carries both changes — never the first call's now-stale
    // snapshot, regardless of which IPC response actually settled first.
    expect(savePreferences.mock.calls[1][0]).toMatchObject({
      fontSize: 14,
      wordWrap: false,
    });
  });

  // Isolates the snapshot-freeze requirement from ordering: `current` is a
  // single mutable object the toggles below update in place, so a queued
  // write that re-reads `current` only when the queue gets to it (instead
  // of cloning it at persistPreferences()'s own call time) would let
  // write #1 pick up write #2's change too, since both toggles run
  // synchronously before either queued write actually executes.
  it("freezes each write's snapshot at its own call time, not when the queue runs it", async () => {
    savePreferences.mockResolvedValue(undefined);

    adjustFontSize(1); // must capture fontSize=14, wordWrap=true right now
    toggleWordWrap(); // mutates the same `current` before write #1 has run

    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(savePreferences.mock.calls[0][0]).toMatchObject({
      fontSize: 14,
      wordWrap: true,
    });
    expect(savePreferences.mock.calls[1][0]).toMatchObject({
      fontSize: 14,
      wordWrap: false,
    });
  });

  it("the dialog Save button and an ambient toggle share the same queue", async () => {
    let resolveFirst!: () => void;
    savePreferences.mockImplementation(() => {
      if (savePreferences.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });

    adjustFontSize(1); // enqueues write #1 (slow)

    showPreferencesDialog();
    document.querySelector<HTMLButtonElement>(".prefs-save")!.click();

    // The dialog's write must wait behind the ambient toggle's — it hasn't
    // even reached savePreferences yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(savePreferences).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".prefs-overlay")).not.toBeNull();

    resolveFirst();
    // Two full flush cycles: write #1 (ambient) must settle and hand off
    // the queue before write #2 (dialog) even starts, then the dialog's
    // own async click handler needs to resume past its `await` to close —
    // more hops than a single isolated write's flush() elsewhere in this
    // file needs.
    await flush();
    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".prefs-overlay")).toBeNull();
  });
});
