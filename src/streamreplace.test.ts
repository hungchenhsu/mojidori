import { afterEach, describe, expect, it, vi } from "vitest";

const streamReplaceInFile = vi.fn();
vi.mock("./ipc", () => ({
  streamReplaceInFile: (...args: unknown[]) =>
    (streamReplaceInFile as (...a: unknown[]) => unknown)(...args),
}));

const messageDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// ./streamreplace is evaluated — same pattern as batchconvert.test.ts.
import { t } from "./i18n";
import { buildStreamReplaceResultMessage, showStreamReplace } from "./streamreplace";

// Issue #175: StreamReplaceReport.unmatchedRegionReencoded had no frontend
// consumer — buildStreamReplaceResultMessage is the pure message-composing
// half of that wiring (split from the DOM-driving runReplace exactly like
// lossysave.ts's buildLossySaveDialogContent), so it's covered directly
// without needing a WebView or the overlay DOM at all.
describe("buildStreamReplaceResultMessage (issue #175)", () => {
  it("appends_the_reencoded_note_when_unmatched_region_reencoded_is_true", () => {
    expect(buildStreamReplaceResultMessage(3, true, null)).toBe(
      `${t("streamReplace.resultMessage", 3)} ${t("streamReplace.unmatchedRegionReencodedNote")}`,
    );
  });

  it("omits_the_note_when_unmatched_region_reencoded_is_false", () => {
    expect(buildStreamReplaceResultMessage(3, false, null)).toBe(
      t("streamReplace.resultMessage", 3),
    );
  });
});

// Issue #328 (third review round): a replace whose content-rename landed
// but whose parent-directory fsync could not be confirmed must still show
// up on this same success message, never as a separate failure path.
describe("buildStreamReplaceResultMessage durability warning (issue #328)", () => {
  it("appends_the_durability_warning_note_when_present", () => {
    expect(buildStreamReplaceResultMessage(3, false, "simulated fsync failure")).toBe(
      `${t("streamReplace.resultMessage", 3)} ${t("statusbar.durabilityWarning", "simulated fsync failure")}`,
    );
  });

  it("omits_the_durability_warning_note_when_null", () => {
    expect(buildStreamReplaceResultMessage(3, false, null)).toBe(
      t("streamReplace.resultMessage", 3),
    );
  });

  it("appends_both_notes_together_when_both_apply", () => {
    expect(buildStreamReplaceResultMessage(3, true, "simulated fsync failure")).toBe(
      `${t("streamReplace.resultMessage", 3)} ${t("streamReplace.unmatchedRegionReencodedNote")} ${t("statusbar.durabilityWarning", "simulated fsync failure")}`,
    );
  });
});

// showStreamReplace(path, encoding, onReplaced) has no editor/tabs
// dependency — it only touches the DOM, ./ipc, @tauri-apps/plugin-dialog,
// and ./i18n — so it's driveable in jsdom exactly like showBatchConvert()
// in batchconvert.test.ts, with no untestable dependency to stub out.

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise plus its resolve/reject, exposed for manual settlement —
 *  lets a test hold an IPC mock's response open across other synchronous
 *  actions before deciding when it "arrives". Mirrors batchconvert.test.ts. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function overlayEl(): HTMLElement | null {
  return document.querySelector(".streamreplace-overlay");
}

function openPanel(onReplaced: () => void): HTMLElement {
  showStreamReplace("/big/file.txt", "UTF-8", onReplaced);
  return document.querySelector(".streamreplace-panel") as HTMLElement;
}

async function fillAndExecute(panel: HTMLElement, search = "foo"): Promise<void> {
  const searchInput = panel.querySelector(".streamreplace-search") as HTMLInputElement;
  searchInput.value = search;
  searchInput.dispatchEvent(new Event("input"));
  (panel.querySelector(".streamreplace-execute") as HTMLButtonElement).click();
  await flush();
}

