// Typed UI dictionary. English is the source-of-truth key set: every other
// dictionary (`zhTW`, `ja`, `zhCN`) is typed against the exact same
// `Messages` interface, so a missing (or extra) key in any dictionary is a
// compile error — there is no runtime "key not found" fallback path to test
// for.
//
// Values are either a plain string or a template function (for strings that
// interpolate a filename, a number, etc.). Word order varies by language, so
// every interpolated string is a full sentence template here, never string
// concatenation at the call site.
//
// Scope: this module owns all *frontend* UI strings. The native menu
// (src-tauri/src/menu.rs) maintains its own small en/zh-TW/ja/zh-CN label
// table in Rust, since it is built before the frontend loads — see menu.rs.

export type Locale = "en" | "zh-TW" | "ja" | "zh-CN";

export interface Messages {
  "app.untitled": string;
  "app.untitledNumbered": (n: number) => string;

  "tabs.closeAria": (title: string) => string;
  "tabs.newTabAria": string;

  // Tab-strip right-click menu (ROADMAP.md Track C "Tab context menu");
  // see main.ts's showTabContextMenu. Reveal has two platform-variant
  // labels rather than one neutral string — chosen to match each OS's own
  // familiar terminology (macOS Finder / Windows File Explorer), same as
  // this app already picks a platform-appropriate default line ending.
  "tabs.closeOthers": string;
  "tabs.closeTabsToRight": string;
  "tabs.copyPath": string;
  "tabs.revealInFinder": string;
  "tabs.revealInExplorer": string;

  "statusbar.noFile": string;
  "statusbar.cursor": (line: number, column: number) => string;
  "statusbar.encodingWithBom": (encoding: string) => string;
  "statusbar.readonlyPreview": (size: string) => string;
  "statusbar.userReadOnly": string;
  /** Shown when doc.missingOnDisk is set (ROADMAP.md v0.7 Track V
   *  "external delete/rename visibility") — a reload attempt already
   *  confirmed this doc's file no longer exists on disk (see main.ts's
   *  markMissingIfConfirmed / missingondisk.ts's isConfirmedMissing).
   *  Purely informational: the buffer is untouched and dirty-state is
   *  unaffected, see tabs.ts's Doc.missingOnDisk doc comment. */
  "statusbar.missingOnDisk": string;
  /** Shown when the *last* save/streaming-write for this doc succeeded —
   *  the bytes really are on disk — but the parent-directory `fsync` that
   *  would confirm that rename survives an immediate crash could not be
   *  completed (issue #328's third review round; see
   *  `lib.rs::finish_atomic_commit`'s doc comment). Purely informational,
   *  same as `missingOnDisk` above: never blocks anything, never reopens
   *  the stale-file dialog, just a non-blocking heads-up in case the
   *  underlying filesystem (network share, FUSE mount, ...) is degraded.
   *  Cleared the instant a later save/write succeeds without the same
   *  warning. `detail` is the raw I/O error string from the failed
   *  `fsync` attempt, shown as-is (not translated) as diagnostic context —
   *  same treatment `dialog.saveFailedTitle`'s paired error message
   *  already gives a raw backend error. */
  "statusbar.durabilityWarning": (detail: string) => string;
  "statusbar.decodeWarning": string;
  "statusbar.buildingIndex": string;
  "statusbar.preparingUpdate": string;
  "statusbar.textStats": (words: number, chars: number, lines: number) => string;
  "statusbar.textStatsSelection": (words: number, chars: number, lines: number) => string;
  "statusbar.charInspector": (char: string, codepoint: string) => string;
  "statusbar.suspiciousChars": (count: number) => string;
  "statusbar.nonNfc": string;
  "statusbar.indentSpaces": (width: number) => string;
  "statusbar.indentTabs": string;
  "statusbar.indentMixed": string;

  "confirm.unsavedChanges": (title: string) => string;
  "confirm.dontSave": string;
  "confirm.cancel": string;
  "confirm.save": string;

  "detectcard.reasonBom": string;
  "detectcard.reasonExtension": string;
  "detectcard.reasonDetector": string;
  "detectcard.reasonFallback": string;
  "detectcard.noBom": string;
  "detectcard.title": (encoding: string) => string;
  "detectcard.labelFile": string;
  "detectcard.labelBom": string;
  "detectcard.labelVerdict": string;
  "detectcard.labelSampled": string;
  "detectcard.labelWouldChoose": string;
  "detectcard.labelCurrentlyUsing": string;
  "detectcard.sampledAll": (size: string) => string;
  "detectcard.sampledPartial": (shown: string, total: string) => string;
  "detectcard.wouldChooseValue": (encoding: string, reason: string) => string;
  "detectcard.manualNote": (current: string, detected: string) => string;
  "detectcard.detectionBoundaryNote": (encoding: string) => string;
  "detectcard.truncatedSampleNote": string;

  // Document Info dialog (File menu; ROADMAP.md v0.6 E1) — a read-only
  // "file trust surface." See src/docinfo.ts's module doc comment for the
  // untitled-tab reduced-content decision and the section-independent
  // error-handling design these keys back.
  "docinfo.title": (file: string) => string;
  "docinfo.close": string;
  "docinfo.labelPath": string;
  "docinfo.pathUnsaved": (title: string) => string;
  "docinfo.labelSize": string;
  "docinfo.labelModified": string;
  "docinfo.labelEncoding": string;
  "docinfo.labelLineEnding": string;
  "docinfo.labelScanned": string;
  "docinfo.lineEndingSampledNote": (scanned: string) => string;
  "docinfo.lineEndingUtf16Note": string;
  "docinfo.labelTextStats": string;
  /** Shown in place of a section's data when its IPC call genuinely fails
   *  (e.g. the file was deleted since the dialog opened) — never a blank
   *  or silently-missing section (CLAUDE.md's decode-error-surfacing
   *  discipline, generalized to every fact this dialog shows). */
  "docinfo.loadError": (message: string) => string;
  "docinfo.dirtyNote": string;

  "charinspect.title": (codepoint: string) => string;
  "charinspect.labelChar": string;
  "charinspect.labelCodePoint": string;
  "charinspect.labelUtf8Bytes": string;
  "charinspect.labelEncodingBytes": (encoding: string) => string;
  "charinspect.lossyValue": (encoding: string) => string;

  "hexview.showingAll": (size: string) => string;
  "hexview.showingPartial": (shown: string, total: string) => string;

  "findInFiles.chooseFolder": string;
  "findInFiles.searchPlaceholder": string;
  "findInFiles.matchCase": string;
  "findInFiles.regex": string;
  "findInFiles.searching": string;
  "findInFiles.status": (
    count: number,
    truncated: boolean,
    filesScanned: number,
  ) => string;
  "findInFiles.scanErrorsSummary": (count: number) => string;

  // Replace-in-files (ROADMAP.md v0.5 Track S, frontend item): the dry-run
  // preview + destructive confirm + result summary layered on top of the
  // find-in-files panel above. Kept in this same "findInFiles." namespace
  // rather than a new prefix — it's an extension of the one panel, not a
  // separate feature surface (mirrors streamReplace.ts already reusing
  // findInFiles.matchCase for the same reason).
  "findInFiles.replaceButton": string;
  "findInFiles.replaceScanning": string;
  "findInFiles.replaceNoMatches": string;
  "findInFiles.replacePreviewSummary": (
    fileCount: number,
    matchCount: number,
    skippedCount: number,
  ) => string;
  /** Appended to the preview summary when `ReplaceScanReport.truncated` —
   *  the scan stopped at its entry cap, so the report may be missing whole
   *  files (not just matches within listed files). A user about to run a
   *  destructive folder-wide replace must know the preview didn't cover
   *  the whole folder. */
  "findInFiles.replacePreviewTruncated": string;
  "findInFiles.replaceMatchCount": (count: number) => string;
  "findInFiles.replaceLossyTooltip": string;
  /** Shown under the replacement field only while regex mode is on:
   *  `replacement` is always inserted literally — `$1` and other
   *  backreferences are never expanded (replaceinfiles.rs's v1
   *  `regex::NoExpand` scope). */
  "findInFiles.replaceRegexLiteralHint": string;
  /** Localized label for `ReplaceScanEntry.skippedReason` — never the raw
   *  Rust/OS text (see replaceinfiles-ui.ts's `skipReasonLabel`). */
  "findInFiles.skipReasonOversized": string;
  "findInFiles.skipReasonMalformed": string;
  "findInFiles.skipReasonIoError": string;
  "findInFiles.replaceExecuteButton": (count: number) => string;
  "findInFiles.replaceConfirmMessage": (fileCount: number, matchCount: number) => string;
  /** S1-reviewed app semantics (ROADMAP.md Track S): an unmappable
   *  replacement character is never rejected outright, it is written as a
   *  literal HTML numeric character reference (`&#NNNN;`) by
   *  `encoding_rs`'s encoder (src-tauri/src/streamcodec.rs's `encode_chunk`
   *  doc comment) — this message must say so explicitly, never gloss over
   *  it with a generic "may lose data" warning. */
  "findInFiles.replaceConfirmMessageLossy": (
    fileCount: number,
    matchCount: number,
    lossyFileCount: number,
  ) => string;
  "findInFiles.replaceResultSummary": (
    okCount: number,
    totalReplacements: number,
    failedCount: number,
  ) => string;
  /** Post-execute failure group labels — keyed by `ReplaceExecuteEntry.status`
   *  (see ipc.ts's doc comment for the exact status set). */
  "findInFiles.replaceStatusChangedSinceScan": string;
  "findInFiles.replaceStatusLossyBlocked": string;
  "findInFiles.replaceStatusIoError": string;
  "findInFiles.replaceStatusDecodeError": string;
  "findInFiles.replaceStatusTooLarge": string;
  "findInFiles.replaceFailuresHeading": (count: number) => string;

  "goto.placeholder": string;

  "quickOpen.searchPlaceholder": string;
  "quickOpen.noRecent": string;
  "quickOpen.noMatches": string;

  // Command Palette (Mod+Shift+P; ROADMAP.md v0.6 C1) — see src/palette.ts.
  // The command labels themselves come from menu.rs's own LABELS table
  // (fetched via ipc.ts's paletteCommands), not this dictionary — this
  // module owns only the palette's own chrome text, same split as every
  // other menu-adjacent feature (see this file's header comment).
  "palette.searchPlaceholder": string;
  "palette.noResults": string;

  "preferences.title": string;
  "preferences.editorFont": string;
  "preferences.editorFontPlaceholder": string;
  "preferences.fontSize": string;
  "preferences.theme": string;
  "preferences.language": string;
  "preferences.encodingForNewFiles": string;
  "preferences.trimTrailingWhitespaceOnSave": string;
  "preferences.extHeading": string;
  "preferences.extHint": string;
  "preferences.extPlaceholder": string;
  "preferences.extRemoveTitle": string;
  "preferences.extAdd": string;
  "preferences.cancel": string;
  "preferences.save": string;
  "preferences.themeSystem": string;
  "preferences.themeLight": string;
  "preferences.themeDark": string;
  "preferences.themePaper": string;
  "preferences.themeDusk": string;
  "preferences.langSystemOption": string;

  "menu.whyEncoding": (encoding: string) => string;
  "menu.reopenWithEncoding": string;
  "menu.saveWithEncoding": string;
  "menu.convertFileToEncoding": string;
  "menu.compareEncodings": string;
  "menu.viewRawBytes": string;
  "menu.repairMojibake": string;
  "menu.lineEndingLf": string;
  "menu.lineEndingCrlf": string;
  "menu.lineEndingCr": string;

  "mojibake.title": string;
  "mojibake.noCandidates": string;
  "mojibake.pickCandidate": string;
  "mojibake.candidateDescription": (original: string, intermediate: string) => string;
  "mojibake.replacementCount": (count: number) => string;
  "mojibake.before": string;
  "mojibake.after": string;
  "mojibake.appliedTitle": string;
  "mojibake.appliedMessage": string;
  "mojibake.staleContentTitle": string;
  "mojibake.staleContentMessage": string;

  "comparePreview.title": (file: string) => string;
  "comparePreview.encodingALabel": string;
  "comparePreview.encodingBLabel": string;
  "comparePreview.compareButton": string;
  "comparePreview.malformedBadge": string;
  "comparePreview.reopenButton": string;

  "batchConvert.title": string;
  "batchConvert.chooseFolder": string;
  "batchConvert.chooseFolderFirst": string;
  "batchConvert.extPlaceholder": string;
  "batchConvert.targetLabel": string;
  "batchConvert.keepEncoding": string;
  "batchConvert.lineEndingLabel": string;
  "batchConvert.lineEndingKeep": string;
  "batchConvert.scanButton": string;
  "batchConvert.scanning": string;
  "batchConvert.noResults": string;
  "batchConvert.summary": (
    convertible: number,
    alreadyTarget: number,
    lossy: number,
    undecodable: number,
    tooLarge: number,
    byteDrift: number,
  ) => string;
  "batchConvert.statusConvertible": string;
  "batchConvert.statusAlreadyTarget": string;
  "batchConvert.statusLossy": string;
  "batchConvert.statusUndecodable": string;
  "batchConvert.statusTooLarge": string;
  "batchConvert.byteDriftBadge": string;
  "batchConvert.byteDriftTooltip": string;
  "batchConvert.byteDriftTooltipConvertible": string;
  "batchConvert.lineEndingMixed": string;
  "batchConvert.includeFileLabel": string;
  "batchConvert.convertButton": (count: number) => string;
  "batchConvert.confirmMessage": (count: number) => string;
  "batchConvert.confirmMessageIncomplete": (count: number, scanErrorCount: number) => string;
  "batchConvert.rescanNeeded": string;
  "batchConvert.converting": string;
  "batchConvert.resultSummary": (ok: number, failed: number) => string;
  "batchConvert.scanErrorsSummary": (count: number) => string;

  "streamReplace.title": (file: string) => string;
  "streamReplace.searchPlaceholder": string;
  "streamReplace.replacePlaceholder": string;
  "streamReplace.caseInsensitiveHint": string;
  "streamReplace.executeButton": string;
  "streamReplace.replacing": string;
  "streamReplace.resultMessage": (count: number) => string;
  // Appended to streamReplace.resultMessage's dialog text when the report's
  // unmatchedRegionReencoded is true (issue #175): a chunk with no actual
  // match was still re-encoded (carry/pending entanglement with a
  // neighboring matching chunk, or chunk 0 under a BOM), so a non-canonical
  // legacy byte sequence there may have been normalized even though the
  // user only asked to change the matched text — vocabulary mirrors
  // batchConvert.byteDriftTooltip. Never appended when replacements is 0
  // (the field is always false then — see StreamReplaceReport's doc
  // comment in ipc.ts).
  "streamReplace.unmatchedRegionReencodedNote": string;
  // Shown instead of reloading when the tab active at the start of the
  // replace closed before it finished and no tab for the same path was
  // reopened in the meantime (issue #163) — the file itself was already
  // updated (this always fires after streamReplace.resultMessage's own
  // unconditional success notice), there is just no live preview left to
  // refresh.
  "streamReplace.completedTabClosedMessage": string;

  "streamConvert.title": (file: string) => string;
  "streamConvert.converting": (encoding: string) => string;
  "streamConvert.resultMessage": (encoding: string) => string;
  "streamConvert.failedMessage": string;
  // Same "operation succeeded, but the tab that started it is gone and
  // nothing reopened onto that path" case as
  // streamReplace.completedTabClosedMessage above, for the convert flow
  // (issue #163).
  "streamConvert.completedTabClosedMessage": string;

