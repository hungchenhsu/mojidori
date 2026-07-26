import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  confirm as confirmDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  characterBeforeCursor,
  contentOf,
  createEditor,
  cursorOf,
  detectIndentationOf,
  isEmptyBuffer,
  isNonNfcOf,
  lineCountOf,
  suspiciousCharCountOf,
  textStatsOf,
} from "./editor";
import { showCharInspector } from "./charinspect";
import {
  encodingChoices,
  filterEncodingChoices,
  groupEncodingChoices,
  matchedEncodingAlias,
  reopenEncodingChoices,
  streamConvertEncodingChoices,
  type EncodingChoice,
} from "./encodings";
import { getLocale, onLocaleChange, t } from "./i18n";
import {
  addRecentFile,
  buildLineIndex,
  checkByteDrift,
  checkRepresentable,
  clearRecentFiles,
  documentMetadata,
  listBackups,
  loadBackup,
  loadRecentFiles,
  loadSession,
  locateLineOffset,
  openDocument,
  openfileProbePath,
  paletteCommands,
  printWindow,
  readDocumentChunk,
  readDocumentChunkBefore,
  reportOpenfileReady,
  reportStartupReady,
  deleteBackup,
  saveBackup,
  saveDocument,
  saveSession,
  syncClearRecentMenu,
  syncReadOnlyMenu,
  syncReopenClosedTabMenu,
  takePendingFiles,
  unwatchFile,
  watchFile,
  type LineIndex,
  type OpenedDocument,
  type PaletteCommand,
  type SessionData,
  type SessionFile,
} from "./ipc";
import {
  captureIdentity,
  reloadEncodingFor,
  validateIdentity,
  type GuardIdentity,
} from "./asyncguard";
import { createBackupPipeline } from "./backuppipeline";
import { createBackupFlushScheduler } from "./backupflush";
import { createOpQueue } from "./opqueue";
import { showBatchConvert } from "./batchconvert";
import {
  nextBookmark,
  previousBookmark,
  toggleBookmark,
  windowRelativeBookmarks,
} from "./bookmarks";
import { runByteDriftGate } from "./bytedrift";
import { canAutoAppend, canPrepend, pagingSupported } from "./chunkpolicy";
import { preemptChunkLoad, shouldApplyChunkResponse } from "./chunkguard";
import { hasClosedTabs, popClosedTab, recordClosedTab } from "./closedtabs";
import { showComparePreview } from "./comparepreview";
import { lookupExtensionEncoding } from "./extensionEncodings";
import { pushBack, pushFront } from "./chunkwindow";
import { showCloseConfirm } from "./confirm";
import { showLossySaveConfirm } from "./lossysave";
import { showStaleFileConfirm } from "./stalefile";
import { showDetectionCard } from "./detectcard";
import { showDocumentInfo } from "./docinfo";
import { showFindInFiles } from "./findinfiles";
import { showGoToLine } from "./goto";
import { showHexView } from "./hexview";
import { formatInsertDateTime } from "./insertdatetime";
import { clampLine, indexMatchesBaseline, selectCheckpoint } from "./lineindex";
import {
  convertLeadingSpacesToTabs,
  convertLeadingTabsToSpaces,
  joinLines,
  lowerCase,
  reverseLines,
  sortLines,
  sortLinesCaseInsensitive,
  sortLinesNumeric,
  toFullWidth,
  toHalfWidth,
  trimTrailingWhitespace,
  uniqueLines,
  upperCase,
} from "./lineops";
import { isConfirmedMissing } from "./missingondisk";
import { isMojibakeSnapshotStale, showMojibakeWizard } from "./mojibake";
import { planNormalization, type NormalizeForm } from "./normalize";
import { orphanBackups } from "./orphans";
import { showPalette } from "./palette";
import { showQuickOpen } from "./quickopen";
import { showFilterableMenu, showMenu, type MenuItem } from "./popup";
import { decideSaveCompletion } from "./savecompletion";
import { isLikelySaveEcho, SAVE_ECHO_WINDOW_MS, type SaveEchoRecord } from "./saveecho";
import { fingerprintsEqual, mustDefer, nextDrainStep } from "./savemutex";
import { createSessionPersister } from "./sessionpersist";
import { runStreamConvert } from "./streamconvert";
import { showStreamReplace } from "./streamreplace";
import { shouldTrimTrailingWhitespaceOnSave } from "./trimonsave";
import { checkForUpdatesAndPrompt, type UpdaterDeps } from "./updater";
import { flushWithRevisionRecheck } from "./updaterflush";
import {
  adjustFontSize,
  initPreferences,
  preferences,
  setTheme,
  showPreferencesDialog,
  toggleIndentGuides,
  toggleShowInvisibles,
  toggleSuspiciousChars,
  toggleWordWrap,
} from "./preferences";
import {
  currentCursorLine,
  currentInspectedChar,
  refreshCharInspector,
  refreshCursor,
  refreshIndentInfo,
  refreshNormalizationStatus,
  refreshStatusBar,
  refreshSuspiciousChars,
  refreshTextStats,
  setIndexing,
  setUpdating,
  updateCharInspector,
  updateCursor,
  updateIndentInfo,
  updateNormalizationStatus,
  updatePager,
  updateStatusBar,
  updateSuspiciousChars,
  updateTextStats,
} from "./statusbar";
import {
  canMutateDocument,
  closeSequentially,
  idsOtherThan,
  idsToTheRightOf,
  isEffectivelyReadOnly,
  TabStore,
  type Doc,
  type SpeculativeEncoding,
} from "./tabs";

const defaultLineEnding = navigator.userAgent.includes("Windows")
  ? "CRLF"
  : "LF";

let nextId = 1;
let untitledCounter = 0;
/** Single app-wide sequence for Doc.revision (issue #112) — shared across
 *  all docs rather than a per-doc counter starting at 0, so that resetting
 *  a doc's revision on open/reload/reopen always draws a value strictly
 *  greater than anything assigned before, and can never spuriously match a
 *  stale revisionAtStart snapshot a concurrent saveFlow captured earlier
 *  (see tabs.ts Doc.revision and savecompletion.ts). */
let nextRevision = 1;

const tabs = new TabStore(document.querySelector<HTMLElement>("#tabbar")!, {
  onSelect: (id) => activate(id),
  onClose: (id) => void closeTab(id),
  onNew: () => newTab(),
  // Drag-to-reorder changes tab order, which is what session restore
  // replays on next launch — persist immediately, same timing as every
  // other order-affecting tab operation (activate/closeTab/openFile).
  onReorder: () => persistSession(),
  onContextMenu: (id, tab) => showTabContextMenu(id, tab),
});

// ---- Word/char/line count status-bar segment (ROADMAP.md v0.4 Track C).
// textStatsOf's whole-document pass is O(document length) — fine for a
// one-off (tab switch, open, reload — see showActive below, which calls
// computeAndShowTextStats directly) but too expensive to redo on every
// keystroke of a multi-MB file, unlike the cursor-position math in
// onCursorMoved below (O(log n) via Text.lineAt, and stays synchronous).
// There's no existing throttle on that cursor/doc-changed path to
// piggyback on — editor.ts's updateListener calls it synchronously on
// every CM6 transaction — so the expensive recompute gets its own
// debounce instead, mirroring backupFlush.schedule()'s debounce below.
const TEXTSTATS_DEBOUNCE_MS = 300;
let textStatsTimer: number | null = null;

/** Compute and show stats for whatever tab is active *right now* — always
 *  reads tabs.active/editor.snapshot() fresh rather than anything
 *  captured at schedule time, so a debounced recompute that fires after
 *  the user has switched (or closed) tabs just shows the new tab's own
 *  stats instead of stale ones for a tab that's no longer active. Also
 *  cancels any pending debounced recompute, so calling this directly
 *  (tab switch, open, reload, large-file jump — see showActive) never
 *  leaves a stale timer to redundantly re-fire moments later. */
function computeAndShowTextStats(): void {
  if (textStatsTimer !== null) {
    window.clearTimeout(textStatsTimer);
    textStatsTimer = null;
  }
  const doc = tabs.active;
  if (!doc || doc.truncated) {
    updateTextStats(null);
    return;
  }
  updateTextStats(textStatsOf(editor.snapshot()));
}

/** Debounced entry point for the high-frequency path (typing, selecting):
 *  recomputes only after edits/selection changes settle for a short
 *  moment, instead of on every keystroke. */
function scheduleTextStatsUpdate(): void {
  if (textStatsTimer !== null) window.clearTimeout(textStatsTimer);
  textStatsTimer = window.setTimeout(computeAndShowTextStats, TEXTSTATS_DEBOUNCE_MS);
}

// ---- Suspicious/invisible character audit status-bar count (ROADMAP.md
// v0.4 Track A). Same cost class and shape as the text-stats segment just
// above (O(document length) whole-document walk, so it needs its own
// debounce on the typing path and hides for large-file/truncated windows)
// but a distinct concern — kept as its own timer/function pair rather than
// folded into computeAndShowTextStats/scheduleTextStatsUpdate so each stays
// focused on one status-bar segment, matching how the character-inspector
// segment above already gets its own dedicated update call rather than
// being merged into the text-stats one it happens to share a trigger with.
// Unlike text stats, this never needs to distinguish "selection changed"
// from "document changed" (the audit is always whole-document, never
// selection-scoped — see editor.ts's `suspiciousCharCountOf`), so
// recomputing on every onCursorMoved call (which fires on both) is a
// harmless superset rather than a precision requirement.
const SUSPICIOUS_DEBOUNCE_MS = 300;
let suspiciousCharsTimer: number | null = null;

/** Compute and show the suspicious-char count for whatever tab is active
 *  *right now* — same freshness/cancel-pending-timer contract as
 *  `computeAndShowTextStats` above. Intentionally does NOT consult
 *  `preferences().suspiciousChars` (the View-menu inline-highlight toggle):
 *  that toggle only controls the CM6 decoration (editor.ts's
 *  `setSuspiciousChars`), not this status-bar count, the same way no other
 *  status-bar badge (decode-error, read-only) is gated by a View-menu
 *  display preference — see editor.ts's `setSuspiciousChars` doc comment. */
function computeAndShowSuspiciousChars(): void {
  if (suspiciousCharsTimer !== null) {
    window.clearTimeout(suspiciousCharsTimer);
    suspiciousCharsTimer = null;
  }
  const doc = tabs.active;
  if (!doc || doc.truncated) {
    updateSuspiciousChars(null);
    return;
  }
  updateSuspiciousChars(suspiciousCharCountOf(editor.snapshot()));
}

/** Debounced entry point mirroring `scheduleTextStatsUpdate` above. */
function scheduleSuspiciousCharsUpdate(): void {
  if (suspiciousCharsTimer !== null) window.clearTimeout(suspiciousCharsTimer);
  suspiciousCharsTimer = window.setTimeout(computeAndShowSuspiciousChars, SUSPICIOUS_DEBOUNCE_MS);
}

// ---- "Non-NFC" status-bar marker (ROADMAP.md v0.4 Track A Unicode
// normalization [danger]). Same cost class and shape as the suspicious-
// chars segment just above (an O(document length) whole-document walk via
// editor.ts's `isNonNfcOf`, so it needs its own debounce and hides for
// large-file/truncated windows) and, like that segment, always
// whole-document rather than selection-scoped, so recomputing on every
// onCursorMoved call is a harmless superset.
const NORMALIZATION_DEBOUNCE_MS = 300;
let normalizationTimer: number | null = null;

/** Compute and show the non-NFC marker for whatever tab is active *right
 *  now* — same freshness/cancel-pending-timer contract as
 *  `computeAndShowTextStats` above. */
function computeAndShowNormalizationStatus(): void {
  if (normalizationTimer !== null) {
    window.clearTimeout(normalizationTimer);
    normalizationTimer = null;
  }
  const doc = tabs.active;
  if (!doc || doc.truncated) {
    updateNormalizationStatus(null);
    return;
  }
  updateNormalizationStatus(isNonNfcOf(editor.snapshot()));
}

/** Debounced entry point mirroring `scheduleTextStatsUpdate` above. */
function scheduleNormalizationStatusUpdate(): void {
  if (normalizationTimer !== null) window.clearTimeout(normalizationTimer);
  normalizationTimer = window.setTimeout(
    computeAndShowNormalizationStatus,
    NORMALIZATION_DEBOUNCE_MS,
  );
}

// ---- Indentation detection status-bar segment + CM6 indentUnit/tabSize
// wiring (ROADMAP.md v0.4 Track C). Same cost class and shape as text
// stats/suspicious chars above (an O(sampled-lines) walk, bounded by
// editor.ts's INDENT_DETECTION_SAMPLE_LINES so it's cheap even on a huge
// file, but still gets its own debounce rather than recomputing on every
// keystroke). Unlike text stats/suspicious chars, this is NOT hidden for a
// truncated large-file window — see editor.ts `detectIndentationOf`'s doc
// comment for why indentation is a "whatever's currently loaded" question,
// not a whole-file total a partial window would misrepresent.
const INDENT_DEBOUNCE_MS = 300;
let indentTimer: number | null = null;

/** Compute the active tab's indentation style, apply it to CM6's
 *  indentUnit/tabSize (editor.ts `setIndentation`), and show it in the
 *  status bar — same freshness/cancel-pending-timer contract as
 *  `computeAndShowTextStats` above. */
function computeAndShowIndent(): void {
  if (indentTimer !== null) {
    window.clearTimeout(indentTimer);
    indentTimer = null;
  }
  const doc = tabs.active;
  if (!doc) {
    updateIndentInfo(null);
    return;
  }
  const detected = detectIndentationOf(editor.snapshot());
  editor.setIndentation(detected, preferences().indentWidth);
  updateIndentInfo(detected);
}

/** Debounced entry point mirroring `scheduleTextStatsUpdate` above. Like
 *  `scheduleSuspiciousCharsUpdate`, this never needs to distinguish
 *  "selection changed" from "document changed" (indentation detection is
 *  always whole-buffer, never selection-scoped), so recomputing on every
 *  onCursorMoved call (which fires on both) is a harmless superset rather
 *  than a precision requirement — same reasoning as that function's own
 *  doc comment in editor.ts. */
function scheduleIndentUpdate(): void {
  if (indentTimer !== null) window.clearTimeout(indentTimer);
  indentTimer = window.setTimeout(computeAndShowIndent, INDENT_DEBOUNCE_MS);
}

/** Cursor-position callback CM6 fires on every doc/selection change (see
 *  editor.ts's updateListener) — also schedules the debounced text-stats
 *  recompute above, since the same two triggers (content or selection
 *  changed) are exactly what should invalidate it, and updates the
 *  character-inspector status-bar segment (ROADMAP.md v0.4 Track A).
 *  Unlike text stats, the character-inspector recompute runs synchronously
 *  here with no debounce: `characterBeforeCursor` is O(log n) (a
 *  `Text.lineAt` plus an at-most-2-code-unit slice), the same cost class as
 *  `updateCursor`'s own line/column math just above, not the whole-document
 *  O(document length) `textStatsOf` walk that needs one. Runs the same in a
 *  large-file (truncated) window: unlike text stats it is not gated on
 *  `doc.truncated` at all (see statusbar.ts's `updateCharInspector`). */
function onCursorMoved(line: number, column: number): void {
  updateCursor(line, column);
  updateCharInspector(characterBeforeCursor(editor.snapshot()));
  scheduleTextStatsUpdate();
  scheduleSuspiciousCharsUpdate();
  scheduleNormalizationStatusUpdate();
  scheduleIndentUpdate();
}

const editor = createEditor(
  document.querySelector("#editor")!,
  () => {
    const doc = tabs.active;
    // Programmatic chunk appends must not mark read-only previews dirty.
    if (doc && !doc.truncated) {
      // Bumped unconditionally (not just on the clean->dirty transition
      // below) so a saveFlow already in flight can tell a later edit
      // happened even though the doc was already dirty (issue #112).
      doc.revision = nextRevision++;
      if (!doc.dirty) {
        doc.dirty = true;
        tabs.render();
        updateWindowTitle();
      }
      backupFlush.schedule();
    }
  },
  onCursorMoved,
  () => void autoAppendChunk(),
  () => void prependChunk(),
);

// ---- Hot exit: unsaved buffers are continuously backed up so closing the
// window never needs to ask about unsaved changes.

const BACKUP_DEBOUNCE_MS = 2000;

/** Per-document ordered backup writes/deletes; `doc.backupName` is
 *  committed only after a write verifiably lands, so `collectSession`
 *  can never reference a backup file that doesn't exist (issue #263 —
 *  see backuppipeline.ts's header for the full failure-mode inventory).
 *  Flush results stay boolean rather than throwing: mid-editing flushes
 *  are best-effort, but the close handler must know — closing on a
 *  failed flush would silently lose the content hot exit promised to
 *  keep (issue #63). */
const backups = createBackupPipeline({
  save: saveBackup,
  remove: deleteBackup,
});

/** Debounced hot-exit backup of the active document (see backupflush.ts's
 *  header for the timer-vs-tab-switch contract this enforces, issue #253).
 *  persistSession runs only after a *successful* backup write, so the
 *  session file never references a backup that hasn't landed on disk —
 *  a failed or superseded write keeps the last consistent session
 *  instead (issue #263). */
const backupFlush = createBackupFlushScheduler<Doc>({
  debounceMs: BACKUP_DEBOUNCE_MS,
  active: () => tabs.active,
  activeContent: () => editor.content(),
  flush: (doc, content) =>
    backups.flush(doc, content).then((ok) => {
      if (ok) persistSession();
    }),
});

