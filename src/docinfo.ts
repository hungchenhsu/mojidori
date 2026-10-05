// Document Info dialog (File menu; ROADMAP.md v0.6 E1): a single read-only
// "file trust surface" — path, on-disk size/mtime, encoding + BOM +
// detection evidence (reusing detectcard.ts's explain_detection data flow,
// including its large-file truncated-sample warning verbatim), line-ending
// summary + LF/CRLF/CR distribution (bounded at the Rust core's large-file
// threshold, always disclosed when partial), and line/word/char counts
// (reusing editor.ts's textStatsOf via the caller, hidden for a truncated
// large-file window exactly like the status bar's own segment). Nothing
// here is a new capability — every fact shown is already computed or
// cheaply re-derivable elsewhere in the app; this dialog only puts them in
// one place (the moat-deepening "trust through transparency" framing in
// ROADMAP.md, not IDE creep).
//
// Untitled tabs (no on-disk path) get a reduced, buffer-only dialog rather
// than a disabled menu item: path/size/mtime and encoding-detection
// evidence need a real file to re-read, so those rows/notes are simply
// omitted, but encoding+BOM (already known from the tab's own state), the
// line-ending *summary* (doc.lineEnding, also already known), and text
// stats (computed from the live buffer, no disk access needed at all) are
// still genuinely useful to show for a not-yet-saved document. A disabled
// menu item was the other option considered (ROADMAP.md's own spec named
// both as acceptable); this one was chosen because it needs no new
// native-menu enable/disable sync command (menu.rs's `read_only`/
// `reopen_closed_tab` precedent for that kind of dynamic sync is real,
// easy-to-miss machinery — every tab-switch and Save-As completion would
// need to remember to call it) and because a not-yet-saved buffer's own
// trust facts are still worth surfacing, not hidden behind a disabled item.
//
// Snapshot semantics: every IPC call here fires once, when the dialog
// opens; the dialog does not live-refresh if the file changes on disk while
// it's open (closing and reopening it re-snapshots), the same trade-off
// `explain_detection`'s own callers already make.
//
// Each of the three IPC-backed sections (file metadata, encoding evidence,
// line-ending distribution) is independently resilient: one failing (the
// file was deleted, permissions changed, whatever) shows an inline error
// note in place of just that section rather than blanking the whole dialog
// or leaving it silently incomplete (CLAUDE.md's decode-error-surfacing
// discipline, generalized here to every fact this dialog shows). Issue
// #254: all three now come from one `documentInfoSnapshot` IPC round trip
// (backed by a single Rust-side `File::open` + `metadata()`) instead of
// three independent calls each doing its own open/stat — so the three can
// no longer describe three different moments of a file that changes
// underneath the dialog while it's loading. Per-section resilience still
// holds past that: the snapshot's `metadata`/`detection`/`lineEnding`
// fields are each independently "ok"/"error" (`lineEnding` additionally
// "skipped" for UTF-16), adapted below into this module's own `DocInfoFetch`
// shape, which predates the merge and is unaffected by it (still shared with
// the untitled-tab "skipped: untitled" case, which has no IPC call at all).
import { installModal } from "./modal";
import { t } from "./i18n";
import { formatDetectionEvidence } from "./detectcard";
import { formatSize } from "./statusbar";
import type { TextStats } from "./textstats";
import {
  documentInfoSnapshot,
  type DetectionExplanation,
  type DocumentInfoSectionResult,
  type DocumentMetadata,
  type LineEndingDistribution,
} from "./ipc";

export interface DocumentInfoRow {
  label: string;
  value: string;
}

export interface DocumentInfoSection {
  rows: DocumentInfoRow[];
  notes: string[];
}

export interface DocumentInfoDialogContent {
  title: string;
  fileSection: DocumentInfoSection;
  encodingSection: DocumentInfoSection;
  lineEndingSection: DocumentInfoSection;
  /** Null (section omitted entirely) for a truncated large-file window —
   *  mirrors the status bar's own hide-when-truncated convention for text
   *  stats (main.ts's `computeAndShowTextStats`); never a
   *  "window"-qualified partial value that could be mistaken for the whole
   *  document's stats. */
  textStatsSection: DocumentInfoSection | null;
}

