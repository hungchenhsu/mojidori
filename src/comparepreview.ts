// Side-by-side encoding preview: the same bytes decoded under two
// candidate encodings, read-only, for manual disambiguation when automatic
// detection can't confidently choose between look-alike legacy encodings
// (e.g. Big5 vs GBK). Entry point: the status-bar encoding menu's "Compare
// encodings…" item (see main.ts's showEncodingMenu). Mirrors the
// mojibake.ts / batchconvert.ts overlay-panel pattern.
//
// Read-only: this module never edits the document or writes to disk. The
// only action available per column is "Reopen with this encoding", which
// delegates to main.ts's existing reopenWithEncoding flow via a callback
// (the same callback-into-main.ts shape as findinfiles.ts's
// showFindInFiles) and then closes the panel.
import { installModal } from "./modal";
import { groupEncodingChoices, reopenEncodingChoices, type EncodingChoice } from "./encodings";
import { hexPreviewCaption } from "./hexview";
import { t } from "./i18n";
import { previewTwoEncodings, type EncodingPreviewSide } from "./ipc";

/**
 * Pure helper: the default candidate for the "B" (comparison) side — the
 * first choice in `choices` whose value differs from `aValue`, so A and B
 * never default to comparing an encoding against itself. Falls back to the
 * first choice in `choices` (or `aValue` itself if `choices` is empty) in
 * the degenerate case where every choice matches `aValue`.
 */
export function pickDefaultCompareB(choices: EncodingChoice[], aValue: string): string {
  const alt = choices.find((choice) => choice.value !== aValue);
  if (alt) return alt.value;
  return choices[0]?.value ?? aValue;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function renderColumn(
  col: HTMLElement,
  side: EncodingPreviewSide,
  onReopen: (encoding: string) => void,
): void {
  col.replaceChildren();

  const header = document.createElement("div");
  header.className = "comparepreview-col-header";
  const nameEl = document.createElement("span");
  nameEl.className = "comparepreview-col-name";
  nameEl.textContent = side.encoding;
  header.appendChild(nameEl);
  if (side.malformed) {
    const badge = document.createElement("span");
    badge.className = "comparepreview-col-badge";
    badge.textContent = t("comparePreview.malformedBadge");
    header.appendChild(badge);
  }
  col.appendChild(header);

  const content = document.createElement("pre");
  content.className = "comparepreview-col-content";
  content.tabIndex = 0;
  content.textContent = side.content;
  col.appendChild(content);

  const reopenButton = document.createElement("button");
  reopenButton.className = "comparepreview-col-reopen";
  reopenButton.textContent = t("comparePreview.reopenButton");
  reopenButton.addEventListener("click", () => onReopen(side.encoding));
  col.appendChild(reopenButton);
}

function populateSelect(select: HTMLSelectElement, choices: EncodingChoice[]): void {
  for (const group of groupEncodingChoices(choices)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const choice of group.choices) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
}

/**
 * Show the side-by-side encoding comparison overlay for `path` (the active
 * document's file on disk). `currentEncoding` seeds the "A" dropdown's
 * default selection; "B" defaults to the first other choice (see
 * `pickDefaultCompareB`). Only ever reads a bounded prefix of the file (see
 * `previewTwoEncodings`), so this works the same whether the document is
 * fully loaded or a large-file truncated preview. `onReopen` is called with
 * the chosen side's encoding when the user clicks "Reopen with this
 * encoding"; the panel closes immediately after.
 */
export function showComparePreview(
  path: string,
  currentEncoding: string,
  onReopen: (encoding: string) => void,
): void {
  if (document.querySelector(".comparepreview-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "comparepreview-overlay";
  const panel = document.createElement("div");
  panel.className = "comparepreview-panel";

  const header = document.createElement("div");
  header.className = "comparepreview-header";
  header.textContent = t("comparePreview.title", basename(path));
  panel.appendChild(header);

  const controls = document.createElement("div");
  controls.className = "comparepreview-controls";

  const choices = reopenEncodingChoices();

  const aLabel = document.createElement("label");
  aLabel.className = "comparepreview-select-label";
  aLabel.textContent = t("comparePreview.encodingALabel");
  const aSelect = document.createElement("select");
  aSelect.className = "comparepreview-select";
  populateSelect(aSelect, choices);
  const initialA = choices.some((c) => c.value === currentEncoding)
    ? currentEncoding
    : (choices[0]?.value ?? currentEncoding);
  aSelect.value = initialA;
  aLabel.appendChild(aSelect);

  const bLabel = document.createElement("label");
  bLabel.className = "comparepreview-select-label";
  bLabel.textContent = t("comparePreview.encodingBLabel");
  const bSelect = document.createElement("select");
  bSelect.className = "comparepreview-select";
  populateSelect(bSelect, choices);
  bSelect.value = pickDefaultCompareB(choices, initialA);
  bLabel.appendChild(bSelect);

  const compareButton = document.createElement("button");
  compareButton.className = "comparepreview-compare";
  compareButton.textContent = t("comparePreview.compareButton");

  controls.appendChild(aLabel);
  controls.appendChild(bLabel);
  controls.appendChild(compareButton);
  panel.appendChild(controls);

  const status = document.createElement("div");
  status.className = "comparepreview-status";
  panel.appendChild(status);

  const columns = document.createElement("div");
  columns.className = "comparepreview-columns";
  const colA = document.createElement("div");
  colA.className = "comparepreview-col";
  const colB = document.createElement("div");
  colB.className = "comparepreview-col";
  columns.appendChild(colA);
  columns.appendChild(colB);
  panel.appendChild(columns);

  const close = (): void => {
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

  const reopenAndClose = (encoding: string): void => {
    onReopen(encoding);
    close();
  };

  let busy = false;
  const runCompare = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    compareButton.disabled = true;
    status.textContent = t("common.loading");
    try {
      const result = await previewTwoEncodings(path, aSelect.value, bSelect.value);
      status.textContent = hexPreviewCaption(result.sampledBytes, result.totalSize);
      renderColumn(colA, result.a, reopenAndClose);
      renderColumn(colB, result.b, reopenAndClose);
    } catch (error) {
      status.textContent = String(error);
      colA.replaceChildren();
      colB.replaceChildren();
    } finally {
      busy = false;
      compareButton.disabled = false;
    }
  };
  compareButton.addEventListener("click", () => void runCompare());

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { label: t("modal.compareEncodings") });
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);

  void runCompare();
}