function updateWindowTitle(): void {
  const doc = tabs.active;
  const title = doc
    ? `${doc.dirty ? "• " : ""}${doc.title} — Mojidori`
    : "Mojidori";
  void getCurrentWindow().setTitle(title).catch(() => {
    // Title sync is cosmetic; never surface errors for it.
  });
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function makeUntitled(): Doc {
  untitledCounter += 1;
  return {
    id: nextId++,
    path: null,
    title:
      untitledCounter === 1
        ? t("app.untitled")
        : t("app.untitledNumbered", untitledCounter),
    encoding: preferences().defaultEncoding,
    withBom: preferences().defaultBom,
    lineEnding: defaultLineEnding,
    malformed: false,
    dirty: false,
    revision: 0,
    truncated: false,
    userReadOnly: false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    saveReloadInFlight: null,
    pendingReload: false,
    pendingSaveAs: null,
    speculativeEncoding: null,
    backupName: null,
    detectionHint: null,
    fingerprint: null,
    byteDriftChecked: false,
    buffer: editor.newBuffer(""),
  };
}

/** True while the updater flow (src/updater.ts's promptAndInstall, via
 *  `UpdaterDeps.freezeForUpdate`/`unfreezeForUpdate`) has frozen editing to
 *  flush hot-exit backups without racing a keystroke (ROADMAP.md D2,
 *  Codex re-review of PR #309) — see `freezeForUpdate`'s own doc comment
 *  below for the full race this closes. ORed into `syncReadOnlyState`
 *  below (not just set once on whichever tab happened to be active) so
 *  the freeze survives a tab switch mid-flush: `showActive` calls
 *  `syncReadOnlyState` on every switch with the *new* tab's own
 *  `isEffectivelyReadOnly`, which alone would silently re-enable typing
 *  on that tab and defeat the freeze.
 *
 *  ENTRY-POINT AUDIT (Codex re-review, 4th round — read this before adding
 *  any new entry point that changes document content or save-relevant
 *  metadata): the freeze is only as good as every path that can mutate a
 *  doc going through `canMutateDocument`/`blockedByReadOnly` (tabs.ts /
 *  this file) or the CM6 read-only compartment (editor.ts) it also
 *  reconfigures. Three rounds each found a different *class* of path that
 *  didn't: (1) native menu/palette commands going straight to CM6
 *  dispatch instead of through the compartment (runLineOperation/
 *  saveFlow — fixed via blockedByReadOnly); (2) async flows that passed
 *  their own entry guard *before* the freeze started and apply their
 *  result after an await gap the freeze doesn't interrupt (mojibake
 *  repair wizard, Edit > Normalize — fixed via a re-check at the actual
 *  apply point, since neither flow's own staleness check — content diff /
 *  revision diff — can see a freeze that produces neither); (3)
 *  synchronous status-bar pickers reached by a DOM click listener, never
 *  through the native menu or CM6 dispatch at all (setLineEnding, Save
 *  with Encoding in showEncodingMenu).
 *
 *  Audit method used to compile this list (repeat it for any future
 *  addition): `grep -n "nextRevision++\|\.dirty = \|backupFlush\.schedule("
 *  src/main.ts` — every hit is a doc mutation or something that needs
 *  hot-exit backup coverage; trace each backward to its UI entry point(s).
 *  Full result, entry point -> disposition:
 *    - CM6 onChange listener (real typing) -> not a new entry point, the
 *      thing the read-only compartment itself blocks; only reachable at
 *      all when the compartment allows it.
 *    - runLineOperation (all Edit > Line Operations items, insert_datetime,
 *      replace_in_selection/replace_all_in_selection) -> guarded via
 *      blockedByReadOnly (round 1).
 *    - saveFlow -> guarded via blockedByReadOnly (pre-existing, predates
 *      this freeze; freeze-aware since canMutateDocument covers it).
 *    - showMojibakeRepairWizard's apply callback -> guarded via
 *      blockedByReadOnly at the apply point (round 2).
 *    - runNormalizeFlow's three editor.replaceContent checkpoints ->
 *      guarded via normalizeGuardOutcome's "frozen" verdict (round 2).
 *    - setLineEnding (status-bar line-ending picker) -> guarded via
 *      blockedByReadOnly; picker items also disabled while frozen (round
 *      4, no IPC cost unlike a native menu item).
 *    - showEncodingMenu's "Save with Encoding" action -> guarded via
 *      blockedByReadOnly; picker items also disabled while frozen (round
 *      4).
 *    - reloadFromDisk / applyOpenedForReopen (Reload, Reopen with
 *      Encoding) -> not guarded, deliberately: both *discard* the live
 *      buffer and replace it with disk content — they don't create new,
 *      unbacked content the way every guarded case above does — and both
 *      already require the user to confirm discarding unsaved changes
 *      through their own existing dialog, independent of this freeze.
 *    - Paste / drag-drop into the editor, the @codemirror/search panel's
 *      own Replace -> not separately guarded: both are native CM6
 *      commands that already consult `state.readOnly` themselves (see
 *      editor.ts's `readOnlyExtension` doc comment), so the compartment
 *      alone covers them.
 *    - batch_convert / stream_replace (Find/Replace in Files) -> out of
 *      scope: both write directly to files on disk via a streaming Rust
 *      command, never touching the live CM6 buffer this freeze/flush is
 *      about.
 *    - Tab close/reorder, bookmarks, session/window-state bookkeeping
 *      (persistSession's other call sites) -> out of scope: none of these
 *      are document content or save-relevant metadata (what a save would
 *      write to disk); a tab closing mid-flush is already handled by
 *      flushWithRevisionRecheck's signature comparison (updaterflush.ts),
 *      not by blocking the close itself.
 */
let updateFreezeActive = false;

/** Sync the editor's CM6 readOnly compartment and the View > Read-Only
 *  native menu item (checked + enabled) to `doc`'s effective read-only
 *  state (ROADMAP.md v0.4 Track C), ORed with `updateFreezeActive` above —
 *  called from `showActive` (every tab switch/open/reload/jump) and from
 *  `toggleReadOnly` (the menu action itself), so both entry points
 *  converge on the same doc-derived truth rather than each separately
 *  guessing whether the menu already agrees. `enabled: !doc.truncated &&
 *  !updateFreezeActive` disables the item entirely both for a large-file
 *  preview (its read-only state can never be lifted) and while frozen
 *  (clicking Toggle Read-Only mid-freeze would flip `doc.readOnly` itself,
 *  a real, persisted mutation the freeze has no business allowing) — see
 *  menu.rs `sync_read_only_menu` and its `CheckMenuItem::set_enabled`.
 *  Best-effort like the other menu-sync IPC calls (syncThemeMenu/
 *  retitleMenu): the editor's own enforcement via setReadOnly is
 *  unaffected if this fails. */
function syncReadOnlyState(doc: Doc): void {
  const effective = updateFreezeActive || isEffectivelyReadOnly(doc);
  editor.setReadOnly(effective);
  void syncReadOnlyMenu(effective, !doc.truncated && !updateFreezeActive).catch(() => {
    // Best-effort; see doc comment above.
  });
}

/** Freeze the editor read-only and show the "Preparing update…" status-bar
 *  hint (ROADMAP.md D2, Codex re-review of PR #309) — called from
 *  src/updater.ts's promptAndInstall right before the hot-exit flush that
 *  must run before `install`. Closes a keystroke-loss race: without this,
 *  a user could keep typing during `flushForUpdateRestart`'s own `await`
 *  IPC round trips; anything typed *after* that function's content
 *  snapshot was taken would exist only in the live buffer, never reach
 *  the backup or disk, and `plugin:process|restart`/a Windows install's
 *  `exit(0)` bypass `onCloseRequested` entirely — the same reasoning
 *  `UpdaterDeps.flushForExit`'s own doc comment (updater.ts) already
 *  covers for why the flush has to happen explicitly at all. Every path
 *  out of that flow that does not end in a successful `install` handing
 *  off to `relaunch` must call `unfreezeForUpdate` — enforced there via
 *  try/finally, not here. */
function freezeForUpdate(): void {
  updateFreezeActive = true;
  const doc = tabs.active;
  if (doc) syncReadOnlyState(doc);
  setUpdating(true);
}

/** Reverses `freezeForUpdate`. See that function's doc comment for the
 *  try/finally contract its caller (updater.ts's promptAndInstall) must
 *  honor. */
function unfreezeForUpdate(): void {
  updateFreezeActive = false;
  const doc = tabs.active;
  if (doc) syncReadOnlyState(doc);
  setUpdating(false);
}

/** Sync the editor view and status bar to the active tab. */
function showActive(): void {
  const doc = tabs.active;
  if (!doc) return;
  editor.swap(doc.buffer);
  syncReadOnlyState(doc);
  tabs.render();
  updateStatusBar(doc);
  updatePager(pagerState(doc));
  // Immediate, not debounced: this is a discrete tab switch/open/reload/
  // jump, not the high-frequency typing path scheduleTextStatsUpdate
  // exists for. Also cancels whatever editor.swap's own onCursorMoved
  // call just scheduled, so it can't redundantly re-fire later.
  computeAndShowTextStats();
  computeAndShowSuspiciousChars();
  computeAndShowNormalizationStatus();
  computeAndShowIndent();
  updateWindowTitle();
  editor.focus();
  // No syntax highlighting for large-file windows: parsing tens of MB
  // (and re-parsing on every append) would stall the WebView.
  void editor.setLanguage(
    doc.truncated ? null : doc.title,
    () => tabs.activeId === doc.id,
  );
  syncBookmarkGutter();
}

/** Toggle the active tab's user-driven read-only lock (View menu;
 *  ROADMAP.md v0.4 Track C). A no-op for a truncated large-file preview —
 *  its read-only state can never be lifted, and the View menu item is
 *  kept disabled for it (syncReadOnlyState/showActive), so this normally
 *  isn't even reachable for one, but stays defensive rather than assuming
 *  the menu's disabled state is the only thing standing in the way. */
function toggleReadOnly(): void {
  const doc = tabs.active;
  if (!doc || doc.truncated) return;
  doc.userReadOnly = !doc.userReadOnly;
  syncReadOnlyState(doc);
  updateStatusBar(doc);
  persistSession();
}

function collectSession(): SessionData {
  const sessionDocs = tabs.docs.filter(
    (d) => d.path !== null || (d.dirty && d.backupName !== null),
  );
  const files: SessionFile[] = sessionDocs.map((d) => ({
    path: d.path,
    encoding: d.encoding,
    cursor: cursorOf(d.id === tabs.activeId ? editor.snapshot() : d.buffer),
    backup: d.dirty ? d.backupName : null,
    title: d.title,
    withBom: d.withBom,
    lineEnding: d.lineEnding,
    userReadOnly: d.userReadOnly,
  }));
  const active = sessionDocs.findIndex((d) => d.id === tabs.activeId);
  return { files, active: Math.max(active, 0) };
}

/** Serializes every on-disk session write (v0.7 Track R, following PR
 *  #270's recentOps pattern): saveSession's IPC calls can resolve out of
 *  order, so an in-flight write from an earlier mutation finishing after a
 *  later one's would overwrite session.json with a stale snapshot.
 *  collectSession stays here (it reads tabs/editor, both main.ts-local);
 *  only the queue + capture-at-call-time mechanics live in
 *  sessionpersist.ts, pulled out so that contract gets real vitest
 *  coverage — main.ts itself isn't unit-testable (backupflush.ts's header
 *  has the same reasoning). See preferences.ts's prefsOps for the sibling
 *  case. */
const sessionPersist = createSessionPersister({
  collect: collectSession,
  save: saveSession,
});

function persistSession(): void {
  void sessionPersist.persist().catch(() => {
    // Session persistence is best-effort; never interrupt editing over it.
  });
}

/** Snapshot the active document's buffer and flush its pending hot-exit
 *  backup before the editor switches away. Every switch-away path —
 *  activate, newTab, cycleTab, openPath — must run this rather than
 *  snapshotting on its own: a path that skips the flush leaves the
 *  debounce timer running, and when it fires it sees the *new* active
 *  document, so the previous document's last edits never reach their
 *  backup (issue #253). */
function stashActive(): void {
  const current = tabs.active;
  if (!current) return;
  current.buffer = editor.snapshot();
  backupFlush.flushPending(current, contentOf(current.buffer));
}

function activate(id: number): void {
  if (id === tabs.activeId) return;
  stashActive();
  tabs.setActive(id);
  showActive();
  persistSession();
}

function newTab(): void {
  stashActive();
  tabs.add(makeUntitled());
  showActive();
}

function cycleTab(offset: number): void {
  stashActive();
  tabs.cycle(offset);
  showActive();
}

/** An empty, never-edited, never-saved tab that can be silently replaced. */
function isPristineUntitled(doc: Doc): boolean {
  return doc.path === null && !doc.dirty && isEmptyBuffer(doc.buffer);
}

function docFromOpened(
  opened: OpenedDocument,
  cursor = 0,
  detectionHint: string | null = null,
): Doc {
  void watchFile(opened.path).catch(() => {
    // Watching is best-effort; editing must keep working without it.
  });
  return {
    id: nextId++,
    path: opened.path,
    title: basename(opened.path),
    encoding: opened.encoding,
    withBom: opened.hadBom,
    lineEnding: opened.lineEnding,
    malformed: opened.malformed,
    dirty: false,
    revision: 0,
    truncated: opened.truncated,
    // Session-only, not part of an OpenedDocument (the Rust open_document
    // result knows nothing about it) — restoreSession applies the
    // persisted value from SessionFile.userReadOnly onto the Doc this
    // returns, same pattern as its cursor argument above.
    userReadOnly: false,
    totalSize: opened.totalSize,
    chunkOffset: 0,
    nextChunkOffset: opened.nextOffset,
    prevChunkOffsets: [],
    windowChunks: opened.truncated
      ? [
          {
            chars: opened.content.length,
            bytes: opened.nextOffset ?? opened.totalSize,
          },
        ]
      : [],
    lineIndex: null,
    // Offset 0 is unambiguously line 1 — no scan needed to know this yet.
    windowStartLine: opened.truncated ? 1 : null,
    bookmarks: [],
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    saveReloadInFlight: null,
    pendingReload: false,
    pendingSaveAs: null,
    speculativeEncoding: null,
    backupName: null,
    detectionHint,
    fingerprint: opened.fingerprint,
    byteDriftChecked: false,
    buffer: editor.newBuffer(opened.content, opened.truncated, cursor),
  };
}

function pagerState(doc: Doc): { hasPrev: boolean; hasNext: boolean } | null {
  if (!pagingSupported(doc)) return null;
  return {
    hasPrev: doc.prevChunkOffsets.length > 0,
    hasNext: doc.nextChunkOffset !== null,
  };
}

/**
 * Next/Prev pager button. Guarded against issue #120's stale-response
 * class of bugs via `doc.chunkGeneration` — bumped here and checked via
 * `shouldApplyChunkResponse` once the IPC call resolves — which catches a
 * response that a newer request (another click, a goto/bookmark jump, or
 * a reload/reopen) has since made irrelevant. A request already in flight
 * for this doc (an auto append/prepend the user scrolled past, or another
 * still-in-flight manual jump) is preempted rather than blocking this one
 * (issue #134 — see chunkguard.ts's preemptChunkLoad); `doc.chunkLoadInFlight`
 * still exists purely so auto append/prepend know to yield instead
 * (chunkpolicy.ts's canAutoAppend/canPrepend), since those deliberately
 * never preempt.
 * The Prev offset is only popped off `prevChunkOffsets` once the response
 * is actually about to be applied — previously it was popped eagerly,
 * before the request was even known to succeed, so a failed or
 * superseded Prev silently dropped that offset from the history stack.
 * This still holds under preemption: a preempted Prev's response is
 * discarded by the generation check before it would ever reach the pop.
 */
async function pageChunk(direction: 1 | -1): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  let target: number;
  if (direction === 1) {
    if (doc.nextChunkOffset === null) return;
    target = doc.nextChunkOffset;
  } else {
    // Peeked, not popped: popping happens only once this request's
    // response is confirmed current, below.
    const prev = doc.prevChunkOffsets[doc.prevChunkOffsets.length - 1];
    if (prev === undefined) return;
    target = prev;
  }
  // A prior request for this doc — an auto append/prepend the user
  // scrolled past, or another still-in-flight manual jump — may already
  // be in flight. Preempt it rather than silently no-op (issue #134).
  if (doc.chunkLoadInFlight) preemptChunkLoad(doc);
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    // Next targets are the previous chunk's own nextOffset (Prev targets
    // are earlier applied window starts) — continuation points, read
    // exactly as given (#118): realigning could skip bytes mid-overlong-line.
    // `doc.fingerprint` pins the file version those offsets came from
    // (issue #251).
    const chunkData = await readDocumentChunk(
      doc.path,
      target,
      doc.encoding,
      "continuation",
      doc.fingerprint ?? undefined,
    );
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: tabs.activeId === doc.id,
      })
    ) {
      return;
    }
    if (chunkData.stale) {
      // The file changed under the paging offsets (issue #251): route
      // through the same flow a watcher event uses — a clean (always, for
      // a read-only preview) doc reloads silently with a fresh window.
      await handleExternalChange(doc.path);
      return;
    }
    if (direction === 1) {
      doc.prevChunkOffsets.push(doc.chunkOffset);
    } else {
      doc.prevChunkOffsets.pop();
    }
    doc.chunkOffset = chunkData.offset;
    doc.nextChunkOffset = chunkData.nextOffset;
    doc.malformed = chunkData.malformed;
    doc.windowChunks = [
      {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      },
    ];
    // The jump pager doesn't track how many lines it moved by, unlike
    // gotoLargeFileLine below (which computes this for free from the line
    // index) — see the windowStartLine trade-off note on tabs.ts Doc.
    doc.windowStartLine = null;
    doc.buffer = editor.newBuffer(chunkData.content, true);
    showActive();
  } catch (error) {
    // A superseded request's failure is exactly as irrelevant as its
    // success would have been — surfacing this dialog after the user has
    // already moved on (a newer request, or a reload) would be confusing.
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: tabs.activeId === doc.id,
      })
    ) {
      return;
    }
    await messageDialog(String(error), {
      title: t("dialog.pagingTitle"),
      kind: "warning",
    });
  } finally {
    // Only release the lock if nothing has superseded this request —
    // otherwise a reload/reopen (which bump the generation and clear this
    // flag themselves, see reloadFromDisk/reopenWithEncoding) or a newer
    // chunk request already owns it, and this stale request clearing it
    // out from under them would let a third request overlap.
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/** Scrolling near the end of a large-file window loads the next chunk. */
async function autoAppendChunk(): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  if (
    !canAutoAppend({
      nextOffset: doc.nextChunkOffset,
      inFlight: doc.chunkLoadInFlight,
    })
  ) {
    return;
  }
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const loadedAt = doc.nextChunkOffset!;
    const chunkData = await readDocumentChunk(
      doc.path,
      loadedAt,
      doc.encoding,
      "continuation",
      doc.fingerprint ?? undefined,
    );
    // The user may have switched tabs while the chunk was loading, or a
    // newer request/reload/reopen may have superseded this one (#120).
    if (
      shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: tabs.activeId === doc.id,
      })
    ) {
      if (chunkData.stale) {
        // See pageChunk's stale branch (issue #251).
        await handleExternalChange(doc.path);
        return;
      }
      editor.appendText(chunkData.content);
      doc.nextChunkOffset = chunkData.nextOffset;
      const trim = pushBack(doc.windowChunks, {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      });
      if (trim) {
        editor.trimStart(trim.trimChars);
        doc.chunkOffset += trim.trimBytes;
      }
      // The window shifted without tracking by how many lines — clear
      // rather than show gutter marks at now-wrong positions.
      doc.windowStartLine = null;
      editor.setBookmarks([]);
      doc.buffer = editor.snapshot();
      updatePager(pagerState(doc));
    }
  } catch {
    // Transient read failure; the manual pager remains available.
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/** Scrolling near the top of a mid-file window loads the previous chunk. */
async function prependChunk(): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path || !pagingSupported(doc)) return;
  if (
    !canPrepend({
      windowStart: doc.chunkOffset,
      inFlight: doc.chunkLoadInFlight,
    })
  ) {
    return;
  }
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const windowStart = doc.chunkOffset;
    const chunkData = await readDocumentChunkBefore(
      doc.path,
      windowStart,
      doc.encoding,
      doc.fingerprint ?? undefined,
    );
    // The user may have switched tabs while the chunk was loading, or a
    // newer request/reload/reopen may have superseded this one (#120).
    if (
      shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: tabs.activeId === doc.id,
      })
    ) {
      if (chunkData.stale) {
        // See pageChunk's stale branch (issue #251).
        await handleExternalChange(doc.path);
        return;
      }
      editor.prependText(chunkData.content);
      doc.chunkOffset = chunkData.offset;
      const trim = pushFront(doc.windowChunks, {
        chars: chunkData.content.length,
        bytes: windowStart - chunkData.offset,
      });
      if (trim) {
        editor.trimEnd(trim.trimChars);
        doc.nextChunkOffset =
          (doc.nextChunkOffset ?? chunkData.totalSize) - trim.trimBytes;
      }
      // The window shifted without tracking by how many lines — clear
      // rather than show gutter marks at now-wrong positions.
      doc.windowStartLine = null;
      editor.setBookmarks([]);
      doc.buffer = editor.snapshot();
      updatePager(pagerState(doc));
    }
  } catch {
    // Transient read failure; the manual pager remains available.
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/**
 * Build (or reuse) `doc`'s line-offset index for go-to-line/bookmarks
 * beyond the loaded window. Staleness in practice rides on the file
 * watcher: every path that learns about an external change (reload,
 * reopen) also clears `lineIndex`, and nothing updates `totalSize` from
 * disk without doing so — the `indexedSize` comparison below is a cheap
 * internal-consistency guard, not an independent external-change
 * detector. A same-size overwrite that the best-effort watcher misses
 * can therefore leave a stale index; gotoLargeFileLine requests its
 * chunk with kind "lineStart", which makes the Rust core verify the
 * index-derived offset and realign a stale one to the next real line
 * boundary (see chunk.rs OffsetKind — paging's "continuation" reads
 * deliberately never realign, #118), but the reported line number can
 * be off until the watcher catches up.
 * Returns null on failure or for a doc with no path to index; the
 * caller treats that as a no-op.
 *
 * `myGeneration` is the caller's (gotoLargeFileLine's) own generation,
 * captured before this was called — if a reload/reopen bumps
 * `doc.chunkGeneration` while `buildLineIndex`'s IPC call is in flight,
 * the result is discarded rather than resurrecting a line index for a
 * file version reload just replaced (issue #120).
 */
async function ensureLineIndex(doc: Doc, myGeneration: number): Promise<LineIndex | null> {
  if (!doc.path) return null;
  // Reuse only an index that still describes this doc's file version:
  // size alone misses a same-size overwrite, so the index's own
  // fingerprint must also match the doc's (issue #251) — e.g. a reload
  // that re-opened the file leaves doc.fingerprint fresh and any older
  // index behind. The Rust core re-validates against the live file on
  // every locate/read anyway; this check just skips IPC round trips that
  // are already known to come back stale.
  if (
    doc.lineIndex &&
    doc.lineIndex.indexedSize === doc.totalSize &&
    fingerprintsEqual(doc.lineIndex.fingerprint, doc.fingerprint)
  ) {
    return doc.lineIndex;
  }
  setIndexing(true);
  try {
    const report = await buildLineIndex(doc.path, doc.encoding);
    if (doc.chunkGeneration !== myGeneration) return null;
    // A fresh index describing a *different* file version than the doc's
    // own baseline means the file was replaced under a missed watcher
    // event (issue #267). Adopting it anyway would mix versions in one
    // Doc — a goto would show the new file's bytes while the buffer,
    // encoding and fingerprint still describe the old one, and every
    // continuation page (which validates against doc.fingerprint) would
    // then flag stale, with this reuse guard rebuilding the index on
    // every jump. Route through the watcher's own external-change flow
    // instead: a read-only preview is never dirty, so this reloads
    // silently and re-establishes one coherent baseline.
    if (!indexMatchesBaseline(report.fingerprint, doc.fingerprint)) {
      await handleExternalChange(doc.path);
      return null;
    }
    doc.lineIndex = report;
    // Keep totalSize in lockstep with what was actually just scanned, so
    // the staleness check above compares against the index's own baseline
    // rather than a possibly-already-stale open-time size (which would
    // otherwise force a pointless rebuild on every subsequent call if the
    // file had already grown before this first build). Also keeps the
    // status bar's read-only-preview size fresh as a side benefit.
    doc.totalSize = report.indexedSize;
    return report;
  } catch (error) {
    if (doc.chunkGeneration === myGeneration) {
      await messageDialog(String(error), {
        title: t("dialog.lineIndexFailedTitle"),
        kind: "warning",
      });
    }
    return null;
  } finally {
    setIndexing(false);
  }
}

/**
 * Large-file go-to-line: jump straight to `targetLine1` (1-based) via the
 * line-offset index, replacing the loaded window with a single fresh chunk
 * starting at that line — mirroring pageChunk's own single-chunk window
 * reset. `column` (1-based, optional) positions the cursor within that
 * first line of the freshly loaded window — see the clamp comment at its
 * one use below. Deliberately does *not* check whether the target already falls
 * inside the currently loaded window first (it always reloads): tracking
 * "how many lines does the loaded window currently span" would need line
 * counts threaded through chunkwindow.ts's WindowChunk bookkeeping (append
 * /prepend/trim all over pageChunk.ts's usage), which is real extra surface
 * in a byte/char/line-unit danger domain for what's a rare-ish operation.
 * The cost is one extra IPC round trip when the target was already
 * visible — see the PR description for the full trade-off.
 *
 * Shares `doc.chunkLoadInFlight`/`doc.chunkGeneration` with
 * pageChunk/autoAppendChunk/prependChunk (issue #120): this can be
 * triggered mid-paging (Go to Line, or a bookmark jump via
 * jumpToBookmark) and its own IPC chain (buildLineIndex, optionally
 * locateLineOffset, then readDocumentChunk) must not overlap with those,
 * nor apply once superseded by a newer request or a reload/reopen. Being
 * user-initiated, it preempts a request already in flight (an auto
 * append/prepend, or another still-in-flight manual jump) instead of
 * no-opping on it, same as pageChunk — see chunkguard.ts's
 * preemptChunkLoad (issue #134).
 */
async function gotoLargeFileLine(
  doc: Doc,
  targetLine1: number,
  column?: number,
): Promise<void> {
  if (!doc.path) return;
  // See pageChunk's preempt comment (issue #134).
  if (doc.chunkLoadInFlight) preemptChunkLoad(doc);
  doc.chunkLoadInFlight = true;
  doc.chunkGeneration += 1;
  const myGeneration = doc.chunkGeneration;
  try {
    const index = await ensureLineIndex(doc, myGeneration);
    if (!index || index.totalLines === 0) return;
    const target0 = clampLine(targetLine1 - 1, index.totalLines);
    const checkpoint = selectCheckpoint(index.checkpoints, target0);
    // Both the checkpoint walk and the chunk read below carry the
    // *index's* fingerprint — these offsets describe the file version the
    // index scanned, not necessarily the one the doc was opened from —
    // so a same-size overwrite the size checks can't see still comes
    // back as stale instead of as the wrong line (issue #251).
    let offset = checkpoint.offset;
    if (target0 !== checkpoint.line) {
      const located = await locateLineOffset(
        doc.path,
        target0,
        checkpoint.offset,
        checkpoint.line,
        index.fingerprint ?? undefined,
      );
      if (located.stale) {
        if (doc.chunkGeneration === myGeneration) {
          doc.lineIndex = null;
          await handleExternalChange(doc.path);
        }
        return;
      }
      offset = located.offset;
    }
    // "lineStart": the offset rides on the line index, which can be
    // stale (see ensureLineIndex above) — the Rust core verifies it and
    // realigns to the next real line start if it isn't one (#118).
    const chunkData = await readDocumentChunk(
      doc.path,
      offset,
      doc.encoding,
      "lineStart",
      index.fingerprint ?? undefined,
    );
    if (
      !shouldApplyChunkResponse({
        requestGeneration: myGeneration,
        currentGeneration: doc.chunkGeneration,
        isActiveTab: tabs.activeId === doc.id,
      })
    ) {
      return;
    }
    if (chunkData.stale) {
      doc.lineIndex = null;
      await handleExternalChange(doc.path);
      return;
    }
    doc.chunkOffset = chunkData.offset;
    doc.nextChunkOffset = chunkData.nextOffset;
    doc.prevChunkOffsets = [];
    doc.malformed = chunkData.malformed;
    doc.windowChunks = [
      {
        chars: chunkData.content.length,
        bytes: (chunkData.nextOffset ?? chunkData.totalSize) - chunkData.offset,
      },
    ];
    // The "lineStart" request above means chunkData.content's first line
    // *is* the target line, still within this single freshly loaded
    // window — column (1-based, UTF-16 code units, same as editor.ts's
    // goToLine) becomes a same-unit cursor offset from the buffer start,
    // clamped to that first line's own length so it can't spill onto the
    // chunk's second line (mirrors goToLine's own clamp for the
    // small-file path; no cross-chunk column math needed).
    const firstLineLength = (() => {
      const eol = chunkData.content.indexOf("\n");
      return eol === -1 ? chunkData.content.length : eol;
    })();
    const cursor =
      column === undefined
        ? 0
        : Math.max(0, Math.min(column - 1, firstLineLength));
    doc.buffer = editor.newBuffer(chunkData.content, true, cursor);
    doc.windowStartLine = target0 + 1;
    showActive();
  } catch (error) {
    if (doc.chunkGeneration === myGeneration) {
      await messageDialog(String(error), {
        title: t("dialog.pagingTitle"),
        kind: "warning",
      });
    }
  } finally {
    if (doc.chunkGeneration === myGeneration) doc.chunkLoadInFlight = false;
  }
}

/** Mod+L / Edit > Go to Line: within the loaded window for a regular
 *  document (or a large-file doc whose paging is unsupported, e.g.
 *  UTF-16 or ISO-2022-JP — see pagingSupported), just move the cursor;
 *  otherwise jump via the line-offset index. `column` (1-based; null when
 *  the user's input named only a line — see goto.ts's `parseGoToInput`) is
 *  forwarded either way. */
function handleGotoLine(line: number, column: number | null): void {
  const doc = tabs.active;
  if (!doc) return;
  if (!pagingSupported(doc)) {
    editor.goToLine(line, column ?? undefined);
    return;
  }
  void gotoLargeFileLine(doc, line, column ?? undefined);
}

/** Refresh the gutter's bookmark dots for whatever's currently on screen.
 *  Small docs map 1:1 (doc.bookmarks are already buffer line numbers);
 *  large docs need windowStartLine to translate absolute -> buffer-relative,
 *  and show nothing when it's unknown (see tabs.ts Doc.windowStartLine). */
function syncBookmarkGutter(): void {
  const doc = tabs.active;
  if (!doc) return;
  if (!doc.truncated) {
    editor.setBookmarks(doc.bookmarks);
    return;
  }
  editor.setBookmarks(
    windowRelativeBookmarks(doc.bookmarks, doc.windowStartLine, lineCountOf(editor.snapshot())),
  );
}

/** The absolute (1-based) file line the cursor is currently on, or null if
 *  that can't be determined right now (large file, window position
 *  unknown — see tabs.ts Doc.windowStartLine). */
function currentAbsoluteLine(doc: Doc): number | null {
  const bufferLine = currentCursorLine();
  if (!doc.truncated) return bufferLine;
  if (doc.windowStartLine === null) return null;
  return doc.windowStartLine + bufferLine - 1;
}

function jumpToBookmark(doc: Doc, target: number | null): void {
  if (target === null) return;
  if (!doc.truncated) {
    editor.goToLine(target);
    return;
  }
  void gotoLargeFileLine(doc, target);
}

/**
 * Edit > Toggle Bookmark. For a large file whose window position isn't
 * currently known (windowStartLine null — nothing has anchored it since
 * the last append/prepend/pageChunk jump), bookmarking the current line
 * can't be done safely, so this asks the user to Go to Line first rather
 * than silently bookmarking the wrong line or guessing.
 */
function toggleBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const line = currentAbsoluteLine(doc);
  if (line === null) {
    void messageDialog(t("dialog.bookmarkNeedsGotoMessage"), {
      title: t("dialog.bookmarkNeedsGotoTitle"),
      kind: "info",
    });
    return;
  }
  doc.bookmarks = toggleBookmark(doc.bookmarks, line);
  syncBookmarkGutter();
}