  "dialog.pagingTitle": string;
  "dialog.fileChangedTitle": string;
  "dialog.fileChangedMessage": (title: string) => string;
  "dialog.reload": string;
  /** Shown instead of dialog.fileChangedMessage's own reload/cancel
   *  confirm when handleExternalChange already knows this doc's file is
   *  gone (doc.missingOnDisk — ROADMAP.md v0.7 Track V): a "Reload?"
   *  question is misleading once Reload is known to be a silent no-op, so
   *  this is a single-button (messageDialog, not confirmDialog)
   *  acknowledgement instead. */
  "dialog.fileDeletedTitle": string;
  "dialog.fileDeletedMessage": (title: string) => string;
  "dialog.staleFileMessage": (title: string) => string;
  "dialog.overwrite": string;
  "dialog.openFailedTitle": string;
  "dialog.clearRecentFailedTitle": string;
  "dialog.readonlyPreviewTitle": string;
  "dialog.readonlyPreviewMessage": (title: string) => string;
  "dialog.userReadOnlyTitle": string;
  "dialog.userReadOnlyMessage": (title: string) => string;
  // Update-install freeze (ROADMAP.md D2, Codex re-review of PR #309) —
  // main.ts's blockedByReadOnly, checked before the truncated/userReadOnly
  // cases above since it's an app-wide condition unrelated to this
  // specific doc. See tabs.ts's canMutateDocument doc comment.
  "dialog.updateInProgressTitle": string;
  "dialog.updateInProgressMessage": string;
  "dialog.saveFailedTitle": string;
  "dialog.lossyEncodingTitle": string;
  "dialog.lossyEncodingMessage": (encoding: string, count: number) => string;
  "dialog.lossyEncodingConfirm": string;
  /** One line per sample in the lossy-save preview dialog (ROADMAP.md v0.4
   *  Track A "Lossy-save character preview"): `display` is the Rust-
   *  formatted "char (U+XXXX)" text (src-tauri/src/normalize.rs's
   *  `format_sample`, shared with `dialog.normalizeUnrepresentableMessage`'s
   *  samples), `line`/`column` are 1-based and localized the same way
   *  `statusbar.cursor` already phrases a cursor position. */
  "dialog.lossySampleLine": (display: string, line: number, column: number) => string;
  /** Shown below the sample list only when `LossyReport.samplesTruncated` —
   *  a capped list must never be mistaken for a complete one. */
  "dialog.lossySamplesTruncated": string;
  "dialog.backupFailedTitle": string;
  "dialog.backupFailedMessage": (titles: string[]) => string;
  "dialog.backupFailedDiscard": string;
  /** Shown once after session restore (main.ts restoreSession) when
   *  loadBackup resolved to null for one or more session entries that did
   *  record a backup name — as opposed to an entry with no backup at all,
   *  which is silent. Batched across every failed entry (both session-
   *  tracked and orphan recovery, see orphanScanFailedTitle below) into
   *  one dialog instead of one per tab, mirroring backupFailedMessage's
   *  own batching (v0.6 V2 IPC-error-surfacing audit #1). Non-blocking
   *  (main.ts fires it with `void`) so it never delays opening files
   *  passed in via OS/CLI (takePendingFiles runs right after). */
  "dialog.backupRestoreFailedTitle": string;
  "dialog.backupRestoreFailedMessage": (titles: string[]) => string;
  /** Shown once, at startup, when listBackups itself fails (main.ts
   *  restoreSession) — distinct from backupRestoreFailedTitle above,
   *  which is about a specific known backup name failing to load: this is
   *  the orphan-recovery scan (finding backups the session index doesn't
   *  reference) never running at all this session, so any orphan stays
   *  unreachable rather than merely unread (v0.6 V2 IPC-error-surfacing
   *  audit #2). */
  "dialog.orphanScanFailedTitle": string;
  "dialog.orphanScanFailedMessage": string;
  /** Shown once, at startup, when takePendingFiles fails (main.ts) — the
   *  files an OS "Open With"/CLI invocation asked Mojidori to open never
   *  arrive, with no other feedback that anything was even requested
   *  (v0.6 V2 IPC-error-surfacing audit #3). */
  "dialog.pendingFilesFailedTitle": string;
  "dialog.pendingFilesFailedMessage": string;
  "dialog.unsavedChangesTitle": string;
  "dialog.reopenMessage": (title: string) => string;
  "dialog.reopen": string;
  "dialog.reopenFailedTitle": string;
  /** Shown instead of running Reopen with Encoding (issue #169) when a
   *  save or reload already holds the doc's save/reload lock — reopen
   *  never queues a deferred retry, so this is the whole response. */
  "dialog.reopenBusyTitle": string;
  "dialog.reopenBusyMessage": (title: string) => string;
  "dialog.printTitle": string;
  "dialog.streamReplaceUseRegularTitle": string;
  "dialog.streamReplaceUseRegularMessage": string;
  "dialog.lineIndexFailedTitle": string;
  "dialog.bookmarkNeedsGotoTitle": string;
  "dialog.bookmarkNeedsGotoMessage": string;
  "dialog.normalizeConfirmTitle": (form: string) => string;
  "dialog.normalizeConfirmMessage": (count: number, form: string) => string;
  "dialog.normalizeConfirmButton": string;
  "dialog.normalizeUnrepresentableTitle": string;
  "dialog.normalizeUnrepresentableMessage": (
    encoding: string,
    count: number,
    samples: string[],
    truncated: boolean,
  ) => string;
  "dialog.normalizeUnrepresentableConfirm": string;
  "dialog.normalizeFailedTitle": string;
  /** Shown instead of applying the result (issue #158) when the document
   *  changed — a same-tab edit racing one of `runNormalizeFlow`'s own
   *  await gaps (see asyncguard.ts's "edited" verdict) — while a confirm
   *  dialog or the representability IPC round trip was in flight. Not
   *  shown for a tab switch or the tab closing during the same window:
   *  those are silent, same reasoning as `mojibake.staleContentTitle`/
   *  `mojibake.staleContentMessage`, whose wording this mirrors. */
  "dialog.normalizeStaleTitle": string;
  "dialog.normalizeStaleMessage": string;
  /** Lazy byte-drift detection (issue #96 (2/3)) [danger]: the one-time,
   *  informed-consent dialog shown before a document's first save this
   *  session when src-tauri/src/bytedrift.rs's `check_byte_drift` finds
   *  that saving would silently canonicalize a non-injective legacy byte
   *  sequence (Big5/Shift_JIS/GBK-family duplicate mappings — see
   *  src-tauri/src/encoding.rs's module doc). Plain native confirm (main.ts
   *  runSaveFlow), not a custom DOM dialog like lossyEncoding/staleFile —
   *  this is purely informational, with no sample list to lay out. */
  "dialog.byteDriftTitle": string;
  "dialog.byteDriftMessage": (encoding: string) => string;
  "dialog.byteDriftConfirm": string;
  /** Shown by the Preferences dialog's Save button (preferences.ts
   *  showPreferencesDialog) when savePreferences rejects. Unlike the
   *  file's other six savePreferences call sites (ambient font/theme/
   *  view-toggle persistence, left as-is — applying immediately and
   *  persisting best-effort never misrepresents anything since the UI
   *  already reflects the new value), closing this dialog on failure
   *  would tell the user their edits are saved when they are not, so the
   *  dialog stays open instead (v0.6 V2 IPC-error-surfacing audit #4).
   *  Body text is String(error), same convention as saveFailedTitle/
   *  openFailedTitle/etc. above — no separate message key needed. */
  "dialog.preferencesSaveFailedTitle": string;

  "encoding.utf8": string;
  "encoding.utf8Bom": string;
  "encoding.utf16le": string;
  "encoding.utf16be": string;
  "encoding.big5": string;
  "encoding.gb18030": string;
  "encoding.gbk": string;
  "encoding.shiftJis": string;
  "encoding.eucJp": string;
  "encoding.eucKr": string;
  "encoding.windows1252": string;
  "encoding.windows1250": string;
  "encoding.windows1251": string;
  "encoding.windows1253": string;
  "encoding.windows1254": string;
  "encoding.windows1255": string;
  "encoding.windows1256": string;
  "encoding.windows1257": string;
  "encoding.windows1258": string;
  "encoding.iso88592": string;
  "encoding.iso88595": string;
  "encoding.iso88597": string;
  "encoding.iso885915": string;
  "encoding.koi8r": string;
  "encoding.koi8u": string;
  "encoding.windows874": string;
  "encoding.macintosh": string;

  // Encoding picker filter (ROADMAP.md v0.7 Track C encoding-picker alias
  // search) — popup.ts's showFilterableMenu chrome text, same split as
  // palette.searchPlaceholder/noResults above (the matched choices'
  // `label`s come from the encoding.* keys above, not this pair).
  "encodingPicker.searchPlaceholder": string;
  "encodingPicker.noResults": string;

  "encoding.group.unicode": string;
  "encoding.group.eastAsian": string;
  "encoding.group.westernEuropean": string;
  "encoding.group.centralEuropean": string;
  "encoding.group.cyrillic": string;
  "encoding.group.other": string;

  // Auto-update (ROADMAP.md D2) — src/updater.ts's checkForUpdatesAndPrompt.
  // availableMessage's "backed up automatically" clause is only true
  // because updater.ts's flushForExit call actually runs before relaunch
  // (see UpdaterDeps' doc comment there) — keep this wording in sync with
  // that behavior if it ever changes.
  "updater.availableTitle": string;
  "updater.availableMessage": (version: string) => string;
  "updater.downloadAndRestart": string;
  "updater.later": string;
  "updater.downloadFailedTitle": string;
  "updater.downloadFailedMessage": string;
  "updater.checkFailedTitle": string;
  "updater.checkFailedMessage": string;
  // Shown when a manual "Check for Updates…" click lands while another
  // check (background or manual) is already running (ROADMAP.md D2,
  // Codex re-review of PR #309's in-flight guard).
  "updater.checkInProgressTitle": string;
  "updater.checkInProgressMessage": string;
  "updater.upToDateTitle": string;
  "updater.upToDateMessage": string;
  // Shown when flushForExit (main.ts) reports a failed backup/session
  // write, before install is called — installAnyway/cancelInstall back a
  // two-choice dialog whose default is Cancel (see updater.ts's
  // promptAndInstall).
  "updater.flushFailedTitle": string;
  "updater.flushFailedMessage": string;
  "updater.installAnyway": string;
  "updater.cancelInstall": string;
  "updater.installFailedTitle": string;
  "updater.installFailedMessage": string;

  "common.loading": string;
}

