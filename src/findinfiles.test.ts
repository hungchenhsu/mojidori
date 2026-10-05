import { afterEach, describe, expect, it, vi } from "vitest";

const searchInFolder = vi.fn();
const scanReplaceInFolder = vi.fn();
const executeReplaceInFolder = vi.fn();
vi.mock("./ipc", () => ({
  searchInFolder: (...args: unknown[]) =>
    (searchInFolder as (...a: unknown[]) => unknown)(...args),
  scanReplaceInFolder: (...args: unknown[]) =>
    (scanReplaceInFolder as (...a: unknown[]) => unknown)(...args),
  executeReplaceInFolder: (...args: unknown[]) =>
    (executeReplaceInFolder as (...a: unknown[]) => unknown)(...args),
}));

const openDialog = vi.fn();
const confirmDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => (openDialog as (...a: unknown[]) => unknown)(...args),
  confirm: (...args: unknown[]) => (confirmDialog as (...a: unknown[]) => unknown)(...args),
}));

// vi.mock calls above are hoisted above this static import by vitest, so
// ./ipc and @tauri-apps/plugin-dialog are already mocked by the time
// ./findinfiles is evaluated — same pattern as batchconvert.test.ts.
import { showFindInFiles } from "./findinfiles";
import { t } from "./i18n";
import type {
  ReplaceExecuteEntry,
  ReplaceScanEntry,
  ReplaceScanReport,
  SearchMatch,
  SearchResults,
  SearchScanError,
} from "./ipc";
import { findHistory, pushFindTerm, replaceHistory } from "./searchhistory";

// showFindInFiles builds its own DOM (no framework) and never touches the
// WebView directly, so this is driveable in jsdom — same as
// batchconvert.test.ts drives showBatchConvert.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scanError(path: string, message = "Permission denied (os error 13)"): SearchScanError {
  return { path, message };
}

/** Builds a full `SearchResults` mock, defaulting to an exhaustive search
 *  (no `scanErrors`, one match). */
function results(
  matches: SearchMatch[],
  scanErrors: SearchScanError[] = [],
): SearchResults {
  return { matches, truncated: false, filesScanned: matches.length, scanErrors };
}

async function openAndSearch(
  matches: SearchMatch[],
  scanErrors: SearchScanError[] = [],
): Promise<HTMLElement> {
  openDialog.mockResolvedValue("/some/folder");
  searchInFolder.mockResolvedValue(results(matches, scanErrors));
  showFindInFiles(() => {});
  const panel = document.querySelector(".fif-panel") as HTMLElement;
  (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
  await flush();
  const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
  input.value = "needle";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await flush();
  return panel;
}

// Issue #130: a scan_errors-carrying result (a subdirectory that couldn't
// be listed, an entry whose metadata failed) used to be invisible in the
// UI — the panel had no way to show a search wasn't exhaustive. Mirrors
// batchconvert.test.ts's "incomplete-scan warning (issue #116)" suite,
// minus the confirm-dialog cases: find-in-files has no destructive
// execute step to gate, only the disclosure itself.
describe("showFindInFiles — incomplete-scan warning (issue #130)", () => {
  afterEach(() => {
    // Let the currently-open panel's own outside-click handler clean up
    // its document-level listener (mirrors a real dismiss, since
    // findinfiles.ts — unlike batchconvert.ts — has no document-level
    // keydown handler to fire an Escape at); the overlay removal is a
    // fallback in case nothing was open.
    document.dispatchEvent(new MouseEvent("mousedown"));
    document.querySelector(".fif-overlay")?.remove();
    searchInFolder.mockReset();
    openDialog.mockReset();
  });

  function scanErrorsContainer(panel: HTMLElement): HTMLElement {
    return panel.querySelector(".fif-scan-errors-container") as HTMLElement;
  }

  it("stays hidden when the search was exhaustive (no scanErrors)", async () => {
    const panel = await openAndSearch([{ path: "/a.txt", line: 1, preview: "needle" }]);
    const container = scanErrorsContainer(panel);
    expect(container.hidden).toBe(true);
    expect(container.querySelector("details")).toBeNull();
  });

  it("shows a disclosure naming the count and every unreadable path when scanErrors is non-empty", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [
        scanError("/some/folder/locked", "Permission denied (os error 13)"),
        scanError("/some/folder/noexec/hidden.txt"),
      ],
    );
    const container = scanErrorsContainer(panel);
    expect(container.hidden).toBe(false);
    const summaryEl = container.querySelector("summary");
    expect(summaryEl?.textContent).toBe(t("findInFiles.scanErrorsSummary", 2));
    const rows = container.querySelectorAll(".fif-scan-errors-row");
    expect(rows).toHaveLength(2);
    expect(container.querySelector(".fif-scan-errors-path")?.textContent).toBe("locked");
    expect(container.querySelector(".fif-scan-errors-message")?.textContent).toBe(
      "Permission denied (os error 13)",
    );
  });

  it("a fresh exhaustive search clears a previous search's error banner", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [scanError("/locked")],
    );
    expect(scanErrorsContainer(panel).hidden).toBe(false);

    searchInFolder.mockResolvedValueOnce(
      results([{ path: "/a.txt", line: 1, preview: "needle" }]),
    );
    const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(scanErrorsContainer(panel).hidden).toBe(true);
  });

  it("a new search hides the previous banner immediately, before the response arrives", async () => {
    const panel = await openAndSearch(
      [{ path: "/a.txt", line: 1, preview: "needle" }],
      [scanError("/locked")],
    );
    expect(scanErrorsContainer(panel).hidden).toBe(false);

    let resolveSearch!: (value: SearchResults) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(scanErrorsContainer(panel).hidden).toBe(true);

    resolveSearch(results([{ path: "/a.txt", line: 1, preview: "needle" }]));
    await flush();
  });
});