/** Edit > Next/Previous Bookmark. When the current line can't be
 *  determined (see currentAbsoluteLine), Next starts from "before
 *  everything" (jumps to the first bookmark) and Previous starts from
 *  "after everything" (jumps to the last) — a reasonable default when
 *  there's no current position to search relative to. */
function nextBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const current = currentAbsoluteLine(doc) ?? 0;
  jumpToBookmark(doc, nextBookmark(doc.bookmarks, current));
}

function previousBookmarkFlow(): void {
  const doc = tabs.active;
  if (!doc) return;
  const current = currentAbsoluteLine(doc) ?? Number.MAX_SAFE_INTEGER;
  jumpToBookmark(doc, previousBookmark(doc.bookmarks, current));
}

/** Cached recent-files list, refreshed by the backend on every addition.
 *  Only ever updated from a response whose write reached disk (the
 *  backend commands are Result-returning since issue #252), so the cache
 *  never claims a list the next launch won't see. */
let recentFiles: string[] = [];

/** Serializes the recent-list IPC pair (add/clear). Both are backend
 *  read-modify-writes over recent.json, and their responses replace
 *  `recentFiles` wholesale — without ordering, an in-flight add resolving
 *  after a later Clear writes the pre-clear list back over both the disk
 *  file and the cache (issue #252). */
const recentOps = createOpQueue();

function rememberRecent(path: string): void {
  void recentOps
    .enqueue(() => addRecentFile(path))
    .then((list) => {
      recentFiles = list;
      syncClearRecentState();
    })
    .catch(() => {
      // Best-effort: the write never landed, so the cache keeps its last
      // disk-confirmed list; quick open just shows a slightly stale one.
    });
}

/** File > Clear Recently Opened (ROADMAP.md v0.6 C4): empty recent.json
 *  and the frontend's cached copy together, so a Quick Open opened right
 *  after shows nothing stale and a relaunch doesn't bring the list back. */
function clearRecent(): void {
  void recentOps
    .enqueue(() => clearRecentFiles())
    .then((list) => {
      recentFiles = list;
      syncClearRecentState();
    })
    .catch(async (error) => {
      // Unlike rememberRecent's silent catch, a failed clear must be
      // said out loud: the user explicitly asked for it, and a list that
      // silently survives on disk resurrects on the next launch.
      await messageDialog(String(error), {
        title: t("dialog.clearRecentFailedTitle"),
        kind: "error",
      });
    });
}

/** Sync the File > Clear Recently Opened item's enabled state to whether
 *  recentFiles currently holds anything (menu.rs `sync_clear_recent_menu`).
 *  Unlike syncReopenClosedTabState, no call is needed at startup: recent.json
 *  is persisted, so menu.rs's `build` already derives the initial state
 *  from disk. Called after every add (rememberRecent) and clear
 *  (clearRecent) — the only two ways recentFiles's emptiness can change. */
function syncClearRecentState(): void {
  void syncClearRecentMenu(recentFiles.length > 0).catch(() => {
    // Best-effort; see rememberRecent's doc comment above.
  });
}

/** Timestamp (and best-effort on-disk snapshot) of our own saves, to tell
 *  the watcher echo they cause apart from a real external change landing
 *  in the same short window (issue #302) — see saveecho.ts's
 *  isLikelySaveEcho and recordOwnSave below. */
const recentSaves = new Map<string, SaveEchoRecord>();
/** Paths with a reload-confirmation dialog currently open. */
const reloadPrompts = new Set<string>();
/** Resolvers for saveFlow calls coalesced into doc.pendingSaveAs while the
 *  per-doc save/reload lock (issue #124) was held by something else —
 *  keyed by doc.id since a resolve callback has no business living on
 *  Doc's own (session-persistence-adjacent) state. All resolvers queued
 *  for a doc settle together, once, with whatever the pending save
 *  actually resolves to once drained (see drainLock below) — never
 *  dropped, so a coalesced caller's promise can never hang. */
const pendingSaveResolvers = new Map<number, Array<(written: boolean) => void>>();

/**
 * Record that `path` was just written by us (issue #302), so the next
 * watcher event for it can be told apart from a genuine external change.
 * The timestamp is recorded synchronously — the suppression window starts
 * counting from the write, not from whenever this best-effort metadata
 * fetch happens to resolve. The metadata fetch itself is fire-and-forget:
 * awaiting it here would delay every save's own success side effects
 * (dirty clearing, title update, ...) for a stat call that only matters if
 * a watcher event happens to land inside the window. `recentSaves.get(path)
 * === record` guards against attaching this fetch's result to a *newer*
 * save's record if another save to the same path lands before this one
 * resolves — the guard target (`record`) is the exact object this call's
 * own `.set` below installed, so identity is a precise "still mine" check.
 */
function recordOwnSave(path: string): void {
  const record: SaveEchoRecord = { time: Date.now(), metadata: null };
  recentSaves.set(path, record);
  void documentMetadata(path).then(
    (metadata) => {
      if (recentSaves.get(path) === record) record.metadata = metadata;
    },
    () => {
      // Best-effort only (matches missingondisk.ts's isConfirmedMissing
      // precedent for treating documentMetadata failures as non-fatal):
      // record.metadata stays null, so isLikelySaveEcho falls back to
      // time-only suppression for this path, same as before this fix.
    },
  );
}

/** Acquire `doc`'s save/reload lock for the duration of `body`, then
 *  release it and drain whatever queued up while it was held (issue
 *  #124). Every saveFlow/reloadFromDisk entry that isn't already
 *  deferring (see savemutex.ts's mustDefer) goes through this, so the
 *  lock is never left stuck even if `body` throws or its promise rejects
 *  — the release and drain live in `finally`. */
async function withLock(
  doc: Doc,
  owner: "save" | "reload",
  body: () => Promise<void>,
): Promise<void> {
  doc.saveReloadInFlight = owner;
  try {
    await body();
  } finally {
    doc.saveReloadInFlight = null;
    await drainLock(doc);
  }
}

/** Once the lock releases, run whatever queued up behind it —
 *  savemutex.ts's nextDrainStep always drains a pending reload before a
 *  pending save. Recurses (through withLock's own finally calling this
 *  again) until nothing is left pending, since draining one step can
 *  itself pick up a newer request that arrived while it ran.
 *
 *  isEffectivelyReadOnly(doc) (tabs.ts's pure truncated||userReadOnly
 *  check, no dialog) is computed unconditionally on every call — cheap,
 *  and it's savemutex.ts's nextDrainStep, not this glue, that decides
 *  whether it actually matters for the branch taken (issue #217: it's
 *  only consulted there once a pending save is confirmed still dirty, so
 *  a dropSave outcome or a queued reload can never be affected by it). */
async function drainLock(doc: Doc): Promise<void> {
  const step = nextDrainStep({
    pendingReload: doc.pendingReload,
    pendingSaveAs: doc.pendingSaveAs,
    dirty: doc.dirty,
    blockedByReadOnly: isEffectivelyReadOnly(doc),
  });
  if (step.kind === "done") return;
  if (step.kind === "reload") {
    doc.pendingReload = false;
    await withLock(doc, "reload", () => reevaluateReload(doc));
    return;
  }
  const resolvers = pendingSaveResolvers.get(doc.id) ?? [];
  pendingSaveResolvers.delete(doc.id);
  doc.pendingSaveAs = null;
  if (step.kind === "dropSave") {
    // The doc came out of the lock already clean — either the save that
    // just finished wrote this exact content (double-save coalesce: its
    // revision-matched completion cleared dirty), or a reload the user
    // explicitly consented to (reevaluateReload's dirty-confirm, or the
    // stale-save dialog's own "reload" choice) discarded it. Running the
    // pending save for real would be a redundant no-op write either way,
    // so it's dropped. Resolving `true` is exact for the coalesce case —
    // the content the caller wanted saved is on disk — and a deliberate
    // simplification for the consented-discard case (the user just chose
    // to abandon those edits, so no caller should act on them anymore).
    // The two are indistinguishable here without threading "what released
    // the lock" through the decision table, and resolving `false` instead
    // would make the *common* coalesce case misreport failure — e.g. the
    // save-with-encoding menu would roll its speculative encoding back
    // even though the save it coalesced into genuinely wrote (see its
    // .then(written) handler below).
    for (const resolve of resolvers) resolve(true);
    await drainLock(doc);
    return;
  }
  if (step.kind === "rejectBlocked") {
    // Issue #217: nextDrainStep has already decided this coalesced save is
    // still dirty (something genuinely hasn't reached disk yet) *and*
    // blocked (isEffectivelyReadOnly(doc), fed in above) as of this exact
    // recheck — most plausibly doc.userReadOnly toggled during the defer
    // window (a plain, ungated state flip never routed through this lock
    // at all), or in principle doc.truncated (though every production path
    // that sets it also clears dirty in the same call, which nextDrainStep
    // already accounts for by checking dirty first — see savemutex.ts's
    // own doc comment). saveFlow's own entry gate only ran once, at
    // enqueue time, before any of that could have happened yet — without
    // this recheck the save would run anyway and write doc's current
    // (possibly now a preview-slice) buffer over the real file.
    // blockedByReadOnly(doc) is called here purely for its dialog side
    // effect — same rejection UX saveFlow's own entry gate shows; its
    // boolean return is redundant with step.kind here and discarded.
    // Resolved `false`, not `true` like dropSave above, since nothing was
    // written this time.
    blockedByReadOnly(doc);
    for (const resolve of resolvers) resolve(false);
    await drainLock(doc); // something else may have queued up meanwhile
    return;
  }
  let result = false;
  await withLock(doc, "save", async () => {
    result = await runSaveFlow(doc, step.saveAs);
  });
  for (const resolve of resolvers) resolve(result);
}

/**
 * Replace `doc`'s buffer with what's on disk right now. Every caller has
 * already resolved discarding whatever the buffer held (a clean doc, or an
 * explicit reload/overwrite confirmation) — see handleExternalChange and
 * saveFlow's stale-confirm branch. Public entry point: defers instead of
 * running if a save or another reload is already in flight for this doc
 * (issue #124) rather than racing it — see savemutex.ts's module comment
 * for what that race used to do to the hot-exit backup and doc.fingerprint.
 * The deferred request isn't dropped: withLock's finally drains it once
 * the lock frees up, via reevaluateReload below.
 */
async function reloadFromDisk(doc: Doc): Promise<void> {
  if (!doc.path) return;
  if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
    doc.pendingReload = true;
    return;
  }
  await withLock(doc, "reload", () => fetchAndApplyReload(doc));
}

/** Fetch doc.path fresh and apply it once the lock is confirmed free —
 *  reloadFromDisk's own behavior, factored out so reevaluateReload (the
 *  drained-pending-reload path) can share the fetch shape while gating
 *  the apply differently.
 *
 *  Captures doc's identity before the openDocument await and validates it
 *  after (issue #159): that IPC round trip is itself an await gap the
 *  user can type in — or close the tab during — same hazard
 *  reevaluateReload already guards against for the *drained* reload path
 *  via its own dirty-recheck-after-fetch; this is the direct,
 *  non-deferred entry's own version of that protection. A closed tab
 *  (asyncguard.ts's "closed" verdict) discards the result outright — no
 *  tab left to apply it to. A same-tab edit ("edited") routes through
 *  reevaluateReload itself rather than re-deriving the same dirty-confirm
 *  dialog a second way — its fingerprint check also means a same-tab edit
 *  racing a reload that turns out to be a spurious wake (nothing actually
 *  different on disk) resolves as a silent no-op instead of an
 *  unnecessary prompt. */
async function fetchAndApplyReload(doc: Doc): Promise<void> {
  const path = doc.path;
  if (!path) return;
  const guard = captureIdentity(doc);
  try {
    // reloadEncodingFor, not doc.encoding directly: a Save with Encoding
    // still in flight for this doc has that speculatively set to its
    // not-yet-written target (issue #161) — see asyncguard.ts's doc
    // comment.
    const opened = await openDocument(path, reloadEncodingFor(doc));
    const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
    if (verdict === "closed") return;
    if (verdict === "edited") {
      await reevaluateReload(doc);
      return;
    }
    applyOpenedForReload(doc, opened);
  } catch {
    // The file may be mid-replace or deleted; find out which (ROADMAP.md
    // v0.7 Track V "external delete/rename visibility") — see
    // markMissingIfConfirmed's own doc comment for why this reactive,
    // catch-only check never costs the (overwhelmingly common)
    // reload-succeeds path an extra IPC round trip.
    await markMissingIfConfirmed(doc, path);
  }
}

/**
 * Shared tail of fetchAndApplyReload/reevaluateReload's own catch
 * (ROADMAP.md v0.7 Track V): a reload's openDocument fetch just failed;
 * find out whether that's because the file is genuinely gone, and if so,
 * raise doc.missingOnDisk so the status bar can say so. Before this
 * existed, both catches swallowed every failure identically — mid-replace,
 * a permissions hiccup, or a real deletion alike — leaving a clean doc's
 * tab with zero signal that anything had happened at all.
 *
 * `path` is whatever path the caller's own just-failed openDocument call
 * used, passed in rather than re-read from doc.path here — the two could
 * only ever differ if a concurrent Save As moved this doc mid-await, a
 * vanishingly rare window, but reusing the caller's own local is free and
 * removes the question entirely.
 *
 * Only mutates `doc` when it's still open: a tab close during this
 * function's own extra await (isConfirmedMissing's documentMetadata call)
 * leaves nothing to show a status-bar hint on. A same-tab edit in that
 * same window is fine to mutate through, unlike an actual content apply —
 * the missing flag is orthogonal to buffer content, so it doesn't need
 * asyncguard.ts's full revision check, just plain tab membership.
 */
async function markMissingIfConfirmed(doc: Doc, path: string): Promise<void> {
  const missing = await isConfirmedMissing(path);
  if (!missing || !tabs.docs.includes(doc)) return;
  doc.missingOnDisk = true;
  if (tabs.activeId === doc.id) updateStatusBar(doc);
}

