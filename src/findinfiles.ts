// Find-in-files panel: pick a folder, type a query, click a result to jump.
// Also hosts replace-in-files (ROADMAP.md v0.5 Track S): an optional
// replacement field + "Replace in Files…" button below the search
// controls. Leaving the replacement field empty and never clicking that
// button is exactly the pre-existing find-in-files flow above, byte for
// byte — every replace-specific addition below is gated behind its own
// button/state and never runs unless the user actually engages it.
//
// The dry-run preview (scanReplaceInFolder) and the destructive execute
// (executeReplaceInFolder) are a two-phase flow mirroring
// batchconvert.ts's scan/convert pattern exactly: a per-file checkbox
// report, any input change voids it (rescan required), and a
// batch-convert-strength native confirm — naming the lossy/HTML-numeric-
// character-reference risk explicitly when it applies — gates the actual
// write. Pure classification/formatting logic (preview rows, the confirm
// message, the post-execute summary, selection -> execute() params) lives
// in replaceinfiles-ui.ts so it's unit-testable without a DOM; this module
// is just the wiring.
import { installModal } from "./modal";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import {
  executeReplaceInFolder,
  scanReplaceInFolder,
  searchInFolder,
  type ReplaceExecuteEntry,
  type ReplaceScanEntry,
  type SearchMatch,
  type SearchScanError,
} from "./ipc";
import {
  buildPreviewRows,
  buildReplaceConfirmMessage,
  previewTotals,
  selectedReplaceTargets,
  selectionTotals,
  summarizeReplaceResults,
  type ReplaceResultGroup,
} from "./replaceinfiles-ui";
import { findHistory, pushFindTerm, pushReplaceTerm, replaceHistory } from "./searchhistory";

let lastFolder: string | null = null;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

// MRU search-history dropdowns for the query/replacement fields below,
// backed by the exact same store (searchhistory.ts's shared `searchHistory`
// singleton, "mojidori.searchHistory.v1" in localStorage) that the CM6
// in-editor search panel's wireSearchHistory (editor.ts) reads and writes —
// a term searched or replaced in either panel becomes selectable in the
// other's dropdown, with no separate wiring needed here beyond calling the
// same imported functions. Ids are namespaced "fif-" (distinct from
// editor.ts's own "mojidori-find-history" / "mojidori-replace-history") so both
// panels' datalists never collide even if their DOM happened to coexist.
const FIND_DATALIST_ID = "mojidori-fif-find-history";
const REPLACE_DATALIST_ID = "mojidori-fif-replace-history";

/** Refills `list`'s `<option>`s from `terms` — mirrors editor.ts's
 *  populateDatalist for the CM6 search panel's own MRU dropdowns. */
function populateDatalist(list: HTMLDataListElement, terms: readonly string[]): void {
  list.replaceChildren(
    ...terms.map((term) => {
      const option = document.createElement("option");
      option.value = term;
      return option;
    }),
  );
}

/** The exact scan parameters a replace preview was produced from — bound to
 *  the report's lifecycle (set together with the preview, cleared together
 *  with it) so execute can only ever act on what the user actually
 *  reviewed, never on the controls' possibly-since-edited live values
 *  (mirrors batchconvert.ts's `ScanParams`/`lastScanParams`, issue #95). */
interface ReplaceParams {
  folder: string;
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  replacement: string;
}