// Issue #215: plain find-in-files had no generation guard — unlike the
// replace-preview scan below (replaceGeneration, issue #95), an in-flight
// plain search whose query/case/regex/folder was changed before it
// resolved would still land unconditionally on resolve: stale matches
// rendered, the pre-change query pushed into search history, and
// scanErrors from the wrong search shown (or a stale error surfacing after
// a reject). These mirror the "superseded scan discarded unrendered" suite
// further down, but for runSearch instead of runReplaceScan.
describe("showFindInFiles — plain search generation guard (issue #215)", () => {
  afterEach(() => {
    document.dispatchEvent(new MouseEvent("mousedown"));
    document.querySelector(".fif-overlay")?.remove();
    searchInFolder.mockReset();
    openDialog.mockReset();
  });

  it("control: an uninterrupted search renders its results and is recorded in history", async () => {
    openDialog.mockResolvedValue("/some/folder");
    searchInFolder.mockResolvedValue(
      results([{ path: "/some/folder/a.txt", line: 1, preview: "hit" }]),
    );
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "control-query-215e";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    expect(panel.querySelectorAll(".fif-item")).toHaveLength(1);
    expect(findHistory()).toContain("control-query-215e");
  });

  it("a search superseded by a query change before it resolves is discarded — unrendered and not recorded in history", async () => {
    openDialog.mockResolvedValue("/some/folder");
    let resolveSearch!: (value: SearchResults) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "stale-query-215a";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    // Superseding query change before the in-flight search resolves.
    queryInput.value = "fresh-query-215a";
    queryInput.dispatchEvent(new Event("input"));

    resolveSearch(results([{ path: "/some/folder/a.txt", line: 1, preview: "stale hit" }]));
    await flush();

    expect(panel.querySelectorAll(".fif-item")).toHaveLength(0);
    expect(findHistory()).not.toContain("stale-query-215a");
  });

  it("a search superseded by a folder change before it resolves is discarded — unrendered and not recorded in history", async () => {
    openDialog.mockResolvedValueOnce("/folder-one-215b");
    let resolveSearch!: (value: SearchResults) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "folder-race-query-215b";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    // Superseding folder change before the in-flight search resolves.
    openDialog.mockResolvedValueOnce("/folder-two-215b");
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();

    resolveSearch(
      results([{ path: "/folder-one-215b/a.txt", line: 1, preview: "stale hit" }]),
    );
    await flush();

    expect(panel.querySelectorAll(".fif-item")).toHaveLength(0);
    expect(findHistory()).not.toContain("folder-race-query-215b");
  });

  it("a search superseded by a case-sensitivity change before it resolves is discarded — unrendered and not recorded in history", async () => {
    openDialog.mockResolvedValue("/some/folder");
    let resolveSearch!: (value: SearchResults) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "case-race-query-215c";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    // Superseding case-sensitivity change before the in-flight search
    // resolves.
    const caseBox = panel.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
    caseBox.checked = true;
    caseBox.dispatchEvent(new Event("change"));

    resolveSearch(results([{ path: "/some/folder/a.txt", line: 1, preview: "stale hit" }]));
    await flush();

    expect(panel.querySelectorAll(".fif-item")).toHaveLength(0);
    expect(findHistory()).not.toContain("case-race-query-215c");
  });

  it("a search superseded before it rejects does not surface the stale error", async () => {
    openDialog.mockResolvedValue("/some/folder");
    let rejectSearch!: (reason?: unknown) => void;
    searchInFolder.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSearch = reject;
      }),
    );
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "reject-race-query-215d";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    // Superseding query change before the in-flight search rejects.
    queryInput.value = "reject-race-query-215d-fresh";
    queryInput.dispatchEvent(new Event("input"));

    rejectSearch(new Error("stale boom"));
    await flush();

    const status = panel.querySelector(".fif-status") as HTMLElement;
    expect(status.textContent).toBe(t("findInFiles.searching"));
  });
});

