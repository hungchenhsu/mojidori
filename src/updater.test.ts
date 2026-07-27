import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
// vi.mock's factory is hoisted above ordinary top-level declarations, so a
// plain `class FakeChannel {}` referenced inside it would hit a
// before-initialization error the way `invoke`'s bare `vi.fn()` doesn't;
// vi.hoisted lifts the class declaration itself above that hoist point.
const { FakeChannel } = vi.hoisted(() => ({
  FakeChannel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => (invoke as (...a: unknown[]) => unknown)(...args),
  Channel: FakeChannel,
}));

const confirmDialog = vi.fn();
const messageDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => (confirmDialog as (...a: unknown[]) => unknown)(...args),
  message: (...args: unknown[]) => (messageDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// @tauri-apps/api/core and @tauri-apps/plugin-dialog are already mocked by
// the time ./updater is evaluated — same pattern as streamconvert.test.ts.
import { checkForUpdatesAndPrompt, type UpdaterDeps } from "./updater";

const update = {
  rid: 7,
  currentVersion: "0.7.0",
  version: "0.8.0",
  rawJson: {},
};

function makeDeps(): {
  deps: UpdaterDeps;
  flushForExit: ReturnType<typeof vi.fn>;
  freezeForUpdate: ReturnType<typeof vi.fn>;
  unfreezeForUpdate: ReturnType<typeof vi.fn>;
} {
  const flushForExit = vi.fn().mockResolvedValue(true);
  const freezeForUpdate = vi.fn();
  const unfreezeForUpdate = vi.fn();
  return {
    deps: { flushForExit, freezeForUpdate, unfreezeForUpdate },
    flushForExit,
    freezeForUpdate,
    unfreezeForUpdate,
  };
}

beforeEach(() => {
  // Every dialog call in the real flow is followed by `.catch(() => {})`;
  // give both mocks a resolvable default so a test only needs to override
  // `confirmDialog`'s return value when the flow's branch actually depends
  // on it. `invoke`'s own default (a resolved `undefined`) covers the
  // `plugin:resources|close` calls a test doesn't care to assert on —
  // `mockResolvedValueOnce`/`mockImplementation` calls in an individual
  // test still take priority over this base.
  messageDialog.mockResolvedValue(undefined);
  confirmDialog.mockResolvedValue(false);
  invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  confirmDialog.mockReset();
  messageDialog.mockReset();
});

describe("checkForUpdatesAndPrompt — no update available", () => {
  it("silent: true shows no dialog", async () => {
    invoke.mockResolvedValueOnce(null); // plugin:updater|check
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: true });
    expect(invoke).toHaveBeenCalledWith("plugin:updater|check", {});
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("silent: false tells the user they're up to date", async () => {
    invoke.mockResolvedValueOnce(null);
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });
});

describe("checkForUpdatesAndPrompt — check() fails", () => {
  it("silent: true logs but shows no dialog", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("offline"));
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: true });
    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("silent: false shows a check-failed dialog", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("offline"));
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });

  // Issue #330: the updater feed simply not existing (an unpublished/draft
  // release — a 404, but indistinguishable at this point from a 403/500,
  // see updaterErrors.ts) was previously misreported as a network problem.
  // `plugin:updater|check` rejects with a plain string (see updaterErrors.ts'
  // module doc comment for why) — these three cases exercise the actual
  // literal each class produces.
  it("silent: false shows the neutral 'update info unavailable' dialog for a ReleaseNotFound rejection, not the network one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Exact Display string of tauri_plugin_updater::Error::ReleaseNotFound
    // (tauri-plugin-updater-2.10.1 src/error.rs:24-26), pinned Rust-side by
    // src-tauri/src/updater_errors.rs.
    invoke.mockRejectedValueOnce("Could not fetch a valid release JSON from the remote");
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(messageDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Update Info Unavailable" }),
    );
  });

  it("silent: false shows the network-failure dialog for a reqwest-shaped rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce("error sending request for url (https://example.com/latest.json)");
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Update Check Failed" }),
    );
  });

  it("silent: false shows a generic check-error dialog for an unrecognized (e.g. parse) rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce("missing field `version` at line 1 column 42");
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: false });
    expect(messageDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Update Check Error" }),
    );
  });
});

const bytesRid = 42;

/** Default invoke stub for the "update available" describe block: `check`
 *  resolves the update, `download` resolves a bytes resource id, `install`
 *  and `restart` resolve to nothing — matching the real plugin commands'
 *  return shapes (verified against tauri-apps/plugins-workspace v2
 *  plugins/updater/src/commands.rs: `download` returns `ResourceId`,
 *  `install` returns `()`). Tests override specific commands with
 *  `mockImplementationOnce`/rejects as needed. */