export function showFindInFiles(
  onPick: (path: string, line: number) => void,
): void {
  if (document.querySelector(".fif-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "fif-overlay";
  const panel = document.createElement("div");
  panel.className = "fif-panel";

  const controls = document.createElement("div");
  controls.className = "fif-controls";

  const folderButton = document.createElement("button");
  folderButton.className = "fif-folder";
  folderButton.textContent = lastFolder
    ? basename(lastFolder)
    : t("findInFiles.chooseFolder");
  if (lastFolder) folderButton.title = lastFolder;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t("findInFiles.searchPlaceholder");

  const caseLabel = document.createElement("label");
  caseLabel.className = "fif-case";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseLabel.appendChild(caseBox);
  caseLabel.appendChild(document.createTextNode("Aa"));
  caseLabel.title = t("findInFiles.matchCase");

  const regexLabel = document.createElement("label");
  regexLabel.className = "fif-case";
  const regexBox = document.createElement("input");
  regexBox.type = "checkbox";
  regexLabel.appendChild(regexBox);
  regexLabel.appendChild(document.createTextNode(".*"));
  regexLabel.title = t("findInFiles.regex");

  controls.appendChild(folderButton);
  controls.appendChild(input);
  controls.appendChild(caseLabel);
  controls.appendChild(regexLabel);
  panel.appendChild(controls);

  // Replace-in-files controls (ROADMAP.md v0.5 Track S): a second row below
  // the search controls, sharing this same query/case/regex state. Never
  // touched, never rendered differently, when the user only ever uses plain
  // find above.
  const replaceRow = document.createElement("div");
  replaceRow.className = "fif-replace-row";
  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "fif-replace-input";
  replaceInput.placeholder = t("streamReplace.replacePlaceholder");
  const replaceButton = document.createElement("button");
  replaceButton.className = "fif-replace-button";
  replaceButton.textContent = t("findInFiles.replaceButton");
  replaceRow.appendChild(replaceInput);
  replaceRow.appendChild(replaceButton);
  // Visible only while regex mode is on: replacement is always inserted
  // literally — "$1" and other backreferences are never expanded
  // (replaceinfiles.rs's v1 regex::NoExpand scope). Without this, a user
  // typing "$1" and expecting a captured group would only discover the
  // literal semantics after an unrecoverable folder-wide write; the
  // preview lists files and counts, not replaced text, so nothing else in
  // this flow would have surfaced it.
  const regexHint = document.createElement("div");
  regexHint.className = "fif-replace-regex-hint";
  regexHint.textContent = t("findInFiles.replaceRegexLiteralHint");
  regexHint.hidden = !regexBox.checked;
  replaceRow.appendChild(regexHint);
  panel.appendChild(replaceRow);

  const findDatalist = document.createElement("datalist");
  findDatalist.id = FIND_DATALIST_ID;
  const replaceDatalist = document.createElement("datalist");
  replaceDatalist.id = REPLACE_DATALIST_ID;
  panel.append(findDatalist, replaceDatalist);
  populateDatalist(findDatalist, findHistory());
  populateDatalist(replaceDatalist, replaceHistory());
  input.setAttribute("list", FIND_DATALIST_ID);
  replaceInput.setAttribute("list", REPLACE_DATALIST_ID);

  const status = document.createElement("div");
  status.className = "fif-status";
  panel.appendChild(status);

  // Issue #130: a folder/entry the walk couldn't read means `matches`
  // below may be missing whatever that path contained. This must stay
  // visible above the results list — not buried where it might go
  // unnoticed — and use <details>/<summary> so the path list is
  // inspectable without cluttering the common (no errors) case. Mirrors
  // batchconvert.ts's identical disclosure for issue #116, styled with
  // this panel's own `.fif-*` classes rather than the batch panel's.
  //
  // Shared verbatim by the replace-preview scan below: ReplaceScanReport's
  // `scanErrors` is the exact same `SearchScanError[]` shape as
  // SearchResults', so one disclosure serves both flows rather than
  // duplicating it (task requirement: reuse this element as-is).
  const scanErrorsEl = document.createElement("div");
  scanErrorsEl.className = "fif-scan-errors-container";
  scanErrorsEl.hidden = true;
  panel.appendChild(scanErrorsEl);

  // Post-execute failure classification (changed_since_scan / lossy_blocked
  // / io_error / …), populated only after a replace execute that had at
  // least one non-"ok" result. Always expanded (unlike scanErrorsEl's
  // <details>) — this is the direct outcome of an action the user just
  // took, not an incidental side-channel warning.
  const failuresEl = document.createElement("div");
  failuresEl.className = "fif-replace-failures-container";
  failuresEl.hidden = true;
  panel.appendChild(failuresEl);

  // Persistent report-wide breakdown ("N files, M occurrences[, K
  // skipped]") for the current replace preview — mirrors
  // batchconvert.ts's `.batchconvert-summary`. Hidden whenever there is no
  // active preview.
  const previewSummaryEl = document.createElement("div");
  previewSummaryEl.className = "fif-replace-summary";
  previewSummaryEl.hidden = true;
  panel.appendChild(previewSummaryEl);

  const list = document.createElement("ul");
  list.className = "fif-list";
  panel.appendChild(list);

  // Always in the DOM (like batchconvert.ts's `.batchconvert-actions`), but
  // hidden until a replace preview exists — a plain-find-only session never
  // sees it.
  const actions = document.createElement("div");
  actions.className = "fif-replace-actions";
  actions.hidden = true;
  const executeButton = document.createElement("button");
  executeButton.className = "fif-replace-execute";
  executeButton.textContent = t("findInFiles.replaceExecuteButton", 0);
  executeButton.disabled = true;
  actions.appendChild(executeButton);
  panel.appendChild(actions);

  const close = (): void => {
    // A running replace preview scan or execute cannot be cancelled — the
    // Rust command runs to completion regardless of whether this panel is
    // still open to show the outcome (batchconvert.ts issue #97's same
    // reasoning, applied here). Plain find has no such guard: a search has
    // no destructive consequence to protect, so closing mid-search stays
    // exactly as before.
    if (busyReplace) return;
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };

  const renderMatches = (matches: SearchMatch[]): void => {
    list.replaceChildren();
    for (const match of matches) {
      const item = document.createElement("li");
      item.className = "fif-item";
      const location = document.createElement("span");
      location.className = "fif-location";
      location.textContent = `${basename(match.path)}:${match.line}`;
      location.title = match.path;
      const preview = document.createElement("span");
      preview.className = "fif-preview";
      preview.textContent = match.preview;
      item.appendChild(location);
      item.appendChild(preview);
      item.addEventListener("click", () => {
        close();
        onPick(match.path, match.line);
      });
      list.appendChild(item);
    }
  };

  // Issue #130: renders the "N items could not be searched" disclosure
  // above the results list, or hides the block entirely when the walk was
  // exhaustive (the common case) — same behavior as batchconvert.ts's
  // renderScanErrors for issue #116. Reused verbatim by the replace-preview
  // scan (see the module doc comment above scanErrorsEl's creation).
  const renderScanErrors = (scanErrors: SearchScanError[]): void => {
    scanErrorsEl.replaceChildren();
    if (scanErrors.length === 0) {
      scanErrorsEl.hidden = true;
      return;
    }
    scanErrorsEl.hidden = false;
    const details = document.createElement("details");
    details.className = "fif-scan-errors";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = t("findInFiles.scanErrorsSummary", scanErrors.length);
    details.appendChild(summaryEl);
    const errorList = document.createElement("div");
    errorList.className = "fif-scan-errors-list";
    for (const scanError of scanErrors) {
      const row = document.createElement("div");
      row.className = "fif-scan-errors-row";
      const pathEl = document.createElement("span");
      pathEl.className = "fif-scan-errors-path";
      pathEl.textContent = basename(scanError.path);
      pathEl.title = scanError.path;
      const messageEl = document.createElement("span");
      messageEl.className = "fif-scan-errors-message";
      messageEl.textContent = scanError.message;
      row.appendChild(pathEl);
      row.appendChild(messageEl);
      errorList.appendChild(row);
    }
    details.appendChild(errorList);
    scanErrorsEl.appendChild(details);
  };

  // ---------------------------------------------------------------------
  // Replace-in-files state and rendering. Everything below is additive:
  // it only ever runs from the new replace-row's own listeners, or from
  // the small invalidation hooks added to the existing controls (each of
  // which no-ops instantly — see invalidatePreview's own guard — unless a
  // preview has actually been shown at least once this panel session).
  // ---------------------------------------------------------------------

  // The report a replace-preview scan produced, and the exact parameters
  // it was scanned with (see ReplaceParams's doc comment) — `null` means
  // no active preview (either none has run yet, or it was invalidated /
  // consumed by execute). Set together, cleared together, in
  // renderPreview / invalidatePreview / renderReplaceResults, mirroring
  // batchconvert.ts's lastEntries/lastScanParams.
  let lastPreviewEntries: ReplaceScanEntry[] | null = null;
  let lastPreviewParams: ReplaceParams | null = null;
  // Paths the user has excluded from an otherwise-selectable preview row
  // via its checkbox (batchconvert.ts's uncheckedPaths precedent). Empty
  // means "everything selectable stays selected" — the state after every
  // fresh preview.
  let uncheckedReplacePaths = new Set<string>();
  // Bumped by every runReplaceScan call and every invalidatePreview call —
  // a scan response is only rendered if its generation is still current by
  // the time the IPC call resolves (batchconvert.ts issue #95's fix,
  // applied here).
  let replaceGeneration = 0;
  // True while a replace-preview scan or a replace execute is in flight.
  // Deliberately independent of `searching` above: plain find keeps its
  // own behavior (including closability) completely unchanged.
  let busyReplace = false;

  const updateExecuteButton = (): void => {
    if (lastPreviewEntries === null) {
      executeButton.disabled = true;
      executeButton.textContent = t("findInFiles.replaceExecuteButton", 0);
      return;
    }
    const totals = selectionTotals(lastPreviewEntries, uncheckedReplacePaths);
    executeButton.textContent = t("findInFiles.replaceExecuteButton", totals.fileCount);
    executeButton.disabled = totals.fileCount === 0;
  };

  // Renders the post-execute failure classification (task requirement:
  // changed_since_scan / lossy_blocked / io_error, each listed
  // separately) — or hides the block when there is nothing to report,
  // exactly like renderScanErrors above but for a different concept (an
  // execute's outcome, not a directory walk's).
  const renderReplaceFailures = (groups: ReplaceResultGroup[]): void => {
    failuresEl.replaceChildren();
    if (groups.length === 0) {
      failuresEl.hidden = true;
      return;
    }
    failuresEl.hidden = false;
    const totalFailed = groups.reduce((sum, group) => sum + group.entries.length, 0);
    const heading = document.createElement("div");
    heading.className = "fif-replace-failures-heading";
    heading.textContent = t("findInFiles.replaceFailuresHeading", totalFailed);
    failuresEl.appendChild(heading);
    for (const group of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "fif-replace-failures-group";
      const labelEl = document.createElement("div");
      labelEl.className = "fif-replace-failures-group-label";
      labelEl.textContent = `${group.label} (${group.entries.length})`;
      groupEl.appendChild(labelEl);
      const rowsEl = document.createElement("div");
      rowsEl.className = "fif-replace-failures-list";
      for (const entry of group.entries) {
        const row = document.createElement("div");
        row.className = "fif-replace-failures-row";
        const pathEl = document.createElement("span");
        pathEl.className = "fif-replace-failures-path";
        pathEl.textContent = basename(entry.path);
        pathEl.title = entry.path;
        const messageEl = document.createElement("span");
        messageEl.className = "fif-replace-failures-message";
        messageEl.textContent = entry.message;
        row.appendChild(pathEl);
        row.appendChild(messageEl);
        rowsEl.appendChild(row);
      }
      groupEl.appendChild(rowsEl);
      failuresEl.appendChild(groupEl);
    }
  };

  // Renders the per-file checkbox report into the shared `list` element
  // (reused from plain find's renderMatches above — the two row shapes
  // never appear at the same time, matching batchconvert.ts's single
  // `.batchconvert-list` serving both its report and its result views).
  const renderPreviewRows = (entries: ReplaceScanEntry[]): void => {
    list.replaceChildren();
    const rows = buildPreviewRows(entries);
    entries.forEach((entry, index) => {
      const row = rows[index];
      const item = document.createElement("li");
      item.className = row.selectable
        ? "fif-replace-item"
        : "fif-replace-item fif-replace-item-skipped";

      const checkboxCell = document.createElement("span");
      checkboxCell.className = "fif-replace-item-checkbox";
      if (row.selectable) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !uncheckedReplacePaths.has(entry.path);
        checkbox.setAttribute("aria-label", t("batchConvert.includeFileLabel"));
        checkbox.title = t("batchConvert.includeFileLabel");
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            uncheckedReplacePaths.delete(entry.path);
          } else {
            uncheckedReplacePaths.add(entry.path);
          }
          updateExecuteButton();
        });
        checkboxCell.appendChild(checkbox);
      }

      const pathEl = document.createElement("span");
      pathEl.className = "fif-replace-item-path";
      pathEl.textContent = basename(entry.path);
      pathEl.title = entry.path;

      const countEl = document.createElement("span");
      countEl.className = "fif-replace-item-count";
      if (row.selectable) {
        countEl.textContent = row.matchCountLabel;
      } else {
        countEl.textContent = row.skipLabel ?? "";
        if (row.skipTitle) countEl.title = row.skipTitle;
      }

      const encodingEl = document.createElement("span");
      encodingEl.className = "fif-replace-item-encoding";
      encodingEl.textContent = row.encoding;
      if (row.lossy) {
        const badge = document.createElement("span");
        badge.className = "fif-replace-item-lossy-badge";
        badge.textContent = t("batchConvert.statusLossy");
        badge.title = t("findInFiles.replaceLossyTooltip");
        encodingEl.appendChild(badge);
      }

      item.appendChild(checkboxCell);
      item.appendChild(pathEl);
      item.appendChild(countEl);
      item.appendChild(encodingEl);
      list.appendChild(item);
    });
  };

  // Renders a freshly-scanned replace preview: report-wide summary line,
  // per-file rows, and the execute action — the counterpart to
  // batchconvert.ts's renderReport.
  const renderPreview = (
    entries: ReplaceScanEntry[],
    scanErrors: SearchScanError[],
    truncated: boolean,
    params: ReplaceParams,
  ): void => {
    lastPreviewEntries = entries;
    lastPreviewParams = params;
    uncheckedReplacePaths = new Set();
    renderScanErrors(scanErrors);
    renderReplaceFailures([]);
    const totals = previewTotals(entries);
    previewSummaryEl.hidden = false;
    previewSummaryEl.replaceChildren();
    previewSummaryEl.append(
      entries.length === 0
        ? t("findInFiles.replaceNoMatches")
        : t(
            "findInFiles.replacePreviewSummary",
            totals.fileCount,
            totals.matchCount,
            totals.skippedCount,
          ),
    );
    // ReplaceScanReport.truncated: the scan stopped at its entry cap, so
    // whole files may be missing from this report — not just matches
    // within the files listed. Swallowing this would let a user "select
    // all and execute" believing the folder was covered, get "N files
    // succeeded", and never learn the rest was never examined (the exact
    // hazard plain find's own status line already surfaces via its "+"
    // suffix, made explicit here because this preview gates a destructive
    // write). Warning-toned span, same emphasis family as the
    // scan-errors disclosure above.
    if (truncated) {
      const truncatedEl = document.createElement("span");
      truncatedEl.className = "fif-replace-truncated";
      truncatedEl.textContent = t("findInFiles.replacePreviewTruncated");
      previewSummaryEl.append(" ", truncatedEl);
    }
    renderPreviewRows(entries);
    actions.hidden = false;
    updateExecuteButton();
  };

  // The dry-run preview is only trustworthy for the exact inputs it was
  // scanned with — changing the folder, the query, case sensitivity,
  // regex mode, or the replacement text after a preview would let execute
  // act on a target the user never reviewed (the same adversarial-review
  // finding batchconvert.ts's invalidateScan documents), so any of those
  // changes voids the report and requires clicking "Replace in Files…"
  // again. Guaranteed inert (no DOM writes at all) whenever no preview has
  // ever been shown and nothing is in flight — this is what keeps plain
  // find's own behavior byte-for-byte unchanged for every caller that
  // never touches replace.
  const invalidatePreview = (): void => {
    replaceGeneration += 1;
    if (!busyReplace && lastPreviewEntries === null) return;
    lastPreviewEntries = null;
    lastPreviewParams = null;
    uncheckedReplacePaths = new Set();
    previewSummaryEl.hidden = true;
    previewSummaryEl.textContent = "";
    actions.hidden = true;
    executeButton.disabled = true;
    executeButton.textContent = t("findInFiles.replaceExecuteButton", 0);
    list.replaceChildren();
    renderReplaceFailures([]);
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
  };

  // Renders the post-execute outcome: a one-line success headline (reusing
  // `status`, exactly like batchconvert.ts's renderResults reuses
  // `.batchconvert-status`), the failure classification below it, and
  // clears the consumed preview ("執行後清預覽").
  const renderReplaceResults = (results: ReplaceExecuteEntry[]): void => {
    const resultSummary = summarizeReplaceResults(results);
    const failedCount = resultSummary.failedGroups.reduce(
      (sum, group) => sum + group.entries.length,
      0,
    );
    status.textContent = t(
      "findInFiles.replaceResultSummary",
      resultSummary.okCount,
      resultSummary.totalReplacements,
      failedCount,
    );
    renderReplaceFailures(resultSummary.failedGroups);

    lastPreviewEntries = null;
    lastPreviewParams = null;
    uncheckedReplacePaths = new Set();
    previewSummaryEl.hidden = true;
    previewSummaryEl.textContent = "";
    actions.hidden = true;
    executeButton.disabled = true;
    executeButton.textContent = t("findInFiles.replaceExecuteButton", 0);
    list.replaceChildren();
  };

  // Silently refreshes the plain match list from the current query after a
  // successful execute ("重跑搜尋刷新結果") — deliberately bypasses
  // runSearch's own status-line/searching bookkeeping so it never
  // clobbers the result headline renderReplaceResults just wrote. A
  // best-effort background refresh: a failure here is swallowed rather
  // than surfaced, since surfacing it would overwrite that same headline;
  // the next explicit Enter-triggered search still reports any real
  // problem normally.
  const silentRefreshList = async (): Promise<void> => {
    if (!lastFolder) return;
    try {
      const results = await searchInFolder(
        lastFolder,
        input.value,
        caseBox.checked,
        regexBox.checked,
      );
      renderMatches(results.matches);
      renderScanErrors(results.scanErrors);
    } catch {
      // Best-effort; see the comment above.
    }
  };

  const runReplaceScan = async (): Promise<void> => {
    if (busyReplace) return;
    if (!lastFolder || input.value === "") return;
    replaceGeneration += 1;
    const myGeneration = replaceGeneration;
    const params: ReplaceParams = {
      folder: lastFolder,
      query: input.value,
      caseSensitive: caseBox.checked,
      useRegex: regexBox.checked,
      replacement: replaceInput.value,
    };
    busyReplace = true;
    replaceButton.disabled = true;
    executeButton.disabled = true;
    status.textContent = t("findInFiles.replaceScanning");
    list.replaceChildren();
    previewSummaryEl.hidden = true;
    previewSummaryEl.textContent = "";
    renderReplaceFailures([]);
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    try {
      const report = await scanReplaceInFolder(
        params.folder,
        params.query,
        params.caseSensitive,
        params.useRegex,
        params.replacement,
      );
      // A newer scan, or an input change that invalidated this one, has
      // already superseded this response — discard it unrendered (issue
      // #95's fix, applied here).
      if (myGeneration !== replaceGeneration) return;
      // Recorded only once the scan is known to be the one actually
      // rendered below — never for a generation discarded above. Empty
      // replacement text (the "delete the match" use case) is silently not
      // recorded, same as the CM6 panel: pushReplaceTerm no-ops on "".
      pushFindTerm(params.query);
      pushReplaceTerm(params.replacement);
      populateDatalist(findDatalist, findHistory());
      populateDatalist(replaceDatalist, replaceHistory());
      status.textContent = "";
      renderPreview(report.entries, report.scanErrors, report.truncated, params);
    } catch (error) {
      if (myGeneration !== replaceGeneration) return;
      status.textContent = String(error);
    } finally {
      busyReplace = false;
      replaceButton.disabled = false;
    }
  };

  // Destructive confirm + execute — batch-convert strength (see
  // buildReplaceConfirmMessage's doc comment for exactly what that
  // wording must and must not gloss over). `allowLossy` is derived
  // entirely from the checked selection's own scan-time lossy flags
  // (`selectionTotals`), never a second round-trip: the single confirm
  // dialog already names the risk before the user can accept it, so there
  // is nothing left to ask a second time (unlike the single-document
  // lossy-save flow's two-stage dialog, which exists only because a save
  // has no prior dry-run to have already computed this from).
  const runReplaceExecute = async (): Promise<void> => {
    if (busyReplace) return;
    if (lastPreviewEntries === null || lastPreviewParams === null) return;
    const targets = selectedReplaceTargets(lastPreviewEntries, uncheckedReplacePaths);
    if (targets.length === 0) return;
    const totals = selectionTotals(lastPreviewEntries, uncheckedReplacePaths);
    const params = lastPreviewParams;

    // Busy engages before the confirm dialog even opens (mirrors
    // batchconvert.ts's issue #95 finding): otherwise the await below is a
    // window where the buttons stay enabled and the overlay stays
    // closable, so a second action could interleave before the user has
    // answered the prompt. A cancel must undo this — see `!proceed` below.
    busyReplace = true;
    replaceButton.disabled = true;
    executeButton.disabled = true;

    const message = buildReplaceConfirmMessage(
      totals.fileCount,
      totals.matchCount,
      totals.lossyFileCount,
    );
    const proceed = await confirmDialog(message, {
      title: t("findInFiles.replaceButton"),
      kind: "warning",
    }).catch(() => false);
    if (!proceed) {
      busyReplace = false;
      replaceButton.disabled = false;
      updateExecuteButton();
      return;
    }

    status.textContent = t("streamReplace.replacing");
    try {
      const results = await executeReplaceInFolder(
        targets,
        params.query,
        params.caseSensitive,
        params.useRegex,
        params.replacement,
        totals.lossyFileCount > 0,
      );
      renderReplaceResults(results);
      if (input.value !== "") {
        await silentRefreshList();
      }
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busyReplace = false;
      replaceButton.disabled = false;
    }
  };

  folderButton.addEventListener("click", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") {
      lastFolder = folder;
      folderButton.textContent = basename(folder);
      folderButton.title = folder;
      // Same issue #215 supersession as the query/case/regex listeners
      // below: a folder switch must invalidate any plain search still in
      // flight against the old folder, not just a pending replace preview.
      searchGeneration += 1;
      invalidatePreview();
      input.focus();
    }
  });

  let searching = false;
  // Bumped by every runSearch call and by every query/case/regex/folder
  // change below — a search response is only rendered (and only recorded
  // into search history) if its generation is still current by the time
  // the IPC call resolves or rejects. Mirrors replaceGeneration's issue
  // #95 fix above; this is issue #215's fix for the same class of bug in
  // plain find, which had no such guard at all: an in-flight search whose
  // query/case/regex/folder changed before it resolved would still land
  // unconditionally — stale matches rendered, the pre-change query pushed
  // into search history, scanErrors from the wrong search shown.
  let searchGeneration = 0;
  const runSearch = async (): Promise<void> => {
    if (searching) return;
    const query = input.value;
    if (!lastFolder || query === "") return;
    searching = true;
    searchGeneration += 1;
    const mySearchGeneration = searchGeneration;
    // A plain search always supersedes any pending replace preview, even
    // when the query text itself didn't change since the preview was
    // shown (e.g. Enter pressed again with the same text) — invalidating
    // only from the `input` event below would miss that case.
    invalidatePreview();
    status.textContent = t("findInFiles.searching");
    list.replaceChildren();
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    try {
      const results = await searchInFolder(
        lastFolder,
        query,
        caseBox.checked,
        regexBox.checked,
      );
      // A newer search, or an input/case/regex/folder change that
      // invalidated this one, has already superseded this response —
      // discard it unrendered and unrecorded (issue #215's fix, mirroring
      // replaceGeneration's issue #95 guard above).
      if (mySearchGeneration !== searchGeneration) return;
      // Recorded on every successful search, matches or not — mirrors the
      // CM6 panel's own commitFind, which fires on Enter regardless of
      // whether anything was found.
      pushFindTerm(query);
      populateDatalist(findDatalist, findHistory());
      const count = results.matches.length;
      status.textContent = t(
        "findInFiles.status",
        count,
        results.truncated,
        results.filesScanned,
      );
      renderMatches(results.matches);
      renderScanErrors(results.scanErrors);
    } catch (error) {
      // Same supersession check on the error path: a stale search's
      // rejection must not overwrite the status line for whatever the
      // user is doing now (issue #215).
      if (mySearchGeneration !== searchGeneration) return;
      status.textContent = String(error);
    } finally {
      // Unconditional regardless of the generation check above — this is
      // the reentrancy guard, not the staleness guard, and must always
      // release so a subsequent genuine search can start even after this
      // one was discarded as stale.
      searching = false;
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void runSearch();
    }
  });
  // Any query/case/regex change supersedes an in-flight plain search
  // (issue #215), exactly like it already supersedes a pending replace
  // preview: bump searchGeneration first so a search response that
  // resolves or rejects afterward is recognized as stale by runSearch's
  // own check above, then invalidate the preview as before.
  const supersedeSearch = (): void => {
    searchGeneration += 1;
    invalidatePreview();
  };
  input.addEventListener("input", supersedeSearch);
  caseBox.addEventListener("change", supersedeSearch);
  regexBox.addEventListener("change", supersedeSearch);
  // Independent of preview state (unlike invalidatePreview above): the
  // literal-replacement hint tracks the regex checkbox itself, whether or
  // not a preview has ever run — the warning matters most *before* the
  // first scan, while the user is still composing the replacement text.
  regexBox.addEventListener("change", () => {
    regexHint.hidden = !regexBox.checked;
  });

  replaceInput.addEventListener("input", invalidatePreview);
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void runReplaceScan();
    }
  });
  replaceButton.addEventListener("click", () => void runReplaceScan());
  executeButton.addEventListener("click", () => void runReplaceExecute());

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { label: t("modal.findInFiles") });
  if (lastFolder) input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
