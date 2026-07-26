import type { WindowChunk } from "./chunkwindow";
import type { EditorBuffer } from "./editor";
import { t } from "./i18n";
import type { LineIndex } from "./ipc";
import type { LockOwner } from "./savemutex";

/** The {encoding, withBom} pair Save with Encoding protects across its own
 *  speculative window — see Doc.speculativeEncoding below. */
export interface SpeculativeEncoding {
  encoding: string;
  withBom: boolean;
}

export interface Doc {
  id: number;
  path: string | null;
  title: string;
  encoding: string;
  withBom: boolean;
  lineEnding: string;
  malformed: boolean;
  dirty: boolean;
  /** Monotonically increasing counter drawn from a single app-wide sequence
   *  (never reset to a fixed 0), bumped on every editor doc-change and on
   *  open/reload/reopen (main.ts). A saveFlow snapshots this right before
   *  its IPC round trip; if it no longer matches once the save resolves,
   *  an edit landed while the write was in flight, so dirty/backup must
   *  survive the completion handler instead of being cleared (issue #112)
   *  — see savecompletion.ts. Drawing resets from the shared sequence
   *  rather than a fixed 0 means a stale snapshot can never spuriously
   *  match a post-reset value. */
  revision: number;
  /** Read-only preview of a large file; saving is disabled. This is
   *  distinct from — and cannot be lifted by — `userReadOnly` below: see
   *  `isEffectivelyReadOnly`. */
  truncated: boolean;
  /** User-toggled per-tab read-only lock (View menu; ROADMAP.md v0.4 Track
   *  C), independent of `truncated`: a small/normal document the user wants
   *  to guard against accidental edits (e.g. while reading a log). Unlike
   *  `truncated`, this can be freely toggled back off. Persisted in the
   *  session (see collectSession/restoreSession in main.ts) so a locked tab
   *  stays locked across a relaunch. See `isEffectivelyReadOnly` for how the
   *  two combine into the one CM6 readOnly-compartment value editor.ts
   *  actually applies. */
  userReadOnly: boolean;
  totalSize: number;
  /** Paging state for truncated docs (line-aligned chunk offsets). */
  chunkOffset: number;
  nextChunkOffset: number | null;
  prevChunkOffsets: number[];
  /** Chunks currently in the buffer (sliding window, char+byte lengths). */
  windowChunks: WindowChunk[];
  /** Sparse line-offset index for go-to-line/bookmarks beyond the loaded
   *  window (truncated docs only). Null until built on first use, and
   *  invalidated back to null on reload/reopen or once its `indexedSize`
   *  no longer matches `totalSize` (see main.ts `ensureLineIndex`). */
  lineIndex: LineIndex | null;
  /** Absolute (1-based) file line number of the loaded window's own first
   *  line. Known only right after an index-driven goto jump (where it is
   *  computed for free); invalidated to null by anything that shifts the
   *  window without tracking the shift (pageChunk, continuous
   *  append/prepend) — this build deliberately does not carry a running
   *  delta through those paths. While null, bookmarks can't be placed and
   *  the gutter can't show them for this doc; the status bar's cursor
   *  position is still only ever the buffer-relative line. */
  windowStartLine: number | null;
  /** Bookmarked absolute (1-based) line numbers, sorted ascending. Small
   *  (non-truncated) docs use these directly as buffer line numbers.
   *  Session-local only — never persisted (see ROADMAP.md Track B). */
  bookmarks: number[];
  /** Monotonically increasing per-doc counter (never reset), bumped by
   *  every chunk-window-mutating operation before issuing its IPC call(s)
   *  — Next/Prev paging, continuous-reading auto append/prepend, go-to-
   *  line/bookmark jump — and by reload-from-disk/reopen-with-encoding
   *  even though they have no chunk response of their own to gate, purely
   *  to invalidate whatever chunk request might still be in flight once
   *  they reset this doc's chunk-window state from scratch. A chunk
   *  response is only applied if it still matches this value once its IPC
   *  round trip resolves — see chunkguard.ts's shouldApplyChunkResponse
   *  (issue #120). */
  chunkGeneration: number;
  /** True while a chunk-window-mutating IPC call (any of the operations
   *  described on chunkGeneration above, except reload/reopen — which
   *  invalidate and clear this instead of waiting on it) is in flight for
   *  this doc. Serializes them so, say, a manual Next click and an
   *  in-progress continuous-reading auto-append never overlap for the
   *  same doc (issue #120). Per-doc rather than the single module-level
   *  flag this replaces, so an in-flight load in one tab no longer blocks
   *  unrelated auto-loading in another tab. */
  chunkLoadInFlight: boolean;
  /** Which of save/reload currently holds this doc's in-flight lock, or
   *  null if neither is running (issue #124) — see main.ts's withLock/
   *  drainLock and savemutex.ts's decision table. Only one of the two may
   *  run at a time for a given doc; a request that arrives while this is
   *  non-null defers instead of running concurrently (see pendingReload/
   *  pendingSaveAs below), which is what keeps a watcher/stale-confirm
   *  reload from setting dirty=false and dropping the backup out from
   *  under a saveFlow whose IPC round trip is still in flight. */
  saveReloadInFlight: LockOwner;
  /** A reload was requested while saveReloadInFlight was held by
   *  something else; re-validated against disk once the lock releases
   *  (savemutex.ts's fingerprintsEqual gate) rather than blindly applied —
   *  see main.ts's reevaluateReload. Single slot: reload has no
   *  parameters to overwrite, so a second request while one is already
   *  pending just leaves this at true. */
  pendingReload: boolean;
  /** A save was requested while saveReloadInFlight was held; the saveAs
   *  flag of the *last* such request. Single slot — a newer request
   *  overwrites an older still-pending one rather than queuing both. Null
   *  means no pending save. The resolver(s) waiting on its eventual
   *  outcome live in main.ts's pendingSaveResolvers, keyed by doc.id — a
   *  function reference has no business riding along on this
   *  session-persistence-adjacent state. */
  pendingSaveAs: boolean | null;
  /** Set for the duration of Save with Encoding's own speculative
   *  doc.encoding/withBom mutation (issue #161) — main.ts's saveWithEncoding
   *  menu action applies its target encoding before the save that's
   *  supposed to make it real has actually reached disk, so a reload
   *  landing during that window (most commonly the stale-save dialog's own
   *  "Reload" choice, deferred through the lock above into
   *  reevaluateReload) must not decode with a target nothing on disk has
   *  adopted yet. Holds the *protected* original {encoding, withBom} pair
   *  a reload should use instead — see asyncguard.ts's reloadEncodingFor.
   *  Cleared the instant a reload actually applies
   *  (applyOpenedForReload): from then on doc.encoding/withBom already
   *  hold a fresh, disk-verified truth of their own, and the speculative
   *  caller's eventual rollback must not stomp it back to the pre-save
   *  snapshot — checked via reference equality against the exact object
   *  it set, not mere nullness, so a second overlapping speculative
   *  change can't have its own rollback clobbered by an earlier one's.
   *  Also cleared unconditionally once that caller's own save settles
   *  either way. Null the overwhelming majority of the time — only
   *  non-null while such a save is actually in flight. */
  speculativeEncoding: SpeculativeEncoding | null;
  /** Hot-exit backup file name once unsaved content has been flushed. */
  backupName: string | null;
  /** The per-extension encoding hint in effect when this document was
   *  opened (main.ts's `extensionHint` at openPath/restoreSession time) —
   *  the input the opening detection actually ran with. Detection
   *  diagnostics (Why Encoding?, Document Info) must pass *this* to
   *  `explainDetection`, never a freshly recomputed hint: the preference
   *  table can change while the tab stays open, and re-running detection
   *  with the new hint fabricates evidence — e.g. a spurious
   *  manual-override note for a document whose encoding the old hint
   *  chose automatically (issue #264). Null when no hint environment
   *  applies: an untitled document, or one resurrected from a hot-exit
   *  backup without a disk re-read. */
  detectionHint: string | null;
  /** Opaque metadata snapshot of the on-disk file as of the last open,
   *  reload, or successful save (see src-tauri/src/fsguard.rs) — passed
   *  back unexamined as `save_document`'s `expectedFingerprint` so a
   *  commit-time mismatch (someone else wrote to this path since) fails
   *  closed instead of silently overwriting the newer content (issue
   *  #113). `null` when there is no verified on-disk baseline yet: an
   *  untitled document, or one restored from a hot-exit backup without
   *  having been re-read from disk this session. */
  fingerprint: unknown;
  /** Whether check_byte_drift (issue #96 (2/3)) has already run for this
   *  doc's current on-disk baseline — the one-time, informed-consent
   *  drift dialog is asked at most once per doc per session, not on every
   *  save (see main.ts's runSaveFlow / src/bytedrift.ts's
   *  shouldCheckByteDrift). Session-local only, deliberately not part of
   *  SessionFile/session.rs: re-asking once after an app relaunch is
   *  cheaper than a session-format migration for what is, at most, one
   *  extra native confirm dialog. Reset to false whenever a fresh on-disk
   *  baseline replaces the current one (reload, reopen-with-encoding) —
   *  see applyOpenedForReload/reopenWithEncoding in main.ts — since the
   *  drift verdict for the old baseline says nothing about the new one. */
  byteDriftChecked: boolean;
  /** Set once a reload attempt's own openDocument fetch has failed AND a
   *  follow-up documentMetadata(path) re-check also failed (ROADMAP.md
   *  v0.7 Track V "external delete/rename visibility" — see main.ts's
   *  markMissingIfConfirmed and missingondisk.ts's isConfirmedMissing).
   *  Before this flag existed, that same double failure was swallowed by
   *  fetchAndApplyReload/reevaluateReload's bare catch with zero UI
   *  signal: a clean doc's tab looked untouched even though its file was
   *  actually gone. Orthogonal to `dirty` — a missing file says nothing
   *  about whether the in-editor buffer has unsaved changes, and this
   *  must never be treated as if it did (no extra save-blocking, no
   *  discard-confirm of its own; Cmd+S still just goes through the
   *  ordinary stale-fingerprint → Overwrite path, which already recreates
   *  the file). Cleared the instant there's fresh proof the file exists
   *  again: a successful reload/reopen (applyOpenedForReload/
   *  applyOpenedForReopen) or a save that actually wrote bytes
   *  (runSaveFlow — a save recreates the file). Optional rather than a
   *  required boolean so every existing Doc-literal call site (docFromOpened,
   *  the untitled-tab factory, backup-restore reconstruction, ...) stays
   *  untouched; absent is exactly as falsy as `false` at every read site. */
  missingOnDisk?: boolean;
  /** Set from `SaveResult.durabilityWarning` (`lib.rs`'s `save_document`)
   *  whenever the *last* save's content-rename succeeded but its
   *  parent-directory `fsync` could not be confirmed — a raw I/O error
   *  string from that failed `fsync` attempt, or absent when the last save
   *  had no such warning (issue #328's third review round; see
   *  `lib.rs::finish_atomic_commit`'s doc comment for why this must never
   *  be treated as if the save itself had failed). Purely informational,
   *  surfaced via statusbar.ts's own badge, same non-blocking treatment as
   *  `missingOnDisk` above — never gates dirty-clearing or the
   *  stale-fingerprint baseline, both of which already update normally
   *  because the write really did land. Cleared (set back to `undefined`)
   *  the moment a later save succeeds without the same warning, so a
   *  transient filesystem hiccup doesn't leave a permanent badge. Optional
   *  for the same reason `missingOnDisk` is: every existing Doc-literal
   *  call site stays untouched; absent is exactly as falsy as `undefined`
   *  at every read site. */
  durabilityWarning?: string;
  buffer: EditorBuffer;
}

