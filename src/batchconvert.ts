// Batch encoding and line-ending conversion: scan a folder (dry run),
// review the per-file classification, then convert the convertible subset
// — one atomic write per file on the Rust side (see
// src-tauri/src/batch.rs). Entry point: Edit menu "Batch Encoding
// Conversion…" (see main.ts's "batch_convert" menu event case; the menu
// label predates the line-ending axis and is left as-is — same entry
// point). Mirrors the findinfiles.ts / mojibake.ts overlay-panel pattern.
//
// Files already open in a tab: this module never touches the editor or
// tabs directly. A successful conversion rewrites the file on disk via the
// same atomic-write path a normal Save uses, so the existing file watcher
// (see main.ts's "mojidori://file-changed" listener / handleExternalChange)
// picks it up exactly like any other external change — reloading a clean
// tab silently, or prompting before discarding a dirty one. Conversion
// never goes through saveFlow, so it never populates `recentSaves`; the
// watcher-echo suppression that exists for normal Save is correctly absent
// here, and the reload prompt fires as expected. See this PR's report for
// the full trace.
//
// Two orthogonal axes, mirroring src-tauri/src/batch.rs: the encoding
// dropdown's first option is a "keep current encoding" pseudo-choice
// (value "keep"), and the line-ending dropdown in `.batchconvert-options`
// offers Keep/LF/CRLF (default Keep). Either axis alone, or both together,
// drives the scan/convert calls; "keep"+"keep" naturally reports every
// file alreadyTarget (nothing to change), which disables Convert without
// any special-case UI code.
import { installModal } from "./modal";
import {
  confirm as confirmDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import { encodingChoices, groupEncodingChoices, type EncodingChoice } from "./encodings";
import { t } from "./i18n";
import {
  executeBatchConversion,
  scanBatchConversion,
  type BatchConvertResult,
  type BatchEntry,
  type BatchScanError,
} from "./ipc";

let lastFolder: string | null = null;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Sentinel `target_encoding` value meaning "leave each file's own
 *  encoding untouched" — see src-tauri/src/batch.rs's `resolve_target_encoding`. */
export const KEEP_ENCODING = "keep";

/**
 * The batch dialog's target-encoding choices: `encodingChoices()` (shared
 * with the reopen/save/preferences pickers) with a "keep current encoding"
 * pseudo-choice prepended. Only meaningful for batch conversion's two-axis
 * design, so this stays local rather than polluting the shared list.
 */
export function batchEncodingChoices(): EncodingChoice[] {
  return [
    { label: t("batchConvert.keepEncoding"), value: KEEP_ENCODING, withBom: false },
    ...encodingChoices(),
  ];
}

export interface LineEndingChoice {
  label: string;
  value: string;
}

/** The batch dialog's target-line-ending choices, "keep" first (the
 *  default selection). Values match src-tauri/src/batch.rs's `line_ending`
 *  argument ("keep" | "LF" | "CRLF") directly — no index-based lookup
 *  needed, unlike `batchEncodingChoices`. */
export function batchLineEndingChoices(): LineEndingChoice[] {
  return [
    { value: "keep", label: t("batchConvert.lineEndingKeep") },
    { value: "LF", label: t("menu.lineEndingLf") },
    { value: "CRLF", label: t("menu.lineEndingCrlf") },
  ];
}

/** Display text for a report row's detected-line-ending cell. "LF"/"CRLF"
 *  stay as the international abbreviation (same convention as the menu's
 *  line-ending labels); "Mixed" is localized since it's prose, not a
 *  standard abbreviation. Empty string (unknown, e.g. `tooLarge`) passes
 *  through unchanged. */
export function lineEndingDisplay(value: string): string {
  return value === "Mixed" ? t("batchConvert.lineEndingMixed") : value;
}

/**
 * Parse the comma-separated extension filter into a lowercase, dot-less,
 * de-duplicated list — matching what `scan_batch_conversion` expects. An
 * empty result means "all files". Pure helper, vitest-covered directly.
 */
export function parseExtensions(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(",")) {
    const ext = raw.trim().replace(/^\.+/, "").toLowerCase();
    if (ext) seen.add(ext);
  }
  return [...seen];
}