// ROADMAP.md v0.5 Track S (frontend item): replace-in-files, layered onto
// the same panel above. The plain-find suites above already prove the base
// search flow is untouched (they still pass unmodified); the suites below
// cover the new replace field/button/preview/confirm/execute addition.
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

function replaceScanEntry(overrides: Partial<ReplaceScanEntry> = {}): ReplaceScanEntry {
  return {
    path: "/some/folder/a.txt",
    matchCount: 1,
    encoding: "UTF-8",
    fingerprint: { size: 1, mtime: 1 },
    lossy: false,
    skippedReason: null,
    ...overrides,
  };
}

function replaceExecEntry(overrides: Partial<ReplaceExecuteEntry> = {}): ReplaceExecuteEntry {
  return {
    path: "/some/folder/a.txt",
    replacedCount: 1,
    status: "ok",
    message: "",
    ...overrides,
  };
}

function replaceReport(
  entries: ReplaceScanEntry[],
  scanErrors: SearchScanError[] = [],
  truncated = false,
): ReplaceScanReport {
  return { entries, scanErrors, truncated };
}

function previewCheckboxes(panel: HTMLElement): HTMLInputElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLInputElement>(".fif-replace-item-checkbox input[type=checkbox]"),
  );
}

function previewRows(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(".fif-replace-item"));
}

/** Opens the panel, picks a folder, types `query` in the search field and
 *  `replacement` in the replace field (both via native "input" events, the
 *  same way a user typing fires them), then clicks "Replace in Files…" and
 *  flushes. Mirrors batchconvert.test.ts's openAndScan. */