function stubInvokeHappyPath(calledCommands: string[]): void {
  invoke.mockImplementation(async (cmd: string) => {
    calledCommands.push(cmd);
    if (cmd === "plugin:updater|check") return update;
    if (cmd === "plugin:updater|download") return bytesRid;
    return undefined;
  });
}

describe("checkForUpdatesAndPrompt — update available", () => {
  it("declining (Later) never downloads, freezes, flushes, or installs — but does close the checked update's resource", async () => {
    invoke.mockResolvedValueOnce(update); // plugin:updater|check
    confirmDialog.mockResolvedValueOnce(false);
    const { deps, flushForExit, freezeForUpdate, unfreezeForUpdate } = makeDeps();

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2); // check, then resources|close
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin:resources|close", { rid: update.rid });
    expect(flushForExit).not.toHaveBeenCalled();
    // The freeze window starts after download, not at the initial confirm
    // — "Later" never reaches it at all.
    expect(freezeForUpdate).not.toHaveBeenCalled();
    expect(unfreezeForUpdate).not.toHaveBeenCalled();
  });

  it("accepting freezes before flush, flushes, installs, unfreezes, then relaunches — in that order", async () => {
    confirmDialog.mockResolvedValueOnce(true);
    const { deps, flushForExit, freezeForUpdate, unfreezeForUpdate } = makeDeps();

    const order: string[] = [];
    freezeForUpdate.mockImplementation(() => order.push("freeze"));
    unfreezeForUpdate.mockImplementation(() => order.push("unfreeze"));
    flushForExit.mockImplementation(async () => {
      order.push("flush");
      return true;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") {
        order.push("download");
        return bytesRid;
      }
      if (cmd === "plugin:updater|install") {
        order.push("install");
        return undefined;
      }
      if (cmd === "plugin:process|restart") {
        order.push("relaunch");
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(invoke).toHaveBeenCalledWith(
      "plugin:updater|download",
      expect.objectContaining({ rid: update.rid, onEvent: expect.any(FakeChannel) }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "plugin:updater|install",
      expect.objectContaining({
        updateRid: update.rid,
        bytesRid,
        // `true`: on Windows the plugin reads this itself to decide
        // whether the installer relaunches the app — see install()'s doc
        // comment in updater.ts. `false` here was the P2 regression a
        // Codex re-review caught (installed update never came back on
        // Windows).
        restartAfterInstall: true,
      }),
    );
    // freeze starts right before flush (not at download, not at the
    // initial confirm — see freezeForUpdate's doc comment) and unfreeze
    // runs — via try/finally — before relaunch even on the success path,
    // where it's harmless (relaunch either tears the process down or
    // fails into an ordinary, correctly-unfrozen app).
    expect(order).toEqual(["download", "freeze", "flush", "install", "unfreeze", "relaunch"]);
  });

  it("a failed download shows an error dialog, never freezes, flushes, or installs, and still closes the checked update's resource", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    const { deps, flushForExit, freezeForUpdate, unfreezeForUpdate } = makeDeps();
    const calledCommands: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calledCommands.push(cmd);
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") throw new Error("network error");
      if (cmd === "plugin:resources|close") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(flushForExit).not.toHaveBeenCalled();
    expect(freezeForUpdate).not.toHaveBeenCalled();
    expect(unfreezeForUpdate).not.toHaveBeenCalled();
    expect(calledCommands).toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:resources|close",
    ]);
  });

  it("when the hot-exit flush fails, defaults to NOT installing (Cancel) — nothing on disk changes, both resources are closed, the editor is unfrozen, and the user is asked again next check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true); // "Download and Restart"
    confirmDialog.mockResolvedValueOnce(false); // flush-failed dialog, default Cancel
    const { deps, flushForExit, freezeForUpdate, unfreezeForUpdate } = makeDeps();
    flushForExit.mockResolvedValueOnce(false);
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      // bytesRid first (it's the larger resource — the whole downloaded
      // package — and the one this fix specifically targets), then the
      // check's own update.rid — order matches promptAndInstall's source.
      "plugin:resources|close",
      "plugin:resources|close",
    ]);
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: bytesRid });
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: update.rid });
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    expect(confirmDialog).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ title: "Backup Failed" }),
    );
    // Cancel path: the editor must come back out of the frozen state —
    // this is what the try/finally around freeze/flush/install guarantees.
    expect(freezeForUpdate).toHaveBeenCalledTimes(1);
    expect(unfreezeForUpdate).toHaveBeenCalledTimes(1);
  });

  it("a rejected flush is treated the same as a resolved-false one (also defaults to Cancel, also closes both resources, also unfreezes)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    confirmDialog.mockResolvedValueOnce(false);
    const { deps, flushForExit, unfreezeForUpdate } = makeDeps();
    flushForExit.mockRejectedValueOnce(new Error("disk full"));
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).not.toContain("plugin:updater|install");
    expect(calledCommands).not.toContain("plugin:process|restart");
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: bytesRid });
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: update.rid });
    expect(unfreezeForUpdate).toHaveBeenCalledTimes(1);
  });

  it("when the hot-exit flush fails, still installs and relaunches if the user explicitly opts in (Install Anyway)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true); // "Download and Restart"
    confirmDialog.mockResolvedValueOnce(true); // flush-failed dialog: Install Anyway
    const { deps, flushForExit, unfreezeForUpdate } = makeDeps();
    flushForExit.mockResolvedValueOnce(false);
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands).toEqual([
      "plugin:updater|check",
      "plugin:updater|download",
      "plugin:updater|install",
      "plugin:process|restart",
    ]);
    // Unfreezing before relaunch is harmless on the eventual-success path
    // too — see the try/finally comment in updater.ts's promptAndInstall.
    expect(unfreezeForUpdate).toHaveBeenCalledTimes(1);
  });

  it("a failed install shows an error dialog, never relaunches, closes both resources, and unfreezes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    confirmDialog.mockResolvedValueOnce(true);
    const { deps, freezeForUpdate, unfreezeForUpdate } = makeDeps();
    const calledCommands: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calledCommands.push(cmd);
      if (cmd === "plugin:updater|check") return update;
      if (cmd === "plugin:updater|download") return bytesRid;
      if (cmd === "plugin:updater|install") throw new Error("installer failed");
      if (cmd === "plugin:resources|close") return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(consoleError).toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledTimes(1);
    expect(calledCommands).not.toContain("plugin:process|restart");
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: bytesRid });
    expect(invoke).toHaveBeenCalledWith("plugin:resources|close", { rid: update.rid });
    expect(freezeForUpdate).toHaveBeenCalledTimes(1);
    expect(unfreezeForUpdate).toHaveBeenCalledTimes(1);
  });

  it("on the macOS/Linux path where install actually returns, relaunch is called after it", async () => {
    confirmDialog.mockResolvedValueOnce(true);
    const { deps } = makeDeps();
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);

    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(calledCommands.indexOf("plugin:updater|install")).toBeLessThan(
      calledCommands.indexOf("plugin:process|restart"),
    );
  });
});