/** Effective read-only state (ROADMAP.md v0.4 Track C): a large-file
 *  truncated preview is always read-only and that can never be lifted;
 *  `userReadOnly` is the user's own per-tab lock, layered on top of it
 *  independently. This is the single formula every read-only enforcement
 *  or UI call site derives from — editor.ts's CM6 readOnly-compartment
 *  toggle, the View menu's checked/enabled sync, the status-bar badge, and
 *  the saveFlow/runLineOperation rejection guard (all in main.ts) — so
 *  none of them can drift out of sync with each other. Takes just the two
 *  fields it needs (not the whole `Doc`) so callers building a partial
 *  shape (e.g. a menu-sync helper that only tracked these two) don't need
 *  a full Doc on hand. */
export function isEffectivelyReadOnly(doc: Pick<Doc, "truncated" | "userReadOnly">): boolean {
  return doc.truncated || doc.userReadOnly;
}

/**
 * Whether `doc` may be mutated right now — `isEffectivelyReadOnly` above,
 * plus the app-wide "an update is being installed" freeze (ROADMAP.md D2,
 * Codex re-review of PR #309: main.ts's `updateFreezeActive`, held for the
 * flush-through-install span around src/updater.ts's `promptAndInstall` —
 * see `UpdaterDeps.freezeForUpdate`'s doc comment there for the keystroke
 * race this closes). This is the single collapse point every mutating
 * menu/palette command must route through: the first review round only
 * froze the CM6 read-only compartment, which `runLineOperation`'s guard
 * (main.ts's `blockedByReadOnly`) never consulted — a mutation via
 * `insert_datetime`/a line operation/etc. dispatches a raw CM6 change and
 * doesn't go through the compartment at all, so it slipped straight past
 * that freeze. `blockedByReadOnly` is this function's only caller;
 * anything that needs "can I edit this doc" must go through
 * `blockedByReadOnly`, never re-derive `truncated`/`userReadOnly` (or now
 * this freeze) on its own — that duplication is exactly how a second
 * mutation path got missed the first time.
 */