const en: Messages = {
  "app.untitled": "Untitled",
  "app.untitledNumbered": (n) => `Untitled-${n}`,

  "tabs.closeAria": (title) => `Close ${title}`,
  "tabs.newTabAria": "New tab",

  "tabs.closeOthers": "Close Others",
  "tabs.closeTabsToRight": "Close Tabs to the Right",
  "tabs.copyPath": "Copy Path",
  "tabs.revealInFinder": "Reveal in Finder",
  "tabs.revealInExplorer": "Reveal in File Explorer",

  "statusbar.noFile": "No file",
  "statusbar.cursor": (line, column) => `Ln ${line}, Col ${column}`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `Read-only preview of ${size} file`,
  "statusbar.userReadOnly": "🔒 Read-only",
  "statusbar.missingOnDisk": "⚠ File deleted from disk",
  "statusbar.durabilityWarning": (detail) =>
    `⚠ Save landed but durability could not be confirmed (${detail})`,
  "statusbar.decodeWarning": "⚠ decoded with errors",
  "statusbar.buildingIndex": "Building line index…",
  "statusbar.preparingUpdate": "Preparing update…",
  "statusbar.textStats": (words, chars, lines) =>
    `${words} word${words === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}, ` +
    `${lines} line${lines === 1 ? "" : "s"}`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `Selected: ${words} word${words === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}, ` +
    `${lines} line${lines === 1 ? "" : "s"}`,
  "statusbar.charInspector": (char, codepoint) => `${char}  ${codepoint}`,
  "statusbar.suspiciousChars": (count) => `⚠ ${count} suspicious char${count === 1 ? "" : "s"}`,
  "statusbar.nonNfc": "Non-NFC",
  "statusbar.indentSpaces": (width) => `Spaces: ${width}`,
  "statusbar.indentTabs": "Tabs",
  "statusbar.indentMixed": "Mixed",

  "confirm.unsavedChanges": (title) => `"${title}" has unsaved changes.`,
  "confirm.dontSave": "Don't Save",
  "confirm.cancel": "Cancel",
  "confirm.save": "Save",

  "detectcard.reasonBom": "a BOM was found",
  "detectcard.reasonExtension": "per-extension preference, decoded cleanly",
  "detectcard.reasonDetector": "chardetng statistical detection",
  "detectcard.reasonFallback": "no evidence to analyze (empty file), defaulted",
  "detectcard.noBom": "No BOM found",
  "detectcard.title": (encoding) => `Why ${encoding}?`,
  "detectcard.labelFile": "File",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng verdict",
  "detectcard.labelSampled": "Sampled",
  "detectcard.labelWouldChoose": "Auto-detect would choose",
  "detectcard.labelCurrentlyUsing": "Currently using",
  "detectcard.sampledAll": (size) => `all ${size}`,
  "detectcard.sampledPartial": (shown, total) => `first ${shown} of ${total}`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding} (${reason})`,
  "detectcard.manualNote": (current, detected) =>
    `Currently using ${current} manually — auto-detect would choose ${detected}.`,
  "detectcard.detectionBoundaryNote": (encoding) =>
    `${encoding} isn't one of chardetng's detection targets — it can only be selected via a BOM, a per-extension default, or Reopen with Encoding.`,
  "detectcard.truncatedSampleNote":
    "Large-file preview: the verdict above is based on a truncated sample, not the whole file — if the text looks garbled, try Reopen with Encoding.",

  "docinfo.title": (file) => `Document Info — ${file}`,
  "docinfo.close": "Close",
  "docinfo.labelPath": "Path",
  "docinfo.pathUnsaved": (title) => `${title} (not saved yet)`,
  "docinfo.labelSize": "Size",
  "docinfo.labelModified": "Modified",
  "docinfo.labelEncoding": "Encoding",
  "docinfo.labelLineEnding": "Line Ending",
  "docinfo.labelScanned": "Scanned",
  "docinfo.lineEndingSampledNote": (scanned) =>
    `Counted from the first ${scanned} of this file only — these counts do not reflect the whole file.`,
  "docinfo.lineEndingUtf16Note": "Line-ending distribution isn't available for UTF-16 files.",
  "docinfo.labelTextStats": "Word/Character/Line Count",
  "docinfo.loadError": (message) => `Couldn't load this information: ${message}`,
  "docinfo.dirtyNote":
    "This document has unsaved changes: the text statistics and the " +
    "encoding and line-ending settings shown reflect its current unsaved " +
    "state, while the size, modified time, detection evidence and " +
    "line-ending distribution come from the last saved version on disk.",

  "charinspect.title": (codepoint) => `Character ${codepoint}`,
  "charinspect.labelChar": "Character",
  "charinspect.labelCodePoint": "Code Point",
  "charinspect.labelUtf8Bytes": "UTF-8 Bytes",
  "charinspect.labelEncodingBytes": (encoding) => `${encoding} Bytes`,
  "charinspect.lossyValue": (encoding) => `Cannot be represented in ${encoding}`,

  "hexview.showingAll": (size) => `showing all ${size}`,
  "hexview.showingPartial": (shown, total) => `showing first ${shown} of ${total}`,

  "findInFiles.chooseFolder": "Choose folder…",
  "findInFiles.searchPlaceholder": "Search in files…",
  "findInFiles.matchCase": "Match case",
  "findInFiles.regex": "Regular expression",
  "findInFiles.searching": "Searching…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `${count}${truncated ? "+" : ""} match${count === 1 ? "" : "es"} in ${filesScanned} files`,
  "findInFiles.scanErrorsSummary": (count) =>
    `${count} item${count === 1 ? "" : "s"} could not be searched — results may be incomplete.`,

  "findInFiles.replaceButton": "Replace in Files…",
  "findInFiles.replaceScanning": "Scanning for replacements…",
  "findInFiles.replaceNoMatches": "No files contain a match.",
  "findInFiles.replacePreviewSummary": (fileCount, matchCount, skippedCount) =>
    `${fileCount} file${fileCount === 1 ? "" : "s"}, ${matchCount} occurrence${matchCount === 1 ? "" : "s"}` +
    (skippedCount > 0 ? `, ${skippedCount} skipped` : ""),
  "findInFiles.replacePreviewTruncated":
    "List cut off — the rest of the folder was not scanned and may contain more matching files.",
  "findInFiles.replaceMatchCount": (count) => `${count} occurrence${count === 1 ? "" : "s"}`,
  "findInFiles.replaceLossyTooltip":
    "This file's own encoding can't represent some of the replacement text — proceeding " +
    "will substitute a literal HTML numeric character reference (&#NNNN;) for those characters.",
  "findInFiles.replaceRegexLiteralHint":
    "Replacement is inserted as literal text — backreferences like $1 are not expanded.",
  "findInFiles.skipReasonOversized": "Too large to search — skipped",
  "findInFiles.skipReasonMalformed": "Doesn't decode cleanly — skipped",
  "findInFiles.skipReasonIoError": "Couldn't read this file",
  "findInFiles.replaceExecuteButton": (count) => `Replace ${count} file${count === 1 ? "" : "s"}`,
  "findInFiles.replaceConfirmMessage": (fileCount, matchCount) =>
    `Replace ${matchCount} occurrence${matchCount === 1 ? "" : "s"} across ${fileCount} ` +
    `file${fileCount === 1 ? "" : "s"}? This cannot be undone.`,
  "findInFiles.replaceConfirmMessageLossy": (fileCount, matchCount, lossyFileCount) =>
    `Replace ${matchCount} occurrence${matchCount === 1 ? "" : "s"} across ${fileCount} ` +
    `file${fileCount === 1 ? "" : "s"}? This cannot be undone. ${lossyFileCount} ` +
    `file${lossyFileCount === 1 ? "" : "s"} contain replacement text that can't be represented ` +
    `in their own encoding — proceeding will write it as a literal HTML numeric character ` +
    `reference (&#NNNN;) instead.`,
  "findInFiles.replaceResultSummary": (okCount, totalReplacements, failedCount) =>
    `Replaced in ${okCount} file${okCount === 1 ? "" : "s"}: ${totalReplacements} ` +
    `occurrence${totalReplacements === 1 ? "" : "s"}.` +
    (failedCount > 0 ? ` ${failedCount} file${failedCount === 1 ? "" : "s"} failed.` : ""),
  "findInFiles.replaceStatusChangedSinceScan": "Changed since preview — not touched",
  "findInFiles.replaceStatusLossyBlocked": "Replacement not representable — not written",
  "findInFiles.replaceStatusIoError": "Read/write failed — not written",
  "findInFiles.replaceStatusDecodeError": "No longer decodes cleanly — not written",
  "findInFiles.replaceStatusTooLarge": "Grew too large — not written",
  "findInFiles.replaceFailuresHeading": (count) =>
    `${count} file${count === 1 ? "" : "s"} could not be replaced:`,

  "goto.placeholder": "Go to line:column…",

  "quickOpen.searchPlaceholder": "Search recent files…",
  "quickOpen.noRecent": "No recent files",
  "quickOpen.noMatches": "No matches",

  "palette.searchPlaceholder": "Search commands…",
  "palette.noResults": "No matching commands",

  "preferences.title": "Preferences",
  "preferences.editorFont": "Editor font",
  "preferences.editorFontPlaceholder": "System default",
  "preferences.fontSize": "Font size",
  "preferences.theme": "Theme",
  "preferences.language": "Language",
  "preferences.encodingForNewFiles": "Encoding for new files",
  "preferences.trimTrailingWhitespaceOnSave": "Trim trailing whitespace on save",
  "preferences.extHeading": "Per-extension encodings",
  "preferences.extHint":
    "Files with these extensions open with the given encoding; a BOM, " +
    "valid UTF-8 text, or a byte mismatch still wins.",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "Remove",
  "preferences.extAdd": "Add",
  "preferences.cancel": "Cancel",
  "preferences.save": "Save",
  "preferences.themeSystem": "Follow system",
  "preferences.themeLight": "Light",
  "preferences.themeDark": "Dark",
  "preferences.themePaper": "Paper",
  "preferences.themeDusk": "Dusk",
  "preferences.langSystemOption": "System",

  "menu.whyEncoding": (encoding) => `Why ${encoding}?`,
  "menu.reopenWithEncoding": "Reopen with Encoding",
  "menu.saveWithEncoding": "Save with Encoding",
  "menu.convertFileToEncoding": "Convert File to Encoding",
  "menu.compareEncodings": "Compare encodings…",
  "menu.viewRawBytes": "View raw bytes…",
  "menu.repairMojibake": "Repair mojibake…",
  "menu.lineEndingLf": "LF (Unix / macOS)",
  "menu.lineEndingCrlf": "CRLF (Windows)",
  "menu.lineEndingCr": "CR (Classic Mac)",

  "mojibake.title": "Repair mojibake",
  "mojibake.noCandidates":
    "No mis-decode pattern found — this doesn't look like mojibake.",
  "mojibake.pickCandidate": "Pick a repair to apply:",
  "mojibake.candidateDescription": (original, intermediate) =>
    `Looks like ${original} content that was decoded as ${intermediate} by mistake.`,
  "mojibake.replacementCount": (count) => `changes about ${count} character${count === 1 ? "" : "s"}`,
  "mojibake.before": "Before",
  "mojibake.after": "After repair",
  "mojibake.appliedTitle": "Mojibake repaired",
  "mojibake.appliedMessage":
    "The content was repaired in the editor. Use Undo to revert if this wasn't right.",
  "mojibake.staleContentTitle": "Repair not applied",
  "mojibake.staleContentMessage":
    "The document changed while the repair was being prepared, so it wasn't applied — your edits are safe. Reopen Repair mojibake to try again.",

  "comparePreview.title": (file) => `Compare encodings — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "Compare",
  "comparePreview.malformedBadge": "decode errors",
  "comparePreview.reopenButton": "Reopen with this encoding",

  "batchConvert.title": "Batch Encoding Conversion",
  "batchConvert.chooseFolder": "Choose folder…",
  "batchConvert.chooseFolderFirst": "Choose a folder first.",
  "batchConvert.extPlaceholder":
    "Extensions, comma-separated (e.g. txt,md) — empty means all files",
  "batchConvert.targetLabel": "Target encoding",
  "batchConvert.keepEncoding": "Keep current encoding",
  "batchConvert.lineEndingLabel": "Line ending",
  "batchConvert.lineEndingKeep": "Keep",
  "batchConvert.scanButton": "Scan (dry run)",
  "batchConvert.scanning": "Scanning…",
  "batchConvert.noResults": "No matching files found.",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge, byteDrift) =>
    `${convertible} convertible, ${alreadyTarget} already this encoding, ` +
    `${lossy} would lose data, ${undecodable} undecodable, ${tooLarge} too large, ` +
    `${byteDrift} would drift on re-save`,
  "batchConvert.statusConvertible": "Convertible",
  "batchConvert.statusAlreadyTarget": "Already this encoding",
  "batchConvert.statusLossy": "Would lose data",
  "batchConvert.statusUndecodable": "Undecodable",
  "batchConvert.statusTooLarge": "Too large",
  "batchConvert.byteDriftBadge": "byte drift",
  "batchConvert.byteDriftTooltip":
    "Text unchanged, but re-encoding would still change these bytes — a non-canonical " +
    "legacy byte sequence would be normalized.",
  "batchConvert.byteDriftTooltipConvertible":
    "Line endings will change as requested, but converting would also change these bytes " +
    "beyond that — a non-canonical legacy byte sequence would be normalized.",
  "batchConvert.lineEndingMixed": "Mixed",
  "batchConvert.includeFileLabel": "Include this file",
  "batchConvert.convertButton": (count) => `Convert ${count} file${count === 1 ? "" : "s"}`,
  "batchConvert.confirmMessage": (count) =>
    `Convert ${count} file${count === 1 ? "" : "s"} in place? Each file is ` +
    `re-encoded from the auto-detected encoding shown in the report — ` +
    `review the Detected column first. This cannot be undone.`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `Convert ${count} file${count === 1 ? "" : "s"} in place? ${scanErrorCount} ` +
    `item${scanErrorCount === 1 ? "" : "s"} could not be scanned, so this report may ` +
    `be missing files — review the Detected column and the scan-error list first. ` +
    `This cannot be undone.`,
  "batchConvert.rescanNeeded": "Settings changed — scan again before converting.",
  "batchConvert.converting": "Converting…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0
      ? `Converted ${ok} file${ok === 1 ? "" : "s"}.`
      : `Converted ${ok} file${ok === 1 ? "" : "s"}, ${failed} failed.`,
  "batchConvert.scanErrorsSummary": (count) =>
    `${count} item${count === 1 ? "" : "s"} could not be scanned — this report may be incomplete.`,

  "streamReplace.title": (file) => `Replace in Large File — ${file}`,
  "streamReplace.searchPlaceholder": "Search…",
  "streamReplace.replacePlaceholder": "Replace with…",
  "streamReplace.caseInsensitiveHint":
    "Case-insensitive matching applies to ASCII letters only.",
  "streamReplace.executeButton": "Replace All",
  "streamReplace.replacing": "Replacing…",
  "streamReplace.resultMessage": (count) =>
    `${count} replacement${count === 1 ? "" : "s"} made.`,
  "streamReplace.unmatchedRegionReencodedNote":
    "Some unmatched regions were re-encoded due to cross-chunk entanglement — " +
    "a non-canonical legacy byte sequence there may have been normalized.",
  "streamReplace.completedTabClosedMessage":
    "The file was updated, but its tab was already closed — the preview wasn't refreshed.",

  "streamConvert.title": (file) => `Convert Encoding — ${file}`,
  "streamConvert.converting": (encoding) => `Converting to ${encoding}…`,
  "streamConvert.resultMessage": (encoding) => `File converted to ${encoding}.`,
  "streamConvert.failedMessage": "Conversion failed unexpectedly.",
  "streamConvert.completedTabClosedMessage":
    "The file was converted, but its tab was already closed — the preview wasn't refreshed.",

  "dialog.pagingTitle": "Paging",
  "dialog.fileChangedTitle": "File changed on disk",
  "dialog.fileChangedMessage": (title) =>
    `"${title}" changed on disk. Reload it and discard your unsaved changes?`,
  "dialog.reload": "Reload",
  "dialog.fileDeletedTitle": "File deleted",
  "dialog.fileDeletedMessage": (title) =>
    `"${title}" was deleted from disk. The buffer still holds its content; saving will recreate the file.`,
  "dialog.staleFileMessage": (title) =>
    `"${title}" changed on disk since it was opened. Overwrite it with ` +
    `your version, reload the newer version and discard your unsaved ` +
    `changes, or cancel this save.`,
  "dialog.overwrite": "Overwrite",
  "dialog.openFailedTitle": "Open failed",
  "dialog.clearRecentFailedTitle": "Clear Recently Opened failed",
  "dialog.readonlyPreviewTitle": "Read-only preview",
  "dialog.readonlyPreviewMessage": (title) =>
    `"${title}" is a read-only preview of a large file; saving is disabled.`,
  "dialog.userReadOnlyTitle": "Read-only",
  "dialog.userReadOnlyMessage": (title) =>
    `"${title}" is marked read-only. Uncheck View > Read-Only to edit it.`,
  "dialog.updateInProgressTitle": "Update in Progress",
  "dialog.updateInProgressMessage":
    "Mojidori is preparing to install an update and can't be edited right now. Please wait a moment.",
  "dialog.saveFailedTitle": "Save failed",
  "dialog.lossyEncodingTitle": "Encoding warning",
  "dialog.lossyEncodingMessage": (encoding, count) =>
    `${count} character${count === 1 ? "" : "s"} can't be represented in ${encoding}. ` +
    `Continuing to save will write replacement characters in their place, and this ` +
    `can't be undone.`,
  "dialog.lossyEncodingConfirm": "Save Anyway",
  "dialog.lossySampleLine": (display, line, column) => `${display} — Ln ${line}, Col ${column}`,
  "dialog.lossySamplesTruncated": "More distinct characters exist beyond this list.",
  "dialog.backupFailedTitle": "Backup failed",
  "dialog.backupFailedMessage": (titles) =>
    `Unsaved changes in ${titles.join(", ")} could not be written to their ` +
    `backup (disk full or folder not writable?). Closing now cannot keep ` +
    `these changes. Close anyway?`,
  "dialog.backupFailedDiscard": "Discard and Close",
  "dialog.backupRestoreFailedTitle": "Backup unreadable",
  "dialog.backupRestoreFailedMessage": (titles) =>
    `The backup for ${titles.join(", ")} could not be read. Unsaved changes ` +
    `it held may be lost; Mojidori will fall back to the version on disk where ` +
    `possible.`,
  "dialog.orphanScanFailedTitle": "Backup scan failed",
  "dialog.orphanScanFailedMessage":
    "Mojidori couldn't check for backups left over from a previous session. " +
    "Nothing on disk was changed — restart Mojidori to try again.",
  "dialog.pendingFilesFailedTitle": "Couldn't open requested files",
  "dialog.pendingFilesFailedMessage":
    "Mojidori couldn't retrieve the file(s) it was asked to open. Use File > " +
    "Open to open them directly.",
  "dialog.unsavedChangesTitle": "Unsaved changes",
  "dialog.reopenMessage": (title) =>
    `Reopening will discard unsaved changes in "${title}". Continue?`,
  "dialog.reopen": "Reopen",
  "dialog.reopenFailedTitle": "Reopen failed",
  "dialog.reopenBusyTitle": "Busy",
  "dialog.reopenBusyMessage": (title) =>
    `"${title}" is still saving or reloading. Try again in a moment.`,
  "dialog.printTitle": "Print",
  "dialog.streamReplaceUseRegularTitle": "Replace in Large File",
  "dialog.streamReplaceUseRegularMessage":
    "This isn't a large-file preview. Use the regular Find and Replace " +
    "(Cmd/Ctrl+F) instead.",
  "dialog.lineIndexFailedTitle": "Line index failed",
  "dialog.bookmarkNeedsGotoTitle": "Position unknown",
  "dialog.bookmarkNeedsGotoMessage":
    "This window's position in the file isn't known yet. Use Go to Line " +
    "to jump somewhere first, then bookmark it.",
  "dialog.normalizeConfirmTitle": (form) => `Normalize to ${form}`,
  "dialog.normalizeConfirmMessage": (count, form) =>
    `${count} character sequence${count === 1 ? "" : "s"} will change when ` +
    `normalizing to ${form}. Continue?`,
  "dialog.normalizeConfirmButton": "Normalize",
  "dialog.normalizeUnrepresentableTitle": "Characters Not Representable",
  "dialog.normalizeUnrepresentableMessage": (encoding, count, samples, truncated) =>
    `Saving as ${encoding} would lose ${count} character${count === 1 ? "" : "s"} ` +
    `after normalizing: ${samples.join(", ")}${truncated ? " and more" : ""}. ` +
    `Normalize anyway?`,
  "dialog.normalizeUnrepresentableConfirm": "Normalize Anyway",
  "dialog.normalizeFailedTitle": "Normalize failed",
  "dialog.normalizeStaleTitle": "Normalize not applied",
  "dialog.normalizeStaleMessage":
    "The document changed while Normalize was being prepared, so it wasn't applied — your edits are safe. Run Normalize again if you still want to.",
  "dialog.byteDriftTitle": "Byte drift warning",
  "dialog.byteDriftMessage": (encoding) =>
    `This file contains ${encoding} byte sequences that can't be preserved exactly. ` +
    `Saving will normalize them to their canonical byte form — the text won't change, ` +
    `but the original bytes will, and this can't be undone.`,
  "dialog.byteDriftConfirm": "Save Anyway",
  "dialog.preferencesSaveFailedTitle": "Preferences save failed",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8 with BOM",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5 (Traditional Chinese)",
  "encoding.gb18030": "GB18030 (Simplified Chinese)",
  "encoding.gbk": "GBK (Simplified Chinese)",
  "encoding.shiftJis": "Shift_JIS (Japanese)",
  "encoding.eucJp": "EUC-JP (Japanese)",
  "encoding.eucKr": "EUC-KR (Korean)",
  "encoding.windows1252": "Windows-1252 (Western)",
  "encoding.windows1250": "Windows-1250 (Central European)",
  "encoding.windows1251": "Windows-1251 (Cyrillic)",
  "encoding.windows1253": "Windows-1253 (Greek)",
  "encoding.windows1254": "Windows-1254 (Turkish)",
  "encoding.windows1255": "Windows-1255 (Hebrew)",
  "encoding.windows1256": "Windows-1256 (Arabic)",
  "encoding.windows1257": "Windows-1257 (Baltic)",
  "encoding.windows1258": "Windows-1258 (Vietnamese)",
  "encoding.iso88592": "ISO-8859-2 (Central European)",
  "encoding.iso88595": "ISO-8859-5 (Cyrillic)",
  "encoding.iso88597": "ISO-8859-7 (Greek)",
  "encoding.iso885915": "ISO-8859-15 (Western, with €)",
  "encoding.koi8r": "KOI8-R (Russian)",
  "encoding.koi8u": "KOI8-U (Ukrainian)",
  "encoding.windows874": "Windows-874 (Thai)",
  "encoding.macintosh": "Macintosh (Mac Roman)",

  "encodingPicker.searchPlaceholder": "Search encodings (name or alias)…",
  "encodingPicker.noResults": "No matching encoding",

  "encoding.group.unicode": "Unicode",
  "encoding.group.eastAsian": "East Asian",
  "encoding.group.westernEuropean": "Western European",
  "encoding.group.centralEuropean": "Central European",
  "encoding.group.cyrillic": "Cyrillic",
  "encoding.group.other": "Other",

  "updater.availableTitle": "Update Available",
  "updater.availableMessage": (version) =>
    `Mojidori ${version} is available. Any unsaved changes will be backed up automatically before restarting.`,
  "updater.downloadAndRestart": "Download and Restart",
  "updater.later": "Later",
  "updater.downloadFailedTitle": "Update Failed",
  "updater.downloadFailedMessage": "The update could not be downloaded. Please try again later.",
  "updater.checkFailedTitle": "Update Check Failed",
  "updater.checkFailedMessage": "Could not check for updates. Please check your internet connection.",
  "updater.checkInProgressTitle": "Check in Progress",
  "updater.checkInProgressMessage": "An update check is already in progress. Please wait for it to finish.",
  "updater.upToDateTitle": "You're Up to Date",
  "updater.upToDateMessage": "Mojidori is on the latest version.",
  "updater.flushFailedTitle": "Backup Failed",
  "updater.flushFailedMessage":
    "Some unsaved changes could not be backed up before installing this update, which restarts Mojidori. You can install anyway, or cancel and save your work first — you'll be asked again the next time Mojidori checks for updates.",
  "updater.installAnyway": "Install Anyway",
  "updater.cancelInstall": "Cancel",
  "updater.installFailedTitle": "Update Failed",
  "updater.installFailedMessage": "The update could not be installed. Please try again later.",

  "common.loading": "Loading…",
};