/**
 * Shared guard for reevaluateReload/reevaluateReopen's own post-confirm
 * fetch (issue #209). Both functions reach a point where the user has
 * already agreed to discard whatever the buffer held, and re-fetch the
 * file to carry that decision out — but until this fix that fetch was
 * itself an unguarded await gap, unlike fetchAndApplyReload/
 * fetchAndApplyReopen's own openDocument call just above (issue #159): a
 * same-tab edit or a tab close landing between the discard-confirm
 * resolving and this call resolving was applied (or backups.drop'd)
 * unconditionally. Same capture-before-IPC / validate-after-IPC shape as
 * those two, reused here instead of re-derived a third and fourth time.
 *
 * "closed": the tab closed while this fetch was in flight — discard
 * outright, same as fetchAndApplyReload/fetchAndApplyReopen's own "closed".
 * No mutation of the detached doc, no backups.drop.
 *
 * "edited": the user typed again after already consenting to discard once.
 * Applying this fetch's result would silently discard THOSE keystrokes with
 * no second confirmation — the exact bug issue #209 reports. Simply
 * keeping the old (pre-consent) buffer would be just as wrong: the user
 * already said discard once, and disk may have moved further while this
 * fetch ran. `onEdited` re-runs the caller's own reevaluateReload/
 * reevaluateReopen from the top against doc's now-current state, rather
 * than patching this one fetch's result in place — both functions' own
 * dirty/fingerprint checks need to see the LATEST doc, not stale locals
 * this call captured before the race. This can only recurse as many times
 * as the user actually lands a fresh keystroke inside one of these guarded
 * windows: each round re-captures identity and re-awaits a real IPC round
 * trip (and typically a real confirm dialog), so there is no path back
 * into this function without an actual async gap and an actual edit in
 * between — it cannot spin without user input.
 *
 * "apply": nothing raced this fetch — call `apply` with the result, same
 * as either reevaluate* function's pre-#209 unconditional call.
 */
async function fetchAndApplyGuarded(
  doc: Doc,
  fetchOpen: () => Promise<OpenedDocument>,
  apply: (doc: Doc, opened: OpenedDocument) => void,
  onEdited: () => Promise<void>,
): Promise<void> {
  const guard = captureIdentity(doc);
  const opened = await fetchOpen();
  const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
  if (verdict === "closed") return;
  if (verdict === "edited") {
    await onEdited();
    return;
  }
  apply(doc, opened);
}

/**
 * Drained pending reload (issue #124's drainLock, once whatever held the
 * lock — a save, or another reload — releases it): re-validate against
 * disk instead of blindly applying the reload that was requested earlier.
 * Also reached directly (not via a drain) from fetchAndApplyReload's own
 * guard, when a same-tab edit races the *direct*, non-deferred reload's
 * own openDocument await (issue #159's "edited" verdict — see
 * asyncguard.ts). Both callers already hold doc's lock and have nothing
 * trustworthy left from before their own await, so either way this always
 * re-validates fresh rather than reusing anything captured earlier.
 * A fresh read whose fingerprint still matches doc.fingerprint (the
 * baseline the lock holder that just released already established, via a
 * successful save's own fingerprint update or a prior reload's own fetch)
 * means nothing has changed beyond that — most commonly, the watcher
 * notification behind this pending reload was simply the echo of a save
 * that just wrote this same doc, not a genuine external edit. Applying it
 * anyway would be a pointless, disruptive buffer replacement (fresh undo
 * history, lost cursor/scroll position) for content identical to what's
 * already showing. Only a genuine fingerprint mismatch means something
 * *else* changed the file in the meantime — and even then (critic-review
 * P2 on #124) the disk side alone isn't consent to apply: the doc may
 * have gone *dirty* while the reload sat in the pending slot. The
 * counterexample: a clean doc's save takes the lock, an external change
 * lands, handleExternalChange's no-prompt clean-doc branch defers the
 * reload, the user types in that window, and the save's own completion
 * correctly keeps dirty (#112's revision guard) — silently applying here
 * would then discard those fresh keystrokes with no dialog and no backup
 * left covering them. So a dirty doc walks the same confirm dialog
 * handleExternalChange already shows for dirty docs; only explicit user
 * consent discards. Awaiting a dialog while holding the doc's lock is
 * already this codebase's shape — runSaveFlow holds it across its
 * lossy/stale confirms — and can't deadlock: anything that fires
 * meanwhile just lands in the pending slots this same drain loop
 * processes next. On consent the apply uses a second fresh read, not the
 * pre-dialog snapshot — the disk may well have moved again while the
 * dialog sat open (same reason handleExternalChange's own confirm path
 * re-reads via reloadFromDisk rather than caching a read from before its
 * dialog). It must NOT route through reloadFromDisk itself, though: this
 * runs while holding the lock, so that entry point's mustDefer would just
 * re-queue it as pendingReload — for this same drain to run again,
 * re-detect the mismatch, and re-ask the user, forever.
 */
async function reevaluateReload(doc: Doc): Promise<void> {
  const path = doc.path;
  if (!path) return;
  try {
    // reloadEncodingFor, not doc.encoding directly (issue #161): this is
    // the path a stale-save dialog's own "Reload" choice actually takes
    // (reloadFromDisk always defers while runSaveFlow's own save lock is
    // still held across that dialog — see savemutex.ts's mustDefer doc
    // comment) — most likely to run *during* Save with Encoding's
    // speculative window, so it's the call site most exposed to this bug.
    //
    // This opening fetch is its own await gap too (issue #223): captured
    // before it starts and validated once it resolves, the same
    // captureIdentity/validateIdentity contract as every other guarded
    // fetch in this file, applied manually here rather than via
    // fetchAndApplyGuarded — that helper's synchronous `apply` callback
    // can't host what has to run between this fetch resolving and
    // applyOpenedForReload below (the fingerprint/dirty branching, and on
    // the dirty branch a whole dialog plus a second guarded fetch). Only
    // "closed" needs a special case: a same-tab edit ("edited") is already
    // handled correctly below without one, because the fingerprint/dirty
    // checks just below read doc's state fresh, after this await, not
    // anything captured before it — a keystroke landing during this fetch
    // is already reflected in doc.dirty by the time the dirty branch below
    // runs, routing into its own guarded confirm+re-fetch same as always.
    // A closed tab is different: nothing below re-checks tab membership,
    // so without this, applyOpenedForReload would mutate (and dropBackup)
    // a detached Doc — reachable only for a clean doc whose tab closed
    // while this fetch was in flight (a dirty doc's tab close is instead
    // caught by the dirty branch's own guarded second fetch below, #209).
    const guard = captureIdentity(doc);
    const opened = await openDocument(path, reloadEncodingFor(doc));
    if (validateIdentity(guard, doc, tabs.docs.includes(doc)) === "closed") {
      return;
    }
    if (fingerprintsEqual(opened.fingerprint, doc.fingerprint)) return;
    if (doc.dirty) {
      // Same one-dialog-per-path guard as handleExternalChange: if the
      // watcher's own dirty-doc prompt is already up for this path, defer
      // to it entirely — its outcome (reload or keep) answers the same
      // question this would have asked.
      if (reloadPrompts.has(path)) return;
      reloadPrompts.add(path);
      let reload = false;
      try {
        reload = await confirmDialog(t("dialog.fileChangedMessage", doc.title), {
          title: t("dialog.fileChangedTitle"),
          kind: "warning",
          okLabel: t("dialog.reload"),
        });
      } finally {
        reloadPrompts.delete(path);
      }
      if (!reload) return;
      // Still reloadEncodingFor: doc.speculativeEncoding, if any, is only
      // cleared once applyOpenedForReload below actually runs, so this
      // second (post-consent) fetch is still inside the same protected
      // window as the first. Guarded via fetchAndApplyGuarded (issue
      // #209): this fetch is its own await gap, same hazard as
      // fetchAndApplyReload's own openDocument call above.
      await fetchAndApplyGuarded(
        doc,
        () => openDocument(path, reloadEncodingFor(doc)),
        applyOpenedForReload,
        () => reevaluateReload(doc),
      );
      return;
    }
    applyOpenedForReload(doc, opened);
  } catch {
    // Same as fetchAndApplyReload: mid-replace/deleted, find out which
    // (ROADMAP.md v0.7 Track V) — see markMissingIfConfirmed. Covers both
    // this function's own opening fetch above and its guarded post-confirm
    // second fetch just above (issue #209's fetchAndApplyGuarded call),
    // since neither has a try/catch of its own — a rejection from either
    // one unwinds to this same catch.
    await markMissingIfConfirmed(doc, path);
  }
}

/** Shared state mutation once a freshly-opened `opened` has been decided
 *  as safe to apply — reloadFromDisk's entire pre-#124 body, unchanged. */
function applyOpenedForReload(doc: Doc, opened: OpenedDocument): void {
  doc.encoding = opened.encoding;
  doc.withBom = opened.hadBom;
  doc.lineEnding = opened.lineEnding;
  doc.malformed = opened.malformed;
  doc.dirty = false;
  // This reload's own openDocument call just succeeded, so the file
  // unambiguously exists again — clears a missing-on-disk flag a previous
  // reload attempt may have raised (ROADMAP.md v0.7 Track V; see
  // markMissingIfConfirmed). Unconditional, like every other reset below:
  // every caller of this function has already resolved applying fresh
  // disk content, so there's no "safe to apply the buffer reset but not
  // this" case to gate on.
  doc.missingOnDisk = false;
  // This reload just established a fresh, coherent, disk-verified
  // encoding/withBom (from reloadEncodingFor's protected value, if a Save
  // with Encoding was in flight) alongside the buffer/fingerprint/malformed
  // it also set below — an earlier speculative caller's own eventual
  // rollback must not stomp any of that back to its pre-save snapshot
  // (issue #161). Clearing the marker here, before that caller's rollback
  // ever runs (savemutex.ts's lock guarantees this reload — however it was
  // reached — fully completes before saveFlow's own promise resolves), is
  // what tells it to skip the rollback entirely — see main.ts's
  // saveWithEncoding menu action and asyncguard.ts's reloadEncodingFor.
  doc.speculativeEncoding = null;
  // The buffer is now exactly the on-disk content, so whatever hot-exit
  // backup covered the just-discarded edits (if any — every caller of
  // reloadFromDisk has already resolved discarding, via its own
  // dirty/confirm gate) is stale; leaving it around would let the next
  // launch's orphan recovery resurrect that discarded content as a
  // spurious dirty tab (issue #115). dropBackup no-ops when there is
  // nothing to drop.
  backups.drop(doc);
  // A fresh baseline unrelated to whatever a still-in-flight saveFlow
  // snapshotted before this reload — draws a new value from the shared
  // sequence rather than resetting to a fixed 0 (issue #112).
  doc.revision = nextRevision++;
  doc.fingerprint = opened.fingerprint;
  // A fresh on-disk baseline replaces whatever this doc's byte-drift check
  // (if any) was about — issue #96 (2/3)'s one-time dialog re-asks once
  // more for it, same reasoning as the fingerprint reset just above.
  doc.byteDriftChecked = false;
  doc.truncated = opened.truncated;
  doc.totalSize = opened.totalSize;
  doc.chunkOffset = 0;
  doc.nextChunkOffset = opened.nextOffset;
  doc.prevChunkOffsets = [];
  doc.windowChunks = opened.truncated
    ? [
        {
          chars: opened.content.length,
          bytes: opened.nextOffset ?? opened.totalSize,
        },
      ]
    : [];
  // The file on disk changed, so any prior index is potentially stale —
  // ensureLineIndex would also catch a size mismatch, but reload always
  // rebuilds from scratch (offset 0) so there's nothing to salvage anyway.
  doc.lineIndex = null;
  doc.windowStartLine = opened.truncated ? 1 : null;
  // Invalidate any pageChunk/autoAppendChunk/prependChunk/
  // gotoLargeFileLine response still in flight for this doc (issue
  // #120): bumping the generation makes it discard itself instead of
  // clobbering the fresh state just set above once it resolves; clearing
  // the in-flight flag immediately (rather than waiting for that
  // now-irrelevant response to actually settle) lets a new chunk
  // request start right away.
  doc.chunkGeneration += 1;
  doc.chunkLoadInFlight = false;
  doc.buffer = editor.newBuffer(opened.content, opened.truncated);
  if (tabs.activeId === doc.id) showActive();
  else tabs.render();
}

async function handleExternalChange(path: string): Promise<void> {
  const doc = tabs.docs.find((d) => d.path === path);
  if (!doc) return;
  const now = Date.now();
  const record = recentSaves.get(path);
  // Issue #302: a blind elapsed-time check here used to swallow a genuine
  // external change landing in the same short window as our own save's
  // watcher echo, with nothing left to notice it once the window closed.
  // The extra documentMetadata fetch only runs once `now` is already
  // inside the window — the common case (no save in the last 1.5s) never
  // pays for it.
  if (record && now - record.time < SAVE_ECHO_WINDOW_MS) {
    const current = await documentMetadata(path).catch(() => null);
    if (isLikelySaveEcho({ now, record, current })) return;
  }
  if (!doc.dirty) {
    await reloadFromDisk(doc);
    return;
  }
  if (reloadPrompts.has(path)) return;
  reloadPrompts.add(path);
  try {
    // ROADMAP.md v0.7 Track V: once an earlier reload attempt already
    // confirmed this path is gone (doc.missingOnDisk), the ordinary
    // "changed on disk — reload?" question is the wrong one to ask —
    // clicking Reload would just re-run reloadFromDisk, re-fail
    // openDocument, and land right back in fetchAndApplyReload's own catch
    // (markMissingIfConfirmed) with nothing visibly different. Tell the
    // user what's actually known instead, with a single acknowledgement
    // button — there's nothing to reload.
    // Deliberately reads the flag rather than re-querying documentMetadata
    // here: this is the same reactive-only discipline isConfirmedMissing's
    // own doc comment describes, just applied at the dialog-choice level
    // instead of the catch-block level. A file that reappears after this
    // flag was set is picked up the next time a reload actually succeeds
    // (applyOpenedForReload's own clear) — most directly, the very next
    // external-change notification for this path while doc is clean.
    // That last step leans on a platform assumption: the OS watcher must
    // redeliver a create event for a path whose file was deleted and
    // recreated. True on both Tier-1 backends (FSEvents and
    // ReadDirectoryChangesW watch the parent directory), but a purely
    // file-inode-based backend would go quiet after the delete, leaving
    // the badge stale until a manual save/reopen — accepted, documented
    // here rather than guarded, since no Tier-1 platform behaves that
    // way.
    if (doc.missingOnDisk) {
      await messageDialog(t("dialog.fileDeletedMessage", doc.title), {
        title: t("dialog.fileDeletedTitle"),
        kind: "warning",
      });
      return;
    }
    const reload = await confirmDialog(t("dialog.fileChangedMessage", doc.title), {
      title: t("dialog.fileChangedTitle"),
      kind: "warning",
      okLabel: t("dialog.reload"),
    });
    if (reload) await reloadFromDisk(doc);
  } finally {
    reloadPrompts.delete(path);
  }
}

/** Per-extension default encoding for `path` from the preferences table,
 *  forwarded to the Rust core as an auto-detection hint. */
function extensionHint(path: string): string | undefined {
  return lookupExtensionEncoding(preferences().extensionEncodings, path);
}

/** Open a file by path into a tab, focusing the existing tab if any.
 *  `cursor` is a character offset for the newly opened buffer (clamped by
 *  editor.ts's `newBuffer`, like SessionFile.cursor on session restore) —
 *  reopenClosedTab passes the offset recorded at close time. A path
 *  that's already open keeps that tab's own cursor instead. */
async function openPath(path: string, cursor = 0): Promise<void> {
  const existing = tabs.findByPath(path);
  if (existing) {
    activate(existing.id);
    return;
  }
  try {
    // Captured once and stored on the Doc: the diagnostics surfaces must
    // later explain the detection that ran with *this* hint, not whatever
    // the preference table says by then (issue #264).
    const hint = extensionHint(path);
    const opened = await openDocument(path, undefined, hint);
    stashActive();
    const previous = tabs.active;
    tabs.add(docFromOpened(opened, cursor, hint ?? null));
    if (previous && isPristineUntitled(previous)) tabs.close(previous.id);
    showActive();
    persistSession();
    rememberRecent(opened.path);
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.openFailedTitle"),
      kind: "error",
    });
  }
}

async function openFileFlow(): Promise<void> {
  const paths = await openDialog({ multiple: true, directory: false });
  for (const path of paths ?? []) {
    await openPath(path);
  }
}

/**
 * If `doc` cannot be mutated right now (`tabs.ts`'s `canMutateDocument` —
 * `isEffectivelyReadOnly` plus the update-install freeze, ROADMAP.md D2),
 * shows the matching rejection dialog and returns true — shared by
 * saveFlow and runLineOperation so both entry points reject a blocked
 * save/edit the same way. This is the single call site `canMutateDocument`
 * exists for; no other call site should re-derive
 * truncated/userReadOnly/updateFreezeActive on its own (a second,
 * uncollapsed check site is exactly how a raw CM6 dispatch — e.g.
 * insert_datetime, a line operation — slipped past the update freeze on
 * the first review round, since the freeze only ever reconfigured the CM6
 * read-only compartment those commands never consult). The freeze is
 * checked first: it is a transient, app-wide condition unrelated to
 * anything about this specific doc, so its own dedicated message takes
 * precedence over doc-specific ones. Truncated (large-file preview) and
 * userReadOnly get distinct messages after that: writing a preview slice
 * back would destroy the rest of the file, unrelated to anything the user
 * chose, whereas a userReadOnly doc is telling the user exactly how to
 * unlock it (uncheck View > Read-Only). Truncated is checked before
 * userReadOnly — matching isEffectivelyReadOnly's own precedence and the
 * status bar's (see statusbar.ts updateStatusBar) — since a doc can't be
 * edited back to an un-truncated state from here regardless of
 * userReadOnly.
 */
function blockedByReadOnly(doc: Doc): boolean {
  if (canMutateDocument(doc, updateFreezeActive)) return false;
  if (updateFreezeActive) {
    void messageDialog(t("dialog.updateInProgressMessage"), {
      title: t("dialog.updateInProgressTitle"),
      kind: "warning",
    });
    return true;
  }
  if (doc.truncated) {
    // Writing the preview slice back would destroy the rest of the file.
    void messageDialog(t("dialog.readonlyPreviewMessage", doc.title), {
      title: t("dialog.readonlyPreviewTitle"),
      kind: "warning",
    });
    return true;
  }
  if (doc.userReadOnly) {
    void messageDialog(t("dialog.userReadOnlyMessage", doc.title), {
      title: t("dialog.userReadOnlyTitle"),
      kind: "warning",
    });
    return true;
  }
  return false;
}

/**
 * Save the active document. Resolves to true only when bytes actually
 * reached the disk — callers that speculatively changed doc state (e.g.
 * the save-with-encoding menu) roll back on false.
 *
 * Defers instead of running if a reload — or another saveFlow — is already
 * in flight for this doc (issue #124), rather than racing it: two
 * overlapping saveFlow calls used to each snapshot/compare independently,
 * landing on a dirty/backup outcome that depended on IPC resolution order
 * instead of being deterministic. The deferred call isn't dropped: it
 * resolves once drainLock actually runs the coalesced request (see
 * pendingSaveResolvers above) and reports that attempt's real outcome.
 */
async function saveFlow(saveAs: boolean): Promise<boolean> {
  const doc = tabs.active;
  if (!doc) return false;
  if (blockedByReadOnly(doc)) return false;
  if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
    return new Promise<boolean>((resolve) => {
      doc.pendingSaveAs = saveAs;
      const resolvers = pendingSaveResolvers.get(doc.id) ?? [];
      resolvers.push(resolve);
      pendingSaveResolvers.set(doc.id, resolvers);
    });
  }
  let result = false;
  await withLock(doc, "save", async () => {
    result = await runSaveFlow(doc, saveAs);
  });
  return result;
}

/** saveFlow's body once its per-doc lock (issue #124) is confirmed held —
 *  exactly saveFlow's pre-#124 implementation, taking the already-resolved
 *  active doc as a parameter (rather than re-reading tabs.active) since
 *  drainLock also calls this directly for a coalesced pending save. */
