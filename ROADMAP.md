# Roadmap

This is the execution queue only. Strategy, decision gates, phase plan,
scenario playbook, and the pre-triage feature backlog live in
[DIRECTION.md](DIRECTION.md) — items are promoted from there into this
file once the user signs off. Completed cycles' full item-level record
(design rationale, edge cases, test evidence — everything trimmed out of
the summaries below) lives in
[docs/archive/roadmap-completed-cycles.md](docs/archive/roadmap-completed-cycles.md).

This roadmap is deliberately narrow. The goal of v0.1 is a tool you can genuinely use every day to open, read, and edit text files — not half an IDE.

## North star

> Open a text file faster than an IDE. Handle legacy encodings more reliably than most modern editors. Feel native on macOS — and on Windows.

## Completed cycles

Summary index only — every item's full design rationale, edge cases,
and test evidence is archived verbatim in
[docs/archive/roadmap-completed-cycles.md](docs/archive/roadmap-completed-cycles.md).
Item counts below are shipped `[x]` items per cycle.

- **v0.1 — MVP + Post-MVP candidates** (16 items, 2026-06, tags
  `v0.1.0-alpha.1` → `v0.1.0-alpha.7`): multi-tab editing; full encoding
  detection/reopen/save-with-encoding/BOM/line-ending handling; regex
  find/replace; session restore; native macOS/Windows menus and file
  association. Post-MVP: large-file mode (phases 1-2b), find in files,
  recent files/quick open, column selection, drag-and-drop open,
  auto-reload, printing.
- **v0.2 — polish + feature cycle** (18 items, approved 2026-07-10, tag
  `v0.2.0-alpha.1`): atomic saves, hot exit, cursor/window persistence,
  large-file phase 2c, full visual refresh (design-token system); theme
  system, zh-TW i18n, show-invisibles, hex/bytes preview, per-extension
  default encoding, find/replace history, startup-time budget test,
  encoding-detection diagnostics.
- **v0.3 — feature cycle, four tracks** (12 items done + 2 open, approved
  2026-07-11, tag `v0.3.0-alpha.1`): Track A encoding tools (mojibake
  repair wizard, batch encoding/line-ending conversion, side-by-side
  encoding preview); Track B large-file streaming find/replace +
  line-offset index; Track C code folding/line operations/indent guides;
  Track D issue templates + ja/zh-CN i18n — D1/D2 (naming, signing +
  auto-update) were carried forward and subsequently delivered in the
  v0.8 cycle (see the v0.8 entry below); Windows signing remains open,
  see DIRECTION.md §3/D2.
- **v0.4 — character-level trust** (26 items, planned 2026-07-14,
  delegated, tag `v0.4.0-alpha.1`): character inspector,
  suspicious-character audit, full/half-width conversion, Unicode
  NFC/NFD normalization, lossy-save character preview (all [danger]);
  streaming encoding conversion for large files; multi-cursor, per-tab
  read-only mode, tab drag-to-reorder, indentation tools; fsguard
  fingerprint guards, save-completion revision gating, CR-only
  line-ending fixes, chunk-generation race guards. Ended at 333 Rust /
  572 frontend tests.