export function canMutateDocument(
  doc: Pick<Doc, "truncated" | "userReadOnly">,
  updateFreezeActive: boolean,
): boolean {
  return !isEffectivelyReadOnly(doc) && !updateFreezeActive;
}

export interface TabEvents {
  onSelect(id: number): void;
  onClose(id: number): void;
  onNew(): void;
  /** Fired once, after a completed drag actually changes tab order (never
   *  for a plain click, and never for a drag that drops back on its start
   *  slot) — main.ts hooks this to persistSession(), mirroring the timing
   *  every other order-affecting tab operation already persists at. */
  onReorder(): void;
  /** Right-click (contextmenu) on a tab — main.ts opens the tab context
   *  menu (Close Others / Close Tabs to the Right / Copy Path / Reveal in
   *  Finder(Explorer), ROADMAP.md Track C) anchored at `tab`, targeting
   *  `id` regardless of which tab happens to be active. Independent of the
   *  pointerdown/pointerup drag-or-select machinery below: a right-click's
   *  own pointerdown already arms (and, on release, resolves as a select
   *  — see beginTabDrag's `primaryButton` doc comment) exactly like every
   *  non-primary button did before this event existed, so wiring this
   *  alongside it changes nothing about that resolution. */
  onContextMenu(id: number, tab: HTMLElement): void;
}