async function runSaveFlow(doc: Doc, saveAs: boolean): Promise<boolean> {
  const oldPath = doc.path;
  let path = doc.path;
  if (saveAs || path === null) {
    path = await saveDialog({ defaultPath: path ?? doc.title });
    if (path === null) return false;
  }
  try {
    // ROADMAP.md v0.7 Track C "trim trailing whitespace on save"
    // (adversarial-review addition) [danger]: applied as a real editor edit
    // — never just to the outgoing `content` string below — so the buffer
    // that ends up on disk and the live buffer can never diverge; see
    // editor.ts's `trimTrailingWhitespaceOf` for the full design (precise
    // per-line spans for caret stability, `isolateHistory` for the undo
    // trade-off) and trimonsave.ts's `shouldTrimTrailingWhitespaceOnSave`
    // for this gate's own full branch-table rationale, including why it's
    // scoped to the active doc only. Only reachable from here — never hot-
    // exit's backup flush (saveBackup, a different IPC command entirely),
    // never a watcher/stale-confirm reload, never a truncated large-file
    // preview (blockedByReadOnly already rejected the save before
    // runSaveFlow could ever run) — so those paths are untouched by
    // construction, not by an extra guard here.
    if (
      shouldTrimTrailingWhitespaceOnSave({
        preferenceOn: preferences().trimTrailingWhitespaceOnSave,
        isActiveDoc: doc.id === tabs.activeId,
      })
    ) {
      editor.trimTrailingWhitespaceForSave();
    }
    // doc may not be the active tab here: a saveFlow call that had to
    // defer behind another in-flight save/reload for this same doc (issue
    // #124) only actually runs once drainLock drains it later, by which
    // point the user may have switched tabs — and even without deferring,
    // the saveDialog await just above is itself a gap the user can switch
    // tabs during. editor.ts's shared CodeMirror view only ever holds
    // whichever doc is currently active, so reading it unconditionally
    // here risked writing another tab's live content into this doc's file
    // (issue #208). Same active-tab check as onCloseRequested's backup
    // flush and closeTab's cursorOf call further down.
    const content =
      doc.id === tabs.activeId ? editor.content() : contentOf(doc.buffer);
    // Snapshotted alongside content (issue #112): if doc.revision no
    // longer matches this once the save resolves, an edit landed while
    // the IPC round trip (including the lossy/stale retries below, which
    // reuse this same snapshot rather than re-reading it) was in flight.
    const revisionAtStart = doc.revision;
    const saveParams = {
      path,
      content,
      encoding: doc.encoding,
      withBom: doc.withBom,
      lineEnding: doc.lineEnding,
    };
    // A fingerprint captured for the *old* path describes an unrelated
    // file once Save As — or an untitled document's first save — targets a
    // different path; only a same-path resave has a baseline worth
    // checking against (issue #113).
    const expectedFingerprint = path === oldPath ? doc.fingerprint : null;
    // Lazy byte-drift detection (issue #96 (2/3)) [danger]: a same-path
    // resave is the only case with an on-disk baseline #96's
    // canonicalization concern can even apply to — same reasoning as
    // expectedFingerprint just above, not folded into
    // shouldCheckByteDrift's own input since it's the same condition this
    // codebase already treats as inline, not a named gate (see
    // bytedrift.ts's doc comment). Runs — and shows its one-time,
    // informed-consent dialog — before both the lossy-encode and stale-
    // fingerprint gates below, so the user learns about a silent legacy-
    // byte canonicalization before either of those retries could also
    // fire for the same save attempt.
    if (path === oldPath) {
      // No line ending is passed: the Rust side detects it from the disk
      // bytes themselves, so a Format-menu line-ending switch made after
      // open can't misreport as drift (see checkByteDrift's doc comment).
      // A rejected IPC call (file briefly locked/deleted) fails open
      // inside runByteDriftGate without spending the one-per-session
      // flag — save_document's own atomic write and fingerprint-staleness
      // check still guard the actual write.
      const proceed = await runByteDriftGate(
        doc,
        () =>
          checkByteDrift({
            path,
            encoding: doc.encoding,
            withBom: doc.withBom,
          }),
        () =>
          confirmDialog(t("dialog.byteDriftMessage", doc.encoding), {
            title: t("dialog.byteDriftTitle"),
            kind: "warning",
            okLabel: t("dialog.byteDriftConfirm"),
          }),
      );
      if (!proceed) return false;
    }
    let result = await saveDocument({
      ...saveParams,
      allowLossy: false,
      expectedFingerprint,
      force: false,
    });
    if (result.unmappable && !result.written) {
      // lossyReport is always populated on this path (see save_document's
      // doc comment) — the empty fallback is defensive only, so the dialog
      // degrades to "0 characters" rather than throwing if it were ever
      // absent.
      const report = result.lossyReport ?? {
        unmappableCount: 0,
        samples: [],
        samplesTruncated: false,
      };
      const proceed = await showLossySaveConfirm(doc.encoding, report);
      // Cancelled: no disk write happened — the doc stays dirty, on its
      // old path, with no watcher/session changes. One deliberate
      // exception: if trim-on-save fired at the top of this flow, that
      // edit stays in the buffer (it is a real, undoable edit, not part
      // of the aborted write) — "as before Save" except already trimmed.
      if (!proceed) return false;
      result = await saveDocument({
        ...saveParams,
        allowLossy: true,
        expectedFingerprint,
        force: false,
      });
    }
    if (result.stale && !result.written) {
      const choice = await showStaleFileConfirm(doc.title);
      if (choice === "cancel") return false;
      if (choice === "reload") {
        // Replaces the tab's buffer with the newer on-disk version,
        // exactly like the passive watcher-triggered reload — the user's
        // unsaved edits in this tab are discarded along with the save
        // attempt (the dialog message warns about this explicitly), and
        // nothing is written to disk.
        await reloadFromDisk(doc);
        return false;
      }
      // "overwrite": the user explicitly chose to clobber the external
      // change. Keep whatever allowLossy decision was already resolved
      // above so this retry can't re-trigger the lossy-encoding dialog.
      result = await saveDocument({
        ...saveParams,
        allowLossy: result.unmappable,
        expectedFingerprint,
        force: true,
      });
    }
    // Only once the bytes are actually on disk do we touch doc state or
    // run any of the success side effects below.
    if (!result.written) return false;
    // A successful write means the file exists on disk right now,
    // regardless of the revisionMatches gate decideSaveCompletion applies
    // to dirty/fingerprint just below — a save recreates the file even for
    // a doc previously flagged missingOnDisk (ROADMAP.md v0.7 Track V), so
    // clearing this is unconditional on `written`, not on
    // completion.clearDirty.
    doc.missingOnDisk = false;
    recordOwnSave(path);
    // Checked before this flow's own Save As (below) reassigns doc.path —
    // true only if some concurrent flow already moved this doc to a
    // different path while this save's IPC round trip was in flight
    // (issue #112; see savecompletion.ts's pathChanged doc comment).
    const pathChanged = doc.path !== oldPath;
    const completion = decideSaveCompletion({
      written: result.written,
      stale: result.stale,
      revisionAtStart,
      currentRevision: doc.revision,
      pathChanged,
    });
    if (oldPath !== path) {
      if (oldPath) void unwatchFile(oldPath).catch(() => {});
      void watchFile(path).catch(() => {});
      rememberRecent(path);
    }
    const titleChanged = doc.title !== basename(path);
    doc.path = path;
    doc.title = basename(path);
    // The disk now holds exactly what this call wrote, so the fingerprint
    // baseline updates regardless of the revision/path guard below (issue
    // #113's staleness check needs this or it would misfire next save).
    if (completion.updateFingerprint) doc.fingerprint = result.fingerprint;
    // Only when nothing new landed mid-flight is it safe to call this
    // content saved: clear dirty and let the backup cycle stop covering
    // it. Otherwise dirty and the backup must survive so hot exit keeps
    // covering the newer, still-unsaved edits (issue #112) — no retry, no
    // dialog; the next explicit Save naturally writes the newer content.
    if (completion.clearDirty) doc.dirty = false;
    if (completion.dropBackup) backups.drop(doc);
    // Mixed line endings are written out as LF by the core.
    if (doc.lineEnding === "Mixed") doc.lineEnding = "LF";
    tabs.render();
    updateStatusBar(doc);
    updateWindowTitle();
    if (titleChanged) {
      void editor.setLanguage(doc.title, () => tabs.activeId === doc.id);
    }
    persistSession();
    return true;
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.saveFailedTitle"),
      kind: "error",
    });
    return false;
  }
}

/**
 * Re-decode the file on disk with a user-chosen encoding. Defers to an
 * in-flight save/reload instead of racing it (issue #169) — mustDefer
 * checked at entry, same as reloadFromDisk/saveFlow, but deliberately
 * never queues a deferred retry: unlike those two, reopen is always a
 * direct user action, never watcher-triggered, so there's no passive
 * "will get to it eventually" case to preserve, and blocking with a
 * "try again" notice is simpler than adding a pendingReopenEncoding slot
 * to savemutex.ts's drain table for one narrow, user-repeatable action.
 */
async function reopenWithEncoding(encoding: string): Promise<void> {
  const doc = tabs.active;
  if (!doc?.path) return;
  if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
    await notifyReopenBusy(doc);
    return;
  }
  if (doc.dirty) {
    const discard = await confirmDialog(t("dialog.reopenMessage", doc.title), {
      title: t("dialog.unsavedChangesTitle"),
      kind: "warning",
      okLabel: t("dialog.reopen"),
    });
    if (!discard) return;
    // The confirm dialog above is itself an await gap: a watcher-
    // triggered reload (or a save) could have taken the per-doc lock
    // while it was up. withLock below sets doc.saveReloadInFlight
    // unconditionally, so this must be re-checked right before acquiring
    // rather than trusting the entry check above still holds — otherwise
    // this would silently clobber whatever's mid-flight instead of
    // deferring to it (same hazard the entry check exists for).
    if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
      await notifyReopenBusy(doc);
      return;
    }
  }
  await withLock(doc, "reload", () => fetchAndApplyReopen(doc, encoding));
}

/** reopenWithEncoding's busy notice (issue #169) — shown instead of
 *  queueing whenever a save or reload already holds the per-doc lock. */
async function notifyReopenBusy(doc: Doc): Promise<void> {
  await messageDialog(t("dialog.reopenBusyMessage", doc.title), {
    title: t("dialog.reopenBusyTitle"),
    kind: "warning",
  });
}

/** reopenWithEncoding's body once the lock is confirmed held — mirrors
 *  fetchAndApplyReload's capture/validate shape (issue #159): the
 *  openDocument IPC round trip is an await gap the user can type in, or
 *  close the tab during, exactly like reloadFromDisk's own. A closed tab
 *  (asyncguard.ts's "closed" verdict) discards the result outright; a
 *  same-tab edit ("edited") routes through reevaluateReopen rather than a
 *  silent unconditional apply. */
async function fetchAndApplyReopen(doc: Doc, encoding: string): Promise<void> {
  const path = doc.path;
  if (!path) return;
  const guard = captureIdentity(doc);
  try {
    const opened = await openDocument(path, encoding);
    const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
    if (verdict === "closed") return;
    if (verdict === "edited") {
      await reevaluateReopen(doc, encoding);
      return;
    }
    applyOpenedForReopen(doc, opened);
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.reopenFailedTitle"),
      kind: "error",
    });
  }
}

/**
 * Reached when fetchAndApplyReopen's guard finds doc's revision moved
 * during the openDocument await — the user typed something new after
 * already consenting (or not having needed to, if doc was clean at entry)
 * to discard whatever the buffer held. Unlike reevaluateReload there's no
 * "did disk actually change" question to short-circuit on first — a
 * reopen with a different encoding is something the user explicitly asked
 * for regardless of disk state — so this only ever re-asks the SAME
 * discard-confirm reopenWithEncoding's own entry already shows, against
 * doc's CURRENT dirty state rather than the one observed at entry. On
 * consent (or if doc turned back out clean by the time this runs), applies
 * a SECOND fresh read — not the one fetchAndApplyReopen already fetched —
 * since the disk and the buffer may have moved again while any dialog
 * here was open (same reasoning as reevaluateReload's own post-consent
 * re-fetch), guarded via fetchAndApplyGuarded (issue #209) exactly like
 * reevaluateReload's own second fetch — see that helper's doc comment for
 * the closed/edited/apply handling and the recursion's termination
 * argument. No try/catch of its own: fetchAndApplyReopen's already wraps
 * this call, and reopen's errors are meant to surface to the user (unlike
 * reloadFromDisk's silent swallow) via that same catch — including any
 * error a recursive call (fetchAndApplyGuarded's "edited" path) propagates,
 * since every recursive invocation of this function runs inside that same
 * catch.
 */
async function reevaluateReopen(doc: Doc, encoding: string): Promise<void> {
  const path = doc.path;
  if (!path) return;
  if (doc.dirty) {
    const discard = await confirmDialog(t("dialog.reopenMessage", doc.title), {
      title: t("dialog.unsavedChangesTitle"),
      kind: "warning",
      okLabel: t("dialog.reopen"),
    });
    if (!discard) return;
  }
  // Guarded via fetchAndApplyGuarded (issue #209): this fetch is its own
  // await gap, same hazard as fetchAndApplyReopen's own openDocument call.
  await fetchAndApplyGuarded(
    doc,
    () => openDocument(path, encoding),
    applyOpenedForReopen,
    () => reevaluateReopen(doc, encoding),
  );
}

/** Shared state mutation once a freshly-opened `opened` (decoded with a
 *  user-chosen encoding) has been decided as safe to apply — mirrors
 *  applyOpenedForReload almost field-for-field; the only substantive
 *  difference is that the encoding comes from the user's menu choice
 *  rather than doc.encoding, and a successful reopen calls persistSession
 *  (encoding is session-persisted; a plain reload never changes it, so
 *  applyOpenedForReload has no matching call). Conditionally
 *  shows/renders exactly like applyOpenedForReload (issue #159): the
 *  active tab may have changed out from under this doc while its own IPC
 *  was in flight, so this must not force-focus the editor for a doc
 *  that's no longer on screen. */
function applyOpenedForReopen(doc: Doc, opened: OpenedDocument): void {
  doc.encoding = opened.encoding;
  doc.withBom = opened.hadBom;
  doc.lineEnding = opened.lineEnding;
  doc.malformed = opened.malformed;
  doc.dirty = false;
  // Same "this openDocument call just proved the file exists" reasoning as
  // applyOpenedForReload (ROADMAP.md v0.7 Track V) — a stale missing-on-disk
  // flag from an earlier failed passive reload must not survive a
  // successful explicit Reopen with Encoding of the very same file.
  doc.missingOnDisk = false;
  // Same stale-backup reasoning as reloadFromDisk (issue #115): by this
  // point the user either wasn't dirty or explicitly confirmed discarding
  // (initially, or again via reevaluateReopen), so the buffer's previous
  // content — and whatever backup covered it — is gone for good.
  backups.drop(doc);
  // Same fresh-baseline reasoning as reloadFromDisk (issue #112).
  doc.revision = nextRevision++;
  doc.fingerprint = opened.fingerprint;
  // Same reasoning as applyOpenedForReload (issue #96 (2/3)): a new
  // explicit-encoding decode is a new baseline for the drift check too.
  doc.byteDriftChecked = false;
  doc.truncated = opened.truncated;
  doc.totalSize = opened.totalSize;
  doc.chunkOffset = 0;
  doc.nextChunkOffset = opened.nextOffset;
  doc.prevChunkOffsets = [];
  doc.windowChunks = opened.truncated
    ? [
        {
          chars: opened.content.length,
          bytes: opened.nextOffset ?? opened.totalSize,
        },
      ]
    : [];
  // A changed encoding can flip paging support on/off (UTF-16, ISO-2022-JP
  // — see pagingSupported) and, symmetrically with reloadFromDisk, restarts
  // the window at offset 0 anyway, so any prior index is discarded rather
  // than re-validated.
  doc.lineIndex = null;
  doc.windowStartLine = opened.truncated ? 1 : null;
  // Same in-flight-chunk-request invalidation as reloadFromDisk (issue
  // #120) — this doc's chunk window was just reset from scratch too.
  doc.chunkGeneration += 1;
  doc.chunkLoadInFlight = false;
  doc.buffer = editor.newBuffer(opened.content, opened.truncated);
  if (tabs.activeId === doc.id) showActive();
  else tabs.render();
  persistSession();
}

function setLineEnding(lineEnding: string): void {
  const doc = tabs.active;
  if (!doc || doc.lineEnding === lineEnding) return;
  // ROADMAP.md D2, Codex re-review (4th round) of PR #309: this is a
  // synchronous, statusbar-picker-triggered save-relevant mutation, not an
  // async-apply one — same entry-point-audit class as runLineOperation/
  // showMojibakeRepairWizard, just reached from the status bar instead of
  // a menu/palette command. See the entry-point audit comment on
  // `updateFreezeActive`'s declaration for the full list this class
  // covers and how it was compiled.
  if (blockedByReadOnly(doc)) return;
  doc.lineEnding = lineEnding;
  // Line ending is passed into saveParams alongside content (runSaveFlow
  // above), so switching it changes what a save will write to disk exactly
  // like a content edit does — it must draw a new revision from the same
  // shared sequence the editor's onChange handler, applyOpenedForReload,
  // and reopenWithEncoding already use, or a save already in flight when
  // this fires can finish, see revisionAtStart still match doc.revision,
  // and have decideSaveCompletion wrongly clear dirty/drop the backup for
  // bytes it never actually wrote with this line ending (issue #160).
  doc.revision = nextRevision++;
  if (!doc.dirty) {
    doc.dirty = true;
    tabs.render();
    // Mirrors the editor onChange handler above: the dirty transition must
    // repaint the native title bar's unsaved marker immediately, not wait
    // for some unrelated later action to call updateWindowTitle (#191).
    updateWindowTitle();
  }
  // Also mirrors onChange: a line-ending switch is a save-relevant edit
  // (see the revision-bump comment above), so it needs the same hot-exit
  // backup coverage a content edit gets — without this, an app crash right
  // after a pure line-ending change had no backup of it; a normal close
  // still had flushBackup as a fallback either way (#192).
  backupFlush.schedule();
  updateStatusBar(doc);
}

/**
 * Open the mojibake repair wizard for the active document's live editor
 * content. No-op if there is no active tab or it is a read-only large-file
 * preview (repair can't act on the whole document there — see
 * ARCHITECTURE.md's large-file phase 1). Guards against two ways the live
 * document can move on while the (async) wizard sits open — detection and
 * the user's candidate pick both take a round trip:
 *
 * - The active tab changes: if the user switches tabs in the meantime,
 *   applying the repair to whatever is now live in the editor would
 *   silently corrupt an unrelated document. Checked via `tabs.activeId`
 *   and resolved silently (no dialog) — the user isn't looking at this
 *   document anymore, so there's nothing useful to tell them.
 * - The *same* tab is edited: typing, a line operation, or a reload can
 *   all change the buffer without switching tabs. The repair in hand was
 *   computed from `snapshot`, the content at the moment the wizard opened
 *   (see `isMojibakeSnapshotStale` in mojibake.ts) — applying it now would
 *   silently overwrite the user's newer edits with a rebuild of stale
 *   content (issue #93). Since the user is still on this tab, this case
 *   surfaces a dialog rather than failing silently.
 * - The doc became blocked (ROADMAP.md D2, Codex re-review of PR #309):
 *   the update-install freeze doesn't touch `editor.content()` (it blocks
 *   edits, it produces none to compare), so `isMojibakeSnapshotStale`
 *   alone can't see it — the content still matches `snapshot` even while
 *   frozen. Checked via `blockedByReadOnly`, the same single guard
 *   `runLineOperation`/`saveFlow` already share, rather than re-deriving
 *   `updateFreezeActive` (or truncated/userReadOnly, which this callback
 *   never re-checked either, before this fix) here on its own.
 */
function showMojibakeRepairWizard(): void {
  const doc = tabs.active;
  if (!doc || doc.truncated) return;
  const docId = doc.id;
  const snapshot = editor.content();
  showMojibakeWizard(snapshot, (repaired) => {
    if (tabs.activeId !== docId) return;
    if (isMojibakeSnapshotStale(snapshot, editor.content())) {
      void messageDialog(t("mojibake.staleContentMessage"), {
        title: t("mojibake.staleContentTitle"),
        kind: "warning",
      });
      return;
    }
    if (blockedByReadOnly(doc)) return;
    editor.replaceContent(repaired);
  });
}

/**
 * Flattens `choices` into popup `MenuItem`s with a non-interactive section
 * header (see popup.ts's `MenuItem.header`) ahead of each of
 * `groupEncodingChoices`'s buckets. `toItem` supplies the per-choice
 * `checked`/`action` (and anything else besides `label`/`header`), which
 * differs across this menu's three encoding submenus below.
 *
 * `query` (ROADMAP.md v0.7 Track C encoding-picker alias search) is the
 * filterable menu's *current* search text, used only to annotate each item
 * with `hint` — encodings.ts's matchedEncodingAlias, so an item that only
 * matched via an informal alias (e.g. typing "cp950" surfacing Big5) shows
 * which alias it was. It does not filter `choices` itself: the caller
 * already did that via filterEncodingChoices before calling this, since
 * showFilterableMenu's `getItems` needs the filtered-and-grouped result,
 * not a second filtering pass here. Omitted (empty string) for showMenu's
 * plain, unfiltered top-level submenus (none exist below — every one of
 * this menu's three encoding submenus is filterable — but the default
 * keeps this helper usable for a future non-filterable caller too).
 */
function encodingMenuItems(
  choices: EncodingChoice[],
  toItem: (choice: EncodingChoice) => Omit<MenuItem, "label" | "header">,
  query = "",
): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groupEncodingChoices(choices)) {
    items.push({ label: group.label, header: true });
    for (const choice of group.choices) {
      const hint = matchedEncodingAlias(choice, query);
      items.push({ label: choice.label, ...(hint ? { hint } : {}), ...toItem(choice) });
    }
  }
  return items;
}

/**
 * Which doc a completed streaming convert/replace operation (issue #163)
 * should reload — or `null` when there is none, meaning the caller shows a
 * closed-tab notice instead of touching any doc. `guard`/`doc` are the same
 * capture-before-IPC / validate-after-IPC pair fetchAndApplyReload/
 * fetchAndApplyReopen use (asyncguard.ts's captureIdentity/validateIdentity,
 * issue #159); `path` is the file the operation actually ran against,
 * captured alongside `guard` before the operation started — runStreamConvert
 * and showStreamReplace both take the path as a plain argument rather than
 * re-reading `doc.path` later, so it stays available even once `doc` itself
 * might say otherwise.
 *
 * "apply"/"edited" (asyncguard.ts's verdicts): `doc` itself is still open —
 * return it unchanged. Both are treated the same here, not routed through a
 * confirm dialog the way runNormalizeFlow's own "edited" is
 * (normalizeGuardOutcome below): a streaming convert/replace's only entry
 * points (showEncodingMenu's convertFileToEncoding item, the "stream_replace"
 * menu case) both gate on `doc.truncated`, and a truncated preview's CM6
 * read-only compartment makes user edits impossible — so a revision bump
 * here can only be another reload/reopen/external-change landing on the same
 * doc while the (typically long-running) operation was in flight, never a
 * keystroke. reloadFromDisk's own fetchAndApplyReload guard re-validates
 * identity a second time around its own openDocument await and defers to
 * reevaluateReload's dirty-confirm if that ever turns up something to
 * confirm, so nothing here needs to re-derive that decision.
 *
 * "closed": the tab closed while the operation ran. Unlike reload/reopen's
 * own "closed" (nothing left to apply to — those operations target the
 * buffer that closed with the tab), a streaming convert/replace's target is
 * the FILE ON DISK, not the closed doc's buffer: the operation already
 * succeeded and wrote to `path` regardless of what happened to the tab. If
 * `path` has since been reopened into a fresh tab (closedtabs.ts's Reopen
 * Closed Tab, or the user manually reopening it — `tabs.findByPath`), that
 * tab's buffer is exactly as stale as the closed doc's would have been: it
 * still shows whatever the file held before this operation wrote to it, and
 * needs the same reload the original doc would have gotten. A reopened tab
 * for the same path can only have been opened against the file's
 * pre-operation bytes — the write lands atomically right before the
 * operation's own blocking result dialog, which leaves no interactive
 * window for a reopen to observe a half-written file — so it is itself
 * still truncated/read-only/clean at this point, same reasoning as the
 * apply/edited branch above; reloadFromDisk's precondition ("caller already
 * resolved discarding") is trivially satisfied, not silently skipped. No tab
 * at all for `path` anymore: `null`, so the caller only notifies that the
 * operation completed rather than touching a doc that doesn't exist.
 */