const zhTW: Messages = {
  "app.untitled": "未命名",
  "app.untitledNumbered": (n) => `未命名-${n}`,

  "tabs.closeAria": (title) => `關閉 ${title}`,
  "tabs.newTabAria": "新增分頁",

  "tabs.closeOthers": "關閉其他分頁",
  "tabs.closeTabsToRight": "關閉右側分頁",
  "tabs.copyPath": "複製路徑",
  "tabs.revealInFinder": "在 Finder 中顯示",
  "tabs.revealInExplorer": "在檔案總管中顯示",

  "statusbar.noFile": "無檔案",
  "statusbar.cursor": (line, column) => `第 ${line} 行，第 ${column} 欄`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `唯讀預覽（檔案大小 ${size}）`,
  "statusbar.userReadOnly": "🔒 唯讀",
  "statusbar.missingOnDisk": "⚠ 檔案已從磁碟移除",
  "statusbar.durabilityWarning": (detail) => `⚠ 已儲存，但無法確認持久性（${detail}）`,
  "statusbar.decodeWarning": "⚠ 解碼時發生錯誤",
  "statusbar.buildingIndex": "正在建立行號索引…",
  "statusbar.preparingUpdate": "正在準備更新…",
  "statusbar.textStats": (words, chars, lines) => `${words} 詞、${chars} 字元、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `已選取：${words} 詞、${chars} 字元、${lines} 行`,
  "statusbar.charInspector": (char, codepoint) => `${char}  ${codepoint}`,
  "statusbar.suspiciousChars": (count) => `⚠ ${count} 可疑字元`,
  "statusbar.nonNfc": "非 NFC",
  "statusbar.indentSpaces": (width) => `空格：${width}`,
  "statusbar.indentTabs": "Tab",
  "statusbar.indentMixed": "混合",

  "confirm.unsavedChanges": (title) => `「${title}」有未儲存的變更。`,
  "confirm.dontSave": "不要儲存",
  "confirm.cancel": "取消",
  "confirm.save": "儲存",

  "detectcard.reasonBom": "偵測到 BOM",
  "detectcard.reasonExtension": "依副檔名偏好設定，解碼成功",
  "detectcard.reasonDetector": "chardetng 統計偵測",
  "detectcard.reasonFallback": "無可分析的證據（空檔案），使用預設值",
  "detectcard.noBom": "未偵測到 BOM",
  "detectcard.title": (encoding) => `為何是 ${encoding}？`,
  "detectcard.labelFile": "檔案",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng 判定結果",
  "detectcard.labelSampled": "取樣範圍",
  "detectcard.labelWouldChoose": "自動偵測會選擇",
  "detectcard.labelCurrentlyUsing": "目前使用",
  "detectcard.sampledAll": (size) => `全部 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `前 ${shown}（共 ${total}）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `目前手動使用 ${current}——自動偵測會選擇 ${detected}。`,
  "detectcard.detectionBoundaryNote": (encoding) =>
    `${encoding} 不在 chardetng 的偵測範圍內——只能透過 BOM、副檔名預設值，或「以指定編碼重新開啟」選取。`,
  "detectcard.truncatedSampleNote":
    "大型檔案預覽：以上判定結果僅根據截斷樣本，並非整個檔案——若文字顯示為亂碼，可嘗試「以指定編碼重新開啟」。",

  "docinfo.title": (file) => `文件資訊 — ${file}`,
  "docinfo.close": "關閉",
  "docinfo.labelPath": "路徑",
  "docinfo.pathUnsaved": (title) => `${title}（尚未儲存）`,
  "docinfo.labelSize": "大小",
  "docinfo.labelModified": "修改時間",
  "docinfo.labelEncoding": "編碼",
  "docinfo.labelLineEnding": "行尾",
  "docinfo.labelScanned": "已掃描",
  "docinfo.lineEndingSampledNote": (scanned) =>
    `僅根據此檔案前 ${scanned} 計算——這些數字並非整個檔案的統計。`,
  "docinfo.lineEndingUtf16Note": "UTF-16 檔案不支援行尾分布統計。",
  "docinfo.labelTextStats": "詞／字元／行數",
  "docinfo.loadError": (message) => `無法載入此資訊：${message}`,
  "docinfo.dirtyNote":
    "本文件有未儲存的變更：文字統計與顯示的編碼、行尾設定反映目前未儲存的狀態；大小、修改時間、偵測證據與行尾分布則來自磁碟上最後儲存的版本。",

  "charinspect.title": (codepoint) => `字元 ${codepoint}`,
  "charinspect.labelChar": "字元",
  "charinspect.labelCodePoint": "碼位",
  "charinspect.labelUtf8Bytes": "UTF-8 位元組",
  "charinspect.labelEncodingBytes": (encoding) => `${encoding} 位元組`,
  "charinspect.lossyValue": (encoding) => `無法以 ${encoding} 編碼表示`,

  "hexview.showingAll": (size) => `顯示全部 ${size}`,
  "hexview.showingPartial": (shown, total) => `顯示前 ${shown}（共 ${total}）`,

  "findInFiles.chooseFolder": "選擇資料夾…",
  "findInFiles.searchPlaceholder": "在檔案中搜尋…",
  "findInFiles.matchCase": "區分大小寫",
  "findInFiles.regex": "正規表示式",
  "findInFiles.searching": "搜尋中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `在 ${filesScanned} 個檔案中找到 ${count}${truncated ? "+" : ""} 筆符合`,
  "findInFiles.scanErrorsSummary": (count) =>
    `有 ${count} 個項目無法搜尋——搜尋結果可能不完整。`,

  "findInFiles.replaceButton": "在檔案中取代…",
  "findInFiles.replaceScanning": "掃描取代目標中…",
  "findInFiles.replaceNoMatches": "沒有檔案包含相符項目。",
  "findInFiles.replacePreviewSummary": (fileCount, matchCount, skippedCount) =>
    `${fileCount} 個檔案、共 ${matchCount} 處相符` +
    (skippedCount > 0 ? `，另有 ${skippedCount} 個略過` : ""),
  "findInFiles.replacePreviewTruncated":
    "清單已截斷——資料夾其餘部分未掃描，可能還有更多相符檔案。",
  "findInFiles.replaceMatchCount": (count) => `${count} 處`,
  "findInFiles.replaceLossyTooltip":
    "此檔案的編碼無法表示部分取代文字——繼續將以 HTML numeric character reference" +
    "（&#NNNN; 字面文字）寫入這些字元。",
  "findInFiles.replaceRegexLiteralHint":
    "取代內容為字面文字——$1 等反向引用不會展開。",
  "findInFiles.skipReasonOversized": "檔案過大，略過搜尋",
  "findInFiles.skipReasonMalformed": "無法正確解碼，略過搜尋",
  "findInFiles.skipReasonIoError": "無法讀取此檔案",
  "findInFiles.replaceExecuteButton": (count) => `取代 ${count} 個檔案`,
  "findInFiles.replaceConfirmMessage": (fileCount, matchCount) =>
    `即將取代 ${fileCount} 個檔案中的 ${matchCount} 處相符——此操作無法復原。`,
  "findInFiles.replaceConfirmMessageLossy": (fileCount, matchCount, lossyFileCount) =>
    `即將取代 ${fileCount} 個檔案中的 ${matchCount} 處相符——此操作無法復原。` +
    `${lossyFileCount} 個檔案含無法以其編碼表示的替換字元——繼續將以 HTML numeric ` +
    `character reference（&#NNNN; 字面文字）寫入。`,
  "findInFiles.replaceResultSummary": (okCount, totalReplacements, failedCount) =>
    `已在 ${okCount} 個檔案取代共 ${totalReplacements} 處` +
    (failedCount > 0 ? `，失敗 ${failedCount} 個` : "") +
    "。",
  "findInFiles.replaceStatusChangedSinceScan": "自預覽後已變動，未動",
  "findInFiles.replaceStatusLossyBlocked": "替換字元無法以編碼表示，未寫入",
  "findInFiles.replaceStatusIoError": "讀寫失敗，未寫入",
  "findInFiles.replaceStatusDecodeError": "無法解碼，未寫入",
  "findInFiles.replaceStatusTooLarge": "檔案過大，未寫入",
  "findInFiles.replaceFailuresHeading": (count) => `${count} 個檔案未變更：`,

  "goto.placeholder": "跳至行:欄…",

  "quickOpen.searchPlaceholder": "搜尋最近的檔案…",
  "quickOpen.noRecent": "沒有最近的檔案",
  "quickOpen.noMatches": "沒有符合的項目",

  "palette.searchPlaceholder": "搜尋命令…",
  "palette.noResults": "沒有符合的命令",

  "preferences.title": "偏好設定",
  "preferences.editorFont": "編輯器字型",
  "preferences.editorFontPlaceholder": "系統預設",
  "preferences.fontSize": "字型大小",
  "preferences.theme": "主題",
  "preferences.language": "語言",
  "preferences.encodingForNewFiles": "新檔案的編碼",
  "preferences.trimTrailingWhitespaceOnSave": "儲存時移除行尾空白",
  "preferences.extHeading": "副檔名編碼對應",
  "preferences.extHint":
    "符合這些副檔名的檔案會以指定編碼開啟；BOM、有效的 UTF-8 文字，" +
    "或位元組不符時仍會優先採用。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "移除",
  "preferences.extAdd": "新增",
  "preferences.cancel": "取消",
  "preferences.save": "儲存",
  "preferences.themeSystem": "跟隨系統",
  "preferences.themeLight": "亮色",
  "preferences.themeDark": "暗色",
  "preferences.themePaper": "紙張",
  "preferences.themeDusk": "黃昏",
  "preferences.langSystemOption": "系統預設",

  "menu.whyEncoding": (encoding) => `為何是 ${encoding}？`,
  "menu.reopenWithEncoding": "以指定編碼重新開啟",
  "menu.saveWithEncoding": "以指定編碼儲存",
  "menu.convertFileToEncoding": "轉換檔案編碼",
  "menu.compareEncodings": "比較編碼…",
  "menu.viewRawBytes": "檢視原始位元組…",
  "menu.repairMojibake": "修復亂碼…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

  "mojibake.title": "修復亂碼",
  "mojibake.noCandidates": "找不到可修復的 mis-decode pattern。",
  "mojibake.pickCandidate": "選擇一個修復方式套用：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `看起來是 ${original} 的內容曾被當 ${intermediate} 解碼。`,
  "mojibake.replacementCount": (count) => `約變更 ${count} 個字元`,
  "mojibake.before": "修復前",
  "mojibake.after": "修復後",
  "mojibake.appliedTitle": "亂碼已修復",
  "mojibake.appliedMessage": "編輯器內容已修復，可用 Undo 復原。",
  "mojibake.staleContentTitle": "未套用修復",
  "mojibake.staleContentMessage":
    "修復準備期間文件內容已變更，因此未套用——你的編輯內容已保留。請重新開啟「修復亂碼」再試一次。",

  "comparePreview.title": (file) => `比較編碼 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比較",
  "comparePreview.malformedBadge": "解碼錯誤",
  "comparePreview.reopenButton": "以此編碼重新開啟",

  "batchConvert.title": "批次轉換編碼",
  "batchConvert.chooseFolder": "選擇資料夾…",
  "batchConvert.chooseFolderFirst": "請先選擇資料夾。",
  "batchConvert.extPlaceholder": "副檔名，逗號分隔（如 txt,md）——留空代表所有檔案",
  "batchConvert.targetLabel": "目標編碼",
  "batchConvert.keepEncoding": "保持目前編碼",
  "batchConvert.lineEndingLabel": "行尾",
  "batchConvert.lineEndingKeep": "保持不變",
  "batchConvert.scanButton": "掃描（僅預覽）",
  "batchConvert.scanning": "掃描中…",
  "batchConvert.noResults": "找不到符合的檔案。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge, byteDrift) =>
    `可轉換 ${convertible}、已是目標編碼 ${alreadyTarget}、會遺失資料 ${lossy}、` +
    `無法解碼 ${undecodable}、檔案過大 ${tooLarge}、會位元組漂移 ${byteDrift}`,
  "batchConvert.statusConvertible": "可轉換",
  "batchConvert.statusAlreadyTarget": "已是目標編碼",
  "batchConvert.statusLossy": "會遺失資料",
  "batchConvert.statusUndecodable": "無法解碼",
  "batchConvert.statusTooLarge": "檔案過大",
  "batchConvert.byteDriftBadge": "位元組漂移",
  "batchConvert.byteDriftTooltip":
    "文字不會改變，但重新編碼後這些位元組仍會改變——非標準的舊版位元組序列會被正規化。",
  "batchConvert.byteDriftTooltipConvertible":
    "換行將依你的要求改變，但轉換後這些位元組還會有額外變化——非標準的舊版位元組序列會被正規化。",
  "batchConvert.lineEndingMixed": "混合換行",
  "batchConvert.includeFileLabel": "包含此檔案",
  "batchConvert.convertButton": (count) => `轉換 ${count} 個檔案`,
  "batchConvert.confirmMessage": (count) =>
    `即將就地轉換 ${count} 個檔案？每個檔案將依報告中自動偵測的編碼` +
    `（Detected 欄）重新編碼——請先確認偵測結果。此操作無法復原。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `即將就地轉換 ${count} 個檔案？另有 ${scanErrorCount} 個項目無法掃描，本報告` +
    `可能未涵蓋所有檔案——請先確認 Detected 欄與掃描錯誤清單。此操作無法復原。`,
  "batchConvert.rescanNeeded": "設定已變更——請重新掃描後再轉換。",
  "batchConvert.converting": "轉換中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0 ? `已轉換 ${ok} 個檔案。` : `已轉換 ${ok} 個檔案，失敗 ${failed} 個。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `有 ${count} 個項目無法掃描——本報告可能不完整。`,

  "streamReplace.title": (file) => `在大型檔案中取代 — ${file}`,
  "streamReplace.searchPlaceholder": "尋找…",
  "streamReplace.replacePlaceholder": "取代為…",
  "streamReplace.caseInsensitiveHint": "不區分大小寫僅適用於 ASCII 字母。",
  "streamReplace.executeButton": "全部取代",
  "streamReplace.replacing": "取代中…",
  "streamReplace.resultMessage": (count) => `已取代 ${count} 處。`,
  "streamReplace.unmatchedRegionReencodedNote":
    "部分未命中的區段因跨界糾纏被重新編碼——該處可能有非標準的舊版位元組序列被正規化。",
  "streamReplace.completedTabClosedMessage": "檔案已更新，但其分頁已關閉——預覽未重新整理。",

  "streamConvert.title": (file) => `轉換編碼 — ${file}`,
  "streamConvert.converting": (encoding) => `正在轉換為 ${encoding}…`,
  "streamConvert.resultMessage": (encoding) => `檔案已轉換為 ${encoding}。`,
  "streamConvert.failedMessage": "轉換發生非預期的失敗。",
  "streamConvert.completedTabClosedMessage": "檔案已轉換，但其分頁已關閉——預覽未重新整理。",

  "dialog.pagingTitle": "翻頁",
  "dialog.fileChangedTitle": "檔案已在磁碟上異動",
  "dialog.fileChangedMessage": (title) =>
    `「${title}」已在磁碟上異動，要重新載入並捨棄未儲存的變更嗎？`,
  "dialog.reload": "重新載入",
  "dialog.fileDeletedTitle": "檔案已刪除",
  "dialog.fileDeletedMessage": (title) =>
    `「${title}」已從磁碟移除。緩衝區內容仍保留；儲存可重建檔案。`,
  "dialog.staleFileMessage": (title) =>
    `「${title}」自開啟後已在磁碟上異動。要覆寫為目前版本、重新載入較新的版本並捨棄未儲存的變更，還是取消這次儲存？`,
  "dialog.overwrite": "覆寫",
  "dialog.openFailedTitle": "開啟失敗",
  "dialog.clearRecentFailedTitle": "清除最近開啟清單失敗",
  "dialog.readonlyPreviewTitle": "唯讀預覽",
  "dialog.readonlyPreviewMessage": (title) =>
    `「${title}」是大型檔案的唯讀預覽，無法儲存。`,
  "dialog.userReadOnlyTitle": "唯讀",
  "dialog.userReadOnlyMessage": (title) =>
    `「${title}」已設為唯讀，取消勾選「檢視 > 唯讀」即可編輯。`,
  "dialog.updateInProgressTitle": "更新進行中",
  "dialog.updateInProgressMessage": "Mojidori 正在準備安裝更新，目前無法編輯，請稍候。",
  "dialog.saveFailedTitle": "儲存失敗",
  "dialog.lossyEncodingTitle": "編碼警告",
  "dialog.lossyEncodingMessage": (encoding, count) =>
    `有 ${count} 個字元無法以 ${encoding} 表示，繼續儲存將以替代字元寫入且無法復原。`,
  "dialog.lossyEncodingConfirm": "仍要儲存",
  "dialog.lossySampleLine": (display, line, column) => `${display} — 第 ${line} 行，第 ${column} 欄`,
  "dialog.lossySamplesTruncated": "尚有更多不同字元未列出。",
  "dialog.backupFailedTitle": "備份寫入失敗",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} 的未儲存變更無法寫入備份（磁碟已滿或資料夾` +
    `無法寫入？），現在關閉的話，這些變更將無法保留。仍要關閉？`,
  "dialog.backupFailedDiscard": "放棄變更並關閉",
  "dialog.backupRestoreFailedTitle": "備份無法讀取",
  "dialog.backupRestoreFailedMessage": (titles) =>
    `${titles.join("、")} 的備份無法讀取，其中的未儲存變更可能已遺失；如果磁碟上有檔案，Mojidori 將改為開啟磁碟上的版本。`,
  "dialog.orphanScanFailedTitle": "備份掃描失敗",
  "dialog.orphanScanFailedMessage":
    "Mojidori 無法掃描前次工作階段遺留的備份。磁碟上的內容並未受影響，重新啟動 Mojidori 即可再試一次。",
  "dialog.pendingFilesFailedTitle": "無法開啟指定的檔案",
  "dialog.pendingFilesFailedMessage":
    "Mojidori 無法取得這次啟動要求開啟的檔案，請改用「檔案 > 開啟」手動開啟。",
  "dialog.unsavedChangesTitle": "未儲存的變更",
  "dialog.reopenMessage": (title) =>
    `重新開啟將捨棄「${title}」中未儲存的變更，是否繼續？`,
  "dialog.reopen": "重新開啟",
  "dialog.reopenFailedTitle": "重新開啟失敗",
  "dialog.reopenBusyTitle": "操作進行中",
  "dialog.reopenBusyMessage": (title) => `「${title}」正在儲存或重新載入，請稍候再試一次。`,
  "dialog.printTitle": "列印",
  "dialog.streamReplaceUseRegularTitle": "在大型檔案中取代",
  "dialog.streamReplaceUseRegularMessage":
    "這不是大型檔案的唯讀預覽。請改用一般的尋找與取代（Cmd/Ctrl+F）。",
  "dialog.lineIndexFailedTitle": "建立行號索引失敗",
  "dialog.bookmarkNeedsGotoTitle": "位置未知",
  "dialog.bookmarkNeedsGotoMessage":
    "目前視窗在檔案中的位置尚未確定。請先用「跳至行號」跳轉一次，再設定書籤。",
  "dialog.normalizeConfirmTitle": (form) => `正規化為 ${form}`,
  "dialog.normalizeConfirmMessage": (count, form) =>
    `正規化為 ${form} 將變更 ${count} 處字元序列，是否繼續？`,
  "dialog.normalizeConfirmButton": "正規化",
  "dialog.normalizeUnrepresentableTitle": "字元無法表示",
  "dialog.normalizeUnrepresentableMessage": (encoding, count, samples, truncated) =>
    `以 ${encoding} 儲存將在正規化後遺失 ${count} 個字元：${samples.join("、")}${truncated ? " 等" : ""}。仍要正規化嗎？`,
  "dialog.normalizeUnrepresentableConfirm": "仍要正規化",
  "dialog.normalizeFailedTitle": "正規化失敗",
  "dialog.normalizeStaleTitle": "未套用正規化",
  "dialog.normalizeStaleMessage":
    "正規化準備期間文件內容已變更，因此未套用——你的編輯內容已保留。如仍需要，請重新執行正規化。",
  "dialog.byteDriftTitle": "位元組漂移警告",
  "dialog.byteDriftMessage": (encoding) =>
    `此檔案含有 ${encoding} 中無法逐位元組保留的位元組序列，儲存將把它們正規化為標準形式——` +
    `文字內容不會改變，但原始位元組會遺失，且無法復原。`,
  "dialog.byteDriftConfirm": "仍要儲存",
  "dialog.preferencesSaveFailedTitle": "偏好設定儲存失敗",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（含 BOM）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁體中文）",
  "encoding.gb18030": "GB18030（簡體中文）",
  "encoding.gbk": "GBK（簡體中文）",
  "encoding.shiftJis": "Shift_JIS（日文）",
  "encoding.eucJp": "EUC-JP（日文）",
  "encoding.eucKr": "EUC-KR（韓文）",
  "encoding.windows1252": "Windows-1252（西歐語系）",
  "encoding.windows1250": "Windows-1250（中歐）",
  "encoding.windows1251": "Windows-1251（西里爾文）",
  "encoding.windows1253": "Windows-1253（希臘文）",
  "encoding.windows1254": "Windows-1254（土耳其文）",
  "encoding.windows1255": "Windows-1255（希伯來文）",
  "encoding.windows1256": "Windows-1256（阿拉伯文）",
  "encoding.windows1257": "Windows-1257（波羅的海文）",
  "encoding.windows1258": "Windows-1258（越南文）",
  "encoding.iso88592": "ISO-8859-2（中歐）",
  "encoding.iso88595": "ISO-8859-5（西里爾文）",
  "encoding.iso88597": "ISO-8859-7（希臘文）",
  "encoding.iso885915": "ISO-8859-15（西歐語系，含€）",
  "encoding.koi8r": "KOI8-R（俄文）",
  "encoding.koi8u": "KOI8-U（烏克蘭文）",
  "encoding.windows874": "Windows-874（泰文）",
  "encoding.macintosh": "Macintosh（Mac Roman）",

  "encodingPicker.searchPlaceholder": "搜尋編碼（名稱或別名）…",
  "encodingPicker.noResults": "沒有符合的編碼",

  "encoding.group.unicode": "Unicode",
  "encoding.group.eastAsian": "東亞",
  "encoding.group.westernEuropean": "西歐",
  "encoding.group.centralEuropean": "中歐",
  "encoding.group.cyrillic": "西里爾",
  "encoding.group.other": "其他",

  "updater.availableTitle": "有可用更新",
  "updater.availableMessage": (version) =>
    `Mojidori ${version} 已可更新。重新啟動前，任何未儲存的變更都會自動備份。`,
  "updater.downloadAndRestart": "下載並重新啟動",
  "updater.later": "稍後",
  "updater.downloadFailedTitle": "更新失敗",
  "updater.downloadFailedMessage": "無法下載更新，請稍後再試。",
  "updater.checkFailedTitle": "檢查更新失敗",
  "updater.checkFailedMessage": "無法檢查更新，請確認網路連線。",
  "updater.checkInProgressTitle": "檢查進行中",
  "updater.checkInProgressMessage": "已有更新檢查正在進行，請稍候。",
  "updater.upToDateTitle": "已是最新版本",
  "updater.upToDateMessage": "Mojidori 目前已是最新版本。",
  "updater.flushFailedTitle": "備份失敗",
  "updater.flushFailedMessage":
    "部分未儲存的變更在安裝此更新前無法備份，安裝後 Mojidori 會重新啟動。您可以仍要安裝，或取消並先儲存您的工作——下次 Mojidori 檢查更新時會再次詢問。",
  "updater.installAnyway": "仍要安裝",
  "updater.cancelInstall": "取消",
  "updater.installFailedTitle": "更新失敗",
  "updater.installFailedMessage": "無法安裝更新，請稍後再試。",

  "common.loading": "載入中…",
};

const ja: Messages = {
  "app.untitled": "無題",
  "app.untitledNumbered": (n) => `無題-${n}`,

  "tabs.closeAria": (title) => `${title} を閉じる`,
  "tabs.newTabAria": "新しいタブ",

  "tabs.closeOthers": "他のタブを閉じる",
  "tabs.closeTabsToRight": "右側のタブを閉じる",
  "tabs.copyPath": "パスをコピー",
  "tabs.revealInFinder": "Finderで表示",
  "tabs.revealInExplorer": "エクスプローラーで表示",

  "statusbar.noFile": "ファイルなし",
  "statusbar.cursor": (line, column) => `行 ${line}、列 ${column}`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `読み取り専用プレビュー（ファイルサイズ ${size}）`,
  "statusbar.userReadOnly": "🔒 読み取り専用",
  "statusbar.missingOnDisk": "⚠ ディスクから削除されました",
  "statusbar.durabilityWarning": (detail) => `⚠ 保存されましたが永続性を確認できません（${detail}）`,
  "statusbar.decodeWarning": "⚠ デコードエラーが発生しました",
  "statusbar.buildingIndex": "行番号インデックスを構築中…",
  "statusbar.preparingUpdate": "アップデートを準備中…",
  "statusbar.textStats": (words, chars, lines) => `${words} 語、${chars} 文字、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `選択範囲：${words} 語、${chars} 文字、${lines} 行`,
  "statusbar.charInspector": (char, codepoint) => `${char}  ${codepoint}`,
  "statusbar.suspiciousChars": (count) => `⚠ 疑わしい文字 ${count} 件`,
  "statusbar.nonNfc": "非NFC",
  "statusbar.indentSpaces": (width) => `スペース：${width}`,
  "statusbar.indentTabs": "タブ",
  "statusbar.indentMixed": "混在",

  "confirm.unsavedChanges": (title) => `「${title}」には保存されていない変更があります。`,
  "confirm.dontSave": "保存しない",
  "confirm.cancel": "キャンセル",
  "confirm.save": "保存",

  "detectcard.reasonBom": "BOM が検出されました",
  "detectcard.reasonExtension": "拡張子ごとの設定により、正常にデコードされました",
  "detectcard.reasonDetector": "chardetng による統計的判定",
  "detectcard.reasonFallback": "分析できる情報がないため（空のファイル）、既定値を使用",
  "detectcard.noBom": "BOM は検出されませんでした",
  "detectcard.title": (encoding) => `なぜ ${encoding} なのか？`,
  "detectcard.labelFile": "ファイル",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng の判定結果",
  "detectcard.labelSampled": "サンプリング範囲",
  "detectcard.labelWouldChoose": "自動検出の場合の選択",
  "detectcard.labelCurrentlyUsing": "現在使用中",
  "detectcard.sampledAll": (size) => `全 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `先頭 ${shown}（全 ${total} 中）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `現在手動で ${current} を使用しています。自動検出では ${detected} が選択されます。`,
  "detectcard.detectionBoundaryNote": (encoding) =>
    `${encoding} は chardetng の検出対象ではありません。BOM、拡張子ごとの既定値、または「エンコーディングを指定して再度開く」でのみ選択できます。`,
  "detectcard.truncatedSampleNote":
    "大容量ファイルのプレビュー: 上記の判定結果はファイル全体ではなく、切り詰められたサンプルに基づいています。文字化けして見える場合は「エンコーディングを指定して再度開く」を試してください。",

  "docinfo.title": (file) => `ドキュメント情報 — ${file}`,
  "docinfo.close": "閉じる",
  "docinfo.labelPath": "パス",
  "docinfo.pathUnsaved": (title) => `${title}（未保存）`,
  "docinfo.labelSize": "サイズ",
  "docinfo.labelModified": "更新日時",
  "docinfo.labelEncoding": "エンコーディング",
  "docinfo.labelLineEnding": "改行コード",
  "docinfo.labelScanned": "走査範囲",
  "docinfo.lineEndingSampledNote": (scanned) =>
    `このファイルの先頭 ${scanned} のみを対象に集計しています——ファイル全体の値ではありません。`,
  "docinfo.lineEndingUtf16Note": "UTF-16 ファイルでは改行コードの分布を取得できません。",
  "docinfo.labelTextStats": "単語数／文字数／行数",
  "docinfo.loadError": (message) => `この情報を読み込めませんでした: ${message}`,
  "docinfo.dirtyNote":
    "このドキュメントには未保存の変更があります。テキスト統計と表示中のエンコーディング・改行コード設定は現在の未保存状態を反映し、サイズ・更新日時・検出根拠・改行コード分布はディスク上の最終保存版に基づきます。",

  "charinspect.title": (codepoint) => `文字 ${codepoint}`,
  "charinspect.labelChar": "文字",
  "charinspect.labelCodePoint": "コードポイント",
  "charinspect.labelUtf8Bytes": "UTF-8 バイト列",
  "charinspect.labelEncodingBytes": (encoding) => `${encoding} バイト列`,
  "charinspect.lossyValue": (encoding) => `${encoding} では表現できません`,

  "hexview.showingAll": (size) => `全 ${size} を表示`,
  "hexview.showingPartial": (shown, total) => `先頭 ${shown} を表示（全 ${total} 中）`,

  "findInFiles.chooseFolder": "フォルダーを選択…",
  "findInFiles.searchPlaceholder": "ファイル内を検索…",
  "findInFiles.matchCase": "大文字と小文字を区別",
  "findInFiles.regex": "正規表現",
  "findInFiles.searching": "検索中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `${filesScanned} 個のファイル中 ${count}${truncated ? "+" : ""} 件一致`,
  "findInFiles.scanErrorsSummary": (count) =>
    `${count} 件の項目を検索できませんでした — 検索結果は不完全な可能性があります。`,

  "findInFiles.replaceButton": "ファイル内を置換…",
  "findInFiles.replaceScanning": "置換対象をスキャン中…",
  "findInFiles.replaceNoMatches": "一致するファイルがありません。",
  "findInFiles.replacePreviewSummary": (fileCount, matchCount, skippedCount) =>
    `${fileCount} 件のファイル、${matchCount} 件の一致` +
    (skippedCount > 0 ? `、${skippedCount} 件スキップ` : ""),
  "findInFiles.replacePreviewTruncated":
    "一覧は途中で打ち切られました — フォルダーの残りはスキャンされておらず、" +
    "一致するファイルが他にもある可能性があります。",
  "findInFiles.replaceMatchCount": (count) => `${count} 件`,
  "findInFiles.replaceLossyTooltip":
    "このファイルのエンコーディングでは置換テキストの一部を表現できません — 続行すると" +
    "これらの文字は HTML 数値文字参照（&#NNNN; というリテラル文字列）として書き込まれます。",
  "findInFiles.replaceRegexLiteralHint":
    "置換テキストはリテラル文字列として挿入されます — $1 などの後方参照は展開されません。",
  "findInFiles.skipReasonOversized": "サイズ超過のためスキップ",
  "findInFiles.skipReasonMalformed": "デコードできないためスキップ",
  "findInFiles.skipReasonIoError": "このファイルを読み込めません",
  "findInFiles.replaceExecuteButton": (count) => `${count} 件のファイルを置換`,
  "findInFiles.replaceConfirmMessage": (fileCount, matchCount) =>
    `${fileCount} 件のファイル、${matchCount} 件の一致を置換しますか？ この操作は元に戻せません。`,
  "findInFiles.replaceConfirmMessageLossy": (fileCount, matchCount, lossyFileCount) =>
    `${fileCount} 件のファイル、${matchCount} 件の一致を置換しますか？ この操作は元に戻せません。` +
    `${lossyFileCount} 件のファイルに、そのエンコーディングで表現できない置換文字が含まれて` +
    `います — 続行すると HTML 数値文字参照（&#NNNN; というリテラル文字列）として書き込まれます。`,
  "findInFiles.replaceResultSummary": (okCount, totalReplacements, failedCount) =>
    `${okCount} 件のファイルで ${totalReplacements} 件を置換しました。` +
    (failedCount > 0 ? `${failedCount} 件失敗しました。` : ""),
  "findInFiles.replaceStatusChangedSinceScan": "プレビュー後に変更されたため未処理",
  "findInFiles.replaceStatusLossyBlocked": "置換文字を表現できないため未書き込み",
  "findInFiles.replaceStatusIoError": "読み書きに失敗——未書き込み",
  "findInFiles.replaceStatusDecodeError": "デコードできないため未書き込み",
  "findInFiles.replaceStatusTooLarge": "サイズ超過のため未書き込み",
  "findInFiles.replaceFailuresHeading": (count) => `${count} 件のファイルを変更できませんでした:`,

  "goto.placeholder": "行:列に移動…",

  "quickOpen.searchPlaceholder": "最近使用したファイルを検索…",
  "quickOpen.noRecent": "最近使用したファイルはありません",
  "quickOpen.noMatches": "一致する項目がありません",

  "palette.searchPlaceholder": "コマンドを検索…",
  "palette.noResults": "一致するコマンドがありません",

  "preferences.title": "環境設定",
  "preferences.editorFont": "エディターフォント",
  "preferences.editorFontPlaceholder": "システム既定",
  "preferences.fontSize": "フォントサイズ",
  "preferences.theme": "テーマ",
  "preferences.language": "言語",
  "preferences.encodingForNewFiles": "新規ファイルのエンコーディング",
  "preferences.trimTrailingWhitespaceOnSave": "保存時に行末の空白を削除",
  "preferences.extHeading": "拡張子ごとのエンコーディング",
  "preferences.extHint":
    "これらの拡張子のファイルは指定したエンコーディングで開かれます。ただし BOM、" +
    "有効な UTF-8 テキスト、またはバイト不一致が検出された場合はそちらが優先されます。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "削除",
  "preferences.extAdd": "追加",
  "preferences.cancel": "キャンセル",
  "preferences.save": "保存",
  "preferences.themeSystem": "システムに従う",
  "preferences.themeLight": "ライト",
  "preferences.themeDark": "ダーク",
  "preferences.themePaper": "紙",
  "preferences.themeDusk": "黄昏",
  "preferences.langSystemOption": "システム既定",

  "menu.whyEncoding": (encoding) => `なぜ ${encoding} なのか？`,
  "menu.reopenWithEncoding": "エンコーディングを指定して再度開く",
  "menu.saveWithEncoding": "エンコーディングを指定して保存",
  "menu.convertFileToEncoding": "ファイルのエンコーディングを変換",
  "menu.compareEncodings": "エンコーディングを比較…",
  "menu.viewRawBytes": "生バイトを表示…",
  "menu.repairMojibake": "文字化けを修復…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

  "mojibake.title": "文字化けを修復",
  "mojibake.noCandidates":
    "修復可能な誤デコードパターンが見つかりませんでした — 文字化けではないようです。",
  "mojibake.pickCandidate": "適用する修復方法を選択してください：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `${original} の内容が誤って ${intermediate} としてデコードされたようです。`,
  "mojibake.replacementCount": (count) => `約 ${count} 文字を変更`,
  "mojibake.before": "修復前",
  "mojibake.after": "修復後",
  "mojibake.appliedTitle": "文字化けを修復しました",
  "mojibake.appliedMessage":
    "エディター内のコンテンツを修復しました。誤っていた場合は元に戻す（Undo）で戻せます。",
  "mojibake.staleContentTitle": "修復は適用されませんでした",
  "mojibake.staleContentMessage":
    "修復の準備中にドキュメントの内容が変更されたため、適用されませんでした（編集内容は保持されています）。「文字化けを修復」を開き直してもう一度お試しください。",

  "comparePreview.title": (file) => `エンコーディングを比較 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比較",
  "comparePreview.malformedBadge": "デコードエラー",
  "comparePreview.reopenButton": "このエンコーディングで再度開く",

  "batchConvert.title": "エンコーディング一括変換",
  "batchConvert.chooseFolder": "フォルダーを選択…",
  "batchConvert.chooseFolderFirst": "先にフォルダーを選択してください。",
  "batchConvert.extPlaceholder":
    "拡張子をカンマ区切りで指定（例: txt,md）— 空欄の場合はすべてのファイルが対象",
  "batchConvert.targetLabel": "変換先エンコーディング",
  "batchConvert.keepEncoding": "現在のエンコーディングを維持",
  "batchConvert.lineEndingLabel": "改行コード",
  "batchConvert.lineEndingKeep": "維持",
  "batchConvert.scanButton": "スキャン（プレビューのみ）",
  "batchConvert.scanning": "スキャン中…",
  "batchConvert.noResults": "一致するファイルが見つかりません。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge, byteDrift) =>
    `変換可能 ${convertible} 件、既にこのエンコーディング ${alreadyTarget} 件、` +
    `データ損失あり ${lossy} 件、デコード不可 ${undecodable} 件、サイズ超過 ${tooLarge} 件、` +
    `バイトドリフトあり ${byteDrift} 件`,
  "batchConvert.statusConvertible": "変換可能",
  "batchConvert.statusAlreadyTarget": "既にこのエンコーディング",
  "batchConvert.statusLossy": "データ損失あり",
  "batchConvert.statusUndecodable": "デコード不可",
  "batchConvert.statusTooLarge": "サイズ超過",
  "batchConvert.byteDriftBadge": "バイトドリフト",
  "batchConvert.byteDriftTooltip":
    "テキストは変わりませんが、再エンコードするとこれらのバイト列は変わります——" +
    "非正規のレガシーバイト列が正規化されます。",
  "batchConvert.byteDriftTooltipConvertible":
    "改行コードはご指定どおり変更されますが、変換するとそれ以外のバイト列も変わります——" +
    "非正規のレガシーバイト列が正規化されます。",
  "batchConvert.lineEndingMixed": "混在",
  "batchConvert.includeFileLabel": "このファイルを含める",
  "batchConvert.convertButton": (count) => `${count} 件のファイルを変換`,
  "batchConvert.confirmMessage": (count) =>
    `${count} 件のファイルをその場で変換しますか？各ファイルはレポートに表示された` +
    `自動検出エンコーディング（Detected 列）に基づいて再エンコードされます。先に検出結果を` +
    `ご確認ください。この操作は元に戻せません。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `${count} 件のファイルをその場で変換しますか？${scanErrorCount} 件の項目をスキャンでき` +
    `なかったため、このレポートにはファイルが漏れている可能性があります——先に Detected 列と` +
    `スキャンエラーの一覧をご確認ください。この操作は元に戻せません。`,
  "batchConvert.rescanNeeded": "設定が変更されました — 変換前に再度スキャンしてください。",
  "batchConvert.converting": "変換中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0
      ? `${ok} 件のファイルを変換しました。`
      : `${ok} 件のファイルを変換しました。${failed} 件失敗。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `${count} 件の項目をスキャンできませんでした — このレポートは不完全な可能性があります。`,

  "streamReplace.title": (file) => `大きいファイル内で置換 — ${file}`,
  "streamReplace.searchPlaceholder": "検索…",
  "streamReplace.replacePlaceholder": "置換後の文字列…",
  "streamReplace.caseInsensitiveHint":
    "大文字・小文字を区別しない照合は ASCII 文字にのみ適用されます。",
  "streamReplace.executeButton": "すべて置換",
  "streamReplace.replacing": "置換中…",
  "streamReplace.resultMessage": (count) => `${count} 件を置換しました。`,
  "streamReplace.unmatchedRegionReencodedNote":
    "一致しなかった一部の領域が、チャンクをまたぐ巻き込みにより再エンコードされました——" +
    "非正規のレガシーバイト列がそこで正規化された可能性があります。",
  "streamReplace.completedTabClosedMessage":
    "ファイルは更新されましたが、タブはすでに閉じられていたためプレビューは更新されませんでした。",

  "streamConvert.title": (file) => `エンコード変換 — ${file}`,
  "streamConvert.converting": (encoding) => `${encoding} に変換中…`,
  "streamConvert.resultMessage": (encoding) => `ファイルを ${encoding} に変換しました。`,
  "streamConvert.failedMessage": "変換が予期せず失敗しました。",
  "streamConvert.completedTabClosedMessage":
    "ファイルは変換されましたが、タブはすでに閉じられていたためプレビューは更新されませんでした。",

  "dialog.pagingTitle": "ページング",
  "dialog.fileChangedTitle": "ファイルがディスク上で変更されました",
  "dialog.fileChangedMessage": (title) =>
    `「${title}」はディスク上で変更されています。再読み込みして未保存の変更を破棄しますか？`,
  "dialog.reload": "再読み込み",
  "dialog.fileDeletedTitle": "ファイルが削除されました",
  "dialog.fileDeletedMessage": (title) =>
    `「${title}」はディスクから削除されました。バッファの内容は保持されており、保存するとファイルが再作成されます。`,
  "dialog.staleFileMessage": (title) =>
    `「${title}」を開いた後にディスク上で変更されました。現在の内容で上書きするか、` +
    `未保存の変更を破棄して新しいバージョンを再読み込みするか、この保存をキャンセルしてください。`,
  "dialog.overwrite": "上書き",
  "dialog.openFailedTitle": "開くのに失敗しました",
  "dialog.clearRecentFailedTitle": "最近開いたファイルの消去に失敗しました",
  "dialog.readonlyPreviewTitle": "読み取り専用プレビュー",
  "dialog.readonlyPreviewMessage": (title) =>
    `「${title}」は大きいファイルの読み取り専用プレビューです。保存はできません。`,
  "dialog.userReadOnlyTitle": "読み取り専用",
  "dialog.userReadOnlyMessage": (title) =>
    `「${title}」は読み取り専用に設定されています。「表示 > 読み取り専用」のチェックを外すと編集できます。`,
  "dialog.updateInProgressTitle": "アップデート準備中",
  "dialog.updateInProgressMessage":
    "Mojidori はアップデートのインストールを準備しています。しばらくの間、編集はできません。",
  "dialog.saveFailedTitle": "保存に失敗しました",
  "dialog.lossyEncodingTitle": "エンコーディングに関する警告",
  "dialog.lossyEncodingMessage": (encoding, count) =>
    `${count} 文字が ${encoding} で表現できません。このまま保存すると代替文字が書き込まれ、` +
    `元に戻すことはできません。`,
  "dialog.lossyEncodingConfirm": "このまま保存",
  "dialog.lossySampleLine": (display, line, column) => `${display} — 行 ${line}、列 ${column}`,
  "dialog.lossySamplesTruncated": "このほかにも表現できない文字があります。",
  "dialog.backupFailedTitle": "バックアップに失敗しました",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} の未保存の変更をバックアップに書き込めませんでした` +
    `（ディスクの空き容量不足か、フォルダーが書き込み不可の可能性があります）。` +
    `今閉じるとこれらの変更は失われます。それでも閉じますか？`,
  "dialog.backupFailedDiscard": "変更を破棄して閉じる",
  "dialog.backupRestoreFailedTitle": "バックアップを読み込めません",
  "dialog.backupRestoreFailedMessage": (titles) =>
    `${titles.join("、")} のバックアップを読み込めませんでした。未保存の変更が` +
    `失われた可能性があります。可能な場合はディスク上のバージョンを開きます。`,
  "dialog.orphanScanFailedTitle": "バックアップのスキャンに失敗しました",
  "dialog.orphanScanFailedMessage":
    "前回のセッションで残されたバックアップをスキャンできませんでした。ディスク上の" +
    "データは変更されていません。Mojidori を再起動すると再試行されます。",
  "dialog.pendingFilesFailedTitle": "指定されたファイルを開けませんでした",
  "dialog.pendingFilesFailedMessage":
    "起動時に開くよう指定されたファイルを取得できませんでした。「ファイル > 開く」" +
    "から直接開いてください。",
  "dialog.unsavedChangesTitle": "未保存の変更",
  "dialog.reopenMessage": (title) =>
    `再度開くと「${title}」の未保存の変更が破棄されます。続行しますか？`,
  "dialog.reopen": "再度開く",
  "dialog.reopenFailedTitle": "再度開くのに失敗しました",
  "dialog.reopenBusyTitle": "処理中",
  "dialog.reopenBusyMessage": (title) =>
    `「${title}」は保存中または再読み込み中です。しばらくしてからもう一度お試しください。`,
  "dialog.printTitle": "印刷",
  "dialog.streamReplaceUseRegularTitle": "大きいファイル内で置換",
  "dialog.streamReplaceUseRegularMessage":
    "これは大きいファイルのプレビューではありません。通常の検索と置換（Cmd/Ctrl+F）を" +
    "ご利用ください。",
  "dialog.lineIndexFailedTitle": "行番号インデックスの作成に失敗しました",
  "dialog.bookmarkNeedsGotoTitle": "位置が不明です",
  "dialog.bookmarkNeedsGotoMessage":
    "このウィンドウのファイル内での位置がまだ確定していません。先に「行に移動」で" +
    "ジャンプしてから、ブックマークを設定してください。",
  "dialog.normalizeConfirmTitle": (form) => `${form} に正規化`,
  "dialog.normalizeConfirmMessage": (count, form) =>
    `${form} に正規化すると ${count} 件の文字シーケンスが変更されます。続行しますか？`,
  "dialog.normalizeConfirmButton": "正規化",
  "dialog.normalizeUnrepresentableTitle": "表現できない文字があります",
  "dialog.normalizeUnrepresentableMessage": (encoding, count, samples, truncated) =>
    `${encoding} で保存すると、正規化後に ${count} 文字が失われます：${samples.join("、")}` +
    `${truncated ? " など" : ""}。それでも正規化しますか？`,
  "dialog.normalizeUnrepresentableConfirm": "このまま正規化",
  "dialog.normalizeFailedTitle": "正規化に失敗しました",
  "dialog.normalizeStaleTitle": "正規化は適用されませんでした",
  "dialog.normalizeStaleMessage":
    "正規化の準備中にドキュメントの内容が変更されたため、適用されませんでした（編集内容は保持されています）。必要であれば、もう一度正規化を実行してください。",
  "dialog.byteDriftTitle": "バイトドリフトの警告",
  "dialog.byteDriftMessage": (encoding) =>
    `このファイルには、正確に保持できない ${encoding} のバイト列が含まれています。保存すると` +
    `正規の形式に正規化されます。テキスト自体は変わりませんが、元のバイト列は失われ、元に戻す` +
    `ことはできません。`,
  "dialog.byteDriftConfirm": "このまま保存",
  "dialog.preferencesSaveFailedTitle": "環境設定の保存に失敗しました",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（BOM 付き）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁体字中国語）",
  "encoding.gb18030": "GB18030（簡体字中国語）",
  "encoding.gbk": "GBK（簡体字中国語）",
  "encoding.shiftJis": "Shift_JIS（日本語）",
  "encoding.eucJp": "EUC-JP（日本語）",
  "encoding.eucKr": "EUC-KR（韓国語）",
  "encoding.windows1252": "Windows-1252（西欧言語）",
  "encoding.windows1250": "Windows-1250（中欧）",
  "encoding.windows1251": "Windows-1251（キリル文字）",
  "encoding.windows1253": "Windows-1253（ギリシャ語）",
  "encoding.windows1254": "Windows-1254（トルコ語）",
  "encoding.windows1255": "Windows-1255（ヘブライ語）",
  "encoding.windows1256": "Windows-1256（アラビア語）",
  "encoding.windows1257": "Windows-1257（バルト語）",
  "encoding.windows1258": "Windows-1258（ベトナム語）",
  "encoding.iso88592": "ISO-8859-2（中欧）",
  "encoding.iso88595": "ISO-8859-5（キリル文字）",
  "encoding.iso88597": "ISO-8859-7（ギリシャ語）",
  "encoding.iso885915": "ISO-8859-15（西欧、€対応）",
  "encoding.koi8r": "KOI8-R（ロシア語）",
  "encoding.koi8u": "KOI8-U（ウクライナ語）",
  "encoding.windows874": "Windows-874（タイ語）",
  "encoding.macintosh": "Macintosh（Mac Roman）",

  "encodingPicker.searchPlaceholder": "エンコーディングを検索（名前またはエイリアス）…",
  "encodingPicker.noResults": "一致するエンコーディングがありません",

  "encoding.group.unicode": "Unicode",
  "encoding.group.eastAsian": "東アジア",
  "encoding.group.westernEuropean": "西欧",
  "encoding.group.centralEuropean": "中欧",
  "encoding.group.cyrillic": "キリル文字",
  "encoding.group.other": "その他",

  "updater.availableTitle": "アップデートがあります",
  "updater.availableMessage": (version) =>
    `Mojidori ${version} が利用可能です。再起動前に、未保存の変更は自動的にバックアップされます。`,
  "updater.downloadAndRestart": "ダウンロードして再起動",
  "updater.later": "後で",
  "updater.downloadFailedTitle": "アップデートに失敗しました",
  "updater.downloadFailedMessage": "アップデートをダウンロードできませんでした。しばらくしてから再試行してください。",
  "updater.checkFailedTitle": "アップデートの確認に失敗しました",
  "updater.checkFailedMessage": "アップデートを確認できませんでした。インターネット接続をご確認ください。",
  "updater.checkInProgressTitle": "確認中",
  "updater.checkInProgressMessage": "アップデートの確認はすでに進行中です。しばらくお待ちください。",
  "updater.upToDateTitle": "最新の状態です",
  "updater.upToDateMessage": "Mojidori は最新バージョンです。",
  "updater.flushFailedTitle": "バックアップに失敗しました",
  "updater.flushFailedMessage":
    "このアップデートをインストールする前に、一部の未保存の変更をバックアップできませんでした。インストールすると Mojidori が再起動します。このままインストールするか、キャンセルして作業を保存してください——次回のアップデート確認時に再度お尋ねします。",
  "updater.installAnyway": "このままインストール",
  "updater.cancelInstall": "キャンセル",
  "updater.installFailedTitle": "アップデートに失敗しました",
  "updater.installFailedMessage": "アップデートをインストールできませんでした。しばらくしてから再試行してください。",

  "common.loading": "読み込み中…",
};

