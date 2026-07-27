# Changelog

All notable changes to Mojidori are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Mojidori is pre-1.0 (alpha); version numbers do not yet carry strict
Semantic Versioning compatibility guarantees.

## [v0.9.0-alpha.1] - 2026-07-28

### Added

- Mojibake repair wizard: three new repair pairs (repair table 15 → 18
  candidates): windows-1256 (Arabic), windows-1258 (Vietnamese), and
  windows-1253 (Greek), each misread as UTF-8 — admitted only after the
  same reachability, reverse-hypothesis, and aggregate ranking-regression
  gates as every existing pair, independently re-derived by a separate
  harness plus a critic review before merge (#335).
- Replace in Selection / Replace All in Selection now disclose when a
  normalization-equivalent match was skipped rather than replaced: a
  dialog reports the replaced and skipped counts. A one-shot Replace
  All reports immediately whenever anything was skipped; a single-step
  Replace only reports once that step can no longer replace anything
  further, so stepping through repeated matches one at a time no
  longer pops the dialog on every click (a duplicate-disclosure defect
  caught by review before merge) (#292 follow-up).

### Fixed

- Update-check errors now split into three buckets in all four
  locales — a network-layer problem, "no update information is
  currently available" (covers a 404 or any other non-2xx response,
  which previously and incorrectly surfaced as a network-connectivity
  message), and a generic fallback — pinned by a Rust-side test against
  the upstream error string so an unpinned `tauri-plugin-updater` bump
  cannot silently regress the classification (#332, fixes #330).
- The search match the cursor jumps to is readable again: the previous
  fully opaque highlight (reported by a WKWebView user as making the
  matched text completely invisible) is now transparent, relying on
  the same translucent selection fill every ordinary text selection
  already uses, with the match's own foreground color forced to the
  plain document text color so it stays legible even when the match
  lands inside dim syntax-highlighted text such as a comment (#333,
  refs #329; visual acceptance on both WebViews stays with the user).
- Replace in Selection and Replace All in Selection now apply to
  matches that only exist under Unicode normalization (previously
  skipped by design) — ported from CodeMirror's own `SearchCursor`
  precise-match automaton and merge-gated on a differential property
  sweep against the real upstream implementation (closes #292).
  Incidental fixes bundled with the same change: a pre-existing
  synchronous infinite loop in one of the replace paths, and a
  regression-test time budget that had been silently counting esbuild
  bundling overhead against its limit, causing an intermittent flake
  that had once misfired against unrelated Windows CI (#320).

### Known limitations

- #333's fix is verified structurally and by unit test only; visual
  confirmation on both WebViews (WKWebView / WebView2) across all four
  themes is deferred to the user's next hands-on session.

## [v0.8.0-alpha.1] - 2026-07-24

### Added

- Official product name: Mojidori (the "Plume" working name is retired
  to history; it is no longer used in user-facing text). The bundle
  identifier changed from `app.plume.editor` to `app.mojidori.editor`
  across every platform, along with the window title, IPC event
  namespace, and internal crate name (#307, #308).
- A one-time, crash-safe migration moves an existing config directory
  to the new identifier's location on first launch: staged with a
  `.partial` directory and verified before an atomic rename, guarded
  by a durable completion marker so a failed or interrupted attempt is
  retried correctly rather than silently skipped or repeated. If the
  new directory already has some content (e.g. from a partial prior
  attempt), recovery merges in only the items still missing, never
  overwriting anything already there, and rolls back only what it
  copied on failure. Copies preserve source file permissions and are
  fsync'd before the directory is renamed; an OS-level lock prevents
  two launches from migrating concurrently. The old directory is kept
  alongside as a `.migrated` backup rather than deleted (#307, #311).
- Auto-update: Mojidori checks for new releases silently on startup
  and via File > Check for Updates, prompts before downloading, and
  relaunches after installing. The release pipeline signs and
  notarizes macOS builds and publishes updater feed files from a
  rolling `updater` release tag; every tag push produces a draft
  release for manual review before publishing (#309).
- Update-time data safety: the editor freezes against further edits
  while the final pre-restart flush is in progress, funneled through
  one mutation guard shared by every input path (typing, line-ending
  and encoding pickers, mojibake/normalize wizards, and more) so none
  of them can slip a change past the flush; the flush itself is
  serialized with any other in-flight save so the two can't race (#309).

### Known limitations

- Search history does not carry over from Plume to Mojidori: it lives
  in the WebView's per-origin storage, which is keyed by the bundle
  identifier and is not part of the migrated config directory.
- Close the old Plume build before launching Mojidori for the first
  time — the two are not aware of each other's file locks, so running
  both against the same config directory at once is not serialized.
- The updater compares version numbers, so two alpha builds sharing
  the same version (e.g. two re-releases of an `-alpha.1`) will not
  trigger an update between them; only an actual version bump does.

## [v0.7.0-alpha.1] - 2026-07-19

### Added

- Replace in Selection and Replace All in Selection (Edit menu +
  command palette): scoped replace driven by the find panel's current
  query — matches are confined to the selection, multi-range selections
  are handled independently, and regexp group replacement follows the
  find panel's own semantics. One known, deliberately safe divergence:
  matches that only exist under Unicode normalization are skipped
  rather than replaced (#292).
- Trim trailing whitespace on save: an opt-in preference (default off).
  The trim is applied to the live buffer right before the write, so the
  buffer and the file on disk never diverge; undoing after a save
  reverts the trim as its own step.
- Encoding-picker search with alias support in all three encoding menus
  (reopen / save-with / convert-to): typing an informal or historical
  name — latin1, cp950, gb2312, ucs-2, and 70+ more, each verified
  against the encoding standard's own label registry — finds the right
  encoding. Typing "ansi" deliberately lists all five regional
  system-code-page candidates (windows-1252, Big5, Shift_JIS, GBK,
  EUC-KR) instead of guessing one.
- Insert Date/Time (Edit menu): inserts a localized timestamp at the
  caret.
- Go to Matching Bracket now has a menu entry and palette command (the
  keyboard shortcut always existed).
- Five new mojibake-repair hypotheses (repair table 10 → 15 pairs):
  UTF-8 misread as windows-1251, EUC-KR, EUC-JP, or windows-1250, and
  windows-1251 misread as KOI8-U — each admitted only after the same
  reachability + reverse-hypothesis gates as the existing pairs, with
  45,000 fuzz round-trip checks.
- A file deleted on disk while open is now visible: a status-bar
  "missing on disk" hint replaces the previous silence for unmodified
  tabs, and the change prompt for modified tabs says plainly that the
  file was removed (saving recreates it) instead of offering a reload
  that would do nothing.
- Keyboard-shortcut reference: docs/features.md now ends with a
  consolidated, source-verified table of every shortcut on both
  platforms.

### Fixed

- A clean document's Save with Encoding no longer leaves a stray
  "unsaved changes" marker when the write fails for a reason other than
  external modification; real unsaved edits and their hot-exit backup
  are never touched by that cleanup (#231).
- Document Info now reads all three sections (metadata, detection
  evidence, line-ending distribution) from a single file open, so an
  external modification mid-dialog can no longer produce a
  self-contradictory snapshot (#254).
- Preferences and session writes are serialized per file: rapid
  consecutive changes can no longer land out of order and resurrect a
  stale snapshot (the same class of race fixed for recent files in
  v0.6).
- Switching the UI language at runtime now relabels the Go to Matching
  Bracket menu item like every other entry (#289).

### Internal

- Per-process temp-directory isolation for all remaining test fixtures;
  dedicated corruption-regression tests for the session, preferences,
  and recent-files stores; CONTRIBUTING.md rewritten to match the
  project's actual conventions; routine cargo-lockfile refresh.

## [v0.6.0-alpha.1] - 2026-07-17

### Added

- Document Info dialog (File > Document Info): a read-only view of a
  file's facts — size and modified time, encoding with the detection
  evidence behind it, BOM, line-ending distribution (LF / CRLF / CR
  counts), and text stats. For files beyond 10 MB, the line-ending count
  is clearly labeled as scanned from a leading sample rather than shown
  as an unlabeled partial total.
- Command Palette (Mod+Shift+P): a fuzzy-searchable list of every menu
  command, for fast keyboard-driven access without hunting through
  menus.
- Two new Line Operations: Join Lines and Reverse Lines.
- Two new sort variants for Line Operations: case-insensitive sort and
  numeric sort (sorts by the first number found in each line).
- Clear Recently Opened (File menu): empties the recent-files list; the
  item enables and disables itself as the list fills and empties.
- Mojibake repair wizard: added a windows-1252 ⇄ EUC-JP repair
  hypothesis.
- Encoding-detection diagnostics now disclose when a verdict for a large
  file was based on a truncated sample rather than the whole file.
- A features guide (docs/features.md) documenting every encoding and
  large-file tool, and this changelog.

### Fixed

- Excluded ISO-2022-JP from large-file chunk paging: paging to a new
  chunk reset the decoder's shift-state, which could silently misread
  Japanese two-byte text as plain ASCII; also corrected cross-page
  boundary trimming for other legacy multi-byte encodings.
- Closed a cluster of save/reload race conditions: Save with Encoding,
  deferred saves, and reload/reopen confirmations could apply to the
  wrong tab, drop a pending save, misjudge read-only state, or reuse a
  stale encoding after concurrent edits, tab switches, or external file
  changes landed mid-operation.
- Find in Files: malformed decodes are now surfaced instead of silently
  treated as clean results, stale results from a superseded search are
  discarded, and per-file reads are bounded with scan errors surfaced
  instead of skipped silently.
- Four previously-silent failure paths now tell the user what happened:
  an unreadable hot-exit backup, a failed orphan-backup scan, files
  passed from the OS that could not be taken over, and a Preferences
  save failure (the dialog now stays open for a retry instead of
  closing as if it had succeeded).

## [v0.5.0-alpha.2] - 2026-07-16

### Fixed

- Save with Encoding no longer misjudges a file after an
  external-change-triggered reload while the new encoding hasn't been
  written yet.
- Toggling line-ending settings mid-save is no longer misreported as
  saved.
- Content typed while waiting on a Reload / Reopen with Encoding
  confirmation is no longer silently overwritten — the app now always
  asks.
- Unicode Normalize no longer applies to the wrong tab or overwrites
  newer edits if the tab is switched or edited again while its
  confirmation is pending.
- Find in Files line numbers and jump-to-line are now correct for
  Classic Mac (CR-only line ending) files.
- Large-file conversion and replace operations now correctly refresh or
  notify a tab that was closed while the operation was running.
- Line-ending changes are now reflected immediately in the title bar and
  included in hot-exit backups.
- Explicit legacy-encoding (e.g. Big5) large-file preview windows no
  longer misreport malformed bytes at the window boundary.
- Find in Files and Replace in Files now honor the per-extension
  default-encoding preference.
- Batch conversion reports now flag byte drift on files where only the
  line ending changed.
- Large-file replace completion messages now explain when an unmatched
  region was re-encoded for technical reasons.

### Added

- Mojibake repair wizard: added a Cyrillic misdetection hypothesis
  (windows-1251 opened as KOI8-R).

## [v0.5.0-alpha.1] - 2026-07-15

### Added

- Replace in Files: folder-scoped search and replace, with a dry-run
  preview (per-file hit counts, encoding, and risk flags), per-file
  checkboxes, and a strong confirmation before the destructive apply
  step. Only lines that actually change are re-encoded; every other
  line, including its original line ending, is preserved byte-for-byte.
- Encoding picker expanded from 11 to 27 entries: the windows-125x
  family, common ISO-8859 members, KOI8-R/U, windows-874 (Thai), and Mac
  Roman, presented in grouped sections.
- Reopen closed tab (Mod+Shift+T), restoring cursor position, with a
  per-session stack.
- Tab context menu: Close Others, Close to the Right, Copy Path, and
  Reveal in Finder/Explorer.
- Go to Line now accepts a `line:column` syntax, including in large-file
  mode.
- Find/replace history now covers the Find in Files panel as well.
- New `docs/encoding-detection.md` explaining which encodings can be
  auto-detected versus require manual selection; the detection
  diagnostics popup links to it.
- README gained an Install section, including instructions for the
  unsigned build.
- A chunk-paging property-based fuzz test now guards large-file offset
  arithmetic against regressions.

### Fixed

- Closed the remaining gaps in save-path byte fidelity, delivered in
  three stages: unmatched regions in large-file streaming replace are
  now preserved byte-for-byte instead of being silently re-encoded; a
  file containing legacy byte sequences that can't round-trip
  byte-for-byte now gets a one-time, informed confirmation before the
  first save; batch conversion's dry-run report flags files that would
  drift at the byte level even when the conversion is otherwise a no-op.
- Saving and an external-change reload no longer interfere with each
  other — a save in flight and a reload/second save now queue correctly
  instead of producing an orphaned backup or a false "changed on disk"
  warning.
- Large-file paging and go-to-line jumps no longer silently fail while a
  background chunk load is in flight.
- Fixed false decode-error reports at large-file preview window
  boundaries when an explicit UTF-8 encoding is selected.
- Batch scan and Find in Files no longer swallow directory-walk errors —
  unreadable subtrees are now reported instead of silently skipped.

## [v0.4.0-alpha.1] - 2026-07-15

### Added

- Character inspector: a status-bar codepoint (U+XXXX) readout for the
  character at the cursor, with a popup showing its actual byte sequence
  under the file's save encoding.
- Invisible/ambiguous character audit: highlights bidi control
  characters, zero-width characters, NBSP variants, and in-body BOMs,
  with a status-bar count and a View-menu toggle.
- Unicode normalization: non-NFC detection plus a Normalize to NFC/NFD
  command that previews the number of affected sequences and verifies
  the result stays representable in the file's save encoding first —
  normalization can never set up a lossy save.
- Lossy-save character preview: when a save is rejected because some
  characters can't be encoded, the dialog now lists which characters and
  where, not just a bare warning.
- Full-width to half-width conversion and back, scoped to the current
  selection (Edit menu).
- Streaming encoding conversion for large files (over 10 MB): convert in
  place with an atomic write and the same two-stage lossy-save
  confirmation as a normal save.
- Multi-cursor commands (Select Next/All Occurrences) exposed in the
  Edit menu.
- Line move up/down, duplicate, and delete exposed in the Edit menu.
- Word/character/line count in the status bar — selection-aware and
  CJK-aware, hidden in large-file preview windows.
- Tab drag-to-reorder.
- Per-tab read-only mode (View menu and status-bar indicator).
- Indentation tools: detected indentation style (tabs vs. spaces, width)
  shown in the status bar, and Edit-menu commands to convert leading
  tabs ⇄ spaces.
- Expanded round-trip fuzz testing across all ten supported encodings,
  plus mojibake-repair reversibility fuzzing.

### Fixed

- Saves now validate a commit-time file fingerprint first, so an
  externally modified file can no longer be silently overwritten by a
  stale in-memory copy — applied consistently across normal save, batch
  conversion, and streaming replace.
- Edits made while a save is still in flight now correctly keep the tab
  marked dirty instead of being marked saved prematurely.
- Reload and reopen-with-encoding now drop the tab's hot-exit backup
  once its buffer is replaced by on-disk content, so a previously
  discarded edit can no longer resurface as a spurious dirty tab after a
  relaunch.
- Batch conversion's file-size guard is no longer a check-then-read
  race — the actual bytes read are now capped regardless of how much the
  file grows after the check.
- Batch scan and streaming operations no longer skip content on a line
  that exceeds the paging chunk size, and no longer silently swallow
  unreadable-subdirectory errors.
- Unified line-boundary handling (LF / CRLF / lone CR) between the
  large-file line index and chunk-paging alignment, fixing incorrect
  go-to-line, bookmark, and paging behavior in Classic Mac and
  mixed-line-ending files.
- Large-file chunk responses are now generation-guarded, so a slow or
  superseded paging/goto/bookmark response can no longer clobber the
  buffer with stale content after a newer request or a reload.

## [v0.3.0-alpha.1] - 2026-07-12

### Added

- Mojibake repair wizard: detects common mis-decode round-trips and
  offers a previewed, reversible repair.
- Batch encoding conversion for a folder, with a dry-run report before
  any file is written and atomic per-file saves; batch line-ending
  conversion rides the same UI.
- Side-by-side encoding preview: the same bytes decoded under two
  candidate encodings, for manual disambiguation.
- Streaming find/replace inside large-file windows, searching and
  replacing across the full file.
- Line-offset index for large files, enabling fast go-to-line and
  bookmarks beyond the currently loaded window.
- Code folding.
- Line operations (Edit menu): sort, unique, trim trailing whitespace,
  and upper/lower case conversion.
- Indent guides.
- Issue templates, labels, and a good-first-issue starter set for
  contributors.
- Japanese (ja) and Simplified Chinese (zh-CN) UI translations.

### Fixed

- A save with characters that can't be represented in the target
  encoding now requires explicit confirmation before anything is
  written, instead of writing a partially-lossy file.
- Open and file-diagnostics commands no longer read an entire large file
  into memory.
- Fixed a UTF-16 large-file preview truncation bug that produced a false
  decode warning.
- A per-extension UTF-16 encoding preference could incorrectly hijack
  legitimate UTF-8/ASCII content; fixed.
- Session index writes are now atomic, with orphaned hot-exit backups
  recovered instead of lost.
- A hot-exit backup write failure no longer silently allows the window
  to close.

### Security

- Atomic saves now create their temp file with an exclusive-create
  flag, closing a symlink pre-planting attack on the save path.

## [v0.2.0-alpha.1] - 2026-07-10

### Added

- Full visual refresh: a semantic design-token system (color, spacing,
  radius, shadow, type scale) driving both the UI chrome and a new
  token-based CodeMirror editor theme.
- Built-in theme system (paper and dusk, alongside the existing
  light/dark/system options), switchable from the View menu.
- UI translated to Traditional Chinese (zh-TW first), including native
  menus, with English fallback following the system locale.
- Show Invisibles toggle (spaces, tabs, and end-of-line marks), View
  menu.
- Hex/bytes preview for undecodable files, offered from the
  decode-warning UI.
- Per-extension default encoding preference (falls back when detection
  isn't confident).
- Find/replace history dropdown.
- Encoding-detection diagnostics: a status-bar popup explaining the
  evidence behind a detected encoding (BOM found, statistical verdict).
- Startup-time budget script for tracking cold-start regressions
  locally.

### Fixed

- Selection contrast and markup syntax highlighting corrected on
  WKWebView (macOS).

## [v0.1.0-alpha.7] - 2026-06-13

### Added

- Hot exit: unsaved buffers, including untitled tabs, are backed up
  continuously; closing the window never asks about unsaved changes,
  and content, tab titles, cursor position, and encoding settings are
  all restored on the next launch.
- Large-file paging: chunked navigation via status-bar Prev/Next
  controls, forward continuous-scroll auto-loading, and bidirectional
  continuous scrolling with a constant ~16 MB sliding window.
- Atomic saves (temp file + rename) — an interrupted save can no longer
  leave a corrupted file.
- Printing, via a native print dialog and a full-document print view.
- Regex mode for Find in Files.
- Word wrap toggle (View menu, persisted preference).
- Editor zoom shortcuts (Zoom In / Out / Actual Size).
- A Save option in the close-tab confirmation (Save / Don't Save /
  Cancel).
- Window size and position are now remembered across launches.
- Session restore now includes per-file cursor position.

## [v0.1.0-alpha.1] - 2026-06-12

### Added

- Multi-tab editing: open, save, and save-as, with an unsaved-changes
  indicator and close confirmation.
- Automatic encoding detection (BOM sniffing plus statistical
  detection) covering UTF-8, UTF-8 BOM, UTF-16 LE/BE, Big5, Shift_JIS,
  GB18030, and more.
- Decode-error surfacing — malformed text is never silently rendered as
  if it were fine.
- Reopen and Save with an explicitly chosen encoding, including a BOM
  toggle.
- Line-ending detection (LF / CRLF / Mixed), with display and
  conversion.
- Syntax highlighting, loaded on demand per language.
- Find/replace with regex support, and encoding-aware find in files.
- Go to Line, session restore on launch, and a recent-files quick-open
  panel (Mod+P).
- Native macOS menu bar and Windows menu, with platform-correct
  keyboard shortcuts.
- Preferences: font, font size, theme (system/light/dark), and default
  encoding for new files.
- File-association ("Open with") registration, command-line file
  opening, and single-instance forwarding.
- Auto-reload when an open file changes on disk, with a confirmation
  prompt if the tab has unsaved changes.
- Read-only preview mode for files over 10 MB, avoiding WebView freezes
  and accidental overwrites of huge files.

[Unreleased]: https://github.com/hungchenhsu/mojidori/compare/v0.9.0-alpha.1...HEAD
[v0.9.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.8.0-alpha.1...v0.9.0-alpha.1
[v0.8.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.7.0-alpha.1...v0.8.0-alpha.1
[v0.7.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.6.0-alpha.1...v0.7.0-alpha.1
[v0.6.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.5.0-alpha.2...v0.6.0-alpha.1
[v0.5.0-alpha.2]: https://github.com/hungchenhsu/mojidori/compare/v0.5.0-alpha.1...v0.5.0-alpha.2
[v0.5.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.4.0-alpha.1...v0.5.0-alpha.1
[v0.4.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.3.0-alpha.1...v0.4.0-alpha.1
[v0.3.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.2.0-alpha.1...v0.3.0-alpha.1
[v0.2.0-alpha.1]: https://github.com/hungchenhsu/mojidori/compare/v0.1.0-alpha.7...v0.2.0-alpha.1
[v0.1.0-alpha.7]: https://github.com/hungchenhsu/mojidori/compare/v0.1.0-alpha.1...v0.1.0-alpha.7
[v0.1.0-alpha.1]: https://github.com/hungchenhsu/mojidori/releases/tag/v0.1.0-alpha.1