function streamCompletionTarget(guard: GuardIdentity, doc: Doc, path: string): Doc | null {
  const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
  return verdict === "closed" ? tabs.findByPath(path) : doc;
}

function showEncodingMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: t("menu.whyEncoding", doc.encoding),
      // Untitled documents have no file on disk to re-read and explain.
      disabled: doc.path === null,
      action: () => {
        if (doc.path) {
          showDetectionCard(
            anchor,
            doc.path,
            doc.title,
            doc.encoding,
            // The open-time hint snapshot, not a fresh recomputation
            // (issue #264) — see Doc.detectionHint.
            doc.detectionHint ?? undefined,
          );
        }
      },
    },
    {
      label: t("menu.reopenWithEncoding"),
      disabled: doc.path === null,
      action: () =>
        showFilterableMenu(anchor, {
          placeholder: t("encodingPicker.searchPlaceholder"),
          emptyText: t("encodingPicker.noResults"),
          getItems: (query) =>
            encodingMenuItems(
              filterEncodingChoices(reopenEncodingChoices(), query),
              (e) => ({
                checked: e.value === doc.encoding,
                action: () => void reopenWithEncoding(e.value),
              }),
              query,
            ),
        }),
    },
    {
      label: t("menu.compareEncodings"),
      // Read-only side-by-side preview needs a file on disk to re-read;
      // an untitled document has none (mirrors the other doc.path === null
      // guards in this menu).
      disabled: doc.path === null,
      action: () => {
        if (doc.path) {
          showComparePreview(doc.path, doc.encoding, (encoding) =>
            void reopenWithEncoding(encoding),
          );
        }
      },
    },
    {
      label: t("menu.saveWithEncoding"),
      action: () => {
        const toItem = (e: EncodingChoice): Omit<MenuItem, "label" | "header"> => ({
          checked: e.value === doc.encoding && e.withBom === doc.withBom,
          // Low-cost UI disable (in-DOM popup, no IPC round trip) — see
          // showLineEndingMenu's own comment for why this differs from
          // the native-menu items ROADMAP.md D2's earlier rounds skipped
          // disabling.
          disabled: updateFreezeActive,
          action: () => {
            // ROADMAP.md D2, Codex re-review (4th round) of PR #309: same
            // entry-point-audit class as setLineEnding just above — a
            // synchronous, statusbar-picker-triggered save-relevant
            // mutation, guarded the same way.
            if (blockedByReadOnly(doc)) return;
            // Applied speculatively so the save encodes with the new
            // choice; rolled back if nothing was written (lossy save
            // declined, dialog cancelled, or write failure) so a
            // "clean" doc never shows an encoding the disk doesn't have.
            // The protected original is also mirrored onto
            // doc.speculativeEncoding (issue #161): a reload landing
            // before this save resolves — the stale-save dialog's own
            // "Reload" choice, most commonly, deferred through the lock
            // into reevaluateReload — decodes with it instead of this
            // not-yet-written target (see asyncguard.ts's
            // reloadEncodingFor). applyOpenedForReload clears the marker
            // the instant such a reload actually applies, which doubles
            // as this rollback's own signal: a reference match below
            // means no reload consumed it, so the plain metadata-only
            // rollback below is still correct; a mismatch (cleared to
            // null, or — double Save with Encoding — replaced by a
            // newer speculative window's own marker) means a reload (or
            // a newer speculative save) already established a fresher,
            // internally-coherent doc.encoding/withBom/buffer/
            // fingerprint/malformed of its own that this rollback must
            // not stomp those two fields back out of sync with.
            const original: SpeculativeEncoding = {
              encoding: doc.encoding,
              withBom: doc.withBom,
            };
            doc.encoding = e.value;
            doc.withBom = e.withBom;
            doc.speculativeEncoding = original;
            // Draws a new revision from the shared sequence (issue
            // #210), same reasoning as setLineEnding's own bump
            // (main.ts:1916, issue #160): this mutation changes what a
            // save will write to disk exactly like a content edit does,
            // so a plain save already in flight for this doc must be
            // able to tell the difference. Without this, that other
            // save's own revisionAtStart snapshot (captured before this
            // ever ran) still matches doc.revision once it resolves,
            // decideSaveCompletion (src/savecompletion.ts) wrongly
            // clears dirty for bytes that never carried the new
            // encoding, and drainLock's nextDrainStep
            // (src/savemutex.ts) then sees a "clean" doc and drops this
            // now-pending request outright (dropSave) instead of
            // running it — the caller is told it succeeded and the tab
            // shows the new encoding, but disk still holds the old
            // bytes.
            doc.revision = nextRevision++;
            // Captured right after the bump above (issue #231): the
            // write-failure rollback below must only undo the force-dirty
            // transition just below when nothing else — a real edit,
            // another save/reload, or a tab close — touched the doc while
            // this call's own saveFlow was in flight. Reuses the same
            // capture-before/validate-after pair (asyncguard.ts's
            // captureIdentity/validateIdentity) every other post-await
            // mutation in this file already goes through, rather than a
            // bespoke revision check.
            const forceDirtyGuard = captureIdentity(doc);
            // Whether the force just below actually fires (issue #231's
            // own critic-review addition): a doc that was already dirty
            // entering this action has real unsaved edits — and possibly
            // a hot-exit backup genuinely covering them — that the
            // failure rollback below has no business touching. The
            // {id, revision} guard alone can't tell that case apart: a
            // non-stale write failure bumps nothing after this action's
            // own bump above, so validateIdentity would still say
            // "apply" and a rollback gated on it alone would mark real
            // unsaved content clean and delete its only backup —
            // silent data loss, strictly worse than the cosmetic
            // spurious-dirty this fix exists to remove.
            const wasClean = !doc.dirty;
            // Also force dirty=true when the doc was fully clean (issue
            // #221, a residual gap the revision bump above doesn't
            // close): if dirty was already false, the bump alone never
            // sets it — it only stops decideSaveCompletion from wrongly
            // *clearing* an already-true dirty on some unrelated
            // in-flight save's completion. A doc that's clean start to
            // finish (the blocking save/reload is itself a no-op, and
            // this mutation never touches dirty on its own) comes out of
            // the lock still clean, so savemutex.ts's nextDrainStep sees
            // pendingSaveAs !== null && !dirty and drops this now-pending
            // request outright — same dropSave failure #210 fixed, just
            // reached from the "no real edit anywhere" angle instead of
            // "an in-flight save races a dirty doc". Same clean->dirty
            // transition as setLineEnding's own fix just above (issue
            // #160) and the editor's onChange handler near the top of
            // this file.
            if (!doc.dirty) {
              doc.dirty = true;
              tabs.render();
              updateWindowTitle();
            }
            // Also mirrors setLineEnding/onChange: this mutation is a
            // save-relevant change with no disk copy yet, so it needs the
            // same hot-exit backup coverage a content edit gets.
            backupFlush.schedule();
            updateStatusBar(doc);
            void saveFlow(false)
              .then((written) => {
                if (!written && doc.speculativeEncoding === original) {
                  doc.encoding = original.encoding;
                  doc.withBom = original.withBom;
                  // Issue #231: a write failure that never reached disk
                  // (stale or not — a stale failure resolved via the
                  // stale dialog's own "reload" choice already cleared
                  // speculativeEncoding above via applyOpenedForReload,
                  // so this never runs for that case) must also undo the
                  // force-dirty transition above, not just
                  // encoding/withBom, when it's still safe to — BOTH
                  // gates below are load-bearing: wasClean means the
                  // force above actually fired (an already-dirty doc's
                  // dirty and backup belong to real unsaved edits this
                  // rollback must never touch — see wasClean's own doc
                  // comment); "apply" means the doc is still open and
                  // its revision hasn't moved since forceDirtyGuard was
                  // captured, i.e. no real edit (or other save/reload)
                  // landed while this save's IPC round trip was in
                  // flight. Either failing means dirty must stay —
                  // genuinely edited content, or nothing left to fix.
                  if (
                    wasClean &&
                    validateIdentity(forceDirtyGuard, doc, tabs.docs.includes(doc)) ===
                      "apply"
                  ) {
                    doc.dirty = false;
                    tabs.render();
                    updateWindowTitle();
                    // The backupFlush.schedule() call above may already
                    // have landed a hot-exit backup covering the
                    // now-reverted dirty transition (its debounce can
                    // fire before this failed save's own IPC round trip
                    // resolves), or may still be pending. Either way,
                    // backups.drop reconciles it: an already-committed
                    // backup is queued for deletion and backupName
                    // cleared synchronously; a still-pending flush is
                    // cancelled via the epoch bump before it ever writes.
                    // Mirrors runSaveFlow's own successful-completion
                    // pairing of clearDirty with dropBackup
                    // (decideSaveCompletion's dropBackup branch, just
                    // above in this file) — same clean transition,
                    // reached from the rollback side instead of a
                    // successful write.
                    backups.drop(doc);
                  }
                  updateStatusBar(doc);
                }
              })
              .finally(() => {
                // Only drop the marker if it's still this call's own
                // (issue #212) — mirrors the .then() rollback's own
                // reference-equality guard just above. A newer,
                // overlapping Save with Encoding call may already have
                // replaced it with its own (same "coalesce" scenario the
                // `original` comment above describes), or a reload that
                // landed and applied in between may already have cleared
                // it (applyOpenedForReload's own unconditional clear,
                // which is correct there since an applied reload always
                // establishes fresher, disk-verified truth no pending
                // speculative save's own rollback may second-guess — see
                // asyncguard.ts's reloadEncodingFor doc comment). This
                // finally has no such standing over a *different*,
                // still-in-flight call's own marker: clearing it
                // unconditionally would drop that other call's marker out
                // from under it — its own eventual rollback would then
                // read null instead of its own original and silently
                // skip restoring doc.encoding/withBom, and any reload
                // landing in the gap would fall back to doc.encoding
                // directly, which at that point is the *other* call's own
                // not-yet-written speculative target, not disk truth
                // (still stale even if saveFlow itself threw, e.g. the
                // untitled-doc save dialog IPC rejecting — same reasoning
                // either way).
                if (doc.speculativeEncoding === original) {
                  doc.speculativeEncoding = null;
                }
              });
          },
        });
        showFilterableMenu(anchor, {
          placeholder: t("encodingPicker.searchPlaceholder"),
          emptyText: t("encodingPicker.noResults"),
          getItems: (query) =>
            encodingMenuItems(filterEncodingChoices(encodingChoices(), query), toItem, query),
        });
      },
    },
    {
      label: t("menu.convertFileToEncoding"),
      // Only meaningful for a truncated large-file preview: a regular,
      // fully-loaded document already re-encodes its whole content via
      // "Save with Encoding" above. UTF-16 as the document's own *current*
      // encoding is not excluded here (only UTF-16 *targets* are, via
      // streamConvertEncodingChoices) — the streaming decode side has no
      // dead end, only the encode side does (streamconvert.rs doc comment).
      disabled: !doc.truncated,
      action: () => {
        const toItem = (e: EncodingChoice): Omit<MenuItem, "label" | "header"> => ({
          checked: e.value === doc.encoding && e.withBom === doc.withBom,
          action: () => {
            if (!doc.path) return;
            const path = doc.path;
            // Captured before runStreamConvert's own await chain starts
            // (issue #163): the tab can close — or close and have a
            // fresh tab reopened onto the same path — while the
            // (potentially long-running) conversion itself runs. See
            // streamCompletionTarget's doc comment.
            const guard = captureIdentity(doc);
            void runStreamConvert(path, doc.encoding, e, () => {
              const target = streamCompletionTarget(guard, doc, path);
              if (!target) {
                void messageDialog(t("streamConvert.completedTabClosedMessage"), {
                  title: t("streamConvert.title", basename(path)),
                  kind: "info",
                });
                return;
              }
              // Set *before* reloadFromDisk, since reloadFromDisk reopens
              // with whatever target.encoding already holds — it must
              // already be the new encoding, not the file's old one.
              target.encoding = e.value;
              target.withBom = e.withBom;
              void reloadFromDisk(target);
            });
          },
        });
        showFilterableMenu(anchor, {
          placeholder: t("encodingPicker.searchPlaceholder"),
          emptyText: t("encodingPicker.noResults"),
          getItems: (query) =>
            encodingMenuItems(
              filterEncodingChoices(streamConvertEncodingChoices(), query),
              toItem,
              query,
            ),
        });
      },
    },
    {
      label: t("menu.repairMojibake"),
      // Mojibake is "legal but wrong" text, not a decode error, so this
      // entry doesn't depend on doc.malformed — see showDecodeWarningMenu
      // for the other entry point. Large-file previews are read-only.
      disabled: doc.truncated,
      action: () => showMojibakeRepairWizard(),
    },
  ]);
}

function showDecodeWarningMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  showMenu(anchor, [
    {
      label: t("menu.viewRawBytes"),
      // Only real files have bytes on disk to inspect; untitled docs
      // cannot reach the malformed state in the first place, but this
      // stays defensive in case that ever changes.
      disabled: doc.path === null,
      action: () => {
        if (doc.path) showHexView(doc.path, doc.title);
      },
    },
    {
      label: t("menu.repairMojibake"),
      disabled: doc.truncated,
      action: () => showMojibakeRepairWizard(),
    },
  ]);
}

function showLineEndingMenu(anchor: HTMLElement): void {
  const doc = tabs.active;
  if (!doc) return;
  // Low-cost UI disable alongside setLineEnding's own runtime guard (this
  // is an in-DOM popup, not a native OS menu — no IPC round trip needed,
  // unlike the native menu items ROADMAP.md D2's earlier rounds evaluated
  // and skipped disabling for that exact cost reason).
  const disabled = updateFreezeActive;
  showMenu(anchor, [
    {
      label: t("menu.lineEndingLf"),
      checked: doc.lineEnding === "LF",
      disabled,
      action: () => setLineEnding("LF"),
    },
    {
      label: t("menu.lineEndingCrlf"),
      checked: doc.lineEnding === "CRLF",
      disabled,
      action: () => setLineEnding("CRLF"),
    },
    {
      label: t("menu.lineEndingCr"),
      checked: doc.lineEnding === "CR",
      disabled,
      action: () => setLineEnding("CR"),
    },
  ]);
}

/** Tab-strip right-click menu (ROADMAP.md Track C "Tab context menu"):
 *  Close Others and Close Tabs to the Right operate on the id set
 *  snapshotted at click time (tabs.ts's idsOtherThan/idsToTheRightOf) and
 *  close each target exactly the way a manual close does — including the
 *  dirty-doc confirm dialog — one at a time; closeSequentially stops the
 *  moment any one of them is cancelled, leaving the rest of that batch
 *  untouched, same as if the user had cancelled a manual close partway
 *  through closing several tabs by hand. Both are disabled when their
 *  target set is empty (nothing to close), mirroring how the File > Reopen
 *  Closed Tab item is disabled while its own stack is empty.
 *
 *  Copy Path and Reveal in Finder/Explorer need a real file on disk, so
 *  both are disabled for an untitled tab (doc.path === null). Reveal goes
 *  through the already-bundled opener plugin's revealItemInDir — the
 *  `opener:default` permission set already in capabilities/default.json
 *  documents allow-reveal-item-in-dir as included (see
 *  src-tauri/gen/schemas/desktop-schema.json), so no capability change was
 *  needed. Copy Path uses the standard navigator.clipboard Web API rather
 *  than a new Tauri clipboard-plugin dependency, per CLAUDE.md's "no new
 *  runtime dependencies without strong justification" — this repo has no
 *  clipboard usage to date. The reveal label is chosen per platform the
 *  same way defaultLineEnding picks CRLF vs LF above: everything that
 *  isn't Windows is treated as the macOS/Finder case, matching this app's
 *  Tier 1 platform set (ARCHITECTURE.md).
 *
 *  Both actions are best-effort: a failed clipboard write or a file that
 *  vanished before Reveal could run isn't data-loss-risk the way the
 *  save/decode paths this app treats as [danger] are, so neither surfaces
 *  its own error dialog (mirrors syncReopenClosedTabState's IPC calls). */
function showTabContextMenu(id: number, anchor: HTMLElement): void {
  const doc = tabs.get(id);
  if (!doc) return;
  const path = doc.path;
  const others = idsOtherThan(tabs.docs, id);
  const toRight = idsToTheRightOf(tabs.docs, id);
  const isWindows = navigator.userAgent.includes("Windows");

  showMenu(anchor, [
    {
      label: t("tabs.closeOthers"),
      disabled: others.length === 0,
      action: () =>
        void closeSequentially(others, closeTab, (i) => tabs.get(i) !== null),
    },
    {
      label: t("tabs.closeTabsToRight"),
      disabled: toRight.length === 0,
      action: () =>
        void closeSequentially(toRight, closeTab, (i) => tabs.get(i) !== null),
    },
    {
      label: t("tabs.copyPath"),
      disabled: path === null,
      action: () => {
        if (path) {
          void navigator.clipboard.writeText(path).catch(() => {
            // Best-effort; see doc comment above.
          });
        }
      },
    },
    {
      label: isWindows ? t("tabs.revealInExplorer") : t("tabs.revealInFinder"),
      disabled: path === null,
      action: () => {
        if (path) {
          void revealItemInDir(path).catch(() => {
            // Best-effort; see doc comment above.
          });
        }
      },
    },
  ]);
}

/** Open the character-inspector popup (ROADMAP.md v0.4 Track A) for the
 *  status-bar segment's last-shown character. A no-op with no active
 *  document or no character currently shown — the segment is hidden
 *  whenever `currentInspectedChar()` is null, so a click can't normally
 *  reach here then, but this stays defensive like the other status-bar
 *  popup openers above. */
function showCharInspectorPopup(anchor: HTMLElement): void {
  const doc = tabs.active;
  const char = currentInspectedChar();
  if (!doc || char === null) return;
  showCharInspector(anchor, char, doc.encoding);
}

async function closeTab(id: number): Promise<void> {
  const doc = tabs.get(id);
  if (!doc) return;
  if (doc.dirty) {
    const choice = await showCloseConfirm(doc.title);
    if (choice === "cancel") return;
    if (choice === "save") {
      // saveFlow operates on the active doc; activate the tab first.
      if (tabs.activeId !== id) activate(id);
      await saveFlow(false);
      // Save dialog cancelled (e.g. untitled doc): abort the close.
      if (doc.dirty) return;
    }
  }
  if (doc.path) void unwatchFile(doc.path).catch(() => {});
  backups.drop(doc);
  const wasActive = id === tabs.activeId;
  // Record for File > Reopen Closed Tab now that the close is definitely
  // going through (both cancel paths returned above). recordClosedTab
  // itself excludes untitled tabs (path === null); a "save" choice that
  // Save-As'd an untitled tab has already set doc.path, so that close
  // records the new path. Cursor freshness mirrors collectSession: the
  // active tab's live cursor exists only in editor.snapshot() —
  // doc.buffer goes stale until the next tab switch syncs it.
  recordClosedTab(
    doc.path,
    cursorOf(wasActive ? editor.snapshot() : doc.buffer),
  );
  syncReopenClosedTabState();
  tabs.close(id);
  // The tab is gone for good — release its backup-pipeline queue/epoch
  // state. Ops already queued (the drop's delete above) still settle.
  backups.forget(doc.id);
  if (tabs.docs.length === 0) tabs.add(makeUntitled());
  if (wasActive) showActive();
  else tabs.render();
  persistSession();
}

/** File > Reopen Closed Tab (Mod+Shift+T): pop the most recently closed
 *  tab off the session-local stack and reopen it, cursor restored through
 *  openPath's cursor parameter (the same clamped path session restore
 *  uses). The popped entry is consumed even when the open fails (file
 *  deleted since the close): openPath's own error dialog reports it and
 *  the flow stops — no chained pop, so the next Mod+Shift+T moves on to
 *  the previous entry instead of retrying a dead path. A path already
 *  open in another tab goes through openPath's usual
 *  focus-the-existing-tab behavior. */
async function reopenClosedTab(): Promise<void> {
  const entry = popClosedTab();
  syncReopenClosedTabState();
  if (!entry) return;
  await openPath(entry.path, entry.cursor);
}

/** Sync the File > Reopen Closed Tab item's enabled state to whether the
 *  stack holds anything (menu.rs `sync_reopen_closed_tab_menu`; the item
 *  is built disabled since the stack is always empty at launch). Called
 *  after every push (closeTab) and pop (reopenClosedTab) — the stack is
 *  global, not per-tab, so unlike syncReadOnlyState there is nothing for
 *  showActive to re-derive on tab switches. Best-effort like the other
 *  menu-sync IPC calls. */
function syncReopenClosedTabState(): void {
  void syncReopenClosedTabMenu(hasClosedTabs()).catch(() => {
    // Best-effort; see doc comment above.
  });
}