const zhCN: Messages = {
  "app.untitled": "未命名",
  "app.untitledNumbered": (n) => `未命名-${n}`,

  "tabs.closeAria": (title) => `关闭 ${title}`,
  "tabs.newTabAria": "新建标签页",

  "tabs.closeOthers": "关闭其他标签页",
  "tabs.closeTabsToRight": "关闭右侧标签页",
  "tabs.copyPath": "复制路径",
  "tabs.revealInFinder": "在 Finder 中显示",
  "tabs.revealInExplorer": "在文件资源管理器中显示",

  "statusbar.noFile": "无文件",
  "statusbar.cursor": (line, column) => `第 ${line} 行，第 ${column} 列`,
  "statusbar.encodingWithBom": (encoding) => `${encoding} BOM`,
  "statusbar.readonlyPreview": (size) => `只读预览（文件大小 ${size}）`,
  "statusbar.userReadOnly": "🔒 只读",
  "statusbar.missingOnDisk": "⚠ 文件已从磁盘删除",
  "statusbar.durabilityWarning": (detail) => `⚠ 已保存，但无法确认持久性（${detail}）`,
  "statusbar.decodeWarning": "⚠ 解码时发生错误",
  "statusbar.buildingIndex": "正在构建行号索引…",
  "statusbar.preparingUpdate": "正在准备更新…",
  "statusbar.textStats": (words, chars, lines) => `${words} 词、${chars} 字符、${lines} 行`,
  "statusbar.textStatsSelection": (words, chars, lines) =>
    `已选择：${words} 词、${chars} 字符、${lines} 行`,
  "statusbar.charInspector": (char, codepoint) => `${char}  ${codepoint}`,
  "statusbar.suspiciousChars": (count) => `⚠ ${count} 可疑字符`,
  "statusbar.nonNfc": "非 NFC",
  "statusbar.indentSpaces": (width) => `空格：${width}`,
  "statusbar.indentTabs": "Tab",
  "statusbar.indentMixed": "混合",

  "confirm.unsavedChanges": (title) => `“${title}”有未保存的更改。`,
  "confirm.dontSave": "不保存",
  "confirm.cancel": "取消",
  "confirm.save": "保存",

  "detectcard.reasonBom": "检测到 BOM",
  "detectcard.reasonExtension": "根据扩展名偏好设置，解码成功",
  "detectcard.reasonDetector": "chardetng 统计检测",
  "detectcard.reasonFallback": "无可分析的依据（空文件），使用默认值",
  "detectcard.noBom": "未检测到 BOM",
  "detectcard.title": (encoding) => `为什么是 ${encoding}？`,
  "detectcard.labelFile": "文件",
  "detectcard.labelBom": "BOM",
  "detectcard.labelVerdict": "chardetng 判定结果",
  "detectcard.labelSampled": "采样范围",
  "detectcard.labelWouldChoose": "自动检测将选择",
  "detectcard.labelCurrentlyUsing": "目前使用",
  "detectcard.sampledAll": (size) => `全部 ${size}`,
  "detectcard.sampledPartial": (shown, total) => `前 ${shown}（共 ${total}）`,
  "detectcard.wouldChooseValue": (encoding, reason) => `${encoding}（${reason}）`,
  "detectcard.manualNote": (current, detected) =>
    `目前手动使用 ${current}——自动检测将选择 ${detected}。`,
  "detectcard.detectionBoundaryNote": (encoding) =>
    `${encoding} 不在 chardetng 的检测范围内——只能通过 BOM、扩展名默认值，或“以指定编码重新打开”选取。`,
  "detectcard.truncatedSampleNote":
    "大型文件预览：以上判定结果仅根据截断样本，并非整个文件——如果文字显示为乱码，可尝试“以指定编码重新打开”。",

  "docinfo.title": (file) => `文档信息 — ${file}`,
  "docinfo.close": "关闭",
  "docinfo.labelPath": "路径",
  "docinfo.pathUnsaved": (title) => `${title}（尚未保存）`,
  "docinfo.labelSize": "大小",
  "docinfo.labelModified": "修改时间",
  "docinfo.labelEncoding": "编码",
  "docinfo.labelLineEnding": "换行符",
  "docinfo.labelScanned": "已扫描",
  "docinfo.lineEndingSampledNote": (scanned) =>
    `仅根据此文件前 ${scanned} 计算——这些数字并非整个文件的统计。`,
  "docinfo.lineEndingUtf16Note": "UTF-16 文件不支持换行符分布统计。",
  "docinfo.labelTextStats": "词／字符／行数",
  "docinfo.loadError": (message) => `无法加载此信息：${message}`,
  "docinfo.dirtyNote":
    "本文档有未保存的更改：文本统计与显示的编码、换行符设置反映当前未保存状态；大小、修改时间、检测证据与换行符分布则来自磁盘上最后保存的版本。",

  "charinspect.title": (codepoint) => `字符 ${codepoint}`,
  "charinspect.labelChar": "字符",
  "charinspect.labelCodePoint": "码位",
  "charinspect.labelUtf8Bytes": "UTF-8 字节",
  "charinspect.labelEncodingBytes": (encoding) => `${encoding} 字节`,
  "charinspect.lossyValue": (encoding) => `无法以 ${encoding} 编码表示`,

  "hexview.showingAll": (size) => `显示全部 ${size}`,
  "hexview.showingPartial": (shown, total) => `显示前 ${shown}（共 ${total}）`,

  "findInFiles.chooseFolder": "选择文件夹…",
  "findInFiles.searchPlaceholder": "在文件中搜索…",
  "findInFiles.matchCase": "区分大小写",
  "findInFiles.regex": "正则表达式",
  "findInFiles.searching": "搜索中…",
  "findInFiles.status": (count, truncated, filesScanned) =>
    `在 ${filesScanned} 个文件中找到 ${count}${truncated ? "+" : ""} 处匹配`,
  "findInFiles.scanErrorsSummary": (count) =>
    `有 ${count} 个项目无法搜索——搜索结果可能不完整。`,

  "findInFiles.replaceButton": "在文件中替换…",
  "findInFiles.replaceScanning": "正在扫描替换目标…",
  "findInFiles.replaceNoMatches": "没有文件包含匹配项。",
  "findInFiles.replacePreviewSummary": (fileCount, matchCount, skippedCount) =>
    `${fileCount} 个文件，共 ${matchCount} 处匹配` +
    (skippedCount > 0 ? `，另有 ${skippedCount} 个已跳过` : ""),
  "findInFiles.replacePreviewTruncated":
    "列表已截断——文件夹其余部分未扫描，可能还有更多匹配文件。",
  "findInFiles.replaceMatchCount": (count) => `${count} 处`,
  "findInFiles.replaceLossyTooltip":
    "此文件的编码无法表示部分替换文本——继续将以 HTML numeric character reference" +
    "（&#NNNN; 字面文本）写入这些字符。",
  "findInFiles.replaceRegexLiteralHint":
    "替换内容为字面文本——$1 等反向引用不会展开。",
  "findInFiles.skipReasonOversized": "文件过大，已跳过",
  "findInFiles.skipReasonMalformed": "无法正确解码，已跳过",
  "findInFiles.skipReasonIoError": "无法读取此文件",
  "findInFiles.replaceExecuteButton": (count) => `替换 ${count} 个文件`,
  "findInFiles.replaceConfirmMessage": (fileCount, matchCount) =>
    `即将替换 ${fileCount} 个文件中的 ${matchCount} 处匹配——此操作无法撤销。`,
  "findInFiles.replaceConfirmMessageLossy": (fileCount, matchCount, lossyFileCount) =>
    `即将替换 ${fileCount} 个文件中的 ${matchCount} 处匹配——此操作无法撤销。` +
    `${lossyFileCount} 个文件含有无法以其编码表示的替换字符——继续将以 HTML numeric ` +
    `character reference（&#NNNN; 字面文本）写入。`,
  "findInFiles.replaceResultSummary": (okCount, totalReplacements, failedCount) =>
    `已在 ${okCount} 个文件中替换共 ${totalReplacements} 处` +
    (failedCount > 0 ? `，失败 ${failedCount} 个` : "") +
    "。",
  "findInFiles.replaceStatusChangedSinceScan": "预览后已变动，未处理",
  "findInFiles.replaceStatusLossyBlocked": "替换字符无法表示，未写入",
  "findInFiles.replaceStatusIoError": "读写失败，未写入",
  "findInFiles.replaceStatusDecodeError": "无法解码，未写入",
  "findInFiles.replaceStatusTooLarge": "文件过大，未写入",
  "findInFiles.replaceFailuresHeading": (count) => `${count} 个文件未变更：`,

  "goto.placeholder": "跳转到行:列…",

  "quickOpen.searchPlaceholder": "搜索最近的文件…",
  "quickOpen.noRecent": "没有最近的文件",
  "quickOpen.noMatches": "没有匹配项",

  "palette.searchPlaceholder": "搜索命令…",
  "palette.noResults": "没有匹配的命令",

  "preferences.title": "首选项",
  "preferences.editorFont": "编辑器字体",
  "preferences.editorFontPlaceholder": "系统默认",
  "preferences.fontSize": "字体大小",
  "preferences.theme": "主题",
  "preferences.language": "语言",
  "preferences.encodingForNewFiles": "新建文件的编码",
  "preferences.trimTrailingWhitespaceOnSave": "保存时删除行尾空白",
  "preferences.extHeading": "按扩展名设置编码",
  "preferences.extHint":
    "符合这些扩展名的文件会以指定编码打开；若检测到 BOM、有效的 UTF-8 文本，" +
    "或字节不匹配，仍会优先采用。",
  "preferences.extPlaceholder": "txt",
  "preferences.extRemoveTitle": "移除",
  "preferences.extAdd": "添加",
  "preferences.cancel": "取消",
  "preferences.save": "保存",
  "preferences.themeSystem": "跟随系统",
  "preferences.themeLight": "浅色",
  "preferences.themeDark": "深色",
  "preferences.themePaper": "纸张",
  "preferences.themeDusk": "黄昏",
  "preferences.langSystemOption": "系统默认",

  "menu.whyEncoding": (encoding) => `为什么是 ${encoding}？`,
  "menu.reopenWithEncoding": "以指定编码重新打开",
  "menu.saveWithEncoding": "以指定编码保存",
  "menu.convertFileToEncoding": "转换文件编码",
  "menu.compareEncodings": "比较编码…",
  "menu.viewRawBytes": "查看原始字节…",
  "menu.repairMojibake": "修复乱码…",
  "menu.lineEndingLf": "LF（Unix / macOS）",
  "menu.lineEndingCrlf": "CRLF（Windows）",
  "menu.lineEndingCr": "CR（Classic Mac）",

  "mojibake.title": "修复乱码",
  "mojibake.noCandidates": "未找到可修复的误解码模式——这看起来不像乱码。",
  "mojibake.pickCandidate": "选择要应用的修复方式：",
  "mojibake.candidateDescription": (original, intermediate) =>
    `看起来是 ${original} 的内容曾被误当作 ${intermediate} 解码。`,
  "mojibake.replacementCount": (count) => `约变更 ${count} 个字符`,
  "mojibake.before": "修复前",
  "mojibake.after": "修复后",
  "mojibake.appliedTitle": "乱码已修复",
  "mojibake.appliedMessage": "编辑器内容已修复，可撤销还原。",
  "mojibake.staleContentTitle": "未应用修复",
  "mojibake.staleContentMessage":
    "修复准备期间文档内容已变更，因此未应用——你的编辑内容已保留。请重新打开「修复乱码」再试一次。",

  "comparePreview.title": (file) => `比较编码 — ${file}`,
  "comparePreview.encodingALabel": "A",
  "comparePreview.encodingBLabel": "B",
  "comparePreview.compareButton": "比较",
  "comparePreview.malformedBadge": "解码错误",
  "comparePreview.reopenButton": "以此编码重新打开",

  "batchConvert.title": "批量转换编码",
  "batchConvert.chooseFolder": "选择文件夹…",
  "batchConvert.chooseFolderFirst": "请先选择文件夹。",
  "batchConvert.extPlaceholder": "扩展名，逗号分隔（如 txt,md）——留空表示所有文件",
  "batchConvert.targetLabel": "目标编码",
  "batchConvert.keepEncoding": "保持当前编码",
  "batchConvert.lineEndingLabel": "换行符",
  "batchConvert.lineEndingKeep": "保持不变",
  "batchConvert.scanButton": "扫描（仅预览）",
  "batchConvert.scanning": "扫描中…",
  "batchConvert.noResults": "未找到匹配的文件。",
  "batchConvert.summary": (convertible, alreadyTarget, lossy, undecodable, tooLarge, byteDrift) =>
    `可转换 ${convertible}、已是目标编码 ${alreadyTarget}、会丢失数据 ${lossy}、` +
    `无法解码 ${undecodable}、文件过大 ${tooLarge}、会字节漂移 ${byteDrift}`,
  "batchConvert.statusConvertible": "可转换",
  "batchConvert.statusAlreadyTarget": "已是目标编码",
  "batchConvert.statusLossy": "会丢失数据",
  "batchConvert.statusUndecodable": "无法解码",
  "batchConvert.statusTooLarge": "文件过大",
  "batchConvert.byteDriftBadge": "字节漂移",
  "batchConvert.byteDriftTooltip":
    "文本不会改变，但重新编码后这些字节仍会改变——非规范的旧版字节序列会被规范化。",
  "batchConvert.byteDriftTooltipConvertible":
    "换行符将按你的要求改变，但转换后这些字节还会有额外变化——非规范的旧版字节序列会被规范化。",
  "batchConvert.lineEndingMixed": "混合换行",
  "batchConvert.includeFileLabel": "包含此文件",
  "batchConvert.convertButton": (count) => `转换 ${count} 个文件`,
  "batchConvert.confirmMessage": (count) =>
    `即将就地转换 ${count} 个文件？每个文件将依报告中自动检测的编码` +
    `（Detected 列）重新编码——请先确认检测结果。此操作无法撤销。`,
  "batchConvert.confirmMessageIncomplete": (count, scanErrorCount) =>
    `即将就地转换 ${count} 个文件？另有 ${scanErrorCount} 个项目无法扫描，本报告` +
    `可能未涵盖所有文件——请先确认 Detected 列与扫描错误列表。此操作无法撤销。`,
  "batchConvert.rescanNeeded": "设置已更改——请重新扫描后再转换。",
  "batchConvert.converting": "转换中…",
  "batchConvert.resultSummary": (ok, failed) =>
    failed === 0 ? `已转换 ${ok} 个文件。` : `已转换 ${ok} 个文件，失败 ${failed} 个。`,
  "batchConvert.scanErrorsSummary": (count) =>
    `有 ${count} 个项目无法扫描——本报告可能不完整。`,

  "streamReplace.title": (file) => `在大文件中替换 — ${file}`,
  "streamReplace.searchPlaceholder": "查找…",
  "streamReplace.replacePlaceholder": "替换为…",
  "streamReplace.caseInsensitiveHint": "不区分大小写仅适用于 ASCII 字母。",
  "streamReplace.executeButton": "全部替换",
  "streamReplace.replacing": "替换中…",
  "streamReplace.resultMessage": (count) => `已替换 ${count} 处。`,
  "streamReplace.unmatchedRegionReencodedNote":
    "部分未匹配的区域因跨块纠缠被重新编码——该处可能有非规范的旧版字节序列被规范化。",
  "streamReplace.completedTabClosedMessage": "文件已更新，但其标签页已关闭——预览未刷新。",

  "streamConvert.title": (file) => `转换编码 — ${file}`,
  "streamConvert.converting": (encoding) => `正在转换为 ${encoding}…`,
  "streamConvert.resultMessage": (encoding) => `文件已转换为 ${encoding}。`,
  "streamConvert.failedMessage": "转换发生意外失败。",
  "streamConvert.completedTabClosedMessage": "文件已转换，但其标签页已关闭——预览未刷新。",

  "dialog.pagingTitle": "翻页",
  "dialog.fileChangedTitle": "文件已在磁盘上更改",
  "dialog.fileChangedMessage": (title) =>
    `“${title}”已在磁盘上更改，是否重新加载并放弃未保存的更改？`,
  "dialog.reload": "重新加载",
  "dialog.fileDeletedTitle": "文件已删除",
  "dialog.fileDeletedMessage": (title) =>
    `“${title}”已从磁盘删除。缓冲区内容仍会保留，保存即可重建文件。`,
  "dialog.staleFileMessage": (title) =>
    `“${title}”自打开后已在磁盘上更改。要覆盖为当前版本、重新加载较新的版本并放弃未保存的更改，还是取消这次保存？`,
  "dialog.overwrite": "覆盖",
  "dialog.openFailedTitle": "打开失败",
  "dialog.clearRecentFailedTitle": "清除最近打开列表失败",
  "dialog.readonlyPreviewTitle": "只读预览",
  "dialog.readonlyPreviewMessage": (title) => `“${title}”是大文件的只读预览，无法保存。`,
  "dialog.userReadOnlyTitle": "只读",
  "dialog.userReadOnlyMessage": (title) =>
    `“${title}”已设为只读，取消勾选“视图 > 只读”即可编辑。`,
  "dialog.updateInProgressTitle": "更新进行中",
  "dialog.updateInProgressMessage": "Mojidori 正在准备安装更新，目前无法编辑，请稍候。",
  "dialog.saveFailedTitle": "保存失败",
  "dialog.lossyEncodingTitle": "编码警告",
  "dialog.lossyEncodingMessage": (encoding, count) =>
    `有 ${count} 个字符无法以 ${encoding} 表示，继续保存将写入替代字符，且无法撤销。`,
  "dialog.lossyEncodingConfirm": "仍要保存",
  "dialog.lossySampleLine": (display, line, column) => `${display} — 第 ${line} 行，第 ${column} 列`,
  "dialog.lossySamplesTruncated": "还有更多不同字符未列出。",
  "dialog.backupFailedTitle": "备份写入失败",
  "dialog.backupFailedMessage": (titles) =>
    `${titles.join("、")} 的未保存更改无法写入备份（磁盘已满或文件夹` +
    `无法写入？），现在关闭的话，这些更改将无法保留。仍要关闭？`,
  "dialog.backupFailedDiscard": "放弃更改并关闭",
  "dialog.backupRestoreFailedTitle": "备份无法读取",
  "dialog.backupRestoreFailedMessage": (titles) =>
    `${titles.join("、")} 的备份无法读取，其中的未保存更改可能已丢失；如果磁盘上有文件，Mojidori 将改为打开磁盘上的版本。`,
  "dialog.orphanScanFailedTitle": "备份扫描失败",
  "dialog.orphanScanFailedMessage":
    "Mojidori 无法扫描上次会话遗留的备份。磁盘上的内容未受影响，重新启动 Mojidori 即可重试。",
  "dialog.pendingFilesFailedTitle": "无法打开指定的文件",
  "dialog.pendingFilesFailedMessage":
    "Mojidori 无法获取本次启动要求打开的文件，请改用“文件 > 打开”手动打开。",
  "dialog.unsavedChangesTitle": "未保存的更改",
  "dialog.reopenMessage": (title) => `重新打开将放弃“${title}”中未保存的更改，是否继续？`,
  "dialog.reopen": "重新打开",
  "dialog.reopenFailedTitle": "重新打开失败",
  "dialog.reopenBusyTitle": "操作进行中",
  "dialog.reopenBusyMessage": (title) => `“${title}”正在保存或重新加载，请稍候再试一次。`,
  "dialog.printTitle": "打印",
  "dialog.streamReplaceUseRegularTitle": "在大文件中替换",
  "dialog.streamReplaceUseRegularMessage":
    "这不是大文件的只读预览。请改用常规的查找和替换（Cmd/Ctrl+F）。",
  "dialog.lineIndexFailedTitle": "创建行号索引失败",
  "dialog.bookmarkNeedsGotoTitle": "位置未知",
  "dialog.bookmarkNeedsGotoMessage":
    "当前窗口在文件中的位置尚未确定。请先使用“跳转到行”跳转一次，再设置书签。",
  "dialog.normalizeConfirmTitle": (form) => `规范化为 ${form}`,
  "dialog.normalizeConfirmMessage": (count, form) =>
    `规范化为 ${form} 将更改 ${count} 处字符序列，是否继续？`,
  "dialog.normalizeConfirmButton": "规范化",
  "dialog.normalizeUnrepresentableTitle": "字符无法表示",
  "dialog.normalizeUnrepresentableMessage": (encoding, count, samples, truncated) =>
    `以 ${encoding} 保存将在规范化后丢失 ${count} 个字符：${samples.join("、")}${truncated ? " 等" : ""}。仍要规范化吗？`,
  "dialog.normalizeUnrepresentableConfirm": "仍要规范化",
  "dialog.normalizeFailedTitle": "规范化失败",
  "dialog.normalizeStaleTitle": "未应用规范化",
  "dialog.normalizeStaleMessage":
    "规范化准备期间文档内容已变更，因此未应用——你的编辑内容已保留。如仍需要，请重新执行规范化。",
  "dialog.byteDriftTitle": "字节漂移警告",
  "dialog.byteDriftMessage": (encoding) =>
    `此文件包含无法逐字节保留的 ${encoding} 字节序列，保存将把它们规范化为标准形式——` +
    `文本内容不会改变，但原始字节会丢失，且无法撤销。`,
  "dialog.byteDriftConfirm": "仍要保存",
  "dialog.preferencesSaveFailedTitle": "首选项保存失败",

  "encoding.utf8": "UTF-8",
  "encoding.utf8Bom": "UTF-8（带 BOM）",
  "encoding.utf16le": "UTF-16 LE",
  "encoding.utf16be": "UTF-16 BE",
  "encoding.big5": "Big5（繁体中文）",
  "encoding.gb18030": "GB18030（简体中文）",
  "encoding.gbk": "GBK（简体中文）",
  "encoding.shiftJis": "Shift_JIS（日文）",
  "encoding.eucJp": "EUC-JP（日文）",
  "encoding.eucKr": "EUC-KR（韩文）",
  "encoding.windows1252": "Windows-1252（西欧语系）",
  "encoding.windows1250": "Windows-1250（中欧）",
  "encoding.windows1251": "Windows-1251（西里尔文）",
  "encoding.windows1253": "Windows-1253（希腊文）",
  "encoding.windows1254": "Windows-1254（土耳其文）",
  "encoding.windows1255": "Windows-1255（希伯来文）",
  "encoding.windows1256": "Windows-1256（阿拉伯文）",
  "encoding.windows1257": "Windows-1257（波罗的海文）",
  "encoding.windows1258": "Windows-1258（越南文）",
  "encoding.iso88592": "ISO-8859-2（中欧）",
  "encoding.iso88595": "ISO-8859-5（西里尔文）",
  "encoding.iso88597": "ISO-8859-7（希腊文）",
  "encoding.iso885915": "ISO-8859-15（西欧语系，含€）",
  "encoding.koi8r": "KOI8-R（俄文）",
  "encoding.koi8u": "KOI8-U（乌克兰文）",
  "encoding.windows874": "Windows-874（泰文）",
  "encoding.macintosh": "Macintosh（Mac Roman）",

  "encodingPicker.searchPlaceholder": "搜索编码（名称或别名）…",
  "encodingPicker.noResults": "没有匹配的编码",

  "encoding.group.unicode": "Unicode",
  "encoding.group.eastAsian": "东亚",
  "encoding.group.westernEuropean": "西欧",
  "encoding.group.centralEuropean": "中欧",
  "encoding.group.cyrillic": "西里尔",
  "encoding.group.other": "其他",

  "updater.availableTitle": "有可用更新",
  "updater.availableMessage": (version) =>
    `Mojidori ${version} 已可更新。重新启动前，任何未保存的更改都会自动备份。`,
  "updater.downloadAndRestart": "下载并重新启动",
  "updater.later": "稍后",
  "updater.downloadFailedTitle": "更新失败",
  "updater.downloadFailedMessage": "无法下载更新，请稍后重试。",
  "updater.checkFailedTitle": "检查更新失败",
  "updater.checkFailedMessage": "无法检查更新，请确认网络连接。",
  "updater.checkInProgressTitle": "检查进行中",
  "updater.checkInProgressMessage": "已有更新检查正在进行，请稍候。",
  "updater.upToDateTitle": "已是最新版本",
  "updater.upToDateMessage": "Mojidori 当前已是最新版本。",
  "updater.flushFailedTitle": "备份失败",
  "updater.flushFailedMessage":
    "部分未保存的更改在安装此更新前无法备份，安装后 Mojidori 会重新启动。您可以仍然安装，或取消并先保存您的工作——下次 Mojidori 检查更新时会再次询问。",
  "updater.installAnyway": "仍然安装",
  "updater.cancelInstall": "取消",
  "updater.installFailedTitle": "更新失败",
  "updater.installFailedMessage": "无法安装更新，请稍后重试。",

  "common.loading": "加载中…",
};