/** Horizontal pointer displacement, in CSS pixels, a tab must travel before
 *  a press-and-hold becomes a drag rather than a click. Small enough to
 *  feel immediate, large enough that a stationary click's few pixels of
 *  incidental hand jitter never accidentally starts a reorder. */
export const DRAG_THRESHOLD_PX = 4;

/** Live state for one in-progress pointer gesture on a tab, from pointerdown
 *  until pointerup/pointercancel. Only one can exist at a time (a second
 *  pointerdown while one is active is ignored — see beginTabDrag). */
interface TabDragState {
  id: number;
  el: HTMLElement;
  /** clientX at pointerdown; every later delta is measured from this. */
  startX: number;
  /** The tab's own horizontal midpoint at pointerdown (viewport space) —
   *  advanced by the same delta as the pointer to get the dragged tab's
   *  *current* center, which is what drop-slot hit-testing compares
   *  against its stationary siblings' centers (see commitReorder). */
  startCenterX: number;
  /** Only the primary button may graduate to a drag (see onTabPointerMove);
   *  a middle/right-click gesture just rides along inert and resolves as
   *  a select on release, same as a below-threshold left-click. */
  primaryButton: boolean;
  /** Flips true once startX has been left behind by DRAG_THRESHOLD_PX.
   *  Gates both the visual feedback and whether release means "select" or
   *  "reorder." */
  dragging: boolean;
}