// ROADMAP.md D2, Codex re-review of PR #309: the startup background check
// and a manual File > Check for Updates… click can overlap — without a
// guard, two concurrent runs would race freeze/unfreeze (a single boolean
// in main.ts, not a refcount) and, on macOS/Linux, both could reach
// install/relaunch at once.
describe("checkForUpdatesAndPrompt — concurrent calls", () => {
  it("a second call made while the first is still running short-circuits — no duplicate download/install, and the manual caller is told a check is already in progress", async () => {
    const { deps: deps1 } = makeDeps();
    const { deps: deps2, flushForExit: flushForExit2 } = makeDeps();
    const calledCommands: string[] = [];
    stubInvokeHappyPath(calledCommands);
    // First call declines at the initial prompt — just needs to still be
    // "in flight" (inside its own await) when the second call fires;
    // confirmDialog's pending promise is exactly that in-flight window.
    let resolveConfirm!: (value: boolean) => void;
    confirmDialog.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    const first = checkForUpdatesAndPrompt(deps1, { silent: true });
    // Fired synchronously, before `first` has had a chance to resolve —
    // `first` is definitely still in flight (it's blocked on the
    // unresolved confirmDialog promise above).
    const second = checkForUpdatesAndPrompt(deps2, { silent: false });

    resolveConfirm(false); // let the first call finish (declines "Later")
    await Promise.all([first, second]);

    // "plugin:updater|check" appears exactly once — the second call never
    // reached its own checkForUpdate() at all; "plugin:resources|close"
    // is the first call's own decline-path cleanup (see the "declining"
    // describe block above), not a sign of a second flow having run.
    expect(calledCommands).toEqual(["plugin:updater|check", "plugin:resources|close"]);
    expect(flushForExit2).not.toHaveBeenCalled();
    expect(messageDialog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Check in Progress" }),
    );
  });

  it("a silent concurrent call is short-circuited without any dialog", async () => {
    const { deps: deps1 } = makeDeps();
    const { deps: deps2 } = makeDeps();
    let resolveConfirm!: (value: boolean) => void;
    confirmDialog.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    invoke.mockResolvedValueOnce(update); // the first call's own check

    const first = checkForUpdatesAndPrompt(deps1, { silent: true });
    const second = checkForUpdatesAndPrompt(deps2, { silent: true });

    resolveConfirm(false);
    await Promise.all([first, second]);

    expect(messageDialog).not.toHaveBeenCalled();
  });

  it("a check can run again once the first one has fully finished", async () => {
    invoke.mockResolvedValueOnce(null); // first: no update
    const { deps } = makeDeps();
    await checkForUpdatesAndPrompt(deps, { silent: true });

    invoke.mockResolvedValueOnce(null); // second: no update
    await checkForUpdatesAndPrompt(deps, { silent: true });

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
