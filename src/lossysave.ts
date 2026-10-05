// Lossy-save character preview (ROADMAP.md v0.4 Track A) [danger]: when
// save_document's two-phase lossy gate rejects a save, this names *which*
// characters can't be encoded (char + first-occurrence position, capped at
// 20 — src-tauri/src/normalize.rs's SAMPLE_CAP) and the total occurrence
// count, not just a bare "some characters can't be represented" message —
// before the user can still choose the lossy path. The existing two-stage
// save semantics (reject first, only write once the user explicitly opts
// in via `allowLossy: true`) are unchanged; this only makes the rejection
// itself more informative.
//
// This gets its own in-DOM modal rather than reusing the plain
// `confirm()`/`message()` native dialog plugin main.ts's saveFlow used to
// call directly: the native dialog can only show a flat string with no way
// to make a long sample list scrollable, and up to 20 capped samples can
// run past what comfortably fits. Mirrors confirm.ts's showCloseConfirm /
// stalefile.ts's showStaleFileConfirm — same `.confirm-overlay`/
// `.confirm-dialog`/`.confirm-buttons` classes, same Escape-cancels/
// initial-focus-on-Cancel pattern (this is an irreversible, data-losing
// action once confirmed, so — like the stale-file dialog — there is no
// global Enter shortcut for it).
import { installModal } from "./modal";
import { t } from "./i18n";
import type { LossyReport } from "./ipc";

export interface LossySaveDialogContent {
  title: string;
  /** Summary sentence naming the encoding and total occurrence count. */
  summary: string;
  /** One formatted line per sample, already localized — see
   *  `dialog.lossySampleLine`. Empty when `report.samples` is empty. */
  sampleLines: string[];
  /** Non-null only when `report.samplesTruncated` — appended below the
   *  sample list so a capped list is never mistaken for a complete one. */
  truncatedNote: string | null;
}

/**
 * Pure composition of the lossy-save confirm dialog's text content, split
 * out from the DOM-building `showLossySaveConfirm` below so it can be
 * vitest-covered without a WebView (mirrors lineops.ts/textstats.ts's own
 * pure/DOM split).
 */
export function buildLossySaveDialogContent(
  encoding: string,
  report: LossyReport,
): LossySaveDialogContent {
  return {
    title: t("dialog.lossyEncodingTitle"),
    summary: t("dialog.lossyEncodingMessage", encoding, report.unmappableCount),
    sampleLines: report.samples.map((sample) =>
      t("dialog.lossySampleLine", sample.display, sample.line, sample.column),
    ),
    truncatedNote: report.samplesTruncated ? t("dialog.lossySamplesTruncated") : null,
  };
}

/**
 * Shows the lossy-save preview and resolves `true` only once the user
 * explicitly chooses to proceed with the lossy write (the caller then
 * re-invokes `saveDocument` with `allowLossy: true`, exactly as before this
 * dialog existed) — `false` on Cancel or Escape, leaving the document
 * exactly as it was.
 */
export function showLossySaveConfirm(encoding: string, report: LossyReport): Promise<boolean> {
  const content = buildLossySaveDialogContent(encoding, report);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog";

    const title = document.createElement("p");
    title.className = "confirm-dialog-title";
    title.textContent = content.title;
    dialog.appendChild(title);

    const message = document.createElement("p");
    message.textContent = content.summary;
    dialog.appendChild(message);

    if (content.sampleLines.length > 0) {
      const list = document.createElement("div");
      list.className = "lossy-samples";
      for (const line of content.sampleLines) {
        const row = document.createElement("div");
        row.className = "lossy-samples-row";
        row.textContent = line;
        list.appendChild(row);
      }
      dialog.appendChild(list);
    }

    if (content.truncatedNote !== null) {
      const note = document.createElement("p");
      note.className = "lossy-samples-truncated";
      note.textContent = content.truncatedNote;
      dialog.appendChild(note);
    }

    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";

    const finish = (proceed: boolean): void => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(proceed);
    };

    const cancel = document.createElement("button");
    cancel.textContent = t("confirm.cancel");
    cancel.addEventListener("click", () => finish(false));
    buttons.appendChild(cancel);

    const proceedButton = document.createElement("button");
    proceedButton.textContent = t("dialog.lossyEncodingConfirm");
    proceedButton.className = "confirm-primary";
    proceedButton.addEventListener("click", () => finish(true));
    buttons.appendChild(proceedButton);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };
    document.addEventListener("keydown", onKey, true);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    installModal(overlay, dialog, { role: "alertdialog", labelledBy: title, describedBy: message });
    cancel.focus();
  });
}