/**
 * Outcome of one of this dialog's independent IPC round trips, or a
 * principled reason it was never attempted at all ("skipped" — an untitled
 * tab has no path to query; a UTF-16 document can't safely go through the
 * raw-byte line-ending scan, mirroring `buildLineIndex`'s own exclusion).
 * Distinct from "error", a genuine, unexpected failure (e.g. the file was
 * deleted since the tab was opened) that must still be surfaced to the
 * user, never silently blanked.
 */
export type DocInfoFetch<T> =
  | { status: "ok"; data: T }
  | { status: "error"; message: string }
  | { status: "skipped"; reason: "untitled" | "utf16" };

/**
 * Pure composition of the Document Info dialog's content from already-
 * resolved data, split out from the DOM-building `showDocumentInfo` below
 * so it can be vitest-covered without a WebView (mirrors lossysave.ts's
 * `buildLossySaveDialogContent` / detectcard.ts's `formatDetectionCard`
 * split).
 */
export function buildDocumentInfoDialogContent(input: {
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  /** True when the buffer holds unsaved edits. The dialog mixes two fact
   *  sources — text stats from the live buffer, everything disk-backed
   *  (size/mtime, detection evidence, line-ending distribution) from a
   *  fresh re-read of the file — which agree for a clean document but
   *  describe different content for a dirty one; the framing note this
   *  flag adds keeps the rows from reading as mutually corroborating
   *  when they aren't (issue #254). */
  dirty: boolean;
  metadata: DocInfoFetch<DocumentMetadata>;
  detection: DocInfoFetch<DetectionExplanation>;
  lineEndingDist: DocInfoFetch<LineEndingDistribution>;
  /** Null when the caller determined text stats shouldn't be shown at all
   *  (a truncated large-file window) — distinct from `DocInfoFetch` since
   *  this never involves an IPC call or an error state, only "shown" or
   *  "hidden", matching the existing status-bar precedent exactly. */
  textStats: { stats: TextStats; selected: boolean } | null;
}): DocumentInfoDialogContent {
  const fileRows: DocumentInfoRow[] = [];
  const fileNotes: string[] = [];
  // First section, first note, so the disk-vs-buffer split is framed
  // before any disk-backed row is read. Untitled tabs skip it: they have
  // no disk-backed rows for the buffer to disagree with.
  if (input.dirty && input.path !== null) {
    fileNotes.push(t("docinfo.dirtyNote"));
  }
  if (input.path === null) {
    fileRows.push({
      label: t("docinfo.labelPath"),
      value: t("docinfo.pathUnsaved", input.title),
    });
  } else {
    fileRows.push({ label: t("docinfo.labelPath"), value: input.path });
    if (input.metadata.status === "ok") {
      fileRows.push(
        { label: t("docinfo.labelSize"), value: formatSize(input.metadata.data.size) },
        {
          label: t("docinfo.labelModified"),
          value: formatDateTime(input.metadata.data.modifiedMs),
        },
      );
    } else if (input.metadata.status === "error") {
      fileNotes.push(t("docinfo.loadError", input.metadata.message));
    }
  }

  const encodingRows: DocumentInfoRow[] = [
    {
      label: t("docinfo.labelEncoding"),
      value: input.withBom
        ? t("statusbar.encodingWithBom", input.encoding)
        : input.encoding,
    },
  ];
  const encodingNotes: string[] = [];
  if (input.detection.status === "ok") {
    const evidence = formatDetectionEvidence(input.encoding, input.detection.data);
    encodingRows.push(...evidence.rows);
    for (const note of [
      evidence.manualNote,
      evidence.detectionBoundaryNote,
      evidence.truncatedSampleNote,
    ]) {
      if (note !== null) encodingNotes.push(note);
    }
  } else if (input.detection.status === "error") {
    encodingNotes.push(t("docinfo.loadError", input.detection.message));
  }

  const lineEndingRows: DocumentInfoRow[] = [
    { label: t("docinfo.labelLineEnding"), value: input.lineEnding },
  ];
  const lineEndingNotes: string[] = [];
  if (input.lineEndingDist.status === "ok") {
    const dist = input.lineEndingDist.data;
    lineEndingRows.push(
      { label: t("menu.lineEndingLf"), value: String(dist.lf) },
      { label: t("menu.lineEndingCrlf"), value: String(dist.crlf) },
      { label: t("menu.lineEndingCr"), value: String(dist.cr) },
      {
        label: t("docinfo.labelScanned"),
        value:
          dist.scannedBytes >= dist.totalSize
            ? t("detectcard.sampledAll", formatSize(dist.totalSize))
            : t(
                "detectcard.sampledPartial",
                formatSize(dist.scannedBytes),
                formatSize(dist.totalSize),
              ),
      },
    );
    if (dist.scannedBytes < dist.totalSize) {
      lineEndingNotes.push(t("docinfo.lineEndingSampledNote", formatSize(dist.scannedBytes)));
    }
  } else if (input.lineEndingDist.status === "error") {
    lineEndingNotes.push(t("docinfo.loadError", input.lineEndingDist.message));
  } else if (input.lineEndingDist.status === "skipped" && input.lineEndingDist.reason === "utf16") {
    lineEndingNotes.push(t("docinfo.lineEndingUtf16Note"));
  }

  const textStatsSection: DocumentInfoSection | null =
    input.textStats === null
      ? null
      : {
          rows: [
            {
              label: t("docinfo.labelTextStats"),
              value: input.textStats.selected
                ? t(
                    "statusbar.textStatsSelection",
                    input.textStats.stats.words,
                    input.textStats.stats.chars,
                    input.textStats.stats.lines,
                  )
                : t(
                    "statusbar.textStats",
                    input.textStats.stats.words,
                    input.textStats.stats.chars,
                    input.textStats.stats.lines,
                  ),
            },
          ],
          notes: [],
        };

  return {
    title: t("docinfo.title", input.title),
    fileSection: { rows: fileRows, notes: fileNotes },
    encodingSection: { rows: encodingRows, notes: encodingNotes },
    lineEndingSection: { rows: lineEndingRows, notes: lineEndingNotes },
    textStatsSection,
  };
}

