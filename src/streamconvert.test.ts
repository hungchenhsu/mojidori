import { afterEach, describe, expect, it, vi } from "vitest";

const streamConvertFile = vi.fn();
vi.mock("./ipc", () => ({
  streamConvertFile: (...args: unknown[]) =>
    (streamConvertFile as (...a: unknown[]) => unknown)(...args),
}));

const messageDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: (...args: unknown[]) => (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

const showLossySaveConfirm = vi.fn();
vi.mock("./lossysave", () => ({
  showLossySaveConfirm: (...args: unknown[]) =>
    (showLossySaveConfirm as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc, @tauri-apps/plugin-dialog, and ./lossysave are already mocked by
// the time ./streamconvert is evaluated — same pattern as
// streamreplace.test.ts/batchconvert.test.ts.
import { t } from "./i18n";
import { buildStreamConvertResultMessage, runStreamConvert } from "./streamconvert";

// Issue #328 (third review round): a conversion whose content-rename landed
// but whose parent-directory fsync could not be confirmed must still show
// up on this same success message, never as a separate failure path —
// mirrors streamreplace.test.ts's equivalent durability-warning coverage.
describe("buildStreamConvertResultMessage durability warning (issue #328)", () => {
  it("omits_the_durability_warning_note_when_null", () => {
    expect(buildStreamConvertResultMessage("UTF-8", null)).toBe(
      t("streamConvert.resultMessage", "UTF-8"),
    );
  });

  it("appends_the_durability_warning_note_when_present", () => {
    expect(buildStreamConvertResultMessage("UTF-8", "simulated fsync failure")).toBe(
      `${t("streamConvert.resultMessage", "UTF-8")} ${t("statusbar.durabilityWarning", "simulated fsync failure")}`,
    );
  });
});

// runStreamConvert(path, sourceEncoding, target, onConverted) has no
// editor/tabs dependency — it only touches the DOM (its own busy overlay),
// ./ipc, @tauri-apps/plugin-dialog, ./lossysave, and ./i18n — so it's
// driveable in jsdom exactly like showStreamReplace() in
// streamreplace.test.ts.

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold an IPC mock's response open across other synchronous
 *  actions before deciding when it "arrives". Mirrors
 *  streamreplace.test.ts/batchconvert.test.ts. */
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

function busyOverlay(): HTMLElement | null {
  return document.querySelector(".confirm-overlay");
}

const target = { value: "Big5", withBom: false };

describe("runStreamConvert", () => {
  afterEach(() => {
    // Belt-and-suspenders: the busy overlay has no close affordance of its
    // own (see streamconvert.ts), so nothing dismisses it except the flow's
    // own finally — a test that throws before that point could otherwise
    // leak an overlay into the next test.
    document.querySelectorAll(".confirm-overlay").forEach((el) => el.remove());
    streamConvertFile.mockReset();
    messageDialog.mockReset();
    showLossySaveConfirm.mockReset();
  });

  it("clean_conversion_shows_success_dialog_then_reloads", async () => {
    streamConvertFile.mockResolvedValue({
      written: true,
      bytesWritten: 42,
      lossyReport: null,
    });
    messageDialog.mockResolvedValue(undefined);
    const onConverted = vi.fn();

    await runStreamConvert("/big/file.txt", "UTF-8", target, onConverted);

    expect(streamConvertFile).toHaveBeenCalledTimes(1);
    expect(streamConvertFile).toHaveBeenCalledWith(
      "/big/file.txt",
      "UTF-8",
      "Big5",
      false,
      false,
    );
    const title = t("streamConvert.title", "file.txt");
    expect(messageDialog).toHaveBeenCalledWith(
      t("streamConvert.resultMessage", "Big5"),
      expect.objectContaining({ title, kind: "info" }),
    );
    expect(showLossySaveConfirm).not.toHaveBeenCalled();
    expect(onConverted).toHaveBeenCalledTimes(1);
    expect(busyOverlay()).toBeNull();
  });

  it("lossy_rejection_declined_does_not_retry_or_reload", async () => {
    const lossyReport = { unmappableCount: 3, samples: [], samplesTruncated: false };
    streamConvertFile.mockResolvedValue({
      written: false,
      bytesWritten: 0,
      lossyReport,
    });
    showLossySaveConfirm.mockResolvedValue(false);
    const onConverted = vi.fn();

    await runStreamConvert("/big/file.txt", "UTF-8", target, onConverted);

    expect(streamConvertFile).toHaveBeenCalledTimes(1);
    expect(showLossySaveConfirm).toHaveBeenCalledWith("Big5", lossyReport);
    expect(onConverted).not.toHaveBeenCalled();
    expect(messageDialog).not.toHaveBeenCalled();
    expect(busyOverlay()).toBeNull();
  });

  it("lossy_rejection_confirmed_retries_with_allow_lossy_true_then_reloads", async () => {
    const lossyReport = { unmappableCount: 3, samples: [], samplesTruncated: false };
    streamConvertFile
      .mockResolvedValueOnce({ written: false, bytesWritten: 0, lossyReport })
      .mockResolvedValueOnce({ written: true, bytesWritten: 99, lossyReport: null });
    showLossySaveConfirm.mockResolvedValue(true);
    messageDialog.mockResolvedValue(undefined);
    const onConverted = vi.fn();

    await runStreamConvert("/big/file.txt", "Big5", target, onConverted);

    expect(streamConvertFile).toHaveBeenCalledTimes(2);
    expect(streamConvertFile).toHaveBeenNthCalledWith(1, "/big/file.txt", "Big5", "Big5", false, false);
    expect(streamConvertFile).toHaveBeenNthCalledWith(2, "/big/file.txt", "Big5", "Big5", false, true);
    expect(onConverted).toHaveBeenCalledTimes(1);
    expect(busyOverlay()).toBeNull();
  });

  it("defensive_written_false_with_no_lossy_report_shows_failure_dialog", async () => {
    streamConvertFile.mockResolvedValue({
      written: false,
      bytesWritten: 0,
      lossyReport: null,
    });
    messageDialog.mockResolvedValue(undefined);
    const onConverted = vi.fn();

    await runStreamConvert("/big/file.txt", "UTF-8", target, onConverted);

    expect(onConverted).not.toHaveBeenCalled();
    expect(showLossySaveConfirm).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledWith(
      t("streamConvert.failedMessage"),
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("error_shows_message_dialog_and_does_not_reload", async () => {
    streamConvertFile.mockRejectedValue(new Error("disk exploded"));
    messageDialog.mockResolvedValue(undefined);
    const onConverted = vi.fn();

    await runStreamConvert("/big/file.txt", "UTF-8", target, onConverted);

    expect(onConverted).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledWith(
      "Error: disk exploded",
      expect.objectContaining({ kind: "error" }),
    );
    expect(busyOverlay()).toBeNull();
  });

  it("shows_a_busy_overlay_while_the_call_is_in_flight_and_removes_it_after", async () => {
    const call = deferred<{ written: boolean; bytesWritten: number; lossyReport: null }>();
    streamConvertFile.mockReturnValueOnce(call.promise);
    messageDialog.mockResolvedValue(undefined);

    const run = runStreamConvert("/big/file.txt", "UTF-8", target, vi.fn());
    await flush();

    expect(busyOverlay()).not.toBeNull();

    call.resolve({ written: true, bytesWritten: 1, lossyReport: null });
    await run;

    expect(busyOverlay()).toBeNull();
  });

  it("ignores_a_concurrent_invocation_while_one_is_already_in_flight", async () => {
    const call = deferred<{ written: boolean; bytesWritten: number; lossyReport: null }>();
    streamConvertFile.mockReturnValueOnce(call.promise);
    messageDialog.mockResolvedValue(undefined);
    const onConvertedA = vi.fn();
    const onConvertedB = vi.fn();

    const runA = runStreamConvert("/big/file.txt", "UTF-8", target, onConvertedA);
    await flush();
    // A second invocation while the first is still in flight must be a
    // pure no-op: no second IPC call, no second onConverted.
    const runB = runStreamConvert("/big/file.txt", "UTF-8", target, onConvertedB);
    await runB;

    expect(streamConvertFile).toHaveBeenCalledTimes(1);
    expect(onConvertedB).not.toHaveBeenCalled();

    call.resolve({ written: true, bytesWritten: 1, lossyReport: null });
    await runA;
    expect(onConvertedA).toHaveBeenCalledTimes(1);
  });
});