// Issue #98 (P3): runReplace called close() from inside the try block, while
// busy was still true — close()'s own busy guard (added for #97, so a
// mid-run close can't fake a cancel) silently blocked it. finally then
// cleared busy but never retried close(), so a *successful* replace left
// the overlay open and Execute re-enabled. The fix threads a `succeeded`
// flag through runReplace and only closes in `finally`, after busy is
// cleared — see streamreplace.ts's runReplace.
describe("showStreamReplace — panel closes after busy clears (issue #98)", () => {
  afterEach(() => {
    // Let the currently-open panel's own Escape handler clean up its
    // document-level listeners (mirrors a real dismiss); the overlay
    // removal is a fallback in case nothing was open. Same pattern as
    // batchconvert.test.ts's busy-guard describe block.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelector(".streamreplace-overlay")?.remove();
    streamReplaceInFile.mockReset();
    messageDialog.mockReset();
  });

  it("overlay_closes_after_successful_replace", async () => {
    streamReplaceInFile.mockResolvedValue({ replacements: 3, bytesWritten: 42 });
    messageDialog.mockResolvedValue(undefined);
    const onReplaced = vi.fn();
    const panel = openPanel(onReplaced);

    await fillAndExecute(panel);

    const title = t("streamReplace.title", "file.txt");
    expect(messageDialog).toHaveBeenCalledWith(
      t("streamReplace.resultMessage", 3),
      expect.objectContaining({ title, kind: "info" }),
    );
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(overlayEl()).toBeNull();
  });

  // Issue #175: the report's unmatchedRegionReencoded flag reaches the
  // actual blocking dialog the user sees, not just buildStreamReplaceResultMessage
  // in isolation — end-to-end through runReplace's IPC call.
  it("overlay_dialog_includes_reencoded_note_when_report_flags_it", async () => {
    streamReplaceInFile.mockResolvedValue({
      replacements: 3,
      bytesWritten: 42,
      unmatchedRegionReencoded: true,
    });
    messageDialog.mockResolvedValue(undefined);
    const onReplaced = vi.fn();
    const panel = openPanel(onReplaced);

    await fillAndExecute(panel);

    const title = t("streamReplace.title", "file.txt");
    expect(messageDialog).toHaveBeenCalledWith(
      `${t("streamReplace.resultMessage", 3)} ${t("streamReplace.unmatchedRegionReencodedNote")}`,
      expect.objectContaining({ title, kind: "info" }),
    );
    expect(overlayEl()).toBeNull();
  });

  it("overlay_stays_open_on_zero_matches", async () => {
    streamReplaceInFile.mockResolvedValue({ replacements: 0, bytesWritten: 0 });
    const onReplaced = vi.fn();
    const panel = openPanel(onReplaced);

    await fillAndExecute(panel);

    expect(overlayEl()).not.toBeNull();
    expect(messageDialog).not.toHaveBeenCalled();
    expect(onReplaced).not.toHaveBeenCalled();
    const status = panel.querySelector(".streamreplace-status") as HTMLElement;
    expect(status.textContent).toBe(t("streamReplace.resultMessage", 0));
    const executeButton = panel.querySelector(".streamreplace-execute") as HTMLButtonElement;
    expect(executeButton.disabled).toBe(false);
  });

  it("overlay_stays_open_on_error", async () => {
    streamReplaceInFile.mockRejectedValue(new Error("disk exploded"));
    const onReplaced = vi.fn();
    const panel = openPanel(onReplaced);

    await fillAndExecute(panel);

    expect(overlayEl()).not.toBeNull();
    expect(onReplaced).not.toHaveBeenCalled();
    const status = panel.querySelector(".streamreplace-status") as HTMLElement;
    expect(status.textContent).toBe("Error: disk exploded");
    const executeButton = panel.querySelector(".streamreplace-execute") as HTMLButtonElement;
    expect(executeButton.disabled).toBe(false);
  });

  it("overlay_cannot_be_closed_mid_run", async () => {
    const call = deferred<{ replacements: number; bytesWritten: number }>();
    streamReplaceInFile.mockReturnValueOnce(call.promise);
    messageDialog.mockResolvedValue(undefined);
    const onReplaced = vi.fn();
    const panel = openPanel(onReplaced);

    const searchInput = panel.querySelector(".streamreplace-search") as HTMLInputElement;
    searchInput.value = "foo";
    searchInput.dispatchEvent(new Event("input"));
    (panel.querySelector(".streamreplace-execute") as HTMLButtonElement).click();
    await flush();

    // streamReplaceInFile is in flight (the deferred promise hasn't
    // settled) — neither close path may remove the overlay.
    expect(overlayEl()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlayEl()).not.toBeNull();
    overlayEl()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(overlayEl()).not.toBeNull();

    call.resolve({ replacements: 1, bytesWritten: 7 });
    await flush();

    // The run finished successfully (busy cleared, succeeded closes) —
    // the overlay is gone without needing another Escape/click.
    expect(overlayEl()).toBeNull();
    expect(onReplaced).toHaveBeenCalledTimes(1);
  });
});