export class TabStore {
  docs: Doc[] = [];
  activeId: number | null = null;
  /** doc id -> its current tab element, refreshed on every render(). Used
   *  only to measure sibling positions when resolving a drop slot
   *  (commitReorder) — see its own comment for why re-measuring here
   *  beats caching rects at drag-start. */
  private tabElements = new Map<number, HTMLElement>();
  private drag: TabDragState | null = null;

  constructor(
    private container: HTMLElement,
    private events: TabEvents,
  ) {}

  get active(): Doc | null {
    return this.docs.find((d) => d.id === this.activeId) ?? null;
  }

  get(id: number): Doc | null {
    return this.docs.find((d) => d.id === id) ?? null;
  }

  findByPath(path: string): Doc | null {
    return this.docs.find((d) => d.path === path) ?? null;
  }

  add(doc: Doc): void {
    this.docs.push(doc);
    this.activeId = doc.id;
  }

  setActive(id: number): void {
    if (this.get(id)) this.activeId = id;
  }

  /** Remove a tab. If it was active, a neighbor becomes active. */
  close(id: number): void {
    const index = this.docs.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.docs.splice(index, 1);
    if (this.activeId === id) {
      const neighbor = this.docs[index] ?? this.docs[index - 1];
      this.activeId = neighbor?.id ?? null;
    }
  }

  /** Move activation by offset (+1 next, -1 previous), wrapping around. */
  cycle(offset: number): void {
    if (this.docs.length < 2 || this.activeId === null) return;
    const index = this.docs.findIndex((d) => d.id === this.activeId);
    const next = (index + offset + this.docs.length) % this.docs.length;
    this.activeId = this.docs[next].id;
  }