export interface BatchCounts {
  convertible: number;
  alreadyTarget: number;
  lossy: number;
  undecodable: number;
  tooLarge: number;
  /** Issue #96 (3/3) / #176: how many entries carry `byteDrift: true` —
   *  either an `alreadyTarget` no-op entry (#96 3/3) or a `convertible`
   *  entry whose only requested change is line-ending, encoding axis
   *  otherwise untouched (#176; see `BatchEntry.byteDrift`'s doc comment
   *  for both scenarios), tallied independently of `status` since it's an
   *  orthogonal flag, not a status of its own. */
  byteDrift: number;
}

/** Pure helper: tally scan entries by status (plus the orthogonal
 *  byte-drift flag) for the report header. */
export function countByStatus(entries: BatchEntry[]): BatchCounts {
  const counts: BatchCounts = {
    convertible: 0,
    alreadyTarget: 0,
    lossy: 0,
    undecodable: 0,
    tooLarge: 0,
    byteDrift: 0,
  };
  for (const entry of entries) {
    if (entry.status in counts) {
      counts[entry.status as keyof BatchCounts] += 1;
    }
    if (entry.byteDrift) {
      counts.byteDrift += 1;
    }
  }
  return counts;
}

/** Pure helper: paths eligible for conversion, in report order. */
export function convertiblePaths(entries: BatchEntry[]): string[] {
  return entries.filter((e) => e.status === "convertible").map((e) => e.path);
}

/**
 * Pure helper: convertible paths still selected for conversion, in report
 * order — every path from `convertiblePaths(entries)` except those the
 * user has excluded via the report's per-row checkbox. `unchecked` holds
 * exactly those excluded paths; an empty set (the default after every
 * fresh report) means everything convertible stays selected, matching
 * the pre-checkbox behavior. Paths in `unchecked` that don't belong to a
 * convertible entry (stale, or never eligible in the first place) are
 * silently ignored rather than affecting the result.
 */
export function selectedConvertiblePaths(
  entries: BatchEntry[],
  unchecked: ReadonlySet<string>,
): string[] {
  return convertiblePaths(entries).filter((path) => !unchecked.has(path));
}

function statusLabel(status: string): string {
  switch (status) {
    case "convertible":
      return t("batchConvert.statusConvertible");
    case "alreadyTarget":
      return t("batchConvert.statusAlreadyTarget");
    case "lossy":
      return t("batchConvert.statusLossy");
    case "undecodable":
      return t("batchConvert.statusUndecodable");
    case "tooLarge":
      return t("batchConvert.statusTooLarge");
    default:
      return status;
  }
}

/**
 * The exact parameters a scan was run with — captured the moment
 * `runScan` fires the IPC call, and bound to the resulting report's
 * lifecycle (see `lastScanParams` inside `showBatchConvert`). `runConvert`
 * executes with this snapshot, never with the controls' live values, so
 * Convert can only ever act on the target the user actually reviewed
 * (issue #95), even if the controls were edited after the report
 * rendered.
 */
interface ScanParams {
  folder: string;
  extensions: string[];
  targetEncoding: string;
  targetWithBom: boolean;
  lineEnding: string;
}