async function openAndPreview(
  entries: ReplaceScanEntry[],
  scanErrors: SearchScanError[] = [],
  query = "needle",
  replacement = "repl",
  truncated = false,
): Promise<HTMLElement> {
  openDialog.mockResolvedValue("/some/folder");
  scanReplaceInFolder.mockResolvedValue(replaceReport(entries, scanErrors, truncated));
  showFindInFiles(() => {});
  const panel = document.querySelector(".fif-panel") as HTMLElement;
  (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
  await flush();
  const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
  queryInput.value = query;
  queryInput.dispatchEvent(new Event("input"));
  const replaceInput = panel.querySelector(".fif-replace-input") as HTMLInputElement;
  replaceInput.value = replacement;
  replaceInput.dispatchEvent(new Event("input"));
  (panel.querySelector(".fif-replace-button") as HTMLButtonElement).click();
  await flush();
  return panel;
}

function resetReplaceMocks(): void {
  document.dispatchEvent(new MouseEvent("mousedown"));
  document.querySelector(".fif-overlay")?.remove();
  searchInFolder.mockReset();
  scanReplaceInFolder.mockReset();
  executeReplaceInFolder.mockReset();
  openDialog.mockReset();
  confirmDialog.mockReset();
}

describe("showFindInFiles — replace field never affects plain search", () => {
  afterEach(resetReplaceMocks);

  it("typing a replacement value without clicking the replace button leaves a plain Enter-search identical", async () => {
    openDialog.mockResolvedValue("/some/folder");
    searchInFolder.mockResolvedValue(results([{ path: "/a.txt", line: 1, preview: "needle" }]));
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();

    const replaceInput = panel.querySelector(".fif-replace-input") as HTMLInputElement;
    replaceInput.value = "would-be replacement";
    replaceInput.dispatchEvent(new Event("input"));

    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "needle";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    expect(searchInFolder).toHaveBeenCalledWith("/some/folder", "needle", false, false);
    expect(scanReplaceInFolder).not.toHaveBeenCalled();
    expect(panel.querySelectorAll(".fif-item")).toHaveLength(1);
  });

  it("the replace execute action stays out of the DOM's visible state until a preview has run", async () => {
    openDialog.mockResolvedValue("/some/folder");
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    const actions = panel.querySelector(".fif-replace-actions") as HTMLElement;
    expect(actions.hidden).toBe(true);
  });
});

describe("showFindInFiles — replace-in-files dry-run preview", () => {
  afterEach(resetReplaceMocks);

  it("does nothing when the query is empty, even with a folder chosen", async () => {
    // lastFolder is module-level state that persists across showFindInFiles
    // calls within this file (the real "remember the last-picked folder
    // across panel re-opens" feature) — so a fresh panel can't be assumed
    // to start with no folder chosen once any earlier test in this file
    // has picked one. The query-empty half of the same guard
    // (`!lastFolder || input.value === ""`) is reliably testable per-test
    // regardless of that shared state, and exercises the same line.
    openDialog.mockResolvedValue("/some/folder");
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    (panel.querySelector(".fif-replace-button") as HTMLButtonElement).click();
    await flush();
    expect(scanReplaceInFolder).not.toHaveBeenCalled();
  });

  it("scans with the folder, query, case, regex, and replacement text", async () => {
    openDialog.mockResolvedValue("/some/folder");
    scanReplaceInFolder.mockResolvedValue(replaceReport([replaceScanEntry()]));
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "needle";
    queryInput.dispatchEvent(new Event("input"));
    const caseBox = panel.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
    caseBox.checked = true;
    caseBox.dispatchEvent(new Event("change"));
    const replaceInput = panel.querySelector(".fif-replace-input") as HTMLInputElement;
    replaceInput.value = "repl";
    replaceInput.dispatchEvent(new Event("input"));

    (panel.querySelector(".fif-replace-button") as HTMLButtonElement).click();
    await flush();

    expect(scanReplaceInFolder).toHaveBeenCalledWith(
      "/some/folder",
      "needle",
      true,
      false,
      "repl",
    );
  });

  it("renders one selectable, checked row per selectable entry", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt", matchCount: 3 }),
      replaceScanEntry({ path: "/some/folder/b.txt", matchCount: 1 }),
    ]);
    const rows = previewRows(panel);
    expect(rows).toHaveLength(2);
    const boxes = previewCheckboxes(panel);
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it("renders a skipped entry greyed out, unchecked, with no checkbox and a localized reason", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt" }),
      replaceScanEntry({
        path: "/some/folder/huge.txt",
        matchCount: 0,
        encoding: "",
        skippedReason: "File exceeds the 5 MiB search cap",
      }),
    ]);
    const rows = previewRows(panel);
    expect(rows).toHaveLength(2);
    expect(rows[1].className).toContain("fif-replace-item-skipped");
    expect(previewCheckboxes(panel)).toHaveLength(1); // only the selectable row
    expect(rows[1].textContent).toContain(t("findInFiles.skipReasonOversized"));
  });

  it("shows a lossy badge only on entries flagged lossy", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt", lossy: true }),
      replaceScanEntry({ path: "/some/folder/b.txt", lossy: false }),
    ]);
    const rows = previewRows(panel);
    expect(rows[0].querySelector(".fif-replace-item-lossy-badge")).not.toBeNull();
    expect(rows[1].querySelector(".fif-replace-item-lossy-badge")).toBeNull();
  });

  it("shows the report-wide summary line with file/match/skipped counts", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt", matchCount: 2 }),
      replaceScanEntry({ path: "/some/folder/b.txt", matchCount: 5 }),
      replaceScanEntry({
        path: "/some/folder/huge.txt",
        matchCount: 0,
        skippedReason: "File exceeds the 5 MiB search cap",
      }),
    ]);
    const summaryEl = panel.querySelector(".fif-replace-summary") as HTMLElement;
    expect(summaryEl.hidden).toBe(false);
    expect(summaryEl.textContent).toBe(t("findInFiles.replacePreviewSummary", 2, 7, 1));
  });

  it("shows the empty-report message when nothing matched", async () => {
    const panel = await openAndPreview([]);
    const summaryEl = panel.querySelector(".fif-replace-summary") as HTMLElement;
    expect(summaryEl.textContent).toBe(t("findInFiles.replaceNoMatches"));
  });

  // Critic P2: ReplaceScanReport.truncated means the scan stopped at its
  // entry cap — whole files may be missing from the preview, not just
  // matches within listed files. Swallowing it would let a user select
  // all, execute, read "N files succeeded", and believe the folder was
  // covered when part of it was never examined at all.
  it("appends the truncation notice to the summary when the scan report is truncated", async () => {
    const panel = await openAndPreview(
      [replaceScanEntry({ path: "/some/folder/a.txt", matchCount: 2 })],
      [],
      "needle",
      "repl",
      true,
    );
    const summaryEl = panel.querySelector(".fif-replace-summary") as HTMLElement;
    expect(summaryEl.hidden).toBe(false);
    expect(summaryEl.textContent).toContain(t("findInFiles.replacePreviewSummary", 1, 2, 0));
    expect(summaryEl.textContent).toContain(t("findInFiles.replacePreviewTruncated"));
    expect(summaryEl.querySelector(".fif-replace-truncated")).not.toBeNull();
  });

  it("shows no truncation notice when the scan report is not truncated", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    const summaryEl = panel.querySelector(".fif-replace-summary") as HTMLElement;
    expect(summaryEl.textContent).not.toContain(t("findInFiles.replacePreviewTruncated"));
    expect(summaryEl.querySelector(".fif-replace-truncated")).toBeNull();
  });

  it("reuses the existing fif-scan-errors-container disclosure for the replace-scan's scanErrors", async () => {
    const panel = await openAndPreview(
      [replaceScanEntry()],
      [{ path: "/some/folder/locked", message: "Permission denied (os error 13)" }],
    );
    const container = panel.querySelector(".fif-scan-errors-container") as HTMLElement;
    expect(container.hidden).toBe(false);
    expect(container.querySelector("summary")?.textContent).toBe(
      t("findInFiles.scanErrorsSummary", 1),
    );
  });

  it("enables the execute button with the selected count once a preview lands", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt" }),
      replaceScanEntry({ path: "/some/folder/b.txt" }),
    ]);
    const executeButton = panel.querySelector(".fif-replace-execute") as HTMLButtonElement;
    expect(executeButton.disabled).toBe(false);
    expect(executeButton.textContent).toBe(t("findInFiles.replaceExecuteButton", 2));
  });

  it("unchecking a row lowers the execute button's count", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt" }),
      replaceScanEntry({ path: "/some/folder/b.txt" }),
    ]);
    const executeButton = panel.querySelector(".fif-replace-execute") as HTMLButtonElement;
    const boxes = previewCheckboxes(panel);
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event("change"));
    expect(executeButton.textContent).toBe(t("findInFiles.replaceExecuteButton", 1));
  });
});