const dictionaries: Record<Locale, Messages> = {
  en,
  "zh-TW": zhTW,
  ja,
  "zh-CN": zhCN,
};

/**
 * Resolve a BCP-47 language tag (e.g. `navigator.language`) to a supported
 * `Locale`. "ja"/"ja-*" tags resolve to `ja`. Chinese tags split by script:
 * Traditional-Chinese-bearing tags ("zh-TW", anything containing "Hant",
 * "zh-HK", "zh-MO") resolve to `zh-TW`; Simplified-Chinese-bearing tags
 * ("zh-CN", anything containing "Hans", "zh-SG") resolve to `zh-CN`. A bare
 * "zh" with no script/region hint, and every other language, falls back to
 * English rather than guessing a script.
 */
export function resolveSystemLocale(tag: string | undefined | null): Locale {
  const lang = (tag ?? "").toLowerCase();
  if (lang === "ja" || lang.startsWith("ja-")) return "ja";
  if (!lang.startsWith("zh")) return "en";
  if (lang === "zh-tw" || lang.includes("hant") || lang === "zh-hk" || lang === "zh-mo") {
    return "zh-TW";
  }
  if (lang === "zh-cn" || lang.includes("hans") || lang === "zh-sg") {
    return "zh-CN";
  }
  return "en";
}