export function showBatchConvert(): void {
  if (document.querySelector(".batchconvert-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "batchconvert-overlay";
  const panel = document.createElement("div");
  panel.className = "batchconvert-panel";

  const header = document.createElement("div");
  header.className = "batchconvert-header";
  header.textContent = t("batchConvert.title");
  panel.appendChild(header);

  const controls = document.createElement("div");
  controls.className = "batchconvert-controls";

  const folderButton = document.createElement("button");
  folderButton.className = "batchconvert-folder";
  folderButton.textContent = lastFolder ? basename(lastFolder) : t("batchConvert.chooseFolder");
  if (lastFolder) folderButton.title = lastFolder;
  folderButton.addEventListener("click", async () => {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder === "string") {
      lastFolder = folder;
      folderButton.textContent = basename(folder);
      folderButton.title = folder;
      invalidateScan();
    }
  });

  const extInput = document.createElement("input");
  extInput.type = "text";
  extInput.className = "batchconvert-ext";
  extInput.placeholder = t("batchConvert.extPlaceholder");

  const targetLabel = document.createElement("label");
  targetLabel.className = "batchconvert-target";
  targetLabel.textContent = t("batchConvert.targetLabel");
  const encodingSelect = document.createElement("select");
  encodingSelect.className = "batchconvert-encoding";
  const choices = batchEncodingChoices();
  // `option.value` is the choice's index in `choices` (not e.g. its encoding
  // name), since the "keep" pseudo-choice at index 0 shares its withBom
  // shape with nothing else and several real choices share a `.value` (the
  // UTF-8 / UTF-8 BOM pair) — see `batchEncodingChoices`'s doc comment. That
  // scheme survives grouping unchanged: `indexByChoice` looks up each
  // choice's original position by reference, independent of where
  // `groupEncodingChoices` places it in the grouped/reordered DOM.
  const indexByChoice = new Map<EncodingChoice, number>(choices.map((c, i) => [c, i]));
  const keepOption = document.createElement("option");
  keepOption.value = "0";
  keepOption.textContent = choices[0].label;
  encodingSelect.appendChild(keepOption);
  for (const group of groupEncodingChoices(choices.slice(1))) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const choice of group.choices) {
      const option = document.createElement("option");
      option.value = String(indexByChoice.get(choice));
      option.textContent = choice.label;
      optgroup.appendChild(option);
    }
    encodingSelect.appendChild(optgroup);
  }
  targetLabel.appendChild(encodingSelect);

  const scanButton = document.createElement("button");
  scanButton.className = "batchconvert-scan";
  scanButton.textContent = t("batchConvert.scanButton");

  controls.appendChild(folderButton);
  controls.appendChild(extInput);
  controls.appendChild(targetLabel);
  controls.appendChild(scanButton);
  panel.appendChild(controls);

  const lineEndingLabel = document.createElement("label");
  lineEndingLabel.className = "batchconvert-lineending";
  lineEndingLabel.textContent = t("batchConvert.lineEndingLabel");
  const lineEndingSelect = document.createElement("select");
  lineEndingSelect.className = "batchconvert-lineending-select";
  for (const choice of batchLineEndingChoices()) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    lineEndingSelect.appendChild(option);
  }
  lineEndingLabel.appendChild(lineEndingSelect);

  const optionsArea = document.createElement("div");
  optionsArea.className = "batchconvert-options";
  optionsArea.appendChild(lineEndingLabel);
  panel.appendChild(optionsArea);

  const status = document.createElement("div");
  status.className = "batchconvert-status";
  panel.appendChild(status);

  const summary = document.createElement("div");
  summary.className = "batchconvert-summary";
  panel.appendChild(summary);

  // Issue #116: a folder/entry the walk couldn't read means `entries`
  // below may be missing whatever that path contained. This must stay
  // visible above the per-file list — not buried where a user reviewing
  // rows might never notice it — and use <details>/<summary> so the path
  // list is inspectable without cluttering the common (no errors) case.
  const scanErrorsEl = document.createElement("div");
  scanErrorsEl.className = "batchconvert-scan-errors-container";
  scanErrorsEl.hidden = true;
  panel.appendChild(scanErrorsEl);

  const list = document.createElement("div");
  list.className = "batchconvert-list";
  panel.appendChild(list);

  const actions = document.createElement("div");
  actions.className = "batchconvert-actions";
  const convertButton = document.createElement("button");
  convertButton.className = "batchconvert-convert";
  convertButton.textContent = t("batchConvert.convertButton", 0);
  convertButton.disabled = true;
  actions.appendChild(convertButton);
  panel.appendChild(actions);

  const close = (): void => {
    // A running scan or convert cannot be cancelled — the Rust command
    // runs to completion and the files on disk change regardless of
    // whether this panel is still open to show the outcome. Closing it
    // mid-run would only fake a cancel (issue #97), so it stays open
    // until busy clears — same guard as streamreplace.ts's close().
    if (busy) return;
    document.removeEventListener("mousedown", onAway);
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  let lastEntries: BatchEntry[] = [];
  // Paths the user has excluded from an otherwise-convertible report via
  // the per-row checkbox (issue #79: a near-miss encoding guess should be
  // excludable without discarding the rest of the batch). Empty means
  // "everything convertible stays selected" — the state after every fresh
  // report — see selectedConvertiblePaths.
  let uncheckedPaths = new Set<string>();
  // The exact parameters `lastEntries` was scanned with (issue #95). Set
  // together with `lastEntries` in `renderReport`, cleared together with
  // it in `invalidateScan`/`renderResults` — the two never go out of
  // sync. `runConvert` executes with this snapshot instead of re-reading
  // the controls, so Convert can only ever act on the target the user
  // actually reviewed.
  let lastScanParams: ScanParams | null = null;
  // How many scan_errors the report currently on screen came with (issue
  // #116) — set together with `lastEntries`/`lastScanParams` in
  // `renderReport`, cleared together with them in
  // `invalidateScan`/`renderResults`. Read by `runConvert` to pick the
  // confirm dialog's wording: a plain confirm when the scan was
  // exhaustive, or one that explicitly names the incomplete-scan risk
  // when it wasn't — the moment right before a destructive action is
  // exactly where issue #116 warns a user could otherwise act on a
  // report they wrongly believed was complete.
  let lastScanErrorCount = 0;
  // Bumped by every `runScan` call and every `invalidateScan` call. A
  // scan response is only rendered if its generation is still current by
  // the time the IPC call resolves — see `runScan`. Bumping this is what
  // lets a response be recognized as stale even while `lastEntries` is
  // still empty, i.e. a first scan still in flight, which has nothing to
  // invalidate by clearing entries alone.
  let scanGeneration = 0;
  // True while a scan or convert IPC call is in flight.
  let busy = false;

  // The dry-run report is only trustworthy for the exact inputs it was
  // scanned with. Changing the folder, the extension filter, the target
  // encoding, or the target line ending after a scan would let Convert
  // act on a target the user never reviewed (adversarial-review finding)
  // — so any input change voids the report and forces a rescan. This must
  // also invalidate a scan that's still in flight (issue #95): bumping
  // `scanGeneration` unconditionally, before any early return, is what
  // makes `runScan` discard that scan's response when it eventually
  // arrives instead of rendering a report for inputs nobody reviewed.
  const invalidateScan = (): void => {
    scanGeneration += 1;
    if (!busy && lastScanParams === null) return;
    lastEntries = [];
    uncheckedPaths = new Set();
    lastScanParams = null;
    lastScanErrorCount = 0;
    convertButton.disabled = true;
    convertButton.textContent = t("batchConvert.convertButton", 0);
    summary.textContent = "";
    list.replaceChildren();
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    status.textContent = t("batchConvert.rescanNeeded");
  };
  // Every dry-run input is equal-standing: the folder (above), the
  // extension filter, and both target axes changing after a scan must
  // void the report — Convert may only ever act on exactly what the
  // user reviewed.
  extInput.addEventListener("input", invalidateScan);
  encodingSelect.addEventListener("change", invalidateScan);
  lineEndingSelect.addEventListener("change", invalidateScan);

  // Refreshes the Convert button's label/enabled state from the current
  // selection (lastEntries minus uncheckedPaths). Called after every
  // fresh report render and every per-row checkbox toggle.
  const updateConvertButton = (): void => {
    const count = selectedConvertiblePaths(lastEntries, uncheckedPaths).length;
    convertButton.textContent = t("batchConvert.convertButton", count);
    convertButton.disabled = count === 0;
  };

  // Issue #116: renders the "N items could not be scanned" disclosure
  // above the per-file list, or hides the block entirely when the walk
  // was exhaustive (the common case). A collapsed <details> keeps this
  // out of the way until the user chooses to inspect which paths were
  // missed, while the <summary> line itself is always visible so the
  // incompleteness can never go unnoticed the way issue #116 describes.
  const renderScanErrors = (scanErrors: BatchScanError[]): void => {
    scanErrorsEl.replaceChildren();
    if (scanErrors.length === 0) {
      scanErrorsEl.hidden = true;
      return;
    }
    scanErrorsEl.hidden = false;
    const details = document.createElement("details");
    details.className = "batchconvert-scan-errors";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = t("batchConvert.scanErrorsSummary", scanErrors.length);
    details.appendChild(summaryEl);
    const errorList = document.createElement("div");
    errorList.className = "batchconvert-scan-errors-list";
    for (const scanError of scanErrors) {
      const row = document.createElement("div");
      row.className = "batchconvert-scan-errors-row";
      const pathEl = document.createElement("span");
      pathEl.className = "batchconvert-scan-errors-path";
      pathEl.textContent = basename(scanError.path);
      pathEl.title = scanError.path;
      const messageEl = document.createElement("span");
      messageEl.className = "batchconvert-scan-errors-message";
      messageEl.textContent = scanError.message;
      row.appendChild(pathEl);
      row.appendChild(messageEl);
      errorList.appendChild(row);
    }
    details.appendChild(errorList);
    scanErrorsEl.appendChild(details);
  };

  const renderReport = (
    entries: BatchEntry[],
    scanErrors: BatchScanError[],
    params: ScanParams,
  ): void => {
    lastEntries = entries;
    lastScanParams = params;
    lastScanErrorCount = scanErrors.length;
    // A fresh report is a fresh review: any exclusions from a previous
    // report must not leak into this one (adversarial-review finding —
    // see invalidateScan above for the same principle on stale inputs).
    uncheckedPaths = new Set();
    renderScanErrors(scanErrors);
    const counts = countByStatus(entries);
    summary.textContent =
      entries.length === 0
        ? t("batchConvert.noResults")
        : t(
            "batchConvert.summary",
            counts.convertible,
            counts.alreadyTarget,
            counts.lossy,
            counts.undecodable,
            counts.tooLarge,
            counts.byteDrift,
          );
    list.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `batchconvert-row batchconvert-row-${entry.status}`;
      // Non-convertible rows still get the grid cell (empty) so every
      // row's path/detected/lineending/status columns line up.
      const checkboxEl = document.createElement("span");
      checkboxEl.className = "batchconvert-row-checkbox";
      if (entry.status === "convertible") {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = true;
        checkbox.setAttribute("aria-label", t("batchConvert.includeFileLabel"));
        checkbox.title = t("batchConvert.includeFileLabel");
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            uncheckedPaths.delete(entry.path);
          } else {
            uncheckedPaths.add(entry.path);
          }
          updateConvertButton();
        });
        checkboxEl.appendChild(checkbox);
      }
      const pathEl = document.createElement("span");
      pathEl.className = "batchconvert-row-path";
      pathEl.textContent = basename(entry.path);
      pathEl.title = entry.path;
      const detectedEl = document.createElement("span");
      detectedEl.className = "batchconvert-row-detected";
      detectedEl.textContent = entry.detected;
      const lineEndingEl = document.createElement("span");
      lineEndingEl.className = "batchconvert-row-lineending";
      lineEndingEl.textContent = lineEndingDisplay(entry.lineEnding);
      const statusEl = document.createElement("span");
      statusEl.className = "batchconvert-row-status";
      statusEl.textContent = statusLabel(entry.status);
      // Issue #96 (3/3) / #176: an orthogonal flag, not a status of its own
      // (see BatchEntry.byteDrift's doc comment) — appended as a badge next
      // to the status text rather than replacing it, mirroring
      // comparePreview.ts's malformed-encoding badge (same small-pill
      // presentation, see .comparepreview-col-badge in styles.css). Same
      // badge either way byteDrift is true, but the tooltip's wording
      // differs by status: an `alreadyTarget` row is a pure no-op the user
      // never asked to touch at all ("Text unchanged, but..."), while a
      // `convertible` row (issue #176) is mid-conversion for a line-ending
      // change the user *did* ask for — reusing the no-op wording there
      // would misreport a requested change as an unrequested one, so it
      // gets its own key instead.
      if (entry.byteDrift) {
        const driftBadge = document.createElement("span");
        driftBadge.className = "batchconvert-row-drift-badge";
        driftBadge.textContent = t("batchConvert.byteDriftBadge");
        driftBadge.title =
          entry.status === "alreadyTarget"
            ? t("batchConvert.byteDriftTooltip")
            : t("batchConvert.byteDriftTooltipConvertible");
        statusEl.appendChild(driftBadge);
      }
      row.appendChild(checkboxEl);
      row.appendChild(pathEl);
      row.appendChild(detectedEl);
      row.appendChild(lineEndingEl);
      row.appendChild(statusEl);
      list.appendChild(row);
    }
    updateConvertButton();
  };

  const renderResults = (results: BatchConvertResult[]): void => {
    const failed = results.filter((r) => !r.ok);
    const okCount = results.length - failed.length;
    status.textContent = t("batchConvert.resultSummary", okCount, failed.length);
    summary.textContent = "";
    list.replaceChildren();
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    for (const result of failed) {
      const row = document.createElement("div");
      row.className = "batchconvert-row batchconvert-row-failed";
      // Empty placeholder so the path/message columns still line up with
      // the report view's checkbox/path/detected/lineending/status grid.
      const checkboxEl = document.createElement("span");
      checkboxEl.className = "batchconvert-row-checkbox";
      const pathEl = document.createElement("span");
      pathEl.className = "batchconvert-row-path";
      pathEl.textContent = basename(result.path);
      pathEl.title = result.path;
      const messageEl = document.createElement("span");
      messageEl.className = "batchconvert-row-detected";
      messageEl.textContent = result.message;
      row.appendChild(checkboxEl);
      row.appendChild(pathEl);
      row.appendChild(messageEl);
      list.appendChild(row);
    }
    lastEntries = [];
    uncheckedPaths = new Set();
    lastScanParams = null;
    lastScanErrorCount = 0;
    convertButton.disabled = true;
    convertButton.textContent = t("batchConvert.convertButton", 0);
  };

  const runScan = async (): Promise<void> => {
    if (busy) return;
    if (!lastFolder) {
      status.textContent = t("batchConvert.chooseFolderFirst");
      return;
    }
    // Bump first and capture this call's own generation, plus a full
    // snapshot of the parameters actually being sent (issue #95): the
    // response handler below only trusts a response whose generation is
    // still current by the time the IPC call resolves.
    scanGeneration += 1;
    const myGeneration = scanGeneration;
    const choice = choices[Number(encodingSelect.value)];
    const params: ScanParams = {
      folder: lastFolder,
      extensions: parseExtensions(extInput.value),
      targetEncoding: choice.value,
      targetWithBom: choice.withBom,
      lineEnding: lineEndingSelect.value,
    };
    busy = true;
    scanButton.disabled = true;
    convertButton.disabled = true;
    status.textContent = t("batchConvert.scanning");
    summary.textContent = "";
    list.replaceChildren();
    scanErrorsEl.hidden = true;
    scanErrorsEl.replaceChildren();
    try {
      const report = await scanBatchConversion(
        params.folder,
        params.extensions,
        params.targetEncoding,
        params.targetWithBom,
        params.lineEnding,
      );
      // A newer scan, or an input change that invalidated this one, has
      // already superseded this response — discard it unrendered rather
      // than showing this scan's classification under whatever the
      // controls now say (the exact bug in issue #95).
      if (myGeneration !== scanGeneration) return;
      status.textContent = "";
      renderReport(report.entries, report.scanErrors, params);
    } catch (error) {
      if (myGeneration !== scanGeneration) return;
      status.textContent = String(error);
    } finally {
      busy = false;
      scanButton.disabled = false;
    }
  };
  scanButton.addEventListener("click", () => void runScan());

  const runConvert = async (): Promise<void> => {
    if (busy) return;
    const paths = selectedConvertiblePaths(lastEntries, uncheckedPaths);
    // lastScanParams is null only when lastEntries is also empty (they're
    // always set/cleared together — see renderReport/invalidateScan/
    // renderResults), so paths.length > 0 implies it's non-null; the
    // explicit check is defense in depth and satisfies the type checker.
    if (paths.length === 0 || lastScanParams === null) return;
    const params = lastScanParams;
    // Busy starts here, before the confirm dialog even opens (#95
    // adversarial-review finding): otherwise the await below is a window
    // where Scan/Convert stay enabled and the overlay stays closable, so
    // a second action could interleave with this Convert before the user
    // has answered the prompt. A cancel must undo this — see `!proceed`.
    busy = true;
    scanButton.disabled = true;
    convertButton.disabled = true;
    // N files rewritten in place with no undo: make the user say so. When
    // the scan that produced this report couldn't read everything (issue
    // #116), say so again right here — a native confirm dialog covers the
    // panel's own scan-errors disclosure, so this is the only chance left
    // to warn at the actual moment of a destructive action.
    const confirmMessage =
      lastScanErrorCount > 0
        ? t("batchConvert.confirmMessageIncomplete", paths.length, lastScanErrorCount)
        : t("batchConvert.confirmMessage", paths.length);
    const proceed = await confirmDialog(confirmMessage, {
      title: t("batchConvert.title"),
      kind: "warning",
    }).catch(() => false);
    if (!proceed) {
      busy = false;
      scanButton.disabled = false;
      updateConvertButton();
      return;
    }
    status.textContent = t("batchConvert.converting");
    try {
      // Bound to the scan that produced this report (issue #95) — never
      // re-read from the controls, which may have changed since the scan
      // that produced `lastEntries` ran. Convert must only ever act on
      // the target the user actually reviewed.
      const results = await executeBatchConversion(
        paths,
        params.targetEncoding,
        params.targetWithBom,
        params.lineEnding,
      );
      renderResults(results);
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      scanButton.disabled = false;
    }
  };
  convertButton.addEventListener("click", () => void runConvert());

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { labelledBy: header });
  if (lastFolder) extInput.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}