/** Guard an Edit > Line Operations menu action against a read-only
 *  document — truncated (large-file preview: transforming a preview slice
 *  would silently diverge from the file on disk with no way to save the
 *  result back) or userReadOnly (ROADMAP.md v0.4 Track C: the user
 *  explicitly locked this tab) — then run it. Shares blockedByReadOnly's
 *  dialogs with saveFlow, so both entry points reject the same way.
 *  transformLines/transformSelection/joinLines (sort/unique/reverse/trim/
 *  upper/lowercase/join — ROADMAP.md v0.6 C2 added joinLines, same dispatch
 *  mechanics as the other two) are a raw `view.dispatch` with explicit
 *  changes, which — unlike a CM6 "command" — does not consult
 *  `state.readOnly` on its own (see editor.ts's `setReadOnly` doc comment),
 *  so this guard is their only protection; move/duplicate/delete are
 *  genuine CM6 commands that would self-no-op even without it (verified in
 *  editor.test.ts), but are guarded the same way here for one uniform
 *  rejection dialog regardless of which line operation was invoked. */
function runLineOperation(action: () => void): void {
  const doc = tabs.active;
  if (!doc) return;
  if (blockedByReadOnly(doc)) return;
  action();
}

/** Whether `encoding` (a canonical encoding_rs name, e.g. "UTF-8",
 *  "UTF-16LE") can represent every Unicode scalar value — used by
 *  `runNormalizeFlow` to skip the representability IPC round trip entirely
 *  for these targets (ROADMAP.md v0.4 Track A: UTF-8/UTF-16 documents are
 *  always fully representable, so the check can only ever come back
 *  clean), mirroring the same fast path src-tauri/src/normalize.rs's
 *  `check_representability` applies independently on the Rust side. */
function isUnicodeEncoding(encoding: string): boolean {
  return encoding === "UTF-8" || encoding.startsWith("UTF-16");
}

type NormalizeGuardOutcome = "apply" | "silent" | "notify" | "frozen";

/**
 * Re-validate `guard` (captured at the very start of `runNormalizeFlow`,
 * before its first await) against `doc`'s current state — called after
 * each of that function's three await gaps (the confirm dialog, the
 * checkRepresentable IPC round trip, the second confirm), right before
 * deciding whether to keep going [issue #158]. Combines asyncguard.ts's
 * id/revision identity check (issue #159 — the same one
 * fetchAndApplyReload/fetchAndApplyReopen use) with an explicit active-tab
 * check neither of those needs: `editor` is a single surface shared by
 * every tab, so even a `doc` that's untouched and still open must not be
 * written to once the user has switched away from it —
 * `editor.replaceContent` would land on whatever tab is now showing
 * instead. This is exactly the hazard `showMojibakeRepairWizard` already
 * guards against via its own `tabs.activeId` check (that check predates
 * asyncguard.ts, so it doesn't use captureIdentity/validateIdentity, but
 * the reasoning is the same).
 *
 * "apply": nothing relevant happened — safe to keep going, with zero
 * further await before the next mutation (see call sites below). "silent":
 * either the tab closed (asyncguard.ts's "closed") or the user switched to
 * a different tab — nothing useful to tell them either way, same as
 * showMojibakeRepairWizard's own silent tab-switch case. "notify": still
 * the active tab, but its revision moved (asyncguard.ts's "edited",
 * overwhelmingly a keystroke) — the user is still looking right at this
 * tab and just confirmed an operation, so silently discarding it with no
 * explanation would be confusing; the caller shows a dialog. "frozen": the
 * update-install freeze (ROADMAP.md D2, Codex re-review of PR #309) is
 * active — checked *before* `validateIdentity` since freezing never moves
 * `doc.revision` (it blocks edits, it doesn't produce one), so the
 * revision check alone would have no way to notice it and would wrongly
 * report "apply". A second, uncollapsed apply point that skipped this is
 * exactly how the previous review round's fix — freezing the CM6
 * compartment plus `blockedByReadOnly` — still missed this flow's own
 * `editor.replaceContent`, which sits *after* an async confirm/IPC gap and
 * never re-derives `canMutateDocument` on its own; this function is now
 * where that re-derivation lives for every one of `runNormalizeFlow`'s
 * three checkpoints.
 */
function normalizeGuardOutcome(guard: GuardIdentity, doc: Doc): NormalizeGuardOutcome {
  if (tabs.activeId !== guard.id) return "silent";
  if (updateFreezeActive) return "frozen";
  const verdict = validateIdentity(guard, doc, tabs.docs.includes(doc));
  if (verdict === "apply") return "apply";
  if (verdict === "closed") return "silent";
  return "notify";
}

/**
 * Edit > Normalize to NFC/NFD (ROADMAP.md v0.4 Track A) [danger]. Never
 * applies silently:
 *
 * 1. normalize.ts's `planNormalization` computes the result and how many
 *    combining-character sequences would change; a no-op (already in the
 *    target form — the common case for this app's CJK-heavy documents,
 *    since plain ideographs have no canonical decomposition) applies
 *    nothing and shows no dialog, matching the existing sort/trim/
 *    case-conversion Line Operations' own no-op-dispatches-nothing
 *    precedent (editor.ts's `transformLines`/`transformSelection`).
 * 2. A confirm dialog names the affected sequence count; declining leaves
 *    the buffer untouched.
 * 3. Unless the document's current save encoding is UTF-8/UTF-16
 *    (`isUnicodeEncoding`), a Rust representability dry-run (ipc.ts's
 *    `checkRepresentable`, mirroring `save_document`'s own lossy-encode
 *    gate) checks whether the normalized result can still be losslessly
 *    saved — this is the actual point of the whole feature: NFD's
 *    decomposed combining sequences are frequently unrepresentable in
 *    legacy encodings even when the precomposed NFC form was fine. If
 *    anything is unmappable, a second, explicit warning names the
 *    encoding, the count, and a sample of the characters that would be
 *    lost; declining leaves the buffer untouched. Accepting still leaves
 *    `save_document`'s own lossy gate in place at actual save time —
 *    defense in depth, not a replacement for it.
 * 4. Only then is the transform applied, via `editor.replaceContent` (CM6
 *    undo history intact — one Undo reverts the whole normalization, same
 *    as the mojibake repair wizard).
 *
 * Always whole-document (`editor.content()`/`editor.replaceContent`),
 * never selection-scoped — see menu.rs's `normalize_nfc`/`normalize_nfd`
 * doc comment. Wrapped in `runLineOperation` (see the switch cases below)
 * for the same truncated/userReadOnly guard sort/unique/trim use: a
 * large-file preview's transform would silently diverge from the file on
 * disk with no way to save it back, exactly like those (ROADMAP.md v0.4
 * Track A item 6 — no separate native-menu-disabled wiring needed, this is
 * the same runtime guard).
 *
 * `doc`/the active tab can move on during any of the three await gaps
 * below — a same-tab edit, a tab switch, or the tab closing outright
 * (issue #158: cross-tab apply and edit-overwrite were both filed against
 * the original unconditional `editor.replaceContent` at the end). `guard`
 * (captured up front) is re-validated via `normalizeGuardOutcome` after
 * every one of them, with the same zero-await-before-apply discipline
 * fetchAndApplyReload/fetchAndApplyReopen already established (issue
 * #159): the outcome check itself is a plain synchronous call, and only
 * its "notify" branch (a fire-and-forget dialog, matching
 * showMojibakeRepairWizard's own un-awaited staleContentMessage) touches
 * anything async — every path that reaches the final
 * `editor.replaceContent` does so with no further await after its last
 * passing check.
 */
async function runNormalizeFlow(form: NormalizeForm): Promise<void> {
  const doc = tabs.active;
  if (!doc) return;
  const guard = captureIdentity(doc);
  try {
    const plan = planNormalization(editor.content(), form);
    if (!plan.changed) return;

    const proceed = await confirmDialog(
      t("dialog.normalizeConfirmMessage", plan.changedCount, form),
      {
        title: t("dialog.normalizeConfirmTitle", form),
        kind: "warning",
        okLabel: t("dialog.normalizeConfirmButton"),
      },
    );
    if (!proceed) return;
    let outcome = normalizeGuardOutcome(guard, doc);
    if (outcome === "notify") {
      void messageDialog(t("dialog.normalizeStaleMessage"), {
        title: t("dialog.normalizeStaleTitle"),
        kind: "warning",
      });
    }
    if (outcome === "frozen") {
      void messageDialog(t("dialog.updateInProgressMessage"), {
        title: t("dialog.updateInProgressTitle"),
        kind: "warning",
      });
    }
    if (outcome !== "apply") return;

    if (!isUnicodeEncoding(doc.encoding)) {
      const report = await checkRepresentable(plan.normalized, doc.encoding);
      outcome = normalizeGuardOutcome(guard, doc);
      if (outcome === "notify") {
        void messageDialog(t("dialog.normalizeStaleMessage"), {
          title: t("dialog.normalizeStaleTitle"),
          kind: "warning",
        });
      }
      if (outcome === "frozen") {
        void messageDialog(t("dialog.updateInProgressMessage"), {
          title: t("dialog.updateInProgressTitle"),
          kind: "warning",
        });
      }
      if (outcome !== "apply") return;

      if (report.unmappableCount > 0) {
        const proceedAnyway = await confirmDialog(
          t(
            "dialog.normalizeUnrepresentableMessage",
            doc.encoding,
            report.unmappableCount,
            report.samples,
            report.samplesTruncated,
          ),
          {
            title: t("dialog.normalizeUnrepresentableTitle"),
            kind: "warning",
            okLabel: t("dialog.normalizeUnrepresentableConfirm"),
          },
        );
        if (!proceedAnyway) return;
        outcome = normalizeGuardOutcome(guard, doc);
        if (outcome === "notify") {
          void messageDialog(t("dialog.normalizeStaleMessage"), {
            title: t("dialog.normalizeStaleTitle"),
            kind: "warning",
          });
        }
        if (outcome === "frozen") {
          void messageDialog(t("dialog.updateInProgressMessage"), {
            title: t("dialog.updateInProgressTitle"),
            kind: "warning",
          });
        }
        if (outcome !== "apply") return;
      }
    }

    editor.replaceContent(plan.normalized);
  } catch (error) {
    await messageDialog(String(error), {
      title: t("dialog.normalizeFailedTitle"),
      kind: "error",
    });
  }
}

// File shortcuts (Mod-T/O/S/W) are owned by the native menu accelerators —
// binding them here as well would double-fire. Only tab cycling stays in
// the WebView because Ctrl+Tab is not reliable as a menu accelerator.
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  }
});

/**
 * Runs a native-menu command by id. Extracted out of the `mojidori://menu`
 * listener below (ROADMAP.md v0.6 C1) so the Command Palette
 * (src/palette.ts's `showPalette`) can dispatch a selected command by
 * calling this exact function directly — a plain synchronous call, not a
 * simulated IPC round trip — guaranteeing the palette can never diverge
 * from what a native menu click does for the same id.
 *
 * Guard audit performed for the palette (ROADMAP.md v0.6 C1's "Danger-lite"
 * acceptance criterion): every case below was checked against three
 * invalid states — no active doc, a truncated large-file preview, and a
 * user-locked read-only tab — since the palette can dispatch any of them
 * with no per-command enabled filtering (documented trade-off, see
 * palette.ts's own module comment). Most cases are either state-
 * independent (preference toggles; dialog openers not scoped to the active
 * doc, e.g. preferences/open_recent/batch_convert; non-mutating selection/
 * navigation commands, e.g. select_next_occurrence/find/fold_all — CM6
 * commands that self-no-op on an unmet precondition rather than throw) or
 * already gate through a shared, independently-tested helper:
 * `runLineOperation`'s no-doc + `blockedByReadOnly` check covers every
 * line-operation case (sort/unique/reverse/trim/case/width/normalize/move/
 * duplicate/delete/join — ROADMAP.md v0.6 C2's join_lines/reverse_lines and
 * C3's sort_lines_case_insensitive/sort_lines_numeric included, both added
 * after this audit but through the same guard, as does ROADMAP.md v0.7
 * Track C's insert_datetime); `saveFlow`
 * has its own no-doc + `blockedByReadOnly`
 * check; `toggleReadOnly`/`handleGotoLine`/`toggleBookmarkFlow`/
 * `nextBookmarkFlow`/`previousBookmarkFlow` each have their own no-doc
 * check; `stream_replace`/`document_info` below have their own explicit
 * no-doc check. The one bare case this audit found was `print` — no doc
 * guard at all (though `editor.content()` on no active doc never throws
 * either way, it would print whatever the editor singleton currently holds
 * with no basis) — given a defensive `if (!tabs.active) break;` below for
 * consistency with `stream_replace`/`document_info`'s style. ROADMAP.md
 * v0.6 C4's clear_recent_files, added after this audit, joins the
 * state-independent group above — like open_recent, it never touches the
 * active doc at all. ROADMAP.md v0.7 Track C's replace_in_selection/
 * replace_all_in_selection, added after this audit, join the
 * `runLineOperation`-guarded group above — unlike the surrounding
 * selection-only commands (select_next_occurrence/goto_matching_bracket),
 * they do mutate buffer content via a raw `view.dispatch`, same guard
 * rationale as the line-operation cases.
 */
function dispatchMenuCommand(id: string): void {
  switch (id) {
    case "new_tab":
      newTab();
      break;
    case "open":
      void openFileFlow();
      break;
    case "save":
      void saveFlow(false);
      break;
    case "save_as":
      void saveFlow(true);
      break;
    case "close_tab":
      if (tabs.activeId !== null) void closeTab(tabs.activeId);
      break;
    case "reopen_closed_tab":
      void reopenClosedTab();
      break;
    // Selection commands, not edits — like "find"/"goto_line" below, these
    // run unguarded (no runLineOperation truncated-preview check): they
    // only move/extend the selection, never touch buffer content, so a
    // large-file read-only preview has nothing to silently diverge.
    case "select_next_occurrence":
      editor.selectNextOccurrence();
      break;
    case "select_all_occurrences":
      editor.selectAllOccurrences();
      break;
    case "find":
      editor.openSearch();
      break;
    case "preferences":
      showPreferencesDialog();
      break;
    case "open_recent":
      showQuickOpen(recentFiles, (path) => void openPath(path));
      break;
    case "clear_recent_files":
      clearRecent();
      break;
    case "word_wrap":
      toggleWordWrap();
      break;
    case "show_invisibles":
      toggleShowInvisibles();
      break;
    case "indent_guides":
      toggleIndentGuides();
      break;
    case "suspicious_chars":
      toggleSuspiciousChars();
      break;
    case "read_only":
      toggleReadOnly();
      break;
    case "fold_all":
      editor.foldAll();
      break;
    case "unfold_all":
      editor.unfoldAll();
      break;
    case "zoom_in":
      adjustFontSize(1);
      break;
    case "zoom_out":
      adjustFontSize(-1);
      break;
    case "zoom_reset":
      adjustFontSize(0);
      break;
    case "find_in_files":
      showFindInFiles((path, line) => {
        void openPath(path).then(() => editor.goToLine(line));
      });
      break;
    case "goto_line":
      showGoToLine((line, column) => handleGotoLine(line, column));
      break;
    // Cursor movement only, like select_next_occurrence/
    // select_all_occurrences above and goto_line just above — unguarded
    // (no runLineOperation) for the same reason: it never touches buffer
    // content, so it stays safe on a read-only or truncated large-file
    // preview.
    case "goto_matching_bracket":
      editor.goToMatchingBracket();
      break;
    // ROADMAP.md v0.7 Track C [danger]: unlike select_next_occurrence/
    // goto_matching_bracket above, these DO mutate buffer content (they
    // dispatch replacement edits, not just move the selection), so — same
    // reasoning as the Line Operations group below — they go through
    // runLineOperation for the no-doc + read-only/truncated-large-file
    // guard. The actual matching, `$`-group substitution, and offset
    // bookkeeping are editor.ts's thin `replaceInSelection`/
    // `replaceAllInSelection`, backed by the pure core replacescope.ts.
    case "replace_in_selection":
      runLineOperation(() => editor.replaceInSelection());
      break;
    case "replace_all_in_selection":
      runLineOperation(() => editor.replaceAllInSelection());
      break;
    case "toggle_bookmark":
      toggleBookmarkFlow();
      break;
    case "next_bookmark":
      nextBookmarkFlow();
      break;
    case "prev_bookmark":
      previousBookmarkFlow();
      break;
    case "sort_lines":
      runLineOperation(() => editor.transformLines(sortLines));
      break;
    // ROADMAP.md v0.6 C3: same family as sort_lines above -- "no
    // selection = whole document" via transformLines, no span logic of
    // their own -- just a different per-line comparison (see lineops.ts's
    // sortLinesCaseInsensitive/sortLinesNumeric doc comments).
    case "sort_lines_case_insensitive":
      runLineOperation(() => editor.transformLines(sortLinesCaseInsensitive));
      break;
    case "sort_lines_numeric":
      runLineOperation(() => editor.transformLines(sortLinesNumeric));
      break;
    case "unique_lines":
      runLineOperation(() => editor.transformLines(uniqueLines));
      break;
    // ROADMAP.md v0.6 C2: same "no selection = whole document" scope as
    // sort/unique above (editor.ts's transformLines) — Reverse Lines has
    // no span rule of its own, unlike Join Lines below.
    case "reverse_lines":
      runLineOperation(() => editor.transformLines(reverseLines));
      break;
    case "trim_trailing_whitespace":
      runLineOperation(() => editor.transformLines(trimTrailingWhitespace));
      break;
    // "Current effective width" (ROADMAP.md v0.4 Track C spec) is CM6's own
    // live tabSize — already driven by indentdetect.ts's per-buffer
    // detection via editor.ts's setIndentation (see computeAndShowIndent
    // above) — so reading `editor.snapshot().tabSize` fresh at invocation
    // time is exactly the right width with no separate tracking needed.
    case "convert_leading_tabs_to_spaces":
      runLineOperation(() =>
        editor.transformLines((text) => convertLeadingTabsToSpaces(text, editor.snapshot().tabSize)),
      );
      break;
    case "convert_leading_spaces_to_tabs":
      runLineOperation(() =>
        editor.transformLines((text) => convertLeadingSpacesToTabs(text, editor.snapshot().tabSize)),
      );
      break;
    case "move_line_up":
      runLineOperation(() => editor.moveLineUp());
      break;
    case "move_line_down":
      runLineOperation(() => editor.moveLineDown());
      break;
    case "duplicate_line":
      runLineOperation(() => editor.duplicateLine());
      break;
    case "delete_line":
      runLineOperation(() => editor.deleteLine());
      break;
    // ROADMAP.md v0.6 C2: unlike every other case in this group,
    // editor.joinLines has its own span rule (current line + the next
    // one when there's no selection, mainstream Join Lines convention —
    // see editor.ts's joinLinesSpanInDoc), not transformLines' "whole
    // document" default, so it takes the transform function directly
    // instead of going through transformLines/transformSelection.
    case "join_lines":
      runLineOperation(() => editor.joinLines(joinLines));
      break;
    case "uppercase":
      runLineOperation(() => editor.transformSelection(upperCase));
      break;
    case "lowercase":
      runLineOperation(() => editor.transformSelection(lowerCase));
      break;
    // ROADMAP.md v0.4 Track A: FF01-FF5E <-> ASCII plus ideographic space
    // <-> plain space (see lineops.ts toFullWidth/toHalfWidth docs). A
    // transformSelection like uppercase/lowercase above, not
    // transformLines: this is a character-level substitution with no
    // per-line meaning, so a partial-line selection must stay verbatim
    // rather than being expanded to full lines.
    case "to_full_width":
      runLineOperation(() => editor.transformSelection(toFullWidth));
      break;
    case "to_half_width":
      runLineOperation(() => editor.transformSelection(toHalfWidth));
      break;
    // ROADMAP.md v0.4 Track A [danger]: unlike the transforms above,
    // `runNormalizeFlow` is async (confirm dialogs, a representability IPC
    // round trip) and decides for itself whether there is anything to
    // apply at all — see its own doc comment. `runLineOperation` still
    // guards the read-only/truncated check synchronously before it starts.
    case "normalize_nfc":
      runLineOperation(() => void runNormalizeFlow("NFC"));
      break;
    case "normalize_nfd":
      runLineOperation(() => void runNormalizeFlow("NFD"));
      break;
    // ROADMAP.md v0.7 Track C stretch: inserts a localized "now" timestamp
    // at the cursor, replacing the selection if there is one
    // (editor.ts's insertTextAtCursor — CM6 replaceSelection semantics).
    // A buffer mutation, not a selection/navigation command, so it goes
    // through the same runLineOperation guard as the Line Operations group
    // above rather than running unguarded like goto_matching_bracket.
    case "insert_datetime":
      runLineOperation(() =>
        editor.insertTextAtCursor(formatInsertDateTime(getLocale(), new Date())),
      );
      break;
    case "batch_convert":
      showBatchConvert();
      break;
    case "stream_replace": {
      const doc = tabs.active;
      if (!doc) break;
      if (!doc.truncated) {
        // The regular in-editor Find/Replace (Mod+F) already covers this
        // document in full; streaming replace exists only for read-only
        // large-file previews, where only a slice of the file is loaded.
        void messageDialog(t("dialog.streamReplaceUseRegularMessage"), {
          title: t("dialog.streamReplaceUseRegularTitle"),
          kind: "info",
        });
        break;
      }
      if (doc.path) {
        const path = doc.path;
        // Same capture-before-IPC guard as the streamConvert flow above
        // (issue #163) — see streamCompletionTarget's doc comment.
        const guard = captureIdentity(doc);
        showStreamReplace(path, doc.encoding, () => {
          const target = streamCompletionTarget(guard, doc, path);
          if (!target) {
            void messageDialog(t("streamReplace.completedTabClosedMessage"), {
              title: t("streamReplace.title", basename(path)),
              kind: "info",
            });
            return;
          }
          void reloadFromDisk(target);
        });
      }
      break;
    }
    // Read-only trust surface (ROADMAP.md v0.6 E1): no truncated/read-only
    // guard needed (nothing here mutates the document) — only a no-active-
    // tab guard, same as stream_replace above. See docinfo.ts's module doc
    // comment for the untitled-tab (buffer-only) and truncated-window
    // (text stats hidden, same as the status bar) handling.
    case "document_info": {
      const doc = tabs.active;
      if (!doc) break;
      showDocumentInfo({
        path: doc.path,
        title: doc.title,
        encoding: doc.encoding,
        withBom: doc.withBom,
        lineEnding: doc.lineEnding,
        dirty: doc.dirty,
        // The open-time hint snapshot — the hint openDocument actually
        // got (issue #255), not a fresh recomputation that a later
        // preference edit can desynchronize (issue #264).
        extensionEncoding: doc.detectionHint ?? undefined,
        textStats: doc.truncated ? null : textStatsOf(editor.snapshot()),
      });
      break;
    }
    // ROADMAP.md D2 signing + auto-update: same flow the startup
    // background check runs, but non-silent — see updater.ts's own doc
    // comment on checkForUpdatesAndPrompt's `silent` option.
    case "check_for_updates":
      void checkForUpdatesAndPrompt(updaterDeps, { silent: false });
      break;
    case "print": {
      // Defensive no-doc guard (ROADMAP.md v0.6 C1 palette dispatch-safety
      // audit, this function's own doc comment above) — structurally
      // near-impossible in practice (closeTab always leaves at least one
      // tab open), but costs nothing and matches stream_replace/
      // document_info's style above.
      if (!tabs.active) break;
      // The editor's viewport only renders visible lines, so printing goes
      // through a print-only view holding the full document text.
      const printView = document.querySelector<HTMLElement>("#print-view")!;
      printView.textContent = editor.content();
      void printWindow()
        .catch((error) =>
          messageDialog(String(error), {
            title: t("dialog.printTitle"),
            kind: "warning",
          }),
        )
        .finally(() => {
          printView.textContent = "";
        });
      break;
    }
    // Command Palette (Mod+Shift+P; ROADMAP.md v0.6 C1): fetches the
    // current-locale command list fresh on every open (cheap — a pure
    // static-table lookup on the Rust side, see menu.rs `palette_commands`
    // — so there is no stale-language cache to invalidate when the user
    // changes the language preference mid-session) and shows the overlay.
    case "command_palette":
      void openCommandPalette();
      break;
    default:
      // The View > Theme submenu emits "theme_<value>" for each of its
      // radio entries (menu.rs); route those without a case per value.
      if (id.startsWith("theme_")) {
        setTheme(id.slice("theme_".length));
      }
      break;
  }
}