// Critic P3: in regex mode the replacement is always inserted literally —
// "$1" and other backreferences are never expanded (replaceinfiles.rs's v1
// regex::NoExpand scope). The preview shows files and counts, never the
// replaced text, so without an explicit hint a user would only discover
// the literal semantics after an unrecoverable folder-wide write.
describe("showFindInFiles — regex literal-replacement hint", () => {
  afterEach(resetReplaceMocks);

  function regexHint(panel: HTMLElement): HTMLElement {
    return panel.querySelector(".fif-replace-regex-hint") as HTMLElement;
  }

  function regexCheckbox(panel: HTMLElement): HTMLInputElement {
    // The controls row's second checkbox (first is match-case) — same
    // construction order as the panel builds them.
    return panel.querySelectorAll<HTMLInputElement>(
      '.fif-controls input[type="checkbox"]',
    )[1];
  }

  it("is hidden while regex mode is off (the default)", () => {
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    expect(regexHint(panel).hidden).toBe(true);
  });

  it("appears when regex mode is turned on, and carries the literal-$1 wording", () => {
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    const box = regexCheckbox(panel);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(regexHint(panel).hidden).toBe(false);
    expect(regexHint(panel).textContent).toBe(t("findInFiles.replaceRegexLiteralHint"));
  });

  it("hides again when regex mode is turned back off", () => {
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    const box = regexCheckbox(panel);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(regexHint(panel).hidden).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(regexHint(panel).hidden).toBe(true);
  });
});

describe("showFindInFiles — replace preview invalidation", () => {
  afterEach(resetReplaceMocks);

  it("editing the query after a preview clears it, requiring a rescan", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    expect(previewRows(panel)).toHaveLength(1);

    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "different";
    queryInput.dispatchEvent(new Event("input"));

    expect(previewRows(panel)).toHaveLength(0);
    const actions = panel.querySelector(".fif-replace-actions") as HTMLElement;
    expect(actions.hidden).toBe(true);
    const summaryEl = panel.querySelector(".fif-replace-summary") as HTMLElement;
    expect(summaryEl.hidden).toBe(true);
  });

  it("editing the replacement text after a preview clears it", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    const replaceInput = panel.querySelector(".fif-replace-input") as HTMLInputElement;
    replaceInput.value = "something else";
    replaceInput.dispatchEvent(new Event("input"));
    expect(previewRows(panel)).toHaveLength(0);
  });

  it("toggling case-sensitivity after a preview clears it", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    const caseBox = panel.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
    caseBox.dispatchEvent(new Event("change"));
    expect(previewRows(panel)).toHaveLength(0);
  });

  it("picking a new folder after a preview clears it", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    openDialog.mockResolvedValue("/another/folder");
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    expect(previewRows(panel)).toHaveLength(0);
  });

  it("a plain Enter-search after a preview (same query text) also invalidates it", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    searchInFolder.mockResolvedValue(results([]));
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    // No "input" event — the text is unchanged, only Enter is pressed.
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    expect(previewRows(panel)).toHaveLength(0);
    const actions = panel.querySelector(".fif-replace-actions") as HTMLElement;
    expect(actions.hidden).toBe(true);
  });

  it("a preview scan superseded by an input change before it resolves is discarded unrendered", async () => {
    openDialog.mockResolvedValue("/some/folder");
    const scan = deferred<ReplaceScanReport>();
    scanReplaceInFolder.mockReturnValueOnce(scan.promise);
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "needle";
    queryInput.dispatchEvent(new Event("input"));
    (panel.querySelector(".fif-replace-button") as HTMLButtonElement).click();
    await flush();

    // Superseding input change before the in-flight scan resolves.
    queryInput.value = "different";
    queryInput.dispatchEvent(new Event("input"));

    scan.resolve(replaceReport([replaceScanEntry()]));
    await flush();

    expect(previewRows(panel)).toHaveLength(0);
  });
});

