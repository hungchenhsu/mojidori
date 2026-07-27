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

## v0.9 — trust deepening + issue closure (in progress)

Planned 2026-07-27 under the user's standing overnight delegation;
adversarially reviewed before start (AGREE-WITH-CHANGES — all seven
required changes adopted, notably: #329's initial two hypotheses
(selection-layer stacking, `--bg-selection` opacity) were falsified
and the investigation was reopened onto the search-match theme rule
with a strengthened, fail-first regression-test requirement rather
than a settled root cause, #330 rescoped to the error split the
upstream updater plugin can actually deliver, a third aggregate-ranking
gate added to the mojibake batch, and a planned docs sweep replaced by
the #280 rename-event probe after the sweep was verified to be a
no-op). Theme: no invented scope — every item traces to a filed issue
or an established recurring program. Cycle constraints: no GUI launch,
no release publishing, no visibility changes; good-first-issue items
(#278, #304, #236, #89) are deliberately left for community
contributors.

### Track A — bug fixes

- [ ] A1 (#329, P2): the search match the cursor jumps to is
  unreadable — the issue's original two hypotheses (selection-layer
  stacking, `--bg-selection` opacity) were falsified in pre-cycle
  review. `.cm-searchMatch.cm-searchMatch-selected` in
  `src/editor-theme.ts` already pairs an opaque `var(--accent)`
  background with an explicit `var(--accent-fg)` foreground, so a
  missing foreground color is not the actual defect — the track must
  investigate further (contrast of `--accent`/`--accent-fg` per theme;
  whether CM6's own higher-specificity built-in default for this
  selector silently wins the cascade the same way it did for
  `.cm-selectionBackground` a few lines above in the same file, which
  needed `!important` to actually apply). The regression test must
  fail against the current, unfixed revision — asserting theme-spec
  structure that already exists today would pass without fixing
  anything — and pass only once the true cause is addressed; no
  `getComputedStyle`-based fake greens. Fix must keep the jumped-to
  match readable in all four themes; visual acceptance on both
  WebViews stays with the user — the PR must reference, not close,
  #329.
- [ ] A2 (#330, P3): update-check error handling splits into
  network-layer / "no update information available" (the
  `ReleaseNotFound` bucket — covers 404 and every other non-2xx, and
  the wording says so) / other errors, in all four locales. A
  Rust-side test pins the upstream error display string the frontend
  matches on, so an unpinned `tauri-plugin-updater` bump cannot
  silently regress the classification.

### Track B — encoding trust

- [x] B1: mojibake `REPAIR_PAIRS` expansion batch — delivered
  2026-07-28 (PR #335): 15→18 pairs, admitting `(windows-1256,
  UTF-8)` Arabic, `(windows-1258, UTF-8)` Vietnamese, `(windows-1253,
  UTF-8)` Greek (batch capped at 3, as planned). windows-1255 deferred
  to a future batch purely on the cap; windows-1254 deprioritized as a
  low-marginal-value duplicate of the existing `(windows-1252,
  UTF-8)` pair; windows-1257 rejected (chardetng's own README calls
  its detection inaccurate, and its gap bytes land in the UTF-8
  continuation-byte range). All three admission gates satisfied,
  including the new aggregate ranking-regression assertion (proven
  against the pre-batch 15 pairs first, then re-proven at 18);
  `fuzz_roundtrip.rs` pools/match arms synced in the same PR.
  Independently re-verified before merge: adversarial harness
  re-derivation by a separate agent, plus a critic review
  (APPROVE-WITH-NOTES — four doc/test precision fixes applied), on
  top of Codex CI review. Incidentally surfaced a pre-existing,
  unrelated dead entry, `(windows-1252, gb18030)` — chardetng has no
  distinct GB18030 detection candidate, so `detect_mojibake` can never
  confirm it — filed as issue #336, left unfixed as out of scope for
  this batch.

### Track C — filed-issue closure

- [ ] C1 (#292): NFKD position-mapping feasibility investigation —
  findings-only, written up on the issue; implementing the mapping
  is explicitly out of scope this cycle.
- [ ] C2 (#292 mitigation): replace-in-selection reports how many
  normalized-equivalent matches it skipped (the issue's own second
  option) — the silent part of the bug dies without touching replace
  semantics; vitest-covered.
- [ ] C3 (#280): watcher rename-event probe run on macOS + Windows
  CI to measure notify's `event.paths` behavior (including whether
  the old-path watch survives at all) — findings recorded on the
  issue; the probe branch is discarded unless the probe earns its
  keep as a regression test.

### Track D — research & decision prep (no code)

- [x] D1 (#314): CSP-nonce feasibility research posted to the issue
  (delivered 2026-07-27: conditionally feasible via a placeholder
  `<style>` nonce carrier + `EditorView.cspNonce`; deferred until a
  real-machine verification window).
- [x] D2 (#303): decision-ready trim-on-save contract proposal
  posted to the issue for the maintainer's ruling (delivered
  2026-07-27; ties in PR #288's pending undo-semantics sign-off).

### Track E — close-out

- [ ] E1: version bump to 0.9.0, CHANGELOG release section, this
  section archived, DIRECTION §2 refreshed, overlay/memory lesson
  writeback, tag `v0.9.0-alpha.1`. Publishing stays user-held: the
  new draft release will sit alongside the still-unpublished
  v0.8.0-alpha.1 draft, and the user chooses what to publish
  (publishing is also what creates the updater feed whose absence
  #330's error message currently misreports).

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
  2026-07-23, tag `v0.8.0-alpha.1`, draft — not published): D1 official
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
  serve the update feed — but not yet doing so, since the feed-publish
  workflow only runs on a `release: published` event and
  `v0.8.0-alpha.1` remains an unpublished draft (see DIRECTION §3/D2).
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