/**
 * Format a millisecond epoch timestamp for display using the runtime's own
 * locale/timezone (`toLocaleString`) — there is no existing date-
 * formatting precedent elsewhere in this app to reuse (statusbar.ts only
 * ever formats byte sizes, see `formatSize`), and the app's own i18n locale
 * is a UI-text language choice independent of the OS's date/time
 * formatting convention, so deferring to the WebView's own locale here is
 * consistent with how a native Finder/Explorer "Get Info" panel would show
 * a timestamp.
 */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function renderSection(dialog: HTMLElement, section: DocumentInfoSection): void {
  const dl = document.createElement("dl");
  dl.className = "detectcard-rows";
  for (const row of section.rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  dialog.appendChild(dl);
  for (const note of section.notes) {
    const p = document.createElement("p");
    p.className = "detectcard-note docinfo-note";
    p.textContent = note;
    dialog.appendChild(p);
  }
}

function renderDialog(dialog: HTMLElement, content: DocumentInfoDialogContent, onClose: () => void): void {
  dialog.innerHTML = "";
  dialog.setAttribute("role", "dialog");

  const title = document.createElement("p");
  title.className = "confirm-dialog-title";
  title.id = "docinfo-title";
  title.textContent = content.title;
  dialog.appendChild(title);
  dialog.setAttribute("aria-labelledby", title.id);

  renderSection(dialog, content.fileSection);
  renderSection(dialog, content.encodingSection);
  renderSection(dialog, content.lineEndingSection);
  if (content.textStatsSection) renderSection(dialog, content.textStatsSection);

  const buttons = document.createElement("div");
  buttons.className = "confirm-buttons";
  const close = document.createElement("button");
  close.className = "confirm-primary";
  close.textContent = t("docinfo.close");
  close.addEventListener("click", onClose);
  buttons.appendChild(close);
  dialog.appendChild(buttons);

  close.focus();
}

/** Narrow one section of a `documentInfoSnapshot` response (ipc.ts's
 *  `DocumentInfoSectionResult<T>`, "ok" | "error") into this module's own
 *  `DocInfoFetch<T>` — a strict subset of it missing only the "skipped"
 *  variant, which `sectionToFetch` itself never needs to produce: the
 *  untitled-tab case is decided before any IPC call is made at all (see
 *  `showDocumentInfo` below), and the line-ending section's own "skipped"
 *  (UTF-16) case is handled separately where it's read, since `ipc.ts`'s
 *  `DocumentInfoLineEndingResult` isn't a `DocumentInfoSectionResult<T>`
 *  itself. */
function sectionToFetch<T>(section: DocumentInfoSectionResult<T>): DocInfoFetch<T> {
  return section.status === "ok"
    ? { status: "ok", data: section.data }
    : { status: "error", message: section.message };
}

/**
 * Open the read-only Document Info dialog for the active document. Fires
 * one `documentInfoSnapshot` IPC round trip (issue #254) and renders once
 * it settles; see the module doc comment for the untitled-tab and
 * error-handling design. Only one instance can be open at a time (mirrors
 * detectcard.ts's `.detectcard-panel` already-open guard).
 *
 * `textStats` is precomputed by the caller (main.ts) — this module
 * deliberately never reaches into editor.ts itself, matching every other
 * dialog module's own decoupling from the live CM6 instance — and should
 * already be `null` for a truncated large-file window (mirrors main.ts's
 * `computeAndShowTextStats`).
 *
 * `extensionEncoding` is the same per-extension hint `openDocument` got
 * for this path (main.ts's `extensionHint`), forwarded to
 * `documentInfoSnapshot` so the dialog explains the detection that actually
 * ran — omitting it re-runs detection with different inputs and can show
 * a different verdict/provenance than the one that chose the document's
 * encoding (issue #255; ipc.ts's `documentInfoSnapshot` doc comment and
 * detectcard.ts's Why Encoding? card follow the same contract).
 */
export function showDocumentInfo(doc: {
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  /** Unsaved-edits flag, threaded through to the dialog's disk-vs-buffer
   *  framing note (issue #254) — see buildDocumentInfoDialogContent. */
  dirty: boolean;
  extensionEncoding?: string;
  textStats: { stats: TextStats; selected: boolean } | null;
}): void {
  if (document.querySelector(".docinfo-dialog")) return;

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog docinfo-dialog";
  dialog.textContent = t("common.loading");
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  // Named by its title once renderDialog draws it (see below).
  installModal(overlay, dialog);

  const finish = (): void => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  };
  document.addEventListener("keydown", onKey, true);

  interface Resolved {
    metadata: DocInfoFetch<DocumentMetadata>;
    detection: DocInfoFetch<DetectionExplanation>;
    lineEndingDist: DocInfoFetch<LineEndingDistribution>;
  }

  // Untitled tabs have no path to snapshot — decided here, before any IPC
  // call, exactly as before the merge (documentInfoSnapshot is never
  // invoked at all in this case, not called-and-ignored).
  const resolvedFetch: Promise<Resolved> =
    doc.path === null
      ? Promise.resolve({
          metadata: { status: "skipped", reason: "untitled" },
          detection: { status: "skipped", reason: "untitled" },
          lineEndingDist: { status: "skipped", reason: "untitled" },
        })
      : documentInfoSnapshot(doc.path, doc.extensionEncoding, doc.encoding).then(
          (snapshot): Resolved => ({
            metadata: sectionToFetch(snapshot.metadata),
            detection: sectionToFetch(snapshot.detection),
            lineEndingDist:
              snapshot.lineEnding.status === "skipped"
                ? { status: "skipped", reason: "utf16" }
                : sectionToFetch(snapshot.lineEnding),
          }),
          (reason: unknown): Resolved => {
            // The snapshot call itself rejected: not even total_size could
            // be established (the file didn't open, or its fstat failed),
            // so nothing could be derived for *any* section — every
            // section shows the same load error rather than only one
            // (docinfo.rs's `document_info_snapshot` doc comment).
            const message = String(reason);
            return {
              metadata: { status: "error", message },
              detection: { status: "error", message },
              lineEndingDist: { status: "error", message },
            };
          },
        );

  void resolvedFetch.then(({ metadata, detection, lineEndingDist }) => {
    if (!document.body.contains(overlay)) return; // closed while loading
    const content = buildDocumentInfoDialogContent({
      path: doc.path,
      title: doc.title,
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
      dirty: doc.dirty,
      metadata,
      detection,
      lineEndingDist,
      textStats: doc.textStats,
    });
    renderDialog(dialog, content, finish);
  });
}