describe("showFindInFiles — replace-in-files destructive confirm and execute", () => {
  afterEach(resetReplaceMocks);

  it("sends only the checked, non-skipped targets with their fingerprints, and the plain (non-lossy) confirm message", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({
        path: "/some/folder/a.txt",
        matchCount: 2,
        fingerprint: { size: 10, mtime: 1 },
      }),
      replaceScanEntry({
        path: "/some/folder/b.txt",
        matchCount: 3,
        fingerprint: { size: 20, mtime: 2 },
      }),
      replaceScanEntry({
        path: "/some/folder/huge.txt",
        matchCount: 0,
        skippedReason: "File exceeds the 5 MiB search cap",
        fingerprint: null,
      }),
    ]);
    const boxes = previewCheckboxes(panel);
    boxes[1].checked = false; // exclude b.txt
    boxes[1].dispatchEvent(new Event("change"));

    confirmDialog.mockResolvedValue(true);
    executeReplaceInFolder.mockResolvedValue([replaceExecEntry({ path: "/some/folder/a.txt" })]);
    (panel.querySelector(".fif-replace-execute") as HTMLButtonElement).click();
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith(
      t("findInFiles.replaceConfirmMessage", 1, 2),
      expect.objectContaining({ title: t("findInFiles.replaceButton") }),
    );
    expect(executeReplaceInFolder).toHaveBeenCalledWith(
      [{ path: "/some/folder/a.txt", expectedFingerprint: { size: 10, mtime: 1 } }],
      "needle",
      false,
      false,
      "repl",
      false,
    );
  });

  it("uses the lossy confirm message and passes allowLossy: true when a selected entry is lossy", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt", matchCount: 4, lossy: true }),
    ]);
    confirmDialog.mockResolvedValue(true);
    executeReplaceInFolder.mockResolvedValue([replaceExecEntry()]);
    (panel.querySelector(".fif-replace-execute") as HTMLButtonElement).click();
    await flush();

    expect(confirmDialog).toHaveBeenCalledWith(
      t("findInFiles.replaceConfirmMessageLossy", 1, 4, 1),
      expect.objectContaining({ title: t("findInFiles.replaceButton") }),
    );
    expect(executeReplaceInFolder).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
    );
  });

  it("cancelling the confirm dialog never calls executeReplaceInFolder and restores button state", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    confirmDialog.mockResolvedValue(false);
    const executeButton = panel.querySelector(".fif-replace-execute") as HTMLButtonElement;
    executeButton.click();
    await flush();

    expect(executeReplaceInFolder).not.toHaveBeenCalled();
    expect(executeButton.disabled).toBe(false);
    expect(executeButton.textContent).toBe(t("findInFiles.replaceExecuteButton", 1));
  });

  it("renders the result summary and clears the preview after a successful execute", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt", matchCount: 2 }),
    ]);
    confirmDialog.mockResolvedValue(true);
    executeReplaceInFolder.mockResolvedValue([
      replaceExecEntry({ path: "/some/folder/a.txt", replacedCount: 2, status: "ok" }),
    ]);
    searchInFolder.mockResolvedValue(results([]));
    (panel.querySelector(".fif-replace-execute") as HTMLButtonElement).click();
    await flush();

    const status = panel.querySelector(".fif-status") as HTMLElement;
    expect(status.textContent).toBe(t("findInFiles.replaceResultSummary", 1, 2, 0));
    expect(previewRows(panel)).toHaveLength(0);
    const actions = panel.querySelector(".fif-replace-actions") as HTMLElement;
    expect(actions.hidden).toBe(true);
  });

  it("classifies failures into separate labeled groups (changed_since_scan, lossy_blocked, io_error)", async () => {
    const panel = await openAndPreview([
      replaceScanEntry({ path: "/some/folder/a.txt" }),
      replaceScanEntry({ path: "/some/folder/b.txt" }),
      replaceScanEntry({ path: "/some/folder/c.txt" }),
      replaceScanEntry({ path: "/some/folder/d.txt" }),
    ]);
    confirmDialog.mockResolvedValue(true);
    executeReplaceInFolder.mockResolvedValue([
      replaceExecEntry({ path: "/some/folder/a.txt", status: "ok", replacedCount: 1 }),
      replaceExecEntry({ path: "/some/folder/b.txt", status: "changed_since_scan", replacedCount: 0 }),
      replaceExecEntry({ path: "/some/folder/c.txt", status: "lossy_blocked", replacedCount: 0 }),
      replaceExecEntry({ path: "/some/folder/d.txt", status: "io_error", replacedCount: 0 }),
    ]);
    searchInFolder.mockResolvedValue(results([]));
    (panel.querySelector(".fif-replace-execute") as HTMLButtonElement).click();
    await flush();

    const failuresEl = panel.querySelector(".fif-replace-failures-container") as HTMLElement;
    expect(failuresEl.hidden).toBe(false);
    const groups = failuresEl.querySelectorAll(".fif-replace-failures-group");
    expect(groups).toHaveLength(3);
    expect(failuresEl.textContent).toContain(t("findInFiles.replaceStatusChangedSinceScan"));
    expect(failuresEl.textContent).toContain(t("findInFiles.replaceStatusLossyBlocked"));
    expect(failuresEl.textContent).toContain(t("findInFiles.replaceStatusIoError"));
  });

  it("refreshes the plain match list from the current query after a successful execute", async () => {
    const panel = await openAndPreview([replaceScanEntry({ path: "/some/folder/a.txt" })]);
    confirmDialog.mockResolvedValue(true);
    executeReplaceInFolder.mockResolvedValue([replaceExecEntry()]);
    searchInFolder.mockResolvedValue(
      results([{ path: "/some/folder/a.txt", line: 1, preview: "repl" }]),
    );
    (panel.querySelector(".fif-replace-execute") as HTMLButtonElement).click();
    await flush();

    expect(searchInFolder).toHaveBeenCalledWith("/some/folder", "needle", false, false);
    expect(panel.querySelectorAll(".fif-item")).toHaveLength(1);
  });
});