  /** Reorder tabs: move the doc at `fromIndex` so it ends up at `toIndex`,
   *  shifting whatever was between the two positions over by one — a plain
   *  array move (splice out, splice back in), not a swap. `toIndex` is
   *  interpreted the same way `Array.prototype.splice`'s insertion index
   *  would be *after* the removal (i.e. against the shortened array), not
   *  against the original — see the pointer-drag caller (commitReorder)
   *  for why that convention is exactly the count of untouched tabs a drop
   *  point has passed.
   *
   *  No-op — `docs` left untouched — when the indices are equal or either
   *  is out of `docs`' current bounds, so a caller resolving a raw pointer
   *  position doesn't need to pre-validate it itself.
   *
   *  `activeId` tracks a doc's *id*, never its array position, so moving
   *  tabs around never needs to touch it: the active tab silently "moves
   *  with" its doc for free, whether or not it's the one being reordered. */
  moveTab(fromIndex: number, toIndex: number): void {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.docs.length ||
      toIndex >= this.docs.length
    ) {
      return;
    }
    const [moved] = this.docs.splice(fromIndex, 1);
    this.docs.splice(toIndex, 0, moved);
  }

  render(): void {
    this.container.replaceChildren();
    this.tabElements.clear();
    for (const doc of this.docs) {
      const tab = document.createElement("div");
      tab.className = doc.id === this.activeId ? "tab active" : "tab";
      // pointerdown (not mousedown/click) doubles as both the click-to-
      // select trigger and the drag-to-reorder start — see beginTabDrag
      // for why selection itself is resolved on release, not here.
      tab.addEventListener("pointerdown", (e) =>
        this.beginTabDrag(e, doc.id, tab),
      );
      // Suppress the native context menu and open ours instead. This is a
      // plain "contextmenu" listener, not folded into the pointer-drag
      // state machine above — see TabEvents.onContextMenu for why the two
      // never interfere.
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.events.onContextMenu(doc.id, tab);
      });

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = doc.title;
      if (doc.path) tab.title = doc.path;
      tab.appendChild(title);

      const close = document.createElement("button");
      close.className = doc.dirty ? "tab-close dirty" : "tab-close";
      close.textContent = doc.dirty ? "●" : "×";
      close.ariaLabel = t("tabs.closeAria", doc.title);
      // Stops the tab's own pointerdown (drag-arm/select trigger) from
      // ever seeing this gesture, so the close button can never start a
      // drag or flip selection on its way to its own click handler below.
      close.addEventListener("pointerdown", (e) => e.stopPropagation());
      close.addEventListener("click", () => this.events.onClose(doc.id));
      tab.appendChild(close);

      this.container.appendChild(tab);
      this.tabElements.set(doc.id, tab);
    }

    const add = document.createElement("button");
    add.className = "tab-new";
    add.textContent = "+";
    add.ariaLabel = t("tabs.newTabAria");
    add.addEventListener("click", () => this.events.onNew());
    this.container.appendChild(add);
  }

  /** pointerdown on a tab: arms a potential drag, but never itself selects
   *  or reorders — see onTabPointerUp for why both of those are resolved
   *  on release. Deliberately does not gate on button here: middle/right-
   *  click still arm this (so releasing without moving still selects,
   *  matching the pre-drag mousedown behavior for every button), but
   *  `primaryButton` stops onTabPointerMove from ever promoting one of
   *  them to an actual drag — see requirement "中鍵/右鍵不拖".
   *
   *  Not HTML5 drag-and-drop: that API's native drag image/ghost and drop
   *  effect plumbing has long-standing WKWebView/WebView2 inconsistencies.
   *  Pointer events plus manual transform/DOM updates avoid all of that
   *  and are equally mature on both. */
  private beginTabDrag(e: PointerEvent, id: number, tab: HTMLElement): void {
    if (this.drag) return; // one gesture at a time

    const rect = tab.getBoundingClientRect();
    this.drag = {
      id,
      el: tab,
      startX: e.clientX,
      startCenterX: rect.left + rect.width / 2,
      primaryButton: e.button === 0,
      dragging: false,
    };
    // Progressive enhancement: real WKWebView/WebView2 hosts support
    // Pointer Capture, so a fast drag that momentarily leaves the tab's
    // own bounds keeps delivering move/up here instead of to whatever
    // element is now under the cursor. jsdom (unit tests) implements the
    // PointerEvent constructor but not the capture methods at all — the
    // optional call just no-ops there, which is fine: tests dispatch
    // move/up directly at this same element regardless.
    tab.setPointerCapture?.(e.pointerId);
    tab.addEventListener("pointermove", this.onTabPointerMove);
    tab.addEventListener("pointerup", this.onTabPointerUp);
    tab.addEventListener("pointercancel", this.onTabPointerCancel);
  }

  private onTabPointerMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || !drag.primaryButton) return;
    const dx = e.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      // Visual feedback: the dragged tab itself lifts and follows the
      // pointer (translateX below, every move) rather than a separate
      // placeholder element — minimal viable per ROADMAP, reusing
      // styles.css's existing elevation token (see .tab-dragging).
      drag.el.classList.add("tab-dragging");
    }
    drag.el.style.transform = `translateX(${dx}px)`;
  };

  /** Release ends the gesture one of two ways: a plain click (dragging
   *  never crossed the threshold — true for every middle/right-click
   *  gesture, and for a left-click that barely moved) selects, the same
   *  outcome the pre-drag mousedown handler produced, just resolved on
   *  release instead of on press; a real drag instead resolves a drop slot
   *  and commits it. Selecting only here (not also eagerly on pointerdown,
   *  as the old mousedown handler did) sidesteps a real hazard: onSelect
   *  can synchronously cascade into main.ts's
   *  activate() -> showActive() -> this.render(), which replaces every tab
   *  element in the DOM — if that happened while this drag was still
   *  being armed on the *old* element, the gesture would be left operating
   *  on a detached node. Resolving selection only after this gesture's own
   *  teardown below is already done means that cascade, if it happens, no
   *  longer has any in-flight drag state left to invalidate. */
  private onTabPointerUp = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.teardownDrag(drag.el, e.pointerId);
    this.resetDragVisual(drag.el);
    if (drag.dragging) {
      this.commitReorder(drag, e.clientX - drag.startX);
    } else {
      this.events.onSelect(drag.id);
    }
  };

  /** The platform aborted the gesture (e.g. an OS-level gesture interrupt).
   *  Treated as if nothing happened: no select, no reorder — just put the
   *  tab back to normal. */
  private onTabPointerCancel = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.teardownDrag(drag.el, e.pointerId);
    this.resetDragVisual(drag.el);
  };

  private teardownDrag(el: HTMLElement, pointerId: number): void {
    el.removeEventListener("pointermove", this.onTabPointerMove);
    el.removeEventListener("pointerup", this.onTabPointerUp);
    el.removeEventListener("pointercancel", this.onTabPointerCancel);
    el.releasePointerCapture?.(pointerId);
  }

  private resetDragVisual(el: HTMLElement): void {
    el.classList.remove("tab-dragging");
    el.style.transform = "";
  }

  /** Resolve a completed drag to a drop slot and, if it actually changed
   *  anything, commit it. Siblings are measured fresh here rather than
   *  cached at drag-start: none of them move during the drag (only the
   *  dragged tab's own transform changes, which doesn't affect the others'
   *  flex layout), so a fresh read is exactly as valid and avoids keeping
   *  a second rect cache in sync for no benefit.
   *
   *  The drop slot is "how many other tabs' centers the dragged tab's own
   *  current center has passed" — which lines up exactly with moveTab's
   *  post-removal `toIndex` convention (see its doc comment), so the count
   *  below is used as `toIndex` directly with no further translation. */
  private commitReorder(drag: TabDragState, dx: number): void {
    const fromIndex = this.docs.findIndex((d) => d.id === drag.id);
    if (fromIndex === -1) return; // tab closed mid-drag (e.g. a Cmd+W)

    const draggedCenterX = drag.startCenterX + dx;
    let toIndex = 0;
    for (const doc of this.docs) {
      if (doc.id === drag.id) continue;
      const el = this.tabElements.get(doc.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left + rect.width / 2 < draggedCenterX) toIndex++;
    }

    if (toIndex === fromIndex) return; // dropped back where it started
    this.moveTab(fromIndex, toIndex);
    this.render();
    this.events.onReorder();
  }
}