- **v0.5 — byte-fidelity + replace-in-files** (21 items across five
  tracks, planned 2026-07-15, delegated, tags `v0.5.0-alpha.1` /
  `v0.5.0-alpha.2`): byte-passthrough streaming replace + lazy
  byte-drift detection (#96, 3 stages); new replace-in-files capability
  (Rust backend + panel UI); encoding breadth 11→27 curated encodings
  with a grouped picker; reopen-closed tab, tab context menu, go-to
  line:column; README install section. Six issues closed, six
  follow-ups filed, tests 333/572 → 423/763.
- **v0.7 — consistency, serialization & daily-driver closure** (16
  items across five tracks + close-out, planned 2026-07-18, delegated,
  tag `v0.7.0-alpha.1`): inherited issues closed (#231 spurious dirty,
  #254 one-open Document Info snapshot, #236 fixture isolation);
  prefs/session write serialization; five new mojibake pairs (10→15)
  via the dual-gate investigation batch; replace in selection,
  trim-on-save, encoding-picker alias search, insert date/time,
  matching-bracket menu entry; external-delete visibility; per-module
  corruption tests; shortcut reference + CONTRIBUTING rewrite. PRs
  #273–#297, tests 987/532 → 1117/576 (vitest/cargo). Built under a
  no-GUI constraint: dual-WebView manual acceptance for the two
  editor-UX items is deferred to the user's return.
- **v0.6 — bug queue + trust visibility** (19 items across five tracks,
  planned 2026-07-16, delegated, tag `v0.6.0-alpha.1`): inherited bug
  queue closed (#201/#203/#217/#221/#223/#225/#227); Document Info
  dialog, EUC-JP ⇄ windows-1252 mojibake pair; command palette,
  join/reverse lines, sort variants, clear recent files; session
  forward-compat fixtures, IPC error-path audit; CHANGELOG backfill,
  docs/features.md. 20 PRs (#229–#249 range), ended at 522 cargo test /
  955 vitest.
- **v0.8 — official naming + release pipeline** (PRs #307–#312,
  2026-07-23, tag `v0.8.0-alpha.1`, draft at cycle close; published 2026-07-28): D1 official
  name decided (**Mojidori**) and applied — bundle identifier, window
  title, IPC event namespace, and crate name renamed across every
  platform, with a crash-safe one-time config-directory migration
  (durable completion marker, staged `.partial` directory + atomic
  rename, merge-recovery for a partial prior attempt, fsync, OS-level
  lock against concurrent launches, old directory kept as a
  `.migrated` backup). D2 signing + auto-update pipeline: macOS
  arm64/x64 builds signed and notarized on tag push,
  `tauri-plugin-updater` wired in with a silent startup check and a
  manual File > Check for Updates, the pre-restart flush funneled
  through one shared mutation guard so no input path can slip a
  change past it, and a rolling `updater` release tag configured to
  serve the update feed — inactive at cycle close because the feed-publish
  workflow only runs on a `release: published` event. Both v0.8/v0.9
  were subsequently published; see DIRECTION §2 for the verified snapshot.
  Every tag push opens a draft release for manual publish.
  Follow-up migration hardening landed in the same cycle (#311).
  Then a 2026-07-26→27 issue-clearing sweep (PRs #313–#328, not a
  checkbox cycle): CI third-party actions pinned to SHA with minimized
  permissions (#313); macOS single-instance enforcement so a second
  launch can't clobber session/preferences state (#315); an explicit
  CSP replacing `security.csp: null` (#316); save-to-symlink no longer
  replaces the link with a regular file (#317); two
  replace-in-selection correctness fixes — unquoted plain-string
  matches and a zero-length regexp match looping forever on astral
  characters (#318, #327); two external-change/save interaction edge
  cases, the #302 suppression window and #276 stale→cancel mislabeling
  a doc clean (#319); a saveDialog-rejection path that escaped the save
  error boundary and stranded a queued save (#326); and convergence of
  the save path onto a single durable, provenance-bound atomic-commit
  primitive (#328). D2's Windows signing decision and the updater's
  same-version-never-updates limitation remain open — see DIRECTION
  §3/D2.

127 items shipped across the v0.1–v0.7 checkbox cycles above, plus the
v0.8 cycle (PRs #307–#312) and the 2026-07-26 issue sweep (PRs
#313–#328) — neither of the latter two is a checkbox cycle, so their
work is not folded into the 127 count. D1 (naming) is fully delivered;
D2 (signing + auto-update) is delivered for macOS, with the Windows
signing sub-decision still open — see the v0.8 entry above and
DIRECTION §3/D2.
- **v0.9 — trust deepening + issue closure** (delegated, planned
  2026-07-27, PRs #331–#335 + #340 plus close-out; tag
  `v0.9.0-alpha.1`): #329 unreadable jumped-to search match fixed with
  a fail-first regression test after the issue's original two
  hypotheses were falsified in pre-cycle review; #330 update-check
  error message split three ways and pinned against the upstream error
  string; mojibake `REPAIR_PAIRS` 15→18 (windows-1256/1258/1253 ×
  UTF-8) behind a three-gate admission process (reachability +
  reverse-hypothesis + aggregate ranking-regression), independently
  re-derived by a separate harness and critic-reviewed before merge;
  #292 closed in two PRs — a NFKD normalized-match replace engine
  ported from CodeMirror's own `SearchCursor` automaton, merge-gated on
  a 13,500-case differential property sweep against the real upstream
  implementation (which also surfaced and fixed a pre-existing
  synchronous infinite loop and a regression-test time budget that had
  been silently counting esbuild bundling overhead), plus a follow-up
  (C2) disclosing replaced/skipped counts, where a second Codex review
  round caught and fixed a duplicate-dialog defect on repeated
  single-step Replace before merge; #280 rename-watch probe escalated
  the issue to P2 after CI measurement on both Tier-1 platforms; two
  decision-prep research findings posted (#314 CSP nonce, #303
  trim-on-save contract). New issues filed: #336 (mojibake dead entry),
  #337 (NFKD scan performance), #338 (mojibake false-positive
  category), #339 (glib advisory, Linux Tier-2-only). Full record: see
  the v0.9 entry in
  [docs/archive/roadmap-completed-cycles.md](docs/archive/roadmap-completed-cycles.md).

## Current repair pass (2026-09-20)

The user asked to resume the project plan and reported a selection jump
when copying with macOS Command+C. Prioritize this daily-use regression,
then the existing P2 correctness queue; keep each fix independently reviewable.

- [ ] Diagnose and fix Command+C expanding/jumping the selection.
  **Not reproduced; not fixed.** The user clarified the trigger as a
  double-click selecting a word, immediately followed by Command+C, possibly
  in Markdown or JSON. Ordinary small files are affected; clipboard contents
  during the original failure remain unknown. On 2026-09-20 the user
  explicitly authorized GUI testing, overriding DIRECTION's no-GUI limit
  for this investigation. An isolated debug app (separate identifier/config,
  native WKWebView at `tauri://localhost`, 1080x720) exercised temporary txt,
  md, and json fixtures with CJK/English/emoji, syntax highlighting, long
  wrapped lines, and mid-document/bottom-of-viewport selection. No selection
  expansion or copy-induced scroll jump was observed. Double-click cases
  included Markdown bold/inline code and JSON property names/string values.
  Pasting the txt keyboard-selected range and Markdown double-clicked word
  into scratch tabs returned the expected 150 and 14 characters respectively.
  A temporary in-memory event trace also showed a txt Copy event with equal
  editor/native selected text (`ABC`). Automated drag gestures failed to
  establish a range (observed mouse events had `buttons: 0`), so they are
  not drag-selection acceptance evidence. Windows remains untested.
  Follow-up: a user-nominated 141,457-byte, 99-record JSONL file was
  copied to a temporary path and opened through the app's existing drop
  event in DevTools (the native open panel left Open disabled for that
  suffix). Double-click/Copy at line 1's field name and three wrapped-line
  positions, plus line 50's field name, did not reproduce the expansion.
  The last copied field name pasted as the expected 10 characters. JSONL
  currently has no language-data extension mapping, unlike JSON. No file
  contents/contact details were recorded here. The original and temporary
  copy matched byte-for-byte at cleanup; the copy was removed and the
  isolated app quit. This is non-reproduction evidence, not a resolved bug.
  No speculative clipboard patch was made. Next recurrence should retain
  the exact file/word, copy-before/after selection, and pasted text; reproduce
  on a temporary copy of that file before changing the handler.
- [x] Fix #344: repeated Replace in Selection must advance past inserted
  text, including identical/self-containing replacements, and disclose
  skipped non-precise matches once at exhaustion. Preserve scope and
  multi-range ownership; reset progress on query/selection/document changes
  and tab switches. Zero-length regex and Unicode boundaries are covered.
  Local validation: build, 1,286 frontend tests, cargo fmt/clippy, and
  664 Rust tests passed (3 ignored). The first Rust run hit sandbox socket
  restrictions; the full rerun with local sockets enabled passed.
  Native WKWebView/WebView2 manual acceptance remains outstanding.
- [x] Fix #343: updater feed publication ordering race. `updater-json.yml`
  now serializes runs in a `concurrency` group, syncs the feed to the
  newest published release (by tag semver) that carries a latest.json
  rather than to the triggering release, and refuses any replacement that
  is not strictly newer (version, then `pub_date` for same-version
  alphas) via `scripts/updater-feed.mjs`. A cancelled queued run loses
  nothing because the surviving run computes the same result. Tests cover
  both completion orders, both publish orders, the guard alone under
  pre-fix trigger-only selection (mutation-checked), and a release without
  latest.json. A read-only dry run against live release metadata selected
  `v0.9.0-alpha.1` and skipped (feed already serves 0.9.0). The workflow
  itself only runs on a real publish, so it is not exercised end to end here.
  Scope limit (critic review): GitHub runs the workflow file from the
  published tag's commit, so only tags cut after this fix are protected;
  re-publishing a pre-fix tag (v0.8/v0.9) runs the old unguarded workflow.
- [x] Fix #346: reconcile active release/feed statements against GitHub
  release metadata and the rolling `latest.json` (verified 2026-10-03).
  v0.8/v0.9 are published prereleases; the feed serves `0.9.0` and points
  to v0.9 assets. DIRECTION §2/§3/D2/§6 now distinguish published state,
  future user-held publication policy, and pending client acceptance.
  Completed-cycle/archive records retain their historical context.

## Autonomous correctness pass (2026-10-03)

- [x] Fix #236: isolate the remaining 69 literal temp paths and two
  separately composed paths with a test-only PID + atomic-counter helper.
  Existing PID-scoped helpers and production socket/config paths remain
  unchanged. Fixtures still own creation/cleanup, including missing-path
  error cases. A same-name parallel-thread regression and two concurrent
  full Rust test processes pass without sharing fixture files.
- [x] Fix #362: only tolerate an incomplete recovered byte tail when the
  detection sample is actually shorter than the document. Complete inputs
  use the same strict decode as apply, eliminating guaranteed-to-fail
  candidates such as `café` → `caf`. A fail-first regression pins the
  complete-input candidate/apply invariant; exact-limit rejection and
  UTF-8 round trips around the sample limit complement the existing large
  Big5 sampling regression. No disk-write or apply behavior changes.
- [x] Fix #89: provide all 24 CodeMirror search/fold phrases for Japanese
  and Simplified Chinese, including accessible labels and count/line
  announcements. A typed shared table preserves the existing zh-TW keys;
  English uses upstream defaults. Tests cover placeholder preservation,
  the real phrase API, and an open search panel switching languages while
  retaining its search/replacement query. Native visual acceptance remains
  separate from these jsdom checks.
- [x] Fix #336: remove the structurally unreachable
  `(windows-1252, GB18030)` detection hypothesis. The canonical ranking
  regression now requires a real fixture for every admitted pair, with no
  unreachable-pair exemption; the reversibility fuzz pool stays in sync.
  Explicit GB18030 apply remains unchanged and has a four-byte-character
  round-trip regression. No detector gate is relaxed.
- [x] Mitigate #337: single-ASCII-code-unit normalization bypasses NFKD
  and uses the equivalent ASCII lowercase mapping. At this step all
  non-ASCII inputs and multi-unit queries preserve the upstream order;
  the later CJK optimization is recorded below.
  The existing CodeMirror differential sweeps plus all 128 ASCII units
  beside Unicode cover both case modes and whole-word matching. An
  informational `scripts/replacescope-bench.mjs` measures four corpora
  outside bundling/warmup time. #337 remains open for non-ASCII/dense-match
  synchronous-work limits; this is an ASCII-path optimization, not an
  asynchronous replacement engine.

- [x] Further mitigate #337: bypass normalization for the BMP CJK Unified
  Ideographs block (U+4E00..U+9FFF), whose NFKD/lowercase mappings are
  exhaustively checked for all 20,992 code points. Compatibility ideographs,
  astral characters, other scripts, and multi-unit queries retain the
  upstream path. CodeMirror differential fixtures cover block edges and
  mixed scripts; the benchmark now includes 1,024 distinct CJK characters
  to avoid relying only on a small repeated vocabulary. This adds no cache
  or memory growth; long-query and dense-match synchronous limits remain.
- [x] Investigate #280: add a headless retained-file-handle probe for
  macOS/Windows, covering renames, parent moves, old-path reuse, deletion,
  atomic replacement, and alias limitations. The integration tests run in
  normal CI; [the evidence and design limits](docs/rename-handle-probe.md)
  separate path discovery from a production fix. #280 remains open; watcher,
  document-path, and save behavior are unchanged. Windows CI disproved the
  continuously retained-handle approach: even metadata-only access with full
  sharing blocks parent-directory renames until the handle is closed.
- [x] Reconcile the pass for handoff: record the delivered changes under
  CHANGELOG's Unreleased section, update DIRECTION's current source state,
  and preserve the rejected Windows-handle and normalization-cache
  approaches in the judgment overlay. Source version remains 0.9.0.

## UI/UX pass (2026-10-05)

The user asked for a UI/UX-first autonomous pass (larger visual changes
allowed, one reviewable item per PR); afterwards the open issue queue
resumes. Browser screenshots are review evidence only; native
WKWebView/WebView2 acceptance is collected for the user.

- [x] Unify the status bar: every right-hand item shares one box, only
  clickable items react to hover (borderless, like the rest of the
  chrome), and the cursor position is now a button that opens Go to Line.
  Native acceptance pending.
- [x] Add a browser UI harness (`dev/ui-harness.html` + an IPC mock) so
  themes, panels, and dialogs can be screenshot-reviewed without the Rust
  core. A unit test pins its shell markup to `index.html`; nothing under
  `dev/` is bundled.
- [x] Redesign the Preferences dialog: Appearance / Editor / Files
  sections, uniform control sizing, a pinned button bar, and a theme
  picker of five preview cards painted from each theme's own token block
  (styles.css scopes every `html[data-theme]` block to
  `.theme-swatch[data-theme]` too, so there is no second copy of any
  color). The dialog is a labelled `role="dialog"`. Native acceptance
  pending.
- [x] Polish the tab strip: taller tabs, the active tab merges into the
  editor surface with an accent top rule, inactive close buttons appear
  on hover, and the unsaved dot turns into a close glyph on hover. Tabs
  follow the ARIA tabs pattern (tablist, roving tabindex, unsaved state in
  the accessible name); arrow keys/Home/End switch tabs and middle-click
  closes without activating first. Native acceptance pending.
- [x] Command Palette: show each command's shortcut (menu.rs now keeps
  one `ACCELERATORS` table that both the native menu and
  `palette_commands` read, with a test that every call site resolves),
  formatted per platform (⇧⌘F / Ctrl+Shift+F); highlight fuzzy-matched
  characters; expose the list as an ARIA combobox/listbox; and keep the
  arrow-key selection scrolled into view. Native acceptance pending.

## Explicit non-goals

These are out of scope — not "later", but **not what this project is**:

- Plugin system / scripting / macros
- Project panels, file trees, workspace management
- Integrated terminal, debugger, LSP-based intelligence
- FTP/SFTP browsing
- Trying to replace your IDE

## Platform tiers

- **Tier 1:** macOS, Windows — feature parity, CI-built and tested, platform-correct UX on each.
- **Tier 2:** Linux — kept compiling and functional via Tauri (WebKitGTK), but not UX-polished; community contributions welcome.