describe("showFindInFiles — replace-in-files busy guard", () => {
  afterEach(resetReplaceMocks);

  function overlayEl(): HTMLElement | null {
    return document.querySelector(".fif-overlay");
  }

  it("the overlay cannot be closed while a preview scan is in flight", async () => {
    openDialog.mockResolvedValue("/some/folder");
    const scan = deferred<ReplaceScanReport>();
    scanReplaceInFolder.mockReturnValueOnce(scan.promise);
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "needle";
    queryInput.dispatchEvent(new Event("input"));
    (panel.querySelector(".fif-replace-button") as HTMLButtonElement).click();
    await flush();

    document.dispatchEvent(new MouseEvent("mousedown"));
    expect(overlayEl()).not.toBeNull();

    scan.resolve(replaceReport([]));
    await flush();
    document.dispatchEvent(new MouseEvent("mousedown"));
    expect(overlayEl()).toBeNull();
  });

  it("the overlay cannot be closed while execute is awaiting the confirm dialog or running", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    const confirmed = deferred<boolean>();
    confirmDialog.mockReturnValueOnce(confirmed.promise);
    const executeButton = panel.querySelector(".fif-replace-execute") as HTMLButtonElement;
    executeButton.click();
    await flush();

    expect(executeReplaceInFolder).not.toHaveBeenCalled();
    expect(executeButton.disabled).toBe(true);
    document.dispatchEvent(new MouseEvent("mousedown"));
    expect(overlayEl()).not.toBeNull();

    const exec = deferred<ReplaceExecuteEntry[]>();
    executeReplaceInFolder.mockReturnValueOnce(exec.promise);
    confirmed.resolve(true);
    await flush();

    document.dispatchEvent(new MouseEvent("mousedown"));
    expect(overlayEl()).not.toBeNull();

    exec.resolve([replaceExecEntry()]);
    await flush();
    document.dispatchEvent(new MouseEvent("mousedown"));
    expect(overlayEl()).toBeNull();
  });

  it("clicking execute again while a request is already in flight does not call executeReplaceInFolder twice", async () => {
    const panel = await openAndPreview([replaceScanEntry()]);
    confirmDialog.mockResolvedValue(true);
    const exec = deferred<ReplaceExecuteEntry[]>();
    executeReplaceInFolder.mockReturnValueOnce(exec.promise);
    const executeButton = panel.querySelector(".fif-replace-execute") as HTMLButtonElement;
    executeButton.click();
    await flush();
    executeButton.click(); // in-flight already (disabled, but click() still fires a click event)
    await flush();

    expect(executeReplaceInFolder).toHaveBeenCalledTimes(1);
    exec.resolve([replaceExecEntry()]);
    await flush();
  });
});

