// Streaming find/replace for large-file read-only preview windows: the
// in-editor Find/Replace can't be used there (only a bounded slice of the
// file is ever loaded, and saving that slice back would destroy the rest of
// the file), so this panel calls the Rust streaming replace command
// directly against the file on disk (src-tauri/src/streamreplace.rs) and
// asks the caller to reload the document afterward. Entry point: Edit menu
// "Replace in Large File…" (see main.ts's "stream_replace" menu event
// case). Mirrors the findinfiles.ts / batchconvert.ts overlay-panel
// pattern.
//
// A successful run with at least one replacement is confirmed with a
// blocking native dialog (so the count is actually seen, not just flashed
// in a status line the panel closes over) before the caller reloads the
// document and the panel closes; zero matches or a failed run show their
// result inline and leave the panel open so the user can adjust and retry
// without losing their input.
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { streamReplaceInFile } from "./ipc";

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * Pure composition of the streaming-replace result text — split out from
 * the DOM-driving runReplace below so it's vitest-covered without a WebView
 * (mirrors lossysave.ts's buildLossySaveDialogContent / textstats.ts's own
 * pure/DOM split). Appends a note when `unmatchedRegionReencoded` is true
 * (issue #175; StreamReplaceReport's field of the same name — see its doc
 * comment in ipc.ts): the file was correctly changed, but at least one
 * region the user didn't ask to touch may have had its on-disk byte
 * representation canonicalized along the way. Never fires in practice when
 * `replacements` is 0 (the field is always false then), but this makes no
 * such assumption itself.
 *
 * Also appends a note when `durabilityWarning` is non-null (issue #328's
 * third review round — `StreamReplaceReport.durabilityWarning`'s own doc
 * comment): the replace itself landed on disk, but the follow-up
 * parent-directory `fsync` that would confirm it survives an immediate
 * crash could not be completed. Never a failure on its own, so this stays
 * on the same success dialog rather than gating anything — both notes can
 * appear together.
 */
export function buildStreamReplaceResultMessage(
  replacements: number,
  unmatchedRegionReencoded: boolean,
  durabilityWarning: string | null,
): string {
  let message = t("streamReplace.resultMessage", replacements);
  if (unmatchedRegionReencoded) {
    message = `${message} ${t("streamReplace.unmatchedRegionReencodedNote")}`;
  }
  // Truthy check, not `!== null`, to match `unmatchedRegionReencoded`
  // above: an older/looser mock or caller that omits this field entirely
  // (`undefined`) must behave identically to an explicit `null`, not
  // append a stray "undefined" note.
  if (durabilityWarning) {
    message = `${message} ${t("statusbar.durabilityWarning", durabilityWarning)}`;
  }
  return message;
}

/**
 * Show the streaming replace overlay for `path` (the active large-file
 * document's file on disk), operating in `encoding` (the document's own
 * detected encoding — this command never converts between encodings).
 * `onReplaced` is called once, after a run that made at least one
 * replacement, so the caller can reload the document from disk (e.g.
 * `reloadFromDisk`).
 */
export function showStreamReplace(
  path: string,
  encoding: string,
  onReplaced: () => void,
): void {
  if (document.querySelector(".streamreplace-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "streamreplace-overlay";
  const panel = document.createElement("div");
  panel.className = "streamreplace-panel";

  const title = t("streamReplace.title", basename(path));
  const header = document.createElement("div");
  header.className = "streamreplace-header";
  header.textContent = title;
  header.title = path;
  panel.appendChild(header);

  const fields = document.createElement("div");
  fields.className = "streamreplace-fields";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "streamreplace-search";
  searchInput.placeholder = t("streamReplace.searchPlaceholder");
  // A search term longer than one streaming chunk degrades the Rust side
  // to O(n²) carry growth (documented there); no real search needs 4k.
  searchInput.maxLength = 4096;
  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "streamreplace-replace";
  replaceInput.placeholder = t("streamReplace.replacePlaceholder");
  fields.appendChild(searchInput);
  fields.appendChild(replaceInput);
  panel.appendChild(fields);

  const caseLabel = document.createElement("label");
  caseLabel.className = "streamreplace-case";
  const caseBox = document.createElement("input");
  caseBox.type = "checkbox";
  caseLabel.appendChild(caseBox);
  caseLabel.appendChild(document.createTextNode(t("findInFiles.matchCase")));
  panel.appendChild(caseLabel);

  const hint = document.createElement("div");
  hint.className = "streamreplace-hint";
  hint.textContent = t("streamReplace.caseInsensitiveHint");
  panel.appendChild(hint);

  const status = document.createElement("div");
  status.className = "streamreplace-status";
  panel.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "streamreplace-actions";
  const executeButton = document.createElement("button");
  executeButton.className = "streamreplace-execute";
  executeButton.textContent = t("streamReplace.executeButton");
  actions.appendChild(executeButton);
  panel.appendChild(actions);

  const close = (): void => {
    // A running replace cannot be cancelled — the Rust command will
    // finish and the file will change. Closing the panel mid-run would
    // only fake a cancel, so the panel stays until the run resolves.
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

  let busy = false;
  const updateExecuteEnabled = (): void => {
    executeButton.disabled = busy || searchInput.value === "";
  };
  searchInput.addEventListener("input", updateExecuteEnabled);
  updateExecuteEnabled();

  const runReplace = async (): Promise<void> => {
    if (busy || searchInput.value === "") return;
    busy = true;
    updateExecuteEnabled();
    status.textContent = t("streamReplace.replacing");
    // Whether to close the panel once busy clears below — close() itself
    // is a no-op while busy is true (see its guard above), so closing on
    // success can't happen until *after* finally clears busy, not from
    // inside this try (issue #98).
    let succeeded = false;
    try {
      const report = await streamReplaceInFile(
        path,
        searchInput.value,
        replaceInput.value,
        encoding,
        caseBox.checked,
      );
      const resultMessage = buildStreamReplaceResultMessage(
        report.replacements,
        report.unmatchedRegionReencoded,
        report.durabilityWarning,
      );
      if (report.replacements > 0) {
        status.textContent = "";
        await messageDialog(resultMessage, { title, kind: "info" });
        onReplaced();
        succeeded = true;
      } else {
        status.textContent = resultMessage;
      }
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      updateExecuteEnabled();
      if (succeeded) close();
    }
  };
  executeButton.addEventListener("click", () => void runReplace());
  for (const input of [searchInput, replaceInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runReplace();
      }
    });
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  searchInput.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
}