/** Fetch the palette's command list in the current locale and show it (see
 *  `dispatchMenuCommand`'s own doc comment for the dispatch-safety
 *  contract). Best-effort like the menu-sync IPC calls elsewhere in this
 *  file: a failed fetch just means Mod+Shift+P silently does nothing
 *  rather than throwing, matching this file's `case "print"` neighbor
 *  above and the palette's own no-active-doc guard style. */
async function openCommandPalette(): Promise<void> {
  let commands: PaletteCommand[];
  try {
    commands = await paletteCommands(getLocale());
  } catch {
    return;
  }
  showPalette(commands, (id) => dispatchMenuCommand(id));
}

void listen<string>("mojidori://menu", (event) => dispatchMenuCommand(event.payload));

/** One pass of the updater's hot-exit flush: snapshot and write every
 *  dirty, non-truncated doc's backup, then persist the session. Split out
 *  of `flushForUpdateRestart` purely so that function's bounded-retry loop
 *  can call it more than once without duplicating the loop body. */
async function runUpdateFlushPass(): Promise<boolean> {
  let ok = true;
  for (const doc of tabs.docs) {
    if (!doc.dirty || doc.truncated) continue;
    const content = doc.id === tabs.activeId ? editor.content() : contentOf(doc.buffer);
    const flushed = await backups.flush(doc, content).catch(() => false);
    if (!flushed) {
      console.error(`updater: backup flush failed for ${doc.title}`);
      ok = false;
    }
  }
  try {
    await sessionPersist.persist();
  } catch (error) {
    console.error("updater: session persist failed", error);
    ok = false;
  }
  return ok;
}

/** `(doc.id, doc.revision)` for every open tab, joined into one string —
 *  cheap enough to compute twice around a flush pass just to diff.
 *  `doc.revision` (issue #112, `nextRevision` above) already bumps on
 *  every edit, is what `savecompletion.ts`'s own await-window staleness
 *  check compares, and is exactly the signal `flushForUpdateRestart`'s own
 *  re-verification needs: under a correctly-held `freezeForUpdate` this
 *  should never change mid-pass, an id set changing (a tab opened/closed
 *  during the flush) is folded in as "changed" too, and the join order
 *  matching `tabs.docs`'s own iteration order means a pure reorder also
 *  counts as changed — over-cautious, but a spurious retry is harmless
 *  where a missed one would defeat the whole point of re-verifying. */
function updateFlushSignature(): string {
  return tabs.docs.map((doc) => `${doc.id}:${doc.revision}`).join("|");
}

/** Hot-exit flush for the updater's install-and-restart flow (ROADMAP.md
 *  D2, src/updater.ts's `UpdaterDeps.flushForExit`). Deliberately mirrors —
 *  rather than shares — onCloseRequested's own flush loop just below:
 *  `plugin:process|restart` bypasses onCloseRequested entirely (Tauri's
 *  `request_restart` skips per-window close events), so the updater needs
 *  a flush called explicitly, but onCloseRequested's close-vs-discard
 *  state machine is delicate enough (issue #63) that duplicating a few
 *  lines here is safer than reshaping it to serve a second caller.
 *  `backupFlush.cancel()` mirrors onCloseRequested's own first line — a
 *  pending debounced flush from typing must not race this explicit one.
 *
 *  The caller (updater.ts's promptAndInstall) already holds
 *  `freezeForUpdate` across this whole call — `flushWithRevisionRecheck`
 *  (updaterflush.ts) re-verifies that invariant rather than being the
 *  primary defense against it, retrying up to twice if a doc's signature
 *  moved between the start and end of a pass, and exhausting the retries
 *  is folded into the same `false` result an ordinary write failure
 *  produces, reusing updater.ts's existing flush-failed dialog rather than
 *  a second, parallel failure path.
 *
 *  Unlike onCloseRequested, a failure here doesn't block by itself — it
 *  reports back via the return value (`false` if any backup or the
 *  session write failed, or the signature never stabilized) so
 *  updater.ts's caller can ask the user whether to install anyway, rather
 *  than this function silently deciding for them the way an unconditional
 *  install would. */
async function flushForUpdateRestart(): Promise<boolean> {
  backupFlush.cancel();
  return flushWithRevisionRecheck({
    runPass: runUpdateFlushPass,
    signature: updateFlushSignature,
    maxRetries: 2,
    onRetry: (attempt, maxAttempts) =>
      console.error(
        `updater: document state changed during a frozen flush (attempt ${attempt}/${maxAttempts}); retrying`,
      ),
  });
}

const updaterDeps: UpdaterDeps = {
  flushForExit: flushForUpdateRestart,
  freezeForUpdate,
  unfreezeForUpdate,
};

// Hot exit: flush every unsaved buffer to its backup and quit without
// asking — the next launch restores everything, including untitled tabs.
// If any backup cannot be written (disk full, unwritable config dir),
// closing would silently break that promise, so the window stays open
// and the user chooses: fix the problem, or discard knowingly (#63).
void getCurrentWindow().onCloseRequested(async (event) => {
  backupFlush.cancel();
  const failedTitles: string[] = [];
  for (const doc of tabs.docs) {
    if (!doc.dirty || doc.truncated) continue;
    const content =
      doc.id === tabs.activeId ? editor.content() : contentOf(doc.buffer);
    if (!(await backups.flush(doc, content))) failedTitles.push(doc.title);
  }
  if (failedTitles.length > 0) {
    event.preventDefault();
    // A rejected dialog counts as cancel — staying open is the safe side.
    const discard = await confirmDialog(
      t("dialog.backupFailedMessage", failedTitles),
      {
        title: t("dialog.backupFailedTitle"),
        kind: "warning",
        okLabel: t("dialog.backupFailedDiscard"),
      },
    ).catch(() => false);
    if (discard) {
      // Deliberately keep any backup a *previous* flush wrote, and keep
      // the session referencing it: the next launch may resurrect an
      // older version of these docs as dirty tabs. Losing only the very
      // last edits the user just gave up on — instead of deleting the
      // older backup too — errs on the keep-more side. Through
      // sessionPersist, not a bare call: this must wait for whatever a
      // just-landed backup flush (see persistSession above) already
      // queued, or this final write could race it (v0.7 Track R).
      await sessionPersist.persist().catch(() => {});
      // destroy() closes without re-emitting a close request.
      void getCurrentWindow().destroy();
    }
    return;
  }
  // Same reasoning as the discard branch above: through sessionPersist so
  // this final write is ordered after anything already queued.
  await sessionPersist.persist().catch(() => {});
});

document
  .querySelector<HTMLElement>("#chunk-prev")!
  .addEventListener("click", () => void pageChunk(-1));
document
  .querySelector<HTMLElement>("#chunk-next")!
  .addEventListener("click", () => void pageChunk(1));
document
  .querySelector<HTMLElement>("#status-encoding")!
  .addEventListener("click", (event) =>
    showEncodingMenu(event.currentTarget as HTMLElement),
  );
document
  .querySelector<HTMLElement>("#status-line-ending")!
  .addEventListener("click", (event) =>
    showLineEndingMenu(event.currentTarget as HTMLElement),
  );
document
  .querySelector<HTMLElement>("#status-warning")!
  .addEventListener("click", (event) =>
    showDecodeWarningMenu(event.currentTarget as HTMLElement),
  );
document
  .querySelector<HTMLElement>("#status-char-inspector")!
  .addEventListener("click", (event) =>
    showCharInspectorPopup(event.currentTarget as HTMLElement),
  );

/** Keep new untitled numbering clear of titles restored from backups.
 *  Matches both untitled roots ("Untitled", "未命名") since a session or
 *  hot-exit backup created under one locale can be restored under another. */
function bumpUntitledCounter(title: string): void {
  for (const root of ["Untitled", "未命名"]) {
    const match = new RegExp(`^${root}(?:-(\\d+))?$`).exec(title);
    if (match) {
      untitledCounter = Math.max(
        untitledCounter,
        match[1] ? Number(match[1]) : 1,
      );
      return;
    }
  }
}

/** Restore one session entry from its hot-exit backup, if present. Backup
 *  read failures (as opposed to "this entry never had a backup", which is
 *  silent) push `title` onto `unreadable` instead of surfacing a dialog
 *  here — restoreSession warns once for the whole restore instead of once
 *  per failed tab (v0.6 V2 IPC-error-surfacing audit #1). */
async function restoreFromBackup(
  file: SessionFile,
  unreadable: string[],
): Promise<boolean> {
  if (!file.backup) return false;
  const title =
    file.title || (file.path ? basename(file.path) : t("app.untitled"));
  const content = await loadBackup(file.backup).catch(() => null);
  if (content === null) {
    unreadable.push(title);
    return false;
  }
  bumpUntitledCounter(title);
  tabs.add({
    id: nextId++,
    path: file.path,
    title,
    encoding: file.encoding,
    withBom: file.withBom ?? false,
    lineEnding: file.lineEnding || defaultLineEnding,
    malformed: false,
    dirty: true,
    revision: 0,
    truncated: false,
    // Restored from the session (ROADMAP.md v0.4 Track C) — defaults to
    // false via `??` for a session file written before this field existed
    // (see session.rs SessionFile.user_read_only's own #[serde(default)]).
    userReadOnly: file.userReadOnly ?? false,
    totalSize: 0,
    chunkOffset: 0,
    nextChunkOffset: null,
    prevChunkOffsets: [],
    windowChunks: [],
    lineIndex: null,
    windowStartLine: null,
    bookmarks: [],
    chunkGeneration: 0,
    chunkLoadInFlight: false,
    saveReloadInFlight: null,
    pendingReload: false,
    pendingSaveAs: null,
    speculativeEncoding: null,
    backupName: file.backup,
    detectionHint: null,
    // Restored from the hot-exit backup blob, not from a fresh disk read —
    // there is no verified on-disk baseline for this tab's content this
    // session, so the next save must skip the staleness check (issue #113)
    // exactly like an untitled document's first save.
    fingerprint: null,
    byteDriftChecked: false,
    buffer: editor.newBuffer(content, false, file.cursor ?? 0),
  });
  if (file.path) void watchFile(file.path).catch(() => {});
  return true;
}

/** Reopen the files from the previous session; missing files are skipped. */
async function restoreSession(): Promise<void> {
  const session = await loadSession().catch(() => null);
  // Collected across both the session-tracked loop below and the orphan
  // loop further down, then reported as one dialog at the end instead of
  // one per failed tab (v0.6 V2 IPC-error-surfacing audit #1).
  const unreadableBackups: string[] = [];
  for (const file of session?.files ?? []) {
    try {
      if (await restoreFromBackup(file, unreadableBackups)) continue;
      if (file.path) {
        const opened = await openDocument(file.path, file.encoding);
        // The hint environment of *this* open action (issue #264): the
        // restore decodes with the session's explicit encoding, so no
        // detection ran, but diagnostics still hypothesize "what would
        // auto-detect choose" — anchor that to restore time, matching
        // openPath's capture-at-open semantics.
        const doc = docFromOpened(opened, file.cursor ?? 0, extensionHint(file.path) ?? null);
        // docFromOpened only knows what open_document returned — the
        // user-lock is session-only state layered on afterward, same
        // reasoning as restoreFromBackup's literal above.
        doc.userReadOnly = file.userReadOnly ?? false;
        tabs.add(doc);
      }
    } catch {
      // The file may have been moved or deleted since last session.
    }
  }
  // Recover backups the session index doesn't account for: either the
  // index itself is missing/corrupt (issue #62), or it's merely stale (a
  // backup landed on disk without ever being recorded, or its entry was
  // dropped, before the backup file itself was removed). Each orphan
  // becomes its own untitled tab. This can occasionally resurrect a stale
  // leftover from a failed delete_backup as a spurious extra tab, but that
  // cost is far cheaper than silently losing unsaved content.
  //
  // A failed scan (as opposed to one that legitimately finds nothing) means
  // this whole safety net silently covered zero backups this session —
  // worth a one-time warning rather than looking identical to "there was
  // nothing to recover" (v0.6 V2 IPC-error-surfacing audit #2).
  let orphanScanFailed = false;
  const all = await listBackups().catch(() => {
    orphanScanFailed = true;
    return [] as string[];
  });
  const orphans = orphanBackups(
    session?.files.map((f) => f.backup) ?? [],
    all,
  );
  for (const name of orphans) {
    const content = await loadBackup(name).catch(() => null);
    if (content === null) {
      unreadableBackups.push(name);
      continue;
    }
    untitledCounter += 1;
    const title =
      untitledCounter === 1
        ? t("app.untitled")
        : t("app.untitledNumbered", untitledCounter);
    tabs.add({
      id: nextId++,
      path: null,
      title,
      encoding: preferences().defaultEncoding,
      withBom: preferences().defaultBom,
      lineEnding: defaultLineEnding,
      malformed: false,
      dirty: true,
      revision: 0,
      truncated: false,
      // Orphaned backup with no session entry at all to read a lock from.
      userReadOnly: false,
      totalSize: 0,
      chunkOffset: 0,
      nextChunkOffset: null,
      prevChunkOffsets: [],
      windowChunks: [],
      lineIndex: null,
      windowStartLine: null,
      bookmarks: [],
      chunkGeneration: 0,
      chunkLoadInFlight: false,
      saveReloadInFlight: null,
      pendingReload: false,
      pendingSaveAs: null,
      speculativeEncoding: null,
      backupName: name,
      detectionHint: null,
      // Orphaned backup with no session entry at all — path is always
      // null here, so this is the same "no on-disk baseline yet" case as
      // makeUntitled (issue #113).
      fingerprint: null,
      byteDriftChecked: false,
      buffer: editor.newBuffer(content, false, 0),
    });
  }
  if (tabs.docs.length === 0) {
    tabs.add(makeUntitled());
  } else {
    const index = Math.min(session?.active ?? 0, tabs.docs.length - 1);
    tabs.setActive(tabs.docs[index].id);
  }
  showActive();
  editor.revealCursor();
  // Fired with `void`, not awaited: these are informational, after the
  // fact, and must not delay takePendingFiles()/openPath() for files an
  // OS "Open With"/CLI invocation asked Mojidori to open (issue audit v0.6
  // V2 #1/#2) — the recovery attempts above already ran to completion
  // either way.
  if (unreadableBackups.length > 0) {
    void messageDialog(
      t("dialog.backupRestoreFailedMessage", unreadableBackups),
      { title: t("dialog.backupRestoreFailedTitle"), kind: "warning" },
    );
  }
  if (orphanScanFailed) {
    void messageDialog(t("dialog.orphanScanFailedMessage"), {
      title: t("dialog.orphanScanFailedTitle"),
      kind: "warning",
    });
  }
}

// Files opened through the OS while the app is already running.
void listen<string[]>("mojidori://open-files", async (event) => {
  for (const path of event.payload) {
    await openPath(path);
  }
});

// Files dragged from the system onto the window.
void getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop") return;
  for (const path of event.payload.paths) {
    await openPath(path);
  }
});

// Watched files that changed on disk outside of Mojidori.
void listen<string[]>("mojidori://file-changed", async (event) => {
  for (const path of event.payload) {
    await handleExternalChange(path);
  }
});

// Locale changes (from the Preferences dialog's Language select) update the
// frontend's own strings immediately; the native menu relabels itself
// separately (see preferences.ts applyLanguage / ipc.ts retitleMenu).
onLocaleChange(() => {
  tabs.render();
  refreshStatusBar();
  refreshCursor();
  refreshCharInspector();
  refreshTextStats();
  refreshSuspiciousChars();
  refreshNormalizationStatus();
  refreshIndentInfo();
  updateWindowTitle();
});

void (async () => {
  // Preferences first: the untitled fallback uses the default encoding, and
  // the resolved locale needs to be applied before anything else renders.
  await initPreferences(editor);
  refreshStatusBar();
  refreshCursor();
  refreshCharInspector();
  refreshTextStats();
  refreshSuspiciousChars();
  refreshNormalizationStatus();
  refreshIndentInfo();
  // Through recentOps, not a bare call: the open-files and drag-drop
  // listeners are registered above and can run openPath → rememberRecent
  // (or a menu Clear) while this initial read is still in flight —
  // un-queued, a slow load response would assign last and overwrite the
  // newer mutation's cache with the pre-mutation list (issue #266).
  // Inside the queue the disk accesses serialize, so whichever order the
  // operations enqueue in, each assignment reflects all writes before it.
  // (No syncClearRecentState here: menu.rs's build derives the initial
  // menu state from disk itself — see syncClearRecentState's doc comment.)
  recentFiles = await recentOps
    .enqueue(() => loadRecentFiles())
    .catch(() => [] as string[]);
  await restoreSession();
  // Files that triggered this launch open last so they end up focused. A
  // failure here means an OS "Open With"/CLI invocation asked Mojidori to
  // open specific files and they simply never arrive, with nothing else
  // pointing at why (v0.6 V2 IPC-error-surfacing audit #3) — void, not
  // awaited, so the dialog can't delay the rest of startup.
  const pending = await takePendingFiles().catch(() => {
    void messageDialog(t("dialog.pendingFilesFailedMessage"), {
      title: t("dialog.pendingFilesFailedTitle"),
      kind: "warning",
    });
    return [] as string[];
  });
  for (const path of pending) {
    await openPath(path);
  }
  // Cold-start probe hook: no-op unless MOJIDORI_STARTUP_PROBE=1 (see
  // scripts/startup-bench.mjs). Marks "frontend ready" for the benchmark.
  void reportStartupReady().catch(() => {});
  // Open-file probe hook: no-op unless MOJIDORI_OPENFILE_PROBE=<path> is set
  // on the Rust side (see scripts/openfile-bench.mjs). Reuses the exact
  // openPath() codepath a real drag-drop/file-association open takes,
  // timing trigger -> next paint — decoupled from the cold-start budget
  // above, so it isolates open latency rather than compounding it with
  // WebView/prefs/session-restore overhead.
  const openfileProbeTarget = await openfileProbePath().catch(() => null);
  if (openfileProbeTarget) {
    const openStart = performance.now();
    await openPath(openfileProbeTarget);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const elapsedMs = performance.now() - openStart;
    void reportOpenfileReady(elapsedMs).catch(() => {});
  }
  // ROADMAP.md D2 signing + auto-update: a background check, deferred
  // behind a delay so it can never compete with the startup-critical work
  // above (session restore, pending-file opens, the cold-start probe) —
  // startup-bench.mjs times against that work finishing, not this.
  // Silent: offline is the normal state for a local desktop editor, not
  // an error to surface unprompted (see updater.ts's own doc comment).
  setTimeout(() => {
    void checkForUpdatesAndPrompt(updaterDeps, { silent: true });
  }, 5000);
})();