// Task: wire find-in-files' query/replace fields into the same MRU search
// history as the CM6 in-editor search panel (searchhistory.ts's shared
// `searchHistory` singleton, editor.ts's wireSearchHistory is the existing
// consumer). searchHistory is a module-level singleton, so — like
// `lastFolder` above — its state persists across every test in this file;
// once history-recording is wired in, the suites above (which all search
// for "needle" and replace with "repl") also push into it. Every assertion
// below therefore uses a distinctive marker string and checks containment /
// relative order rather than exact list contents, so it can't be confused
// by entries any other suite in this file has already recorded.
describe("showFindInFiles — search history integration", () => {
  afterEach(resetReplaceMocks);

  function datalistOptions(panel: HTMLElement, id: string): string[] {
    const list = panel.querySelector(`#${id}`) as HTMLDataListElement | null;
    return list ? Array.from(list.querySelectorAll("option")).map((o) => o.value) : [];
  }
  const findOptions = (panel: HTMLElement): string[] =>
    datalistOptions(panel, "mojidori-fif-find-history");
  const replaceOptions = (panel: HTMLElement): string[] =>
    datalistOptions(panel, "mojidori-fif-replace-history");

  it("wires the query field to a find-history datalist and the replace field to a replace-history datalist, with ids distinct from each other and from the CM6 editor panel's own datalists", () => {
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    const replaceInput = panel.querySelector(".fif-replace-input") as HTMLInputElement;

    expect(queryInput.getAttribute("list")).toBe("mojidori-fif-find-history");
    expect(replaceInput.getAttribute("list")).toBe("mojidori-fif-replace-history");
    expect(queryInput.getAttribute("list")).not.toBe(replaceInput.getAttribute("list"));
    expect(panel.querySelector("#mojidori-fif-find-history")).not.toBeNull();
    expect(panel.querySelector("#mojidori-fif-replace-history")).not.toBeNull();
    // editor.ts's wireSearchHistory uses "mojidori-find-history" /
    // "mojidori-replace-history" for the CM6 panel's own datalists — these
    // must never collide, even if both panels' DOM happened to coexist.
    expect(queryInput.getAttribute("list")).not.toBe("mojidori-find-history");
    expect(replaceInput.getAttribute("list")).not.toBe("mojidori-replace-history");
  });

  it("a term already in the shared history (as if recorded by the CM6 editor panel) appears in the query datalist on open", () => {
    pushFindTerm("editor-typed-term-8f2c1");
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    expect(findOptions(panel)).toContain("editor-typed-term-8f2c1");
  });

  it("records the searched query after a successful search, even with zero matches, into the store the CM6 panel also reads", async () => {
    openDialog.mockResolvedValue("/some/folder");
    searchInFolder.mockResolvedValue(results([]));
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;
    queryInput.value = "history-marker-search-9d1e";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    expect(findHistory()).toContain("history-marker-search-9d1e");
    expect(findOptions(panel)).toContain("history-marker-search-9d1e");
  });

  it("refreshes the datalist to newest-first order after each recorded search", async () => {
    openDialog.mockResolvedValue("/some/folder");
    searchInFolder.mockResolvedValue(results([]));
    showFindInFiles(() => {});
    const panel = document.querySelector(".fif-panel") as HTMLElement;
    (panel.querySelector(".fif-folder") as HTMLButtonElement).click();
    await flush();
    const queryInput = panel.querySelector('input[type="text"]') as HTMLInputElement;

    queryInput.value = "order-marker-one-77f3";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    queryInput.value = "order-marker-two-77f3";
    queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    const options = findOptions(panel);
    expect(options.indexOf("order-marker-two-77f3")).toBeLessThan(
      options.indexOf("order-marker-one-77f3"),
    );
  });

  it("records both query and replacement after a successfully initiated replace scan, into the stores the CM6 panel also reads", async () => {
    const panel = await openAndPreview(
      [replaceScanEntry()],
      [],
      "history-marker-query-4a7b",
      "history-marker-repl-4a7b",
    );

    expect(findHistory()).toContain("history-marker-query-4a7b");
    expect(replaceHistory()).toContain("history-marker-repl-4a7b");
    expect(findOptions(panel)).toContain("history-marker-query-4a7b");
    expect(replaceOptions(panel)).toContain("history-marker-repl-4a7b");
  });

  it("does not record an empty replacement text, but still records the query", async () => {
    const replaceCountBefore = replaceHistory().length;
    await openAndPreview([replaceScanEntry()], [], "history-marker-query-empty-rep-c3d9", "");

    expect(findHistory()).toContain("history-marker-query-empty-rep-c3d9");
    expect(replaceHistory()).toHaveLength(replaceCountBefore);
  });
});

describe("showFindInFiles — option chips", () => {
  it("names the Aa / .* toggles and mirrors their state on the chip", () => {
    showFindInFiles(() => {});
    try {
      const [caseLabel, regexLabel] = document.querySelectorAll<HTMLElement>(".fif-case");
      const caseBox = caseLabel.querySelector("input")!;
      const regexBox = regexLabel.querySelector("input")!;
      expect(caseBox.getAttribute("aria-label")).toBe("Match case");
      expect(regexBox.getAttribute("aria-label")).toBe("Regular expression");
      caseBox.click();
      expect(caseLabel.classList.contains("is-checked")).toBe(true);
      expect(regexLabel.classList.contains("is-checked")).toBe(false);
      caseBox.click();
      expect(caseLabel.classList.contains("is-checked")).toBe(false);
    } finally {
      document.querySelector(".fif-overlay")?.remove();
    }
  });
});
