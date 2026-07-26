// Streaming encoding conversion for large-file (truncated) preview windows
// (ROADMAP.md v0.4 Track B) [danger]: a truncated preview only ever has a
// bounded slice of the file loaded, so "Save with Encoding" (which
// re-encodes whatever's currently in the editor buffer) cannot be used to
// change such a file's encoding — see main.ts's showEncodingMenu. This
// instead calls the Rust streaming conversion command directly against the
// file on disk (src-tauri/src/streamconvert.rs) and asks the caller to
// reload the document afterward.
//
// Unlike streamreplace.ts, there is no persistent input panel here — the
// target encoding is already chosen from the encoding menu's own submenu
// (main.ts's showEncodingMenu, encodings.ts's streamConvertEncodingChoices),
// so this module is just the orchestrating flow: call, handle the two-stage
// lossy gate, reload. The two-stage confirm reuses lossysave.ts's
// showLossySaveConfirm verbatim — the exact same dialog save_document's own
// lossy rejection drives — since streamconvert.rs's report shares the
// identical LossyReport shape.
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { streamConvertFile } from "./ipc";
import { showLossySaveConfirm } from "./lossysave";

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Guards re-entrancy across the whole flow — there is no per-invocation
 *  panel instance to hang a local `busy` flag off, unlike streamreplace.ts's
 *  panel. A conversion cannot be cancelled once started (the same "no real
 *  yield point the user can safely interrupt" reasoning behind
 *  streamreplace.ts's busy-blocks-close), just enforced at the module level
 *  instead of a panel's close() guard: a re-entrant call (e.g. reopening the
 *  encoding menu and picking another target while one is already running)
 *  is silently ignored. */
let converting = false;

/**
 * Minimal, non-dismissable "please wait" overlay: reuses the
 * `.confirm-overlay`/`.confirm-dialog` classes every other in-DOM modal in
 * this codebase already shares, but with no buttons and no Escape/away-click
 * handling at all — mirrors streamreplace.ts's "a running replace cannot be
 * cancelled" precedent exactly, just with no panel to guard a close() call
 * on. Returns a function that removes it; safe to call more than once
 * (`Element.remove()` on an already-detached node is a no-op).
 */
function showBusyOverlay(message: string): () => void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog";
  const text = document.createElement("p");
  text.textContent = message;
  dialog.appendChild(text);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return () => overlay.remove();
}

async function withBusyOverlay<T>(message: string, run: () => Promise<T>): Promise<T> {
  const hide = showBusyOverlay(message);
  try {
    return await run();
  } finally {
    hide();
  }
}

/**
 * Pure composition of the streaming-convert result text — split out from
 * the DOM-driving runStreamConvert below so it's vitest-covered without a
 * WebView (mirrors streamreplace.ts's buildStreamReplaceResultMessage).
 * Appends a note when `durabilityWarning` is non-null (issue #328's third
 * review round — `StreamConvertReport.durabilityWarning`'s own doc
 * comment): the conversion itself landed on disk, but the follow-up
 * parent-directory `fsync` that would confirm it survives an immediate
 * crash could not be completed. Never a failure on its own, so this stays
 * on the same success dialog rather than gating anything.
 */
export function buildStreamConvertResultMessage(
  targetEncoding: string,
  durabilityWarning: string | null,
): string {
  const base = t("streamConvert.resultMessage", targetEncoding);
  // Truthy check, not `!== null`, to match every other optional-note flag
  // in this codebase (e.g. StreamReplaceReport's own
  // unmatchedRegionReencoded) — an older/looser mock or caller that omits
  // this field entirely (`undefined`) must behave identically to an
  // explicit `null`, not append a stray "undefined" note.
  return durabilityWarning
    ? `${base} ${t("statusbar.durabilityWarning", durabilityWarning)}`
    : base;
}

/**
 * Convert `path` (the active truncated document's file on disk, currently
 * `sourceEncoding`) to `target`, streaming on the Rust side. `onConverted` is
 * called once, only after a write actually reached disk, so the caller can
 * update `doc.encoding`/`doc.withBom` to `target` *before* reloading (e.g.
 * via `reloadFromDisk`) — see main.ts's call site: `reloadFromDisk` reopens
 * with whatever `doc.encoding` already holds, so it must already be the
 * *new* encoding by the time it runs, not the one the file used to have. A
 * no-op while a previous call is still in flight.
 */
export async function runStreamConvert(
  path: string,
  sourceEncoding: string,
  target: { value: string; withBom: boolean },
  onConverted: () => void,
): Promise<void> {
  if (converting) return;
  converting = true;
  const title = t("streamConvert.title", basename(path));
  try {
    let report = await withBusyOverlay(t("streamConvert.converting", target.value), () =>
      streamConvertFile(path, sourceEncoding, target.value, target.withBom, false),
    );
    if (!report.written && report.lossyReport) {
      const proceed = await showLossySaveConfirm(target.value, report.lossyReport);
      if (!proceed) return;
      report = await withBusyOverlay(t("streamConvert.converting", target.value), () =>
        streamConvertFile(path, sourceEncoding, target.value, target.withBom, true),
      );
    }
    if (report.written) {
      await messageDialog(
        buildStreamConvertResultMessage(target.value, report.durabilityWarning),
        { title, kind: "info" },
      );
      onConverted();
    } else {
      // Defensive: allowLossy: true still coming back written: false has no
      // known cause (mirrors save_document's own contract), but this
      // surfaces something rather than silently doing nothing if it ever
      // happened.
      await messageDialog(t("streamConvert.failedMessage"), { title, kind: "error" });
    }
  } catch (error) {
    await messageDialog(String(error), { title, kind: "error" });
  } finally {
    converting = false;
  }
}