// ---- Tab context menu helpers (ROADMAP.md Track C "Tab context menu") ----
// Pure id-set/ordering logic, kept separate from main.ts's showTabContextMenu
// (which owns the actual closeTab/clipboard/reveal side effects) so the
// target-set math and the batch abort semantics are unit-testable without a
// live TabStore, DOM, or Tauri IPC.

/** Ids of every doc other than `id`, in `docs`' current tab order — the
 *  target set for "Close Others". `id` not being present in `docs` isn't
 *  specially handled: it simply can't match any element's `.id`, so every
 *  doc is returned, same as filtering by any other id no doc has. */
export function idsOtherThan(docs: Doc[], id: number): number[] {
  return docs.filter((d) => d.id !== id).map((d) => d.id);
}

/** Ids of every doc strictly to the right of `id` in `docs`' current tab
 *  order — the target set for "Close Tabs to the Right". `[]` if `id`
 *  isn't found (defensive — a live caller always passes a tab that was
 *  just right-clicked) or is already the rightmost tab. */
export function idsToTheRightOf(docs: Doc[], id: number): number[] {
  const index = docs.findIndex((d) => d.id === id);
  if (index === -1) return [];
  return docs.slice(index + 1).map((d) => d.id);
}

/** Close each of `ids` in order, awaiting `closeTab` (main.ts — the same
 *  dirty-confirm flow a manual close goes through) for one before starting
 *  the next, and stopping the moment any one of them doesn't actually
 *  close. `closeTab` itself never throws on a cancelled close (see its own
 *  doc comment) — cancellation shows up only as the doc still being
 *  present afterward — so `stillOpen` (typically `(id) => tabs.get(id) !==
 *  null`) is how this tells "closed" from "cancelled" apart. Used by
 *  main.ts's showTabContextMenu for both Close Others and Close Tabs to
 *  the Right: same loop, different `ids`. */
export async function closeSequentially(
  ids: number[],
  closeTab: (id: number) => Promise<void>,
  stillOpen: (id: number) => boolean,
): Promise<void> {
  for (const id of ids) {
    await closeTab(id);
    if (stillOpen(id)) return; // cancelled — leave the rest of ids untouched
  }
}