/**
 * Resolve a stored language preference ("system" | "en" | "zh-TW" | "ja" |
 * "zh-CN") to an effective `Locale`, following the system locale for
 * "system" or any unrecognized value (forward-compatible default for prefs
 * written by a future build).
 */
export function effectiveLocale(pref: string, systemTag?: string | null): Locale {
  if (pref === "en" || pref === "zh-TW" || pref === "ja" || pref === "zh-CN") return pref;
  return resolveSystemLocale(
    systemTag ?? (typeof navigator !== "undefined" ? navigator.language : undefined),
  );
}

let currentLocale: Locale = resolveSystemLocale(
  typeof navigator !== "undefined" ? navigator.language : undefined,
);

type LocaleListener = () => void;
const listeners = new Set<LocaleListener>();

export function getLocale(): Locale {
  return currentLocale;
}

/** Set the active locale and notify subscribers so live UI can redraw. */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function onLocaleChange(listener: LocaleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Args<K extends keyof Messages> = Messages[K] extends (...a: infer A) => string
  ? A
  : [];

/** Look up and (if templated) interpolate a UI string in the active locale. */
export function t<K extends keyof Messages>(key: K, ...args: Args<K>): string {
  const entry = dictionaries[currentLocale][key];
  if (typeof entry === "function") {
    return (entry as unknown as (...a: Args<K>) => string)(...args);
  }
  return entry as string;
}
