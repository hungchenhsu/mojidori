# Completed roadmap cycles (full record)

Archived from ROADMAP.md on 2026-07-18. The roadmap proper
([../../ROADMAP.md](../../ROADMAP.md)) keeps only a short summary per
cycle from here on; this file preserves every completed cycle's full
item-level record verbatim — the same heading structure and item text,
including every design-rationale, edge-case, and test-evidence note,
exactly as it read when each item shipped. Nothing here is
re-summarized or reworded. Git history also still has the original
ROADMAP.md in place at every prior commit, unchanged.

## v0.1 — MVP

**Editing**
- [x] Multi-tab open / save / save-as
- [x] Single-document open / save / save-as (skeleton)
- [x] Unsaved-changes indicator and close confirmation

**Encoding (the core identity)**
- [x] Automatic detection: BOM sniffing + statistical detection (UTF-8, UTF-8 BOM, UTF-16 LE/BE, Big5, Shift_JIS, GB18030, …)
- [x] Decode-error surfacing (never silently show mojibake as if it were fine)
- [x] Reopen with explicit encoding (UI)
- [x] Save with explicit encoding / BOM toggle (UI)
- [x] Line-ending detection (LF / CRLF / Mixed) and re-application on save
- [x] Line-ending conversion (UI)

**Editor basics**
- [x] Syntax highlighting for common languages
- [x] Find / replace with regex
- [x] Session restore (reopen last files on launch)

**Platform integration**
- [x] macOS native menu bar with standard shortcuts
- [x] Windows menu and Ctrl-based shortcuts
- [x] File association / "Open with" registration
- [x] Basic preferences (font, font size, theme, default encoding behavior)

## Post-MVP candidates

Ordered roughly by likelihood, not commitment:

- Large-file mode — phase 1 done (read-only 2 MB preview for files over
  10 MB, saving disabled). Phase 2a done: chunk paging via status-bar ◀ ▶
  (line-aligned chunks; UTF-16 excluded). Phase 2b done: continuous
  reading — scrolling near the end auto-appends the next chunk, up to a
  ~64 MB window; beyond that the jump pager takes over. Syntax
  highlighting is disabled in large-file windows by design.
- ~~Find in files (Rust search backend)~~ (done — encoding-aware; regex mode done)
- ~~Recent files / quick open~~ (done)
- ~~Column (rectangular) selection~~ (built into the editor surface: Alt+drag)
- ~~Drag-and-drop file opening~~ (done)
- ~~Auto-reload on external change (file watcher)~~ (done)
- ~~Printing~~ (done — native print dialog via a full-document print view; macOS/Windows)

## v0.2 polish candidates

Engineering-driven follow-ups; product-level decisions (naming, signing,
distribution) are tracked outside this list.

- [x] Regex mode for find in files
- [x] Word wrap toggle (View menu, persisted in preferences)
- [x] Editor zoom shortcuts (Mod+= / Mod+- / Mod+0 adjusting font size)
- [x] Save option in the close-tab confirmation (Save / Don't Save / Cancel)
- [x] Atomic saves (temp file + rename; a crash mid-save can no longer
  corrupt the target file)
- [x] Session restores cursor position per file
- [x] Window size/position persistence across launches
- [x] Hot exit: unsaved buffers (including untitled tabs) are backed up
  continuously and restored on launch; closing the window never asks
  about unsaved changes
- ~~Large-file phase 2c~~ (done — bidirectional continuous reading: the
  window slides through the file with chunk prepend/append plus trimming
  on the opposite edge, bounded at 8 chunks ≈ 16 MB; ◀ ▶ remain as jump
  controls)
- [x] Full visual refresh — semantic design-token system in styles.css
  (color, spacing, radius, shadow, type-scale tokens; light/dark via the
  existing three-layer mechanism) and a token-driven CM6 editor theme
  (`src/editor-theme.ts`) replacing `@codemirror/theme-one-dark`, so chrome
  and editor share one visual language

## v0.2 — feature cycle (approved 2026-07-10)

Scope approved by the user on 2026-07-10 (promoted from DIRECTION.md §6;
autosave-to-disk explicitly declined, multi-window still awaiting a design
conversation). One coherent item per PR.

**UI**
- [x] Full visual refresh: redesigned visual language (tab bar, status
  bar, dialogs, find/replace panel) on a CSS design-token foundation;
  light and dark modes both complete (delivered in #37 together with the
  polish-candidates token-system entry above)
- [x] Built-in theme system: a few curated themes (light / dark /
  eye-friendly) built on the design tokens; View-menu switching,
  persisted preference. Built-ins + CSS variables only — no custom
  theme import
- [x] UI i18n, zh-TW first: lightweight typed dictionary module (no
  runtime dependency), covering UI strings and native menus; language
  preference follows the system by default with English fallback

**Encoding & editing (Tier 1 promotions)**
- [x] Show invisibles toggle (spaces / tabs / EOL marks) — View menu,
  persisted pref
- [x] Hex/bytes preview for undecodable files — read-only view offered
  from the decode-warning UI; hex dump formatted as text in Rust (raw
  bytes never cross IPC)
- [x] Per-extension default encoding — prefs table ext→encoding;
  confident detection still wins; round-trip tests
- [x] Find/replace history dropdown
- [x] Startup-time budget test — scripted cold-start measurement with a
  tracked threshold (local `scripts/startup-bench.mjs` + env-gated probe
  mode; a CI job was attempted and removed — GitHub macOS runners never
  start loading the WebView, see the script header)
- [x] Encoding-detection diagnostics — status-bar popup showing the
  evidence behind the detection (BOM found, chardetng verdict)

## v0.3 — feature cycle (approved 2026-07-11)

Scope approved by the user on 2026-07-11 as four parallel tracks. Tracks
are independent by design — they map to separable module areas (Rust
encoding core / editor module / UI chrome / community infra) so multiple
contributors can work concurrently without colliding. Within a track,
items are roughly ordered; across tracks, anything unblocked is fair
game. One coherent item per PR, as always.

**Track A — encoding tools** (the moat; all items are encoding danger
domain: failing-test-first, round-trip tests mandatory)
- [x] Mojibake repair wizard: detect common mis-decode round-trips
  (e.g. Big5 bytes once decoded as Windows-1252 and re-saved) and offer
  a previewed, reversible repair — never applied silently
- [x] Batch encoding conversion: convert a folder's files to a target
  encoding with a dry-run report first; atomic per-file saves
- [x] Batch line-ending conversion (rides on the same batch UI)
- [x] Side-by-side encoding preview: the same bytes decoded under two
  candidate encodings, read-only, for manual disambiguation

**Track B — large files**
- [x] Find/replace inside large-file windows via streaming Rust
  search/replace over the full file (atomic temp+rename; editor window
  refreshes after)
- [x] Line-offset index for huge files: fast go-to-line and bookmarks
  beyond the loaded window

**Track C — everyday editing comfort**
- [x] Code folding (CM6 fold gutter, wired per language)
- [x] Line operations under Edit menu: sort / unique / trim trailing
  whitespace / upper-lower case (vitest for the pure transforms)
- [x] Indent guides (token-driven color, all four themes)

**Track D — release & community**
- [x] Issue templates, labels, and a good-first-issue starter set
  (unblocked; do first — it is the interface for incoming contributors)
- [x] i18n dictionaries: ja and zh-CN (builds on the v0.2 i18n module)
- (D1 / D2 remained open at the time — subsequently delivered in the
  v0.8 cycle, see this file's v0.8 entry below; Windows signing (D2)
  remains undecided, see DIRECTION.md §3/D2)
- [x] D3 going-public sweep, archive part: internal decision material
  (naming evidence, updater runbook) relocated out of the repo to the
  maintainer's local private storage (2026-07-15, user-approved; note
  the files remain reachable in git history — accepted). Remaining D3
  items (D1 naming, README pass, signing) tracked in DIRECTION §2

## v0.4 — feature cycle (planned 2026-07-14, delegated)

Scope planned autonomously under the user's 2026-07-14 delegation (user
away; plan the cycle, merge on green CI, post-merge review). The plan
passed an adversarial review against the mission and non-goals before
work started. Same track model as v0.3; one coherent item per PR. Items
marked **[danger]** touch encoding/save-path danger domains:
failing-test-first, round-trip tests, and adversarial review before
commit (judgment overlay §1).

**Track A — character-level trust** (the moat, extended to the sneakiest
cases of "never misrepresent user text")
- [x] Character inspector: status-bar codepoint readout (U+XXXX) for the
  character at the cursor, with a popup showing its byte sequence under
  the file's save encoding (bytes rendered in Rust; UTF-16 hand-encoded
  around the encoder dead end) [danger]. Semantics: the character
  *immediately before* the cursor (what Backspace would delete), not
  under it — chosen because it's the one option under which "empty
  document / line start shows nothing" falls out naturally (the char
  before a line start is the *previous* line's own newline, which would
  be misleading to show), documented on `characterBeforeCursor`
  (editor.ts). Wired into the existing `onCursorMoved` path (no new
  update hook): reads up to the last 2 UTF-16 code units before the
  cursor, clamped to the line start, and splits with `Array.from`
  (code-point iteration, i.e. `codePointAt` semantics) so a supplementary
  character split across a surrogate pair (e.g. U+1F600) is read back
  whole — O(log n) via `Text.lineAt` plus an at-most-2-unit slice, the
  same cost class as `updateCursor`'s own line/column math, so — unlike
  the whole-document `textStatsOf` segment — it needs no debounce and
  runs unconditionally in large-file (truncated) windows too (segment
  and popup both stay meaningful within whatever window is loaded).
  New Rust IPC `encode_char(ch, encoding) -> {bytesHex, lossy}`
  (`src-tauri/src/charinspect.rs`): failing-test-first round-trip table
  (ASCII, Big5 "中", GB18030 "中", Shift_JIS "あ", UTF-16LE/BE surrogate
  pair for U+1F600, unmappable "é" in Big5) with every expected byte
  sequence hand-verified against Python's own (encoding_rs-independent)
  codec tables rather than encoding_rs self-certifying its own answer;
  the naive first-draft (calling encoding_rs's whole-buffer `encode()`
  unconditionally, no UTF-16 special case) failed exactly the two
  UTF-16 tests — producing the character's *UTF-8* bytes instead,
  the precise known dead end (`new_encoder()`'s/`encode()`'s output
  encoding for UTF-16LE/BE is UTF-8, judgment-overlay.md §4) — plus the
  unmappable-character test, which got back the literal bytes for
  encoding_rs's own HTML numeric-character-reference fallback
  ("&#233;") instead of the empty/lossy signal. Fixed by special-casing
  UTF-16LE/BE to reuse `encoding::encode_utf16` (bumped to `pub(crate)`),
  the same hand-rolled code-unit encoder the real save path already
  uses, and by discarding (never surfacing) encoding_rs's fallback bytes
  on an unmappable character: `lossy: true` with an empty `bytesHex`,
  since showing "&#233;"'s bytes as if they were "é in Big5" would
  misrepresent a character Big5 cannot represent at all. No `withBom`
  parameter — a BOM is a file-level, offset-0-only marker, not a
  property of one character's bytes. Bytes cross IPC only as an
  uppercase, space-separated hex string (e.g. "E4 B8 AD"), the same
  "bytes formatted as text in Rust" precedent hexdump.rs established for
  the raw-bytes-never-cross-IPC constraint. Popup (`src/charinspect.ts`)
  mirrors the encoding-detection diagnostics status-bar popup
  (detectcard.ts) — same anchored-panel positioning, same away-click/
  Escape close handling, same `.detectcard-header`/`.detectcard-rows`
  inner CSS classes reused verbatim — but keeps its own outer panel
  class (`.charinspect-panel`, sharing `.detectcard-panel`'s rule via a
  combined CSS selector rather than the DOM element carrying both
  classes) so the two features' "already open" guards can never see
  each other's popup. Rows: character, code point, UTF-8 bytes always,
  and a fourth "{encoding} Bytes" row only when the save encoding isn't
  UTF-8 (two `encode_char` calls total) — showing either the hex or,
  when lossy, a "cannot be represented in {encoding}" message in place
  of bytes, styled with the existing `--warning` token. i18n across en/
  zh-TW/ja/zh-CN.
- [x] Invisible/ambiguous character audit: curated highlighting of
  zero-width characters, bidi controls (U+202A–202E, U+2066–2069), NBSP
  variants, soft hyphens, and in-body BOMs, with a status-bar count and
  a View toggle. A single 20-entry curated table (`src/suspiciouschars.ts`)
  is the one source of truth for what's audited, split into bidi (LRE/RLE/
  PDF/LRO/RLO/LRI/RLI/FSI/PDI/ALM/LRM/RLM), zeroWidth (ZWSP/ZWNJ/ZWJ/WJ/
  in-body BOM), and whitespace (NBSP/NNBSP/soft hyphen — U+3000 ideographic
  space deliberately excluded, routine CJK spacing) categories, each with a
  pure `scanSuspiciousChars(text)` (offset/char/label/name/category per
  hit) fully vitest-covered (every category, mixed, none, and
  surrogate-pair-adjacent cases — all 20 code points are single-UTF-16-unit
  BMP characters, so unlike textstats.ts's word counter this needs no
  cross-chunk carry state at all). CM6 wiring
  (`editor.ts`'s `suspiciousCharsExtension`) *overlays* rather than
  replaces `basicSetup`'s own bare `highlightSpecialChars()` (which already
  highlights a subset — SHY/ALM/ZWSP/LRM/RLM/LRO/RLO/LRI/RLI/PDI/in-body
  BOM — as a generic "•" placeholder): verified from
  @codemirror/view/state source that `addSpecialChars` is the documented
  extension point for exactly this, and that basicSetup's own
  parameterless call contributes zero keys to the `specialCharConfig`
  facet's `combineConfig`, so this module's own `addSpecialChars`/`render`
  can never hit its "Config merge conflict" error regardless of extension
  order — pinned by a dedicated `EditorState.create` regression test
  (editor.test.ts) alongside a real `basicSetup`. The custom `render`
  callback labels curated hits `[RLO]`/`[ZWSP]`/etc. (`.cm-suspicious-char`,
  editor-theme.ts, reusing the `--warning`/`--warning-soft` tokens the
  status-bar decode-error/read-only badges already use) and returns `null`
  for anything else, falling back to CM6's stock rendering unchanged for
  its own baseline control-character set — a deliberate `as` cast bridges
  `@codemirror/view`'s `render` type (declared non-nullable `HTMLElement`)
  against its own documented falsy-fallback runtime behavior. View menu
  toggle (`suspicious_chars`, default **on** — a trust/security signal,
  not a convenience default like indent guides) only gates the inline
  highlight; the whole-document status-bar count
  (`suspiciousCharCountOf`, chunked via `Text.iterRange` like
  `textStatsOf`, no cross-chunk state needed for the same reason as
  above) is intentionally independent of that toggle — no other
  status-bar badge (decode error, read-only) is gated by a View-menu
  display preference either, and hiding a trust signal behind an
  easy-to-forget toggle would work against the feature's own purpose.
  Truncated (large-file) windows hide the count entirely rather than
  showing a "window"-qualified partial total, matching the Track C
  text-stats precedent exactly (`computeAndShowSuspiciousChars` in
  main.ts) — inline highlighting still applies as usual within whatever
  window is loaded, unaffected, same as indent guides/EOL marks. i18n
  across en/zh-TW/ja/zh-CN (`statusbar.suspiciousChars`, menu.rs `LABELS`
  with a dedicated pinned-translation test mirroring `read_only`'s).
- [x] Full-width ⇄ half-width conversion (selection-scoped, Edit menu):
  FF01–FF5E ⇄ ASCII plus ideographic space [danger]. `toHalfWidth`/
  `toFullWidth` (lineops.ts) are a straight +/-0xFEE0 offset over
  U+FF01–FF5E ⇄ U+0021–007E plus a dedicated U+3000 ⇄ U+0020 case;
  everything else (halfwidth katakana U+FF61–FF9F, CJK ideographs, tabs,
  newlines) passes through untouched, which is what makes the two exact
  inverses of each other. Iterates by code point (the same technique
  `compareCodePoints` uses), so an adjacent surrogate pair is never split.
  Wired as `editor.transformSelection` (like uppercase/lowercase, not
  `transformLines`: this is a character substitution with no per-line
  meaning, so a partial-line selection must stay verbatim) — no selection
  means whole-document, same precedent. Two new Edit > Line Operations
  items beside the case-conversion pair, `to_full_width`/`to_half_width`,
  i18n across en/zh-TW/ja/zh-CN with a pinned-translation test mirroring
  `convert_leading_tabs_to_spaces`'s. vitest: full ASCII 0x21–0x7E table
  round-tripped bidirectionally in a for loop, boundary characters (U+FF01/
  U+FF5E inclusive, U+FF5F just outside), ideographic-space pair, mixed CJK/
  halfwidth-kana/ASCII text, empty string, adjacent-surrogate-pair safety,
  and idempotence, both directions (101 lineops.test.ts cases total).
  Representability note: both directions only ever produce characters
  representable in Big5/legacy CJK encodings (fullwidth forms sit in
  Big5's mapped range, ASCII is universal), so no new lossy-save risk —
  the existing save-time lossy gate is untouched and sufficient.
- [x] Unicode normalization: non-NFC detection plus Edit-menu Normalize
  to NFC / NFD with a previewed change count — validating
  representability under the file's save encoding first (NFD output can
  be unrepresentable in legacy encodings; normalize must never set up a
  lossy save) [danger]. Detection (`normalize.ts` `isNfcChunked`) walks
  CM6's `Text.iter()` chunk by chunk instead of materializing
  `doc.toString()`, carrying the tail back to the last *normalization
  boundary* (UAX #15 `hasBoundaryBefore`) across each chunk cut: `\p{M}`
  marks plus the non-Mark canonical-composition second elements —
  conjoining Hangul V/T jamo and U+16D67 (Kirat Rai, Unicode 16.0), both
  category Lo, which a `\p{M}`-only proxy misjudged (NFD Hangul open
  syllables read as already-NFC even single-chunk; caught by adversarial
  review) — and never cutting at a trailing lone high surrogate (astral
  marks like U+110BA would otherwise have their base flushed away when a
  chunk cut lands mid-surrogate-pair). Proven failing-test-first at each
  step, and pinned by an exhaustive sweep: the NFD expansion of every
  decomposable code point in planes 0-2 (Hangul sampled), every split
  point, against whole-string ground truth — which is also the
  maintenance contract for the hardcoded jamo/Kirat list (a future
  Unicode version adding another non-Mark second element fails the sweep
  naming the exact code point). Status shown as a new small, hidden-until-
  relevant status-bar segment (`#status-nonnfc`, statusbar.ts
  `updateNormalizationStatus`), mirroring the existing suspicious-chars/
  indent segments' debounce-and-hide-when-truncated pattern, rather than
  a new always-visible segment or a diagnostics popup. Edit > Line
  Operations gains `normalize_nfc`/`normalize_nfd` (menu.rs `LABELS`,
  i18n across en/zh-TW/ja/zh-CN with a pinned-translation test), wired
  through `runLineOperation` — the same truncated/userReadOnly guard
  sort/unique/trim use, which also covers the large-file-preview-
  disabled requirement with no separate native-menu-enabled wiring
  needed. Always whole-document (`editor.content()`/
  `editor.replaceContent`), never selection-scoped. Confirm flow
  (main.ts `runNormalizeFlow`): a no-op (already the target form — the
  common case for plain CJK text, which has no canonical decomposition)
  applies nothing and shows no dialog, matching the existing line-
  operations' no-op-dispatches-nothing precedent; otherwise a confirm
  dialog names the affected sequence count (`normalize.ts`
  `countChangedSequences`, a normalization-boundary-sequence diff — not
  a raw code-point count, which would misalign or double-count once
  composition/decomposition changes how many code points encode one
  character; the boundary-based split keeps NFD and NFC Hangul at the
  same per-syllable sequence count, so this figure stays consistent
  with the representability dialog's own character count). The
  representability guard — the actual point of the feature — is a new
  Rust IPC command, `check_representable`
  (src-tauri/src/normalize.rs), reusing charinspect.rs's per-character
  `encoding_rs::Encoding::encode()` probing technique (encoding_rs only
  reports one whole-string bool, never which characters) to report an
  uncapped per-occurrence unmappable count plus up to 20
  distinct-character samples and a `samplesTruncated` flag (the dialog
  appends "and more" only when distinct characters overflowed the cap —
  repeats alone never imply an incomplete list); UTF-8/UTF-16 targets
  are skipped on both the frontend and the Rust side (every Unicode
  scalar value is representable in either). A non-zero count surfaces a
  second, explicit warning naming the encoding, the count, and the
  samples before the user can still choose to proceed — and
  `save_document`'s own lossy gate remains a second, independent line
  of defense at actual save time regardless. Rust tests: Big5/
  Shift_JIS + an NFD combining sequence → unmappable > 0
  (failing-test-first: a stubbed always-zero implementation fails these
  first), plain Traditional Chinese text and UTF-8/UTF-16 → 0, sample
  cap/dedup/truncated-flag semantics, unknown encoding → `Err`.
- [x] Lossy-save character preview: when a save is rejected as lossy,
  list *which* characters can't be encoded (char + position, capped),
  not just a count, before offering the lossy path [danger]. Previously
  `save_document`'s two-phase lossy gate returned only a bare `unmappable:
  bool` -- not even a count, let alone which characters. The scan-and-
  sample machinery already existed one item up: A3's
  `check_representability` (`src-tauri/src/normalize.rs`) probes each
  character's representability via `encoding_rs::Encoding::encode()` and
  collects up to `SAMPLE_CAP` (20) deduped samples plus a
  `samples_truncated` flag. This item extracts that scan into a shared
  `scan_unmappable` helper (`(count, hits, truncated)`, `hits:
  Vec<UnmappableHit>` carrying each first-encountered character's
  position) so `check_representability` and the new `lossy_save_report`
  are the same source rather than two implementations of the same cap/
  dedup/truncation logic -- `check_representability`'s own 13 tests are
  unchanged (pure refactor). `lossy_save_report(text, label)` returns
  `LossySaveReport { unmappable_count, samples: Vec<UnmappableSample>,
  samples_truncated }`, where `UnmappableSample` adds `line`/`column`
  (1-based) to `RepresentabilityReport`'s plain formatted-string samples.
  Position is computed by scanning `save_document`'s `content` parameter
  (the LF-normalized buffer as sent by the frontend) -- deliberately never
  the line-ending-converted `text` that `encoding::encode` actually
  writes, since a CR-only (classic Mac) conversion replaces every `\n`
  with a bare `\r`, which would silently collapse every reported line to
  "line 1"; a dedicated regression test saves multi-line content with
  `line_ending: "CR"` and asserts the reported line/column still match the
  LF buffer. Column counts UTF-16 code units, not Unicode scalar values --
  matching `editor.ts`'s `onCursorMoved` (`head - line.from`), the same
  convention `statusbar.cursor` already displays with, so an astral
  character (e.g. an emoji) earlier on the same line advances the column
  by 2, not 1; pinned by a dedicated test (rocket emoji followed by "é" on
  one line). `SaveResult` gains `lossy_report: Option<LossySaveReport>`,
  populated only on the lossy-rejection branch (`unmappable: true,
  written: false`) -- `None` on a successful write and on a `stale`
  rejection (issue #113's retry never needs a fresh sample list there).
  Failing-test-first: a stubbed always-clean `lossy_save_report`/always-
  `None` `lossy_report` wiring landed first, the new tests expecting real
  samples/positions failed against it, then the real scan/wiring replaced
  the stub -- 14 new Rust tests (11 in normalize.rs, 3 in lib.rs), full
  suite 299 passed (2 pre-existing `#[ignore]`d fuzz variants unaffected).
  Frontend: the lossy-save confirm outgrew the native `confirm()` dialog
  plugin (main.ts's `saveFlow` used to call directly) -- a native dialog
  can only show a flat string with no way to make a capped 20-line sample
  list scrollable -- so it gets its own in-DOM modal, `src/lossysave.ts`,
  mirroring confirm.ts's `showCloseConfirm`/stalefile.ts's
  `showStaleFileConfirm` (same `.confirm-overlay`/`.confirm-dialog`/
  `.confirm-buttons` classes, Escape cancels, initial focus on Cancel --
  irreversible once confirmed, so, like the stale-file dialog, there is no
  global Enter shortcut). A pure `buildLossySaveDialogContent` (vitest-
  covered, no WebView) composes the title/summary/per-sample lines/
  truncation note from `t()` calls; the DOM builder itself is untested,
  matching the existing confirm.ts/stalefile.ts precedent. i18n:
  `dialog.lossyEncodingMessage` gained a `count` parameter (replacing the
  old vague "some characters"); new `dialog.lossySampleLine` (reusing
  `statusbar.cursor`'s own per-locale Ln/Col phrasing convention verbatim)
  and `dialog.lossySamplesTruncated`, across en/zh-TW/ja/zh-CN. New
  styles.css: `.confirm-dialog-title` (a small heading the two existing
  confirm-style modals didn't need) and `.lossy-samples` (max-height/
  overflow-y: auto, same scrollable-list idiom as
  `.batchconvert-scan-errors-list`). Batch conversion's own lossy
  classification (`batch.rs`'s scan report) is untouched -- out of scope;
  per-file lossy flags already exist there and this item only concerns the
  single-document save dialog.
- [x] UTF-8 BOM toggle gap check: verified no gap, no code change needed.
  The status bar's encoding indicator already opens a "Save with
  Encoding" submenu (`main.ts` `showEncodingMenu`, `menu.saveWithEncoding`)
  listing "UTF-8" and "UTF-8 with BOM" as two distinct, independently
  checkable entries (`encodings.ts` `encodingChoices` — `{value: "UTF-8",
  withBom: false}` vs `{value: "UTF-8", withBom: true}`, localized in all
  four locales); picking either sets `doc.withBom` and immediately saves
  through it, so an existing UTF-8 file's BOM can be added or removed
  today without reopening. This reaches `save_document`'s `with_bom`
  param unchanged and `encoding::encode`, which prepends `EF BB BF` only
  when `with_bom && encoding == UTF_8` — confirmed live via the existing
  `cargo test --lib bom` (19 tests) and `npm test` (565 tests) suites,
  both green with no changes. UTF-16 choices stay BOM-only (no `false`
  variant offered, so the UI can't write a BOM-less UTF-16 file) and
  single-byte/legacy encodings offer no BOM entry at all — both already
  correct, not touched.

**Track B — large files & performance**
- [x] #107: transformLines computes line spans via lineAt instead of
  materializing the document
- [x] Streaming encoding conversion for large files: >10 MB files
  converted via streaming decode→re-encode with atomic temp+rename and
  the same lossy two-stage gate as streaming replace; UTF-16 targets
  excluded (encoder dead end); fail-closed on external modification
  [danger]. New `stream_convert_file` (src-tauri/src/streamconvert.rs)
  mirrors `streamreplace.rs`'s architecture exactly (same atomic
  temp+rename commit, same `fsguard.rs`-backed fail-closed external-
  modification guard captured right after opening the source and
  re-checked immediately before rename) but is a genuinely different loop:
  source and target encodings are independent parameters rather than one
  encoding reused for both directions, so there is no cross-chunk *search*
  carry to track — each decoded chunk is scanned and encoded independently,
  with the streaming `Decoder` alone responsible for resolving a multi-byte
  or surrogate-pair sequence split across the raw 8 MiB read boundary. The
  per-chunk decode/encode primitives (`decode_chunk`/`encode_chunk`/
  `read_chunk`/`CHUNK_BYTES`) were extracted out of `streamreplace.rs` into
  a new shared `streamcodec.rs` (a pure, test-verified refactor — all 18
  pre-existing `streamreplace.rs` tests still pass unchanged) rather than
  forking that buffer-growth-loop logic a second time, the same
  "extract for a second caller" precedent `fsguard.rs` itself set. UTF-16 is
  asymmetric here, unlike streaming replace: only a UTF-16 *target* is
  rejected (`new_encoder()`'s dead end is encode-side only); a UTF-16
  *source* decodes through the ordinary streaming `Decoder` with no dead end
  at all and is fully supported, pinned by a dedicated fixture with a
  surrogate pair's two code units landing on opposite sides of the exact
  8 MiB chunk boundary. Two-stage lossy gate mirrors `save_document`'s
  own two-phase gate (call once with `allowLossy: false`, get a report; call
  again with `true` to commit) rather than a separate up-front dry-run
  command: a single streaming pass always fully encodes to a temp file
  while aggregating an unmappable-character report via
  `normalize::UnmappableScanner`, fed one already-decoded chunk at a time;
  a `written: false` result (unmappable found, not yet allowed) discards
  the temp file without any fingerprint check (nothing was written). The
  scanner's own sample-cap/dedup/position machinery (previously private to
  `scan_unmappable`, now a `pub(crate)` incremental struct so it can be fed
  in pieces) is unchanged in its whole-string callers, `check_representability`
  and `lossy_save_report` — a pure refactor, both callers' full existing test
  suites pass unmodified, plus a new chunked-vs-whole-string equivalence
  test. Performance: the naive version (always running the O(n)
  per-character representability probe alongside the bulk encode) measured
  over two minutes for a single ~13 MiB fixture with only 3 unmappable
  characters; `encode_chunk`'s own bulk `had_unmappable` flag (needed
  regardless, to produce output bytes) now gates the expensive per-character
  scan per chunk — a chunk the bulk encode already reports clean only pays
  for cheap line/column bookkeeping (`UnmappableScanner::advance_position_only`),
  cutting that same test to under 80s and, more importantly, keeping a
  realistic large file with only scattered unmappable characters cheap
  rather than paying the full per-character cost across its entirety.
  Frontend: truncated tabs get a new "Convert File to Encoding" entry in the
  status-bar encoding menu (`main.ts`'s `showEncodingMenu`), alongside the
  existing "Save with Encoding" (left untouched — it already is a dead
  end for a truncated tab, blocked by the read-only-preview dialog, since
  the buffer is only a preview slice; this adds the real capability rather
  than retrofitting that entry), listing `encodings.ts`'s new
  `streamConvertEncodingChoices()` (the existing `encodingChoices()`, minus
  the two UTF-16 target entries — each remaining choice already carries its
  own correct `withBom`, e.g. plain "UTF-8" is `withBom: false`, so picking
  one *is* the BOM decision, matching how batch conversion's own
  `target_with_bom` is a caller-supplied flag with no separate default
  computed on the Rust side). New `src/streamconvert.ts` orchestrates the
  flow with no persistent input panel (the target is already chosen from
  the menu) — a minimal non-dismissable busy overlay reusing the existing
  `.confirm-overlay`/`.confirm-dialog` classes (mirroring streaming
  replace's "cannot be cancelled mid-run" precedent) during each IPC call,
  and the *same* `showLossySaveConfirm` dialog (`lossysave.ts`) the regular
  save path's lossy gate uses for the two-stage confirm, since the Rust
  report reuses `normalize::LossySaveReport` verbatim. On success,
  `doc.encoding`/`doc.withBom` are set to the new target *before*
  `reloadFromDisk` (which reopens with whatever `doc.encoding` already holds) and a
  confirmation dialog names the result before reloading, mirroring streaming
  replace's "the result must actually be seen" precedent. i18n across en/
  zh-TW/ja/zh-CN (`menu.convertFileToEncoding`, `streamConvert.*`). Rust
  tests (failing-test-first): a >12 MiB Big5→UTF-8 round trip with a filler
  unit deliberately sized so a CJK character straddles the exact chunk
  boundary; a small fast test for the dry-run rejection report (count/dedup/
  position) plus a separate >12 MiB UTF-8→Big5 test committing exactly an
  independently-built byte oracle under `allowLossy: true` (split from the
  rejection test so the expensive large-scale encode only runs once, not
  twice); the UTF-16LE cross-boundary surrogate-pair fixture; UTF-16 target
  rejection (both LE and BE); external-modification fail-closed (real
  `rename`-based race plus fingerprint-mismatch unit tests); malformed-source
  abort; BOM semantics (no BOM by default even when the source had one, an
  explicit BOM request honored for a UTF-8 target, a source BOM stripped
  when converting to an encoding with no BOM concept, a legacy target
  ignoring a BOM request); unknown-encoding-label errors; an empty-file edge
  case; two more added directly against an opus `critic` adversarial review
  of this diff (which otherwise agreed the design and the riskiest
  assumption — encoding_rs's bulk per-chunk `had_unmappable` flag matching
  the scanner's own per-character probe exactly, since every supported
  target encoding is a stateless per-character mapping — both hold):
  a >8 MiB fixture with the *first* chunk entirely clean and only the
  *second* containing the one unmappable character, proving the aggregated
  count and position survive a real per-chunk fast-path switch (not just a
  direct unit-level scanner call), and a second fixture with an unmappable
  character's own 4 UTF-8 bytes split exactly 2/2 across the raw chunk
  boundary. 331 Rust tests total (up from 299), 572 frontend tests (up from
  565).
- [x] File-open latency budget script (local-only, like startup-bench;
  never CI — known runner dead end) *(optional)* — new
  `scripts/openfile-bench.mjs` mirrors startup-bench's env-gated probe
  pattern with its own separate probe rather than reusing the cold-start
  one, so open latency is isolated from WebView/prefs/session-restore
  overhead instead of folded into it: `PLUME_OPENFILE_PROBE=<path>` plus
  new `openfile_probe_path`/`report_openfile_ready` commands
  (`src-tauri/src/openfile_probe.rs`), hooked right after the existing
  cold-start probe at the end of the init IIFE in `src/main.ts`. Both
  timing endpoints (trigger, post-paint) live in the frontend, so elapsed
  is measured there with `performance.now()` around the real `openPath()`
  codepath a drag-drop/file-association open already uses (a
  `requestAnimationFrame` wait after it stands in for "content rendered").
  The script generates its own synthetic UTF-8 fixtures in a temp dir,
  cleaned up after — 1 MiB (full open) and 50 MiB (crosses
  `LARGE_FILE_THRESHOLD`, exercises the read-only preview path) — and
  reports median/p95 over a parameterizable run count, with optional
  independent thresholds per size. Verified via `node --check`, `--dry-run`
  (fixture generation/cleanup, no binary spawn — confirmed clean, no temp
  dirs left behind), a standalone import-based check of the pure
  median/percentile/synthDoc helpers, and the usual app-code gate (`npm
  run build`/`npm test`, `cargo fmt`/`clippy`/`test`: 333 Rust tests, up
  from 331; 572 frontend tests, unchanged — this addition has no unit-level
  surface of its own, same as the pre-existing startup probe hook).
  Actually launching the script spawns a real GUI window, which agents in
  this repo must never do (TCC-incident rule), so real `openfile_ms`
  numbers were not gathered in this change; a human should run
  `node scripts/openfile-bench.mjs` on an unlocked desktop after
  `cargo build --release` to get them.

**Track C — everyday editing comfort**
- [x] Multi-cursor: allowMultipleSelections plus select-next/all
  occurrence commands, Edit-menu entries, platform shortcuts (verified
  from source: `basicSetup` already sets `allowMultipleSelections` and
  bundles `searchKeymap`'s Mod-d/Mod-Shift-l for select-next/all-occurrence
  — this cycle's actual work was Edit-menu exposure; CM6's own
  Cmd/Ctrl-click already adds a cursor and does not conflict with the
  existing Alt-drag rectangular selection, so that gesture was left as-is
  rather than remapped to Alt-click)
- [x] Line shuffle ops in the Edit menu: move line up/down, duplicate,
  delete (bindings may already exist via the default keymap — expose
  and complete them)
- [x] Word/char/line count status-bar segment: selection-aware,
  CJK-aware word counting; computed without materializing the document;
  hidden in large-file windows. Pure counting (`textstats.ts`) is split
  from the CM6 walk (`editor.ts`'s `textStatsOf`): a streaming accumulator
  fed one `Text.iterRange` chunk at a time, never `doc.toString()`/a
  whole-range `sliceDoc` (issue #107's anti-pattern) — verified against
  `@codemirror/state`'s own source that a chunk is always a whole line, a
  line break, or (only at the caller's own from/to) a boundary-trimmed
  partial line, so a word or UTF-16 surrogate pair is never split by an
  *internal* chunk boundary; the accumulator still carries a trailing
  high surrogate and an in-word-run flag across chunks defensively. CJK
  word counting: CJK Unified Ideographs (U+4E00-U+9FFF) + Extension A
  (U+3400-U+4DBF), Hiragana (U+3040-U+309F), Katakana (U+30A0-U+30FF), and
  Hangul syllables (U+AC00-U+D7A3) each count as one word per character;
  everything else groups into `\p{L}\p{N}` runs. No selection shows
  whole-document stats; one or more non-empty selection ranges show
  selection stats instead, summed across every range (including "lines,"
  per spec — two single-line ranges on the same physical line sum to 2,
  a deliberate, documented trade-off over tracking distinct line numbers
  touched). Performance: cursor-position updates (`onCursorMoved`) have no
  existing throttle to piggyback on (called synchronously on every CM6
  transaction, but O(log n) via `Text.lineAt`) — text stats are O(document
  length), so they get their own 300ms `setTimeout` debounce
  (`scheduleTextStatsUpdate` in main.ts, mirroring the existing hot-exit
  backup debounce), while tab switch/open/reload/large-file jump compute
  immediately via the same `showActive` choke point everything else
  already uses. Hidden entirely (`updateTextStats(null)`) for
  `doc.truncated` large-file windows. i18n: `statusbar.textStats` /
  `statusbar.textStatsSelection` across en/zh-TW/ja/zh-CN, English
  pluralizing each noun independently per the `resultSummary` precedent.
- [x] Per-tab read-only mode (View menu + status-bar indicator, reusing
  the existing readOnly compartment; large-file preview read-only state
  cannot be lifted): `Doc.userReadOnly` (tabs.ts) is a second, independent
  read-only source alongside `truncated` — `isEffectivelyReadOnly(doc)` =
  `truncated || userReadOnly` is the one formula every call site (CM6
  enforcement, the View menu's checked/enabled sync, the status-bar badge,
  the Save/line-ops rejection guard) derives from, so none of them can
  drift out of sync. editor.ts's `newBuffer` already baked
  `EditorState.readOnly`/`EditorView.editable` in fixed at construction for
  a truncated preview (unchanged, still unlifted); the toggle itself is a
  new `Compartment` (`setReadOnly`), reconfigured per-buffer after every
  `swap` from that doc's own effective value — mirroring `setLanguage`'s
  per-buffer pattern, not the global-pref compartments (wrapping/
  invisibles/indentGuides), since read-only is per-tab. CM6's `readOnly`
  facet ORs every source together, so the two mechanisms layer safely.
  Verified from source (editor.test.ts): CM6's own commands
  (moveLineUp/Down, duplicate/deleteLine, Undo/Redo, search's Replace)
  self-no-op on `state.readOnly` and never dispatch; `transformLines`/
  `transformSelection` (sort/unique/trim/case, a raw `view.dispatch` with
  explicit changes) do not consult it on their own, so `runLineOperation`'s
  JS-level guard is their only protection — extended from `truncated` to
  `isEffectivelyReadOnly`. Native menu: a new `read_only` CheckMenuItem
  (menu.rs, LABELS across all four languages) with a new
  `sync_read_only_menu(checked, enabled)` command — `enabled: false` for a
  truncated tab (its lock can never be lifted, so the item is shown checked
  but disabled, the only existing `CheckMenuItem::set_enabled` use in this
  codebase) — called from main.ts's `syncReadOnlyState` on every tab switch
  (`showActive`) and on the toggle itself (`toggleReadOnly`), since a plain
  click's native auto-checkmark-toggle alone can't track switching to a
  different tab. Status bar: the existing `#status-readonly` badge is
  reused (not duplicated) — truncated's own sized message wins when both
  are true, otherwise a plain locale'd "Read-only" label. Session: a new
  `userReadOnly`/`user_read_only` field (ipc.ts/session.rs) round-trips a
  locked tab's state across a relaunch, `#[serde(default)]`/`??`-guarded
  for old sessions. Save on a read-only tab shows the same blocking dialog
  large-file preview already used (mirrored, not replaced, per existing
  "action rejected" precedent), with a distinct message telling the user
  how to unlock (View > Read-Only) instead of the large-file wording.
- [x] Tab drag-to-reorder (pure reorder logic unit-tested in the tab
  store): `TabStore.moveTab(fromIndex, toIndex)` is a plain splice-out/
  splice-in array move — `activeId` tracks a doc's id, not its array
  position, so the active tab is untouched by any reorder whether or not
  it's the tab being moved. Interaction is Pointer Events, not the HTML5
  DnD API (WKWebView/WebView2 drag-image/drop-effect inconsistencies) —
  pointerdown arms a potential drag on the tab (primary button only
  graduates past the threshold; any button still selects, matching the
  pre-drag mousedown behavior); pointerup resolves it as a select (no/
  below-threshold movement, including every middle/right-click gesture)
  or a reorder (moveTab + one render() + persistSession, mirroring every
  other order-affecting tab op's persist timing). The close button's own
  pointerdown stopPropagation keeps it immune to both. Selection resolves
  on release rather than eagerly on press specifically to dodge a
  reentrancy hazard: onSelect can cascade synchronously into main.ts's
  activate() -> showActive() -> tabs.render(), which rebuilds every tab
  element — resolving it only after this gesture's own teardown means
  that cascade never finds in-flight drag state pointing at a
  soon-to-be-detached node. Visual feedback is the dragged tab itself
  (translateX + existing --shadow-1/--bg-base tokens), not a separate
  placeholder element.
- [x] Indentation tools: detected indentation (tabs/spaces + width) in
  the status bar, indentUnit wired to the detection, Edit-menu convert
  leading tabs ⇄ spaces. Detection (`indentdetect.ts`, pure) is the
  classic heuristic: skip blank lines, classify each remaining line's
  leading run as tabs-only/spaces-only/mixed-within-a-line; any mixed
  line, or both tabs-only and spaces-only lines present, is "mixed"; only
  tabs-only is "tabs" (no width — a tab's display width isn't inferrable
  from the characters themselves); only spaces-only (including depth-0
  anchor lines) is "spaces", width = the *mode* of adjacent depth diffs
  in document order (not the first or largest — a lone deeper jump, e.g.
  a pasted nested block, doesn't outvote a consistent step; ties break to
  the smaller width), falling back to the smallest observed depth when no
  diff is computable at all (one indented line, or uniform depth with no
  baseline); no indentation anywhere is "none". `editor.ts`'s
  `detectIndentationOf` samples at most `INDENT_DETECTION_SAMPLE_LINES`
  (1000) lines from the start via `Text.iterLines` (never
  `doc.toString()`/a whole-document `sliceDoc`) — indentation style is
  established early and doesn't need the whole file, mirroring
  `encoding.rs`'s own bounded-sample detection. Status bar: "Spaces: N" /
  "Tabs" / "Mixed", hidden for "none" or no active doc — deliberately NOT
  hidden for a truncated large-file window (unlike text stats/suspicious
  chars): indentation is a "whatever's currently loaded" question, not a
  whole-file total a partial window would misrepresent. Computed
  immediately on tab switch/open/reload (`showActive`) and, debounced
  300ms (mirroring `scheduleTextStatsUpdate`), after edits/selection
  changes. CM6 wiring: a new per-buffer `indentation` Compartment
  (`EditorHandle.setIndentation`, mirroring `setReadOnly`/`setLanguage` —
  not auto-reapplied inside `swap`) sets `indentUnit`
  (`@codemirror/language`) and `EditorState.tabSize` from the detected
  style, falling back to a new `indentWidth`/`indent_width` preference
  (default 4, no dialog control yet — detection covers the common case)
  for "tabs" (tabSize only; indentUnit is still confidently `"\t"`) and
  "mixed"/"none" (both). Edit menu: "Convert Leading Tabs to Spaces" /
  "Convert Leading Spaces to Tabs" (`lineops.ts`, pure, bidirectional
  round-trip tested), added to the Line Operations submenu and routed
  through `runLineOperation`'s guard like Sort/Unique/Trim; both only
  touch each line's leading whitespace run (tab-stop-aware expansion /
  integer-division grouping with the remainder kept as spaces), using
  CM6's own live `tabSize` as "current effective width". `menu.rs` LABELS
  gained the two new ids across en/zh-TW/ja/zh-CN with pinned tests.

**Track D — robustness**
- [x] #113: save_document validates a commit-time file fingerprint before
  writing (size/mtime/Unix inode identity), fail-closing a stale-file
  overwrite instead of silently clobbering an externally-changed file;
  shared `fsguard.rs` module extracted from the streaming-replace guard
  (#94/#102), reused as-is. Frontend offers Reload/Overwrite/Cancel on
  conflict [danger]
- [x] #114: batch conversion's per-file commit (`convert_one` in
  `batch.rs`) validates the same commit-time fingerprint immediately
  before its `atomic_write`, fail-closing a stale-file overwrite instead of
  silently clobbering an externally-changed file mid-batch; reuses
  `fsguard.rs` (#113) unchanged, fingerprint tied to the same open handle
  the file is read through. One raced file fails independently and reports
  "changed on disk during conversion" — the rest of the batch still
  converts normally [danger]
- [x] #112: save completion is gated on a per-document revision snapshot —
  edits made while a save is in flight keep the tab dirty and keep the
  hot-exit backup instead of being silently marked as saved (pure
  decision table in `savecompletion.ts`, exhaustively unit-tested)
  [danger]
- [x] #115: reload-from-disk and reopen-with-encoding now drop the doc's
  hot-exit backup once its buffer is replaced by on-disk content —
  previously left behind, the stale backup was resurrected by the next
  launch's orphan recovery as a spurious dirty tab, reviving content the
  user had just explicitly discarded. `dropBackup` extracted out of
  main.ts (not unit-testable directly) into its own tested `backup.ts`
  module, mirroring the `savecompletion.ts` (#112) extraction [danger]
- [x] #117: batch conversion's 10 MiB size guard was a TOCTOU — the
  metadata size check and the full `read_to_end` were separate steps, so
  a file that grew past the cap between them still got read in full.
  `read_for_conversion` (`batch.rs`) is now split into
  `open_for_conversion` (metadata fast-path check + fingerprint) and
  `bounded_read`/`take_bounded` (the real guard: `Read::take(MAX_FILE_SIZE
  + 1)`, same technique as the #59/#69 large-file preview read), so the
  actual bytes pulled into memory are capped regardless of what the file
  grows to after the metadata check. Regression test grows the file
  through a second handle after the check passes and asserts the read
  stops at the take-limit sentinel, not the file's real (larger) size
  [danger]
- [x] #116: batch scan's folder walk (`collect_files` in `batch.rs`) used
  to silently `continue`/return `Ok(())` past an unreadable subdirectory or
  an entry whose metadata failed — the dry-run report looked complete
  while quietly missing whatever that subtree contained, risking a
  destructive convert over a report the user wrongly believed was
  exhaustive. The root folder failing to open now fails
  `scan_batch_conversion` closed (`Err`) instead of returning an
  empty-looking report; a subdirectory or entry failing mid-walk is
  instead recorded in a new `BatchScanReport.scan_errors` field and the
  walk continues with whatever it can still read. The batch panel shows a
  collapsible "N items could not be scanned" disclosure above the report
  (i18n'd across en/zh-TW/ja/zh-CN) and switches the Convert confirm
  dialog to a stronger, scan-error-count-naming message — the native
  confirm dialog covers the panel itself, so this is the only warning left
  at the actual moment of the destructive action. `execute_batch_conversion`
  semantics are unchanged: it still only converts the scanned, checked
  subset. Regression tests: a nonexistent root directory fails closed; a
  chmod 000 subdirectory and a chmod 0600 (no execute bit) parent both
  reproduce the two previously-silent failure modes deterministically and
  assert they land in `scan_errors` while the readable sibling still
  scans normally [danger]
- [x] #119 + #132: large-file line handling previously only recognized
  `0x0A` (LF) as a line terminator — the same blind spot #92 fixed in
  `encoding::detect_line_ending` — in two coupled places: the line index
  (`lineindex.rs`) counted a CR-only (Classic Mac) file as a single line,
  breaking Go to Line and bookmarks beyond the loaded chunk window
  (#119), and `chunk.rs`'s page alignment (`align_start`,
  `cut_tail_at_newline`, the prev-byte `at_line_start` check) shifted a
  correct lone-CR line-start offset to the next LF-line, so fixing the
  index alone would have made goto/bookmarks silently land on the wrong
  line in mixed-endings files (#132). Both now share one byte-level
  semantics module, `linebreak.rs`: LF, CRLF (counted once, never split),
  and lone CR all terminate a line, matching #92's three-way split. The
  streaming scanner's `pending_cr` flag carries across reads so a `\r\n`
  pair split across a chunk boundary stays one boundary; alignment treats
  an unresolved trailing CR as "not a complete terminator" (cut before
  it, or keep the whole chunk when it is the only candidate), so a page
  cut can never strand half a CRLF. Line-start checks now consult the
  neighbor pair (prev byte + first byte) because a CR directly followed
  by LF is a CRLF's interior, not a boundary. Regression tests: CR-only
  multi-line index and paging (every page starts and ends on a real line
  boundary, lossless), CRLF not double-counted, mixed LF/CRLF/CR file,
  trailing lone CR at EOF (no phantom line), both directions of the
  read-boundary split (CR|LF and CR|other-byte) for the index and the
  pager, end-to-end locate-then-read-chunk alignment for goto and
  backward paging, and helper-vs-scanner agreement locks in
  `linebreak.rs`; pure-LF and CRLF paging behavior is unchanged
  byte-for-byte [danger]
- [x] #120: large-file chunk IPC responses had no generation guard — a
  slow pageChunk/autoAppendChunk/prependChunk/gotoLargeFileLine response
  could land after a newer request (rapid Next/Next, a goto/bookmark jump
  racing a pager click) or a reload-from-disk/reopen-with-encoding had
  already moved the doc on, silently clobbering the buffer with stale
  content or a byte offset that no longer matched what was on screen.
  Every one of those five call sites now bumps a per-doc monotonic
  `chunkGeneration` counter (`tabs.ts` `Doc.chunkGeneration`, mirroring
  `scanGeneration` from #103) before firing its IPC call(s) and applies
  the response only if the generation still matches *and* the doc is
  still the active tab, via a shared, unit-tested `shouldApplyChunkResponse`
  (`chunkguard.ts`) — otherwise the response, success or error, is
  discarded outright with no mutation and no dialog. `ensureLineIndex`
  (goto's line-index build) is generation-checked too, so a reload can't
  resurrect a stale index after clearing it. The four request kinds also
  now share one per-doc `chunkLoadInFlight` guard (previously a single
  module-level flag that covered only auto append/prepend and could
  cross-block unrelated tabs), so none of them can overlap for the same
  doc; reload/reopen bump the generation and clear the flag unconditionally
  instead, since they preempt whatever's in flight rather than waiting on
  it. pageChunk's Prev no longer pops its offset history until the
  response is confirmed current, fixing a lost-history-entry bug on a
  failed or superseded Prev. Streaming replace's post-convert reload goes
  through the same `reloadFromDisk`, so it's covered without a separate
  path. Regression tests in `chunkguard.test.ts` simulate the exact
  call-site pattern (bump, await, guarded apply) for a rapid-Next/Next
  race, a tab-switch-during-load race, and a reload-during-load race, plus
  full branch coverage of the pure guard [danger]
- [x] #118: large-file paging silently skipped bytes when a single line
  exceeded `CHUNK_BYTES` (2 MiB) — `align_start`'s "skip forward to the
  next line start" is only safe when a *later* read can recover whatever
  it discards, true for backward paging but never true going forward.
  Once a chunk finally reached an overlong line's own closing terminator,
  the old `read_document_chunk` treated the mid-line continuation offset
  as "misaligned" and skipped past that terminator, discarding the entire
  unterminated remainder it was continuing (up to just under CHUNK_BYTES
  per occurrence). `read_document_chunk` now takes a caller-declared
  `OffsetKind`: a `continuation` offset (paging's own next_offset chain —
  either a genuine line start or a raw mid-line continuation point) is
  never realigned, read from exactly that offset and cut at the last
  complete terminator (or kept whole if none exists yet), while a
  `lineStart` offset (goto/bookmark jumps, riding on a line index that a
  missed watcher event can leave stale — mid-line, even mid-character) is
  verified and defensively realigned to the next real line start, falling
  back to a raw head-trimmed read when the window contains no line start
  at all — never an empty window, never a skipped one (goto is a fresh
  jump, so realignment there moves the window instead of losing bytes
  from an assembled sequence). `read_document_chunk_before` keeps
  `align_start` (backward paging's leading-fragment discard is usually
  safe — a further backward read recovers it) but no longer trusts a
  result that would consume the *entire* window: a CHUNK_BYTES backward
  window landing entirely inside one overlong line has its only
  terminator-like byte at the window's very last position (`end`'s own
  predecessor byte), and "skipping past it" used to collapse the chunk to
  empty with offset == end, hanging paging in place forever. A raw,
  non-terminator cut can also land mid-character; new
  `encoding::trim_truncated_utf8_head` (mirroring the existing
  `trim_truncated_utf8_tail`) fixes the boundary back up on both ends,
  gated to UTF-8 (the one paging-supported encoding where this can
  happen), with the same "never consume the entire window" guard on the
  backward head-trim. Regression tests: forward and backward round-trip
  across a ~12 MB unterminated line with normal lines on both sides (the
  exact byte-loss count is asserted directly), a minimal repro of the
  backward degenerate case, exact mid-line cut offset/character-boundary
  arithmetic for a multibyte (CJK) overlong line, the
  EOF/no-trailing-newline case, stale mid-line and mid-character goto
  offsets realigning to the next line start, a stale goto offset inside
  an overlong line falling back raw, and an all-continuation-bytes
  backward window staying an honest U+FFFD chunk instead of collapsing
  empty [danger]
- [x] Encoding round-trip fuzz expansion: deterministic-PRNG
  representable-text round-trips across all supported encodings plus
  mojibake-wizard reversibility fuzz (no new dependencies; scheduled
  before the Track A content transforms land). New `fuzz_roundtrip.rs`
  (test-only, `#[cfg(test)]`-gated): a hand-rolled xorshift64 PRNG (no
  prior fuzz/PRNG precedent existed in the crate to reuse, despite this
  item's premise — `streamreplace.rs`'s large tests are fixed-size, not
  randomized), one representable-text pool per encoding (full-Unicode
  sampling plus a curated control/astral/surrogate-pair edge set for
  UTF-8/UTF-16LE/UTF-16BE; encode-filtered common-script ranges for
  Big5/GBK/gb18030/Shift_JIS/EUC-JP/EUC-KR/windows-1252, each pool proven
  independently representable by its own sanity test before being trusted
  as a fuzz source), and fuzz tests asserting the #109-documented
  contract (text/encoding-label/BOM/line-ending survive a decode<->encode
  cycle — not byte-for-byte identity, which #109 already excludes for
  legacy non-injective mappings) across all ten encodings x 3 line
  endings x BOM states, plus `mojibake::REPAIR_PAIRS` reversibility for
  all 8 wizard hypotheses. 22 new tests at CI scale (~2s), plus two
  `#[ignore]`d 50x-larger variants for manual runs (verified to pass in
  release mode). No round-trip failures found.
- [x] Cycle close-out: version bump to 0.4.0, tag v0.4.0-alpha.1 (the
  draft-release workflow is billing-blocked — re-run it on the tag once
  Actions billing is restored; publish remains user-gated)

## v0.5 — feature cycle (planned 2026-07-15, delegated)

Scope planned autonomously under the user's 2026-07-15 delegation (same
model as v0.4: user away, plan the cycle, merge on green CI, post-merge
review). The plan passed an adversarial review before work started
(AGREE-WITH-CHANGES; every requested change adopted or explicitly
adjudicated in the session log). Theme: extend the v0.3/v0.4 trust
machinery (fsguard fingerprints, lossy two-phase gate, scan-error
surfacing, shared line-break semantics) to byte-level fidelity and
multi-file replace, and clear the open bug queue. Items marked
**[danger]** follow judgment overlay §1: failing-test-first, round-trip
tests, adversarial review before commit; danger items are never worked
in parallel. #89 is deliberately left open as the good-first-issue
surface for incoming contributors.

**Track R — debt & robustness** (bug queue first)
- [x] July dependency cadence: lockfile-level patch/minor float, no
  manifest changes, full local matrix green (merged as #156 ahead of
  this section — routine DIRECTION §7 policy, not new scope)
- [x] #136: explicit-encoding UTF-8 large-file preview applies the same
  tail trim gate as auto-detect (mid-character cut at the 2 MiB window
  edge misreports U+FFFD/malformed); real interior malformed bytes must
  still surface [danger]. The gate now asks "does the effective encoding
  resolve to UTF-8" via a new `encoding::is_utf8_label` that shares the
  same `Encoding::for_label` normalization as the actual decode — no
  WHATWG label spelling can make the gate and the decode disagree.
  `next_offset` takes the trimmed length, pinned by a
  `str::from_utf8(&full[..next_offset])` boundary assertion. The trim
  can never swallow a real EOF-malformed file: `truncated` requires
  total size > 10 MiB while the window is 2 MiB, so a trimmed tail is
  always strictly file-interior (adversarial review confirmed);
  interior bad bytes and ≤10 MiB files keep surfacing `malformed`
  unchanged, and auto-detect/UTF-16/legacy explicit paths are
  bit-identical to before (asserted by an explicit-vs-auto equivalence
  test). Same-shaped gap for explicit legacy multi-byte encodings
  (Big5/Shift_JIS/GBK — no UTF-8-style trim helper exists for them)
  found out-of-scope and filed as #165.
- [x] Chunk-paging property fuzz: deterministic-PRNG random operation
  sequences (Next/Prev/goto/append/prepend × line-ending mixes ×
  multi-byte boundaries) checked against whole-file ground truth;
  scheduled after the #136 fix (built first it would trip the known
  bug) and before the #134 paging change it protects [danger]. New
  test-only `fuzz_paging.rs` mirroring fuzz_roundtrip.rs's xorshift64/
  `#[cfg(test)]`/`#[ignore]`-variant organization: 12 fixtures (LF/
  CRLF/CR-only/Mixed × ASCII/CJK/astral, ~10 MB each — CHUNK_BYTES is
  a hard const with no injection point, so big-fixture/few-rounds; the
  overlong line is 3×CHUNK_BYTES, sized so stale-goto probes actually
  reach the no-terminator raw-fallback branch, measured 114/288 hits
  after an instrumented run showed the naive 1×-plus-epsilon sizing
  hit it 0/144 times) × four properties: forward-chain lossless
  reassembly against the whole file, chunk boundaries on real line
  starts or documented #118 exceptions, line-index goto offsets equal
  to an independently-derived ground-truth line table (zero shared
  code with linebreak.rs, cross-checked against build_line_index's own
  totals so oracle and prod can't self-certify), and same-seed
  determinism — plus a stale-goto boundary fuzz generalizing the #118
  follow-up regressions. Adversarial review (AGREE-WITH-CHANGES) added
  two fixes before commit: goto/stale-goto paths now assert full
  content equivalence against the ground-truth slice (an
  `OffsetKind::LineStart` off-by-one that kept offsets correct but
  dropped a content byte was previously invisible — exactly the region
  #134 is about to touch), and the stale-goto oracle no longer treats
  EOF as a legal realign target when the file ends in an unresolved
  lone CR or no terminator at all (prod correctly raw-falls-back
  there; masked today at ~3e-10/probe but would have become a false
  alarm the moment #134 touched EOF semantics). Suite: 351 tests
  (348 pass / 3 ignored), fuzz subset ~4s wall on a 12-core dev
  machine (expect ~11s on CI runners), release `--ignored` variant
  passes in ~31s.
- [x] #134: user-initiated goto/paging/bookmark jumps preempt an
  in-flight auto-append (bump generation + clear the in-flight flag,
  the reload precedent) instead of silently no-op'ing [danger]. New
  pure `preemptChunkLoad` helper (chunkguard.ts); pageChunk preempts
  only after its target/early-exits resolve, gotoLargeFileLine
  preempts at entry (its only early exits are an index-build failure
  that already shows an error dialog, or an empty file — a killed
  background auto-append re-triggers on the next scroll, so the
  trade-off is documented rather than fought). Auto append/prepend
  still yields (chunkpolicy.ts untouched, asserted by a test that
  throws if auto even issues a request). The classic preemption
  clobber hole is closed by construction: every request's cleanup is
  generation-guarded (`if (doc.chunkGeneration === myGeneration)`),
  so a preempted request's finally can never clear the winner's
  in-flight flag — verified per call site in adversarial review
  (AGREE). Prev's #120 peek-then-pop-on-confirmed invariant survives
  preemption (Prev-during-Prev pops history exactly once, asserted).
  Failing-test-first: the pre-fix assertions showed the bug was
  worse than a silent no-op — the user's target content lost to the
  stale auto chunk. +5 vitest (577 total); the harnesses are honest
  stand-ins for main.ts's orchestration (which needs a WebView), with
  the shared pure helpers imported for real.
- [x] #124: per-doc save/reload in-flight mutual exclusion — no more
  orphan backup or fingerprint/buffer divergence when a reload lands
  mid-save; second save deferred, watcher state re-evaluated on
  unlock [danger]. `Doc.saveReloadInFlight` ("save"|"reload"|null) plus
  single pending slots (`pendingReload`/`pendingSaveAs`, latest-wins),
  mirroring the chunkGeneration/chunkLoadInFlight per-doc convention;
  pure decision module `src/savemutex.ts` (`mustDefer`/`nextDrainStep`/
  `fingerprintsEqual`) exhaustively unit-tested per the #112
  savecompletion precedent, wired through `withLock`/`drainLock` in
  main.ts with saveFlow/reloadFromDisk split into entry gates plus
  verbatim-extracted bodies (whitespace-normalized diff verified zero
  behavior change in adversarial review). Drain runs the pending
  reload first, then the pending save gated on unlock-time
  `doc.dirty` — deliberately not the spec's original "revision
  advanced" test: dirty is edit-based and stays true after a failed
  save, so the dirty gate retries where a revision gate would silently
  drop the retry (reviewer judged this strictly better). A deferred
  reload is re-evaluated on drain against a fresh fingerprint (a save's
  own write never triggers its own reload; a genuine third-party
  change does), and — the review's one P2, fixed before commit —
  re-checks `doc.dirty` at drain time: edits typed while the save was
  in flight now get the same fileChangedMessage consent dialog as any
  dirty-doc external change (declining keeps buffer, dirty state, and
  hot-exit backup; consenting applies a second fresh read, deliberately
  not re-entering reloadFromDisk which would self-defer forever), and
  the internal stale-confirm reload self-defers onto its own lock's
  drain with no deadlock (verified across the full holder×entrant
  matrix). Save-IPC failure paths release the lock via finally and
  keep the retry path alive. +22 vitest (599 total; mutation-tested —
  a disabled mustDefer fails 9, a disabled dirty re-check fails 2).
  Same-shaped consent gap found in reopenWithEncoding filed as #169.
- [x] #128: batch scan classify_file switches to single-handle bounded
  read (#117's exact pattern) closing the metadata/read TOCTOU [danger].
  New `open_for_classification` (open_for_conversion minus the
  Fingerprint — a dry-run has no later commit to guard) feeding the
  #117 `take_bounded` helper verbatim; the oversize verdict now reads
  actual bytes pulled (`bytes.len() > MAX_FILE_SIZE`), literally the
  same test as the execute side. Boundary behavior (exactly-MAX,
  MAX+1, empty) unchanged; one deliberate hardening: an fstat failing
  on an already-open handle now classifies fail-closed as undecodable
  instead of the old silent `.unwrap_or(false)` pass-through
  (#116 spirit, surfaced to the user). Failing-test-first via a
  temporary unbounded stub (real assertion failure 10485801 vs
  10485761), regression test grows the file through a second handle
  after the check and asserts the read stops at the take-limit
  sentinel. Adversarial review AGREE (349 Rust tests).
- [x] #130: find-in-files collect_files records unreadable
  directories/entries as scan errors surfaced in the panel (#116's
  pattern) instead of silently skipping subtrees. `ScanError` and
  `SearchResults.scan_errors` on the Rust side (deliberately its own
  struct, not an import from batch.rs — the two walkers stay
  independent, as before); an unreadable root now fails the whole
  search closed (`Err`) instead of returning a zero-result report,
  the worst-case misread ("the string is gone") being exactly what
  #130 exists to prevent; mid-walk failures are recorded and the walk
  continues. Panel shows a collapsible "N items could not be
  searched" disclosure above the results (`fif-scan-errors*` classes
  following the file's own naming convention, styles mirroring the
  batch panel's), i18n across en/zh-TW/ja/zh-CN.
  Failing-test-first: field added returning an empty vec, three new
  Rust tests failed (nonexistent root, chmod-000 subdir, no-execute
  parent), then the real logic turned them green with the readable
  sibling still scanned. 352 Rust + 603 vitest.
- [x] #96 (1/3): streaming replace read-chunk byte-passthrough — a
  chunk with no match involvement, no decoder pending on either edge,
  and no carry in/out is copied byte-identical (the BOM-bearing first
  chunk always excluded); regions that are re-encoded are honestly
  disclosed; regression fixtures use the #96-verified non-injective
  byte pairs (Big5 8E 69, Shift_JIS 87 90, GBK A2 E3) [danger].
  Eligibility short-circuits cheapest-first: stateless encoding →
  no match/carry-out → no carry-in → decode self-sufficiency (a fresh
  `without_bom_handling` decoder over the raw chunk with `last=true`
  must reproduce the streaming decoder's exact text with zero
  malformed — for a stateless encoding this *is* segment correctness,
  since the whole file is the concatenation of segments that each
  cold-decode cleanly at character boundaries; the worst conceivable
  false negative degrades to the pre-fix re-encode, never to wrong
  bytes). The encoder still runs on every chunk (its state always
  advances); passthrough only chooses which buffer hits the disk.
  Adversarial review REJECTED the first version with a live-fire
  P1: ISO-2022-JP — encoding_rs's only stateful encoder, genuinely
  reachable via chardetng auto-detection — could leave the raw
  chunk's trailing shift-state (e.g. ending in Roman mode via ESC ( J)
  disagreeing with the encoder's internal state, so the next
  re-encoded chunk omitted its escape sequence and the file decoded
  to silently different text with had_errors=false — worse than the
  canonicalization being fixed. Closed by a stateless-encoding gate
  (`enc != ISO_2022_JP`, static-singleton identity, alias-proof —
  reviewer re-verified and lifted the REJECT); the corruption
  signature is pinned by a red→green cross-chunk fixture, and the
  lesson is recorded in the judgment overlay. New
  `StreamReplaceReport.unmatched_region_reencoded` field awaits the
  (2/3)/(3/3) UI. 360 Rust tests (26 in streamreplace, +8).
- [x] #96 (2/3): lazy byte-drift detection on a doc's first save —
  rebuild the full save pipeline (line-ending re-application + BOM)
  against the on-disk bytes and warn once, informed-consent style,
  before normalizing legacy byte variants; Mixed-line-ending files are
  skipped (their pipeline output is inherently unreproducible) [danger].
  New `bytedrift.rs::check_byte_drift(path, encoding, with_bom)`:
  re-reads the on-disk bytes, decodes via the same `decode_with` path
  an explicit open uses (adversarial review verified the label
  round-trip is exact and legacy encodings never hit BOM handling),
  re-detects the file's own line ending from disk — deliberately not
  the doc's current setting, so a user's explicit LF→CRLF conversion
  is never misreported as legacy-byte canonicalization (a review-caught
  false positive: the dialog would have blamed Big5 for a byte change
  the user themselves requested) — then applies apply_line_ending +
  encode + BOM re-prefix and memcmps. Skips (cheapest-first, Mixed and
  UTF-8/UTF-16 before any disk read, proven by nonexistent-path tests):
  Mixed line endings, Unicode targets (1:1 mappings), malformed files
  (the stronger malformed warning already owns those). Frontend gate
  (`bytedrift.ts`, injectable orchestrator + pure decision helpers)
  runs inside runSaveFlow's #124 lock before the stale/lossy gates,
  first save per doc per session only (`byteDriftChecked`, reset on
  reload/reopen, deliberately not persisted to the session store), and
  only for same-path saves (Save As has no baseline to drift from).
  Cancel aborts the save like the lossy gate; an IPC failure fails
  open for that save but leaves the flag unset so the next save
  retries (review-caught: setting it eagerly would have silenced the
  check for the whole session on a transient file lock). i18n across
  en/zh-TW/ja/zh-CN. Failing-test-first both rounds (stub → 7 of 10
  red; review fixes → 4 more red-then-green). 372 Rust + 616 vitest.
- [x] #96 (3/3): batch conversion dry-run report gains a per-file
  byte-drift flag (a same-encoding "no-op" conversion that would still
  canonicalize bytes becomes visible before execute) [danger].
  `BatchEntry.byte_drift`, computed only for alreadyTarget (no-op)
  files — the one case where the user expects bytes to stay put — via
  a new `rebuild_output_bytes()` extracted verbatim from
  `commit_conversion` so scan and execute can never disagree
  (adversarial review verified the extraction bit-for-bit and that
  execute never consumes the flag). The no-op test reuses batch's own
  alreadyTarget predicate including the BOM axis; Mixed-line-ending
  files skip per the (2/3) ruling, and the line-ending axis can't
  false-positive (a pure-LE no-op file round-trips exactly; any
  residue classifies as Mixed and is skipped). Since alreadyTarget
  rows are never checkable for execute, the badge is honest
  diagnostics ("would drift on re-save"), not an action warning —
  wording verified in review. Panel badge mirrors the malformed
  badge, drift count joins the summary line, i18n across four
  locales. Review AGREE; its one observation — a keep-encoding
  line-ending-only conversion still silently canonicalizes legacy
  bytes on convertible files, the deliberately-out-of-scope other
  half — is filed as #176. The (1/3) report field with no UI consumer
  yet is filed as #175. Failing-test-first via stubs on both sides
  (real red runs). 377 Rust + 622 vitest. #96 closed — all three
  stages landed.

**Track S — replace in files** (the new capability, built on Track R's
byte-preservation machinery)
- [x] Rust backend: line-scoped replace (search.rs's existing per-line
  match semantics) with line-level byte preservation — only matched
  lines are re-encoded, line-terminator bytes are copied verbatim,
  untouched lines stay byte-identical; UTF-16 falls back to whole-file
  re-encode (its mapping is 1:1, no drift); per-file fingerprint
  continuity from dry-run to execute (files changed in between are
  reported, never silently re-matched), atomic temp+rename, lossy
  two-phase gate, scan-error surfacing; regex match with literal-only
  replacement (no backrefs, v1 scope); the 5 MiB search cap carries
  over with oversized files disclosed as skipped; stateful encodings
  excluded by an ASCII-compat invariant test [danger]. New
  `replaceinfiles.rs` (`scan_replace_in_folder` /
  `execute_replace_in_folder` + ipc.ts bindings; the panel UI is the
  next item). Three reviewed design decisions: scan counts matches on
  linebreak.rs's three-way byte-level split rather than `.lines()`
  (which misses lone CR — dry-run and execute must agree on
  Classic-Mac files, pinned by an agreement test); a twin folder walk
  instead of reusing search.rs's collect_files (whose silent 5 MiB
  drop conflicts with skipped+reason disclosure; batch.rs set the twin
  precedent); and routing on encoding_rs's own
  `is_ascii_compatible()` — exactly {REPLACEMENT, UTF-16LE/BE,
  ISO-2022-JP} fall out, so the R1a stateful-encoder lesson is honored
  by construction (ISO-2022-JP whole-file fallback, shift-state
  self-consistent, pinned by a cross-line Roman-mode fixture), and
  REPLACEMENT can never reach a write (everything it decodes is
  malformed → skipped). The ASCII-compat invariant test sweeps all 40
  encoding_rs encodings over planes 0–1 empirically rather than by
  table. Lossy gate re-checks at execute time from the encoder's own
  unmappable flag (never trusting the scan's prediction);
  `regex::NoExpand` keeps replacements literal ("$1" writes
  literally). Mixed-line-ending files preserve every line's own
  terminator verbatim (whole-file bytes oracle). Adversarial review
  AGREE (seven attack surfaces held); its observations filed/tracked:
  ext-hint detection divergence vs open_document (#178), HTML
  numeric-reference lossy semantics to be spelled out in the panel's
  confirm wording (next item). 389 Rust tests (+12).
- [x] Frontend: replace field in the find-in-files panel + dry-run
  preview (files × hit counts × drift/lossy flags), per-file
  checkboxes, a batch-convert-strength destructive confirm, and a
  post-execute summary; i18n across en/zh-TW/ja/zh-CN. Pure logic
  (preview rows, confirm-message building, selection→execute-params,
  result classification) in a new `replaceinfiles-ui.ts` (the
  lossysave/bytedrift extraction precedent), DOM wiring in
  findinfiles.ts; plain search behavior untouched (original tests
  unmodified). Gate properties verified adversarially: busyReplace
  set synchronously before the confirm await (double-click test),
  targets/totals/confirm message snapshotted at one synchronous
  moment (checkbox flips during the dialog can't desync message from
  execute params), allowLossy true only when the *selected* set
  contains lossy files (unchecked lossy files don't raise it), the
  lossy wording names the HTML numeric-character-reference semantics
  outright, skipped files excluded at both the DOM and pure-function
  layers, and all five backend statuses render distinctly (failures
  can't vanish). Review-caught fixes landed before commit: the
  preview now surfaces `report.truncated` ("the rest of the folder
  was not scanned") — previously a 600-match folder showed 500,
  executed 500, and reported success with zero disclosure — and
  regex mode shows a "replacement is literal, $1 won't expand" hint
  before the user ever runs a scan. 684 vitest (+62 over the
  pre-item baseline).
- [x] Find-in-files query/replace inputs wired to the existing
  searchhistory module (localStorage datalist, the CM6-panel
  precedent). searchhistory.ts turned out to already be generic
  (shared find/replace MRU singletons behind plain functions) — a
  zero-line diff there; the panel builds its own two namespaced
  datalists mirroring editor.ts's private helper. Queries record on
  every resolved search; replace scans record query+replacement only
  after the non-stale generation check. History is shared with the
  CM6 panel structurally (same module singleton), asserted both
  directions in tests. 690 vitest (+6).

**Track E — encoding breadth [danger]**
- [x] Curated encoding list expansion: windows-125x family, common
  ISO-8859 members, KOI8-R/U, windows-874, macintosh (one-shot
  selection from encoding_rs's supported set), each addition with
  round-trip tests and a fuzz-pool entry; stateful encodings
  (ISO-2022-*) are permanently excluded, pinned by an ASCII-compat
  invariant test over the entire picker list. 11→27 choices
  (windows-1250–1258, ISO-8859-2/5/7/15, KOI8-R/U, windows-874,
  macintosh); every consumer (reopen/save-with/convert menus,
  preferences' default + per-extension tables, batch, compare
  preview) picks the additions up generically. The whitelist mirror
  reuses fuzz_roundtrip.rs's existing `ALL_ENCODING_LABELS` as the
  single Rust-side constant (no second mirror to drift), with
  back-references in both files; the invariant test asserts every
  label resolves to its canonical name and is ascii-compatible or
  UTF-16 — pushing "ISO-2022-JP" into the list fails it (verified
  red). 16 new encode-filtered fuzz pools each with a sanity test
  (single-byte encodings almost never malform, so the fuzz claim
  stays honest: it covers encode-side round-trips, not decode
  robustness); the release-mode 3000-case × 26-encoding ignored
  variant passes. Adversarial review AGREE — 68 display-name strings
  across four locales fact-checked (no language mix-ups), the
  windows-1258 Vietnamese combining-character non-injectivity attack
  held off (encoding_rs's single-byte path does no normalization;
  precomposed forms simply filter out), list correspondence 27↔26
  exact. Mojibake-wizard Cyrillic hypotheses (windows-1251⇄KOI8-R)
  filed as #182. 422 Rust tests (+33) + 690 vitest.
- [x] Encoding picker group headers (popup.ts section support:
  Unicode / East Asian / Western / Central European / Other), reopen
  and save-with-encoding menus kept in sync. Final grouping: Unicode
  4 / East Asian 6 / Western 2 / Central European 2 / Cyrillic 4 /
  Other 9. popup.ts gains an optional non-interactive header item
  (no click handler, no tab stop — the menu's native-focus
  interaction model makes that sufficient); the three other showMenu
  consumers are untouched. All three status-bar encoding menus
  (reopen / save-with / convert-file) share one grouped-items glue
  function; batch, preferences, and compare-preview `<select>`s use
  native `<optgroup>` (batch's index-based values preserved via an
  index map). `EncodingChoice.group` is optional — groupless entries
  (batch's "keep" pseudo-choice) are skipped by design. Group names
  i18n'd across four locales. 703 vitest (+13).
- [x] Detection-boundary documentation: single-byte families chardetng
  cannot reliably detect are labeled "manual reopen only" consistently
  in the detection diagnostics; no detection behavior change. The
  fact-check narrowed the premise considerably: per chardetng's own
  README (0.1.17, fetched verbatim), only four of the 27 picker
  entries can never come out of `guess()` — ISO-8859-15 and macintosh
  (listed "not detected"), gb18030 (always reported as GBK) and
  KOI8-R (always reported as KOI8-U); the windows-125x family,
  windows-874, ISO-8859-2/5/7 and KOI8-U are genuine detection
  targets (some with accuracy caveats), and UTF-16 is owned by the
  BOM layer. `MANUAL_ONLY_ENCODINGS`/`isManualOnlyEncoding`
  (encodings.ts, citation in comments) drive a new detection-boundary
  note in the detectcard diagnostics, shown only when the current
  encoding is one of those four; i18n across four locales. Full
  reference lives in a new `docs/encoding-detection.md` (decision
  order deliberately not restated — it points at
  `detect_with_extension`'s doc comment to avoid drift), with a
  one-sentence pointer added to ARCHITECTURE.md (approved). Also
  fixed a stray NUL byte in encodings.test.ts that made git treat it
  as binary. 714 vitest (+11).

**Track C — comfort (stretch: cut first under schedule pressure)**
- [x] Reopen closed tab (Mod+Shift+T, per-session stack, File menu
  entry, untitled tabs excluded). `ClosedTabsStack` pure module
  (LIFO, MRU dedup on re-closing the same path, cap 20, pop consumes
  even if the file has since vanished — the existing open-error
  dialog shows and the chain does not cascade); pushes happen only
  after a close is truly confirmed (cancel paths don't record).
  Cursor position rides along: the stack stores the offset the
  session snapshot already captures, and reopen feeds it through the
  existing `docFromOpened` clamp — no new persistence invented. The
  File menu item is this codebase's first dynamically-enabled plain
  MenuItem (`sync_reopen_closed_tab_menu`, disabled while the stack
  is empty), LABELS across four locales with the pinned-translation
  test. 725 vitest (+11) + 423 Rust (+1).
- [x] Tab context menu: Close Others / Close to the Right / Copy Path /
  Reveal in Finder(Explorer) via the already-bundled opener plugin
  (zero new dependencies; path items disabled for untitled tabs).
  Batch closes snapshot the target id set at click time and await
  each through the existing closeTab flow — a cancelled confirm
  (detected via stillOpen, closeTab doesn't throw) stops the chain;
  empty target sets disable their items (the Reopen Closed Tab
  precedent). Copy Path uses navigator.clipboard (this codebase's
  first clipboard use — zero new dependencies); reveal labels are
  platform-variant (Finder vs 檔案總管) via the existing userAgent
  convention; opener's default capability already includes
  allow-reveal-item-in-dir, so no capability change. Necessary
  drive-by: showMenu now picks its opening direction from available
  space — the previous always-above placement (fine for status-bar
  anchors) would have rendered a top-anchored tab menu almost
  entirely off-window; existing callers are unaffected (their
  above-space always wins). i18n across four locales. 746 vitest
  (+21).
- [x] Go to line supports line:column (column positioned within the
  loaded window in large-file mode). `parseGoToInput` (goto.ts, pure,
  exported) accepts a bare line or `line:column` with an exact
  grammar (`123:` equals `123`; `:45`, garbage, zero/negative, or
  overflow are invalid rather than leniently truncated); both parts
  1-based in UTF-16 code units, matching the status bar's Ln/Col
  convention. `editor.goToLine` gains an optional clamped column;
  the large-file goto positions the column within the reloaded
  window. Input switches numeric→text (colons), placeholder updated
  across four locales. 763 vitest (+17).

**Track H — outward & close-out**
- [x] README: add an Install section (GitHub Releases pointer +
  unsigned-build caveats for macOS/Windows) and an accuracy pass over
  existing content; no naming-heavy outward material while D1 is
  undecided; positioning red lines checked per DIRECTION §5-S13.
  Install section covers per-platform assets (with the Apple
  Silicon/Intel .dmg distinction), honest Gatekeeper/SmartScreen
  first-open steps, and a one-liner that signing/auto-update are on
  the roadmap. The accuracy pass replaced the stale "v0.1 MVP" status
  with an 8-bullet capability overview (kept deliberately
  changelog-free), fixed the missing Mixed line-ending mention, and
  fixed the Development quick-start that omitted the fresh-clone
  `npm run build` step (contradicting CLAUDE.md/CONTRIBUTING/
  dev-setup — a new contributor following it would have hit the
  `tauri::generate_context!` failure). Adversarial wording review
  (AGREE-WITH-CHANGES): red lines and factual claims held; its four
  precision notes landed — "26 curated encodings" (the picker's 27
  entries include the UTF-8/BOM pair), detection vs conversion scope
  split with a pointer to docs/encoding-detection.md, "byte-fidelity
  handling" over "guarantees", and the .dmg architecture hint.
  Screenshots left as an owner TODO comment (agents must not launch
  the GUI). 64→91 lines, zero competitor mentions.
- [x] Cycle close-out: version 0.5.0 bumped consistently, tag
  v0.5.0-alpha.1, zh-TW release notes, prerelease published (publishing
  pre-releases is delegated; final releases remain user-gated).
  Version bumped across tauri.conf.json/package.json/Cargo.toml plus
  both lockfiles; DIRECTION §2 updated to the v0.5 completion state
  in the same PR. Cycle totals: 21 items across five tracks, every
  danger item adversarially reviewed (one REJECT caught a P1 before
  it could ship), six issues closed, six follow-ups filed, tests
  333/572 → 423/763.

## v0.6 — feature cycle (planned 2026-07-16, delegated)

Scope planned autonomously under the user's standing delegation (user
away until 2026-07-22; same model as v0.4/v0.5: plan the cycle, merge on
green CI, post-merge review). The plan passed an adversarial review
before work started (AGREE-WITH-CHANGES; every requested change
adopted): three CJK↔CJK mojibake-pair candidates were dropped in
planning as the exact reachable-but-wrong shape mojibake.rs already
documents and rejects, E1's line-ending scan was bounded, C1 gained a
dispatch-safety acceptance criterion, and C3/V1 are marked first-to-cut.
Theme: clear the bug queue first, then extend the trust story from file
contents to behavior visibility (Document Info, command palette, user
docs), plus robustness groundwork. Items marked **[danger]** follow
judgment overlay §1: failing-test-first, round-trip tests where encoding
behavior changes, adversarial review before commit; danger items are
never worked in parallel. #89 stays open as the good-first-issue surface
for incoming contributors.

**Track R — debt & correctness** (bug queue first; ordered by execution)
- [x] #225: ISO-2022-JP overlong-line chunk paging silently mis-decodes
  continuation pages (each page's fresh decoder loses the previous
  page's shift-state; JIS two-byte content reads as ASCII with
  malformed=false) — exclude ISO-2022-JP from chunk paging, following
  the existing UTF-16 exclusion pattern; correctness over breadth (the
  full cross-page decoder-state carry was evaluated in planning and
  rejected as a high-risk redesign of the paging offset family)
  [danger]
- [x] #221: Save with Encoding racing another in-flight save/reload
  while the doc stays dirty=false can still dropSave the new encoding —
  encoding mutation bumps the revision and forces dirty, re-adjudicating
  #161's two existing confirm-dialog tests under the new semantics
  [danger]
- [x] #217: drainLock re-runs blockedByReadOnly immediately before
  executing a deferred save — a doc that became truncated during the
  defer window must not write its preview slice as the whole file
  [danger]
- [x] #223: reevaluateReload's opening clean-doc fetch gets the same
  identity guard as the post-confirm path (detached-doc mutation,
  benign but off-contract); models the reloadPrompts path in the
  asyncguard tests while there
- [x] #227: dedicated test pinning the head-trim displacement-absorption
  invariant (backward window start landing exactly on an ASCII+CJK
  boundary; trim fires and whole-file reassembly stays byte-exact)
- [x] #203: de-flake the two large-file streaming tests (fingerprint
  false positives under load) with a load-independent
  external-modification simulation instead of wall-clock-sensitive
  timing
- [x] #201: auto-detect on a truncated preview of a huge single-line
  legacy file can misclassify the window as single-byte with
  malformed=false — surface a "detected from a truncated sample" hint
  in the detection diagnostics (the issue offered confidence-lowering
  *or* disclosure as alternatives; disclosure was chosen, fully
  satisfying it) [danger]. Scoped to pure information
  disclosure, zero detection-outcome change: actually correcting the
  chardetng misjudgment was already deliberately punted by #165's own
  adversarial review (see the comment in `open_document`, lib.rs) as
  its own follow-up, and a statistical-model behavior change is much
  harder to bound safely than a new evidence field — same trade-off
  precedent as the Track A "Detection-boundary documentation" item
  above. `DetectionExplanation.largeFilePreview` (lib.rs's
  `explain_detection`) is true whenever the file exceeds
  `LARGE_FILE_THRESHOLD`, the same condition that sends
  `open_document`'s real auto-detect through the bounded
  `PREVIEW_BYTES` window instead of a whole-file read — deliberately
  distinct from `sampledBytes < totalSize` (this command's own,
  smaller `EXPLAIN_SAMPLE_BYTES` re-sample cap, true for any file over
  64 KiB regardless of whether the real open was truncated; conflating
  the two would warn about files that were never actually truncated).
  detectcard.ts's new `truncatedSampleNote` fires on `largeFilePreview
  && reason !== "bom"` — never for a BOM verdict, since a BOM is read
  from the first few bytes regardless of file size. i18n across four
  locales. Failing-test-first: a >10 MiB single-line Big5 fixture
  (reusing #165's `write_large_big5_fixture`) empirically reproduces
  the swing away from Big5 even at `explain_detection`'s smaller
  64 KiB sample (verdict: windows-874) — red before `largeFilePreview`
  existed (compile error), green after. Zero-diff equivalence:
  `encoding.rs` (`detect_with_extension`, `decode_auto_with_extension`,
  `decode_with`, `preview_slice`, all `trim_truncated_*` functions) is
  untouched by this change, so all pre-existing detection results stay
  bit-identical by construction, not just by re-running the suite. 481
  cargo test (+1), 850 vitest (+5).

**Track E — encoding transparency**
- [x] E1 Document Info dialog: one read-only trust surface, File > Document
  Info… (no accelerator), an in-DOM modal reusing the `.confirm-overlay`/
  `.confirm-dialog` family — `.detectcard-rows`/`.detectcard-note` for the
  row/note layout (lossysave.ts's read-only-list shape and detectcard.ts's
  dl-grid rows were the two nearest precedents; this borrows structure from
  both), a single "Close" button (Escape also closes; nothing here is
  destructive, unlike lossysave's deliberate no-Enter-shortcut). Untitled
  tabs get a reduced, buffer-only dialog rather than a disabled menu item —
  the item is always built enabled; `docinfo.ts`'s own module doc comment
  weighs this against the disabled-item alternative and explains why: a
  dynamic enable/disable sync (the `read_only`/`reopen_closed_tab`
  precedent) would need a new command plus correct calls from every
  tab-switch and Save-As completion, while a not-yet-saved buffer's own
  encoding/line-ending/text-stats facts are still genuinely useful to show.
  Path shows a "(not saved yet)" marker instead of size/mtime/detection
  evidence for that case.

  Rust: two new commands in a new `docinfo.rs` — `document_metadata`
  (fresh `fs::metadata` size + a hand-rolled signed milliseconds-since-epoch
  mtime, never `SystemTime`'s own serde impl, which rejects any pre-epoch
  instant outright; pinned by a dedicated pre-epoch test using
  `File::set_modified`, judgment-overlay.md §4's `EpochOffset` lesson
  applied independently rather than reused verbatim since this value is
  displayed, not round-tripped opaquely like `Fingerprint`) and
  `line_ending_distribution` (the LF/CRLF/lone-CR counts). Encoding + BOM +
  detection evidence reuses `explain_detection` as-is, unmodified — no new
  Rust needed there at all. Failing-test-first for the risky part: a
  deliberately-wrong stub (`line_ending_distribution` always returning
  zero counts) landed first, 6 of the 13 new `docinfo.rs` tests red against
  it (LF-only/CRLF/lone-CR/mixed/cross-chunk-boundary-CRLF/bounded-large all
  failed on the zero counts; empty-file and the ambiguous-trailing-CR-at-
  cutoff test passed vacuously against the stub, as expected, and remain
  real regression locks once real), then the real scan replaced the stub
  and all 13 went green.

  Line-ending scan reuse: extended `linebreak.rs`'s existing
  `scan_line_breaks` rather than writing a second scanner — its `on_break`
  callback now also reports a new `LineBreakKind` (Lf/CrLf/Cr) per
  invocation, a mechanical signature change propagated through its three
  pre-existing callers (`lineindex.rs` x2, `replaceinfiles.rs`), all now
  passing `_kind` and ignoring it; the same `pending_cr` cross-read carry
  this scanner already had is what makes the CRLF-split-across-an-8-MiB-
  chunk-boundary case correct for free, pinned by a dedicated test
  (`crlf_split_across_the_8mib_chunk_boundary_counts_as_one`) building a
  fixture with the CR as `CHUNK_BYTES`'s last byte and the LF as the next
  read's first. `lineindex.rs`'s own private `reject_utf16` was promoted to
  a shared `linebreak::reject_utf16(encoding, context)` (extracted for a
  second caller, the same precedent `fsguard.rs`/`streamcodec.rs` already
  set) rather than a second copy — raw byte-level LF/CR scanning is unsound
  for UTF-16 (0x0A/0x0D can be half of an unrelated code unit) but was
  verified *not* to need an ISO-2022-JP exclusion the way `chunk.rs`'s
  paging does (issue #225): that exclusion is about decode continuity
  across a page cut losing JIS shift-state, a concern that doesn't exist
  for a scan that never decodes at all, and ISO-2022-JP's JIS-mode byte
  pairs structurally never fall in the 0x0A/0x0D range regardless of shift
  state (documented on `line_ending_distribution` itself so a future
  caller doesn't defensively over-apply the paging exclusion here).

  Bounded-scan UI shape (the hard requirement — never an unlabeled partial
  statistic): exact counts for a file at or under
  `LARGE_FILE_THRESHOLD` (10 MiB), a leading-10-MiB sample beyond it,
  disclosed two ways at once — a "Scanned" row reusing detectcard.ts's own
  `sampledAll`/`sampledPartial` phrasing verbatim ("first 10 MB of 15 MB"),
  *and* a separate, explicit `docinfo.lineEndingSampledNote` sentence
  ("Counted from the first 10 MB of this file only — these counts do not
  reflect the whole file") whenever `scannedBytes < totalSize`. An
  unresolved trailing CR landing exactly at the bounded cutoff is left
  uncounted rather than guessed (it might be half of a CRLF whose LF sits
  just past the sample) — `is_full_scan` is decided once, upfront, from the
  same `fs::metadata` read that sets the bound, not inferred from read-loop
  short-reads, and only resolves the trailing-CR-at-EOF case
  (`lineindex.rs`'s own convention) when the scan genuinely covered the
  whole file; pinned by
  `trailing_cr_exactly_at_the_bounded_cutoff_is_not_counted` alongside
  `bounded_scan_stops_at_large_file_threshold` (terminators planted just
  past the bound are proven invisible to the scan). A UTF-16 document skips
  the IPC call entirely on the frontend (mirroring `chunkpolicy.ts`'s own
  "spare a doomed round trip, Rust is still the real guard" precedent) and
  shows a clean localized note instead of a raw Rust error string.

  Encoding section reuses detectcard.ts's data flow and formatting, not
  just the IPC: `formatDetectionCard` was split into a new, exported
  `formatDetectionEvidence` (BOM/verdict/sampled-range/would-choose rows
  plus all three notes — manual-override, detection-boundary, and the
  large-file truncated-sample warning from the immediately preceding R
  track item) and a thin wrapper that adds the "File"/"Currently using"
  framing back for its own status-bar popup; `formatDetectionCard`'s
  existing 20 tests still pass unchanged, proving the refactor is
  behavior-preserving. Document Info's own Encoding row (from `doc.encoding`
  /`doc.withBom`, the same `statusbar.encodingWithBom` template the status
  bar itself uses) sits above the reused evidence rows rather than
  duplicating detectcard's own "Currently using" row a second time.

  Text stats reuse `editor.ts`'s `textStatsOf` precomputed by the caller
  (main.ts, mirroring `computeAndShowTextStats`'s own `doc.truncated ? null
  : textStatsOf(editor.snapshot())` exactly) — `docinfo.ts` deliberately
  never reaches into `editor.ts` itself, matching every other dialog
  module's decoupling from the live CM6 instance. Truncated (large-file
  preview) windows omit the text-stats section entirely, matching the
  status bar's own hide-when-truncated convention precisely (never a
  "window"-qualified partial value) — deliberately different from the
  line-ending distribution's own always-show-a-labeled-sample treatment,
  since the two data sources have different guarantees: the Rust scan
  independently re-derives a real bound from fresh disk metadata, while
  text stats only ever have whatever's currently loaded in the buffer with
  no reliable whole-file denominator to label a partial count against.

  Each of the three IPC-backed sections (file metadata, encoding evidence,
  line-ending distribution) fails independently: `Promise.all` over three
  never-rejecting per-call adapters (`fetchOrError`) so one section's
  genuine failure (file deleted since the tab was opened, etc.) shows an
  inline, localized error note in that section alone, never a blank dialog
  or a silently-missing fact. Snapshot semantics: every call fires once, on
  open; the dialog does not live-refresh on external changes while open
  (closing and reopening re-snapshots), the same trade-off
  `explain_detection`'s existing callers already make.

  i18n: new `docinfo.*` keys across en/zh-TW/ja/zh-CN, reusing
  `menu.lineEndingLf`/`Crlf`/`Cr` verbatim as the three distribution rows'
  labels and `detectcard.sampledAll`/`sampledPartial` verbatim for the
  "Scanned" row's value, rather than parallel new strings for the same
  concepts. `menu.rs` gained the `document_info` `LABELS` entry (File menu,
  after Print) with a pinned-translation test mirroring `read_only`'s.
  497 cargo test (+16, all in `linebreak.rs`/`docinfo.rs`/`menu.rs`), 871
  vitest (+21, all in `docinfo.test.ts`).
- [x] E2 mojibake repair pair, narrowed by planning review: evaluated
  (WINDOWS_1252, EUC_JP) — the CJK↔CJK candidates remain the documented
  reachable-but-wrong dead end, out of scope here. Both required gates
  passed, so the pair was **included**, not withdrawn — a withdrawal was
  the equally valid other outcome per the planning gate, but the
  evidence went the other way this time [danger]

  Gate 1 (reachability), checked at the source level before writing any
  fixture: chardetng 0.1.17's `src/lib.rs` carries a real, positively-
  detected EUC-JP candidate (`EucJpCandidate` struct,
  `EncodingDetector::EUC_JP_INDEX = 4`, one of the 27 candidates wired
  into the array `EncodingDetector::new()` builds) — structurally unlike
  the KOI8-R dead end (judgment-overlay.md §4): chardetng's own README
  lists EUC-JP under "Detected: Historical locale-specific fallbacks",
  never aliased away the way KOI8-R→KOI8-U is, and chardetng's own test
  suite pins `check("これは文字実験です。", EUC_JP)`. Confirmed
  empirically, not just structurally, by failing-test-first:
  `mojibake.rs`'s new `repairs_eucjp_misdecoded_as_windows1252` (a
  diverse three-sentence Japanese fixture mixing kanji/hiragana/
  katakana, distinct from the existing `SHIFT_JIS_TEXT`) was red before
  the pair existed in `REPAIR_PAIRS` (`detect_mojibake` returned no
  candidate) and green after.

  Gate 2 (mutual ambiguity, ISO-8859-5 precedent shape), three checks,
  all green: (a) `windows1252_eucjp_reverse_hypothesis_is_rejected` — the
  reversed hypothesis, (EUC_JP, WINDOWS_1252), does not also pass
  `try_repair` on the same genuine-EUC-JP-as-1252 mojibake, unlike the
  excluded ISO-8859-5 case; (b)
  `no_candidates_for_normal_western_european_text` — a realistic French
  windows-1252 paragraph (distinct from the narrower, purpose-built
  `LATIN1_SUPPLEMENT_TEXT` fixture) does not trigger a false-positive
  (windows-1252, EUC-JP) candidate; (c)
  `windows1252_eucjp_pair_does_not_shadow_existing_cjk_pairs` — genuine
  Big5- and Shift_JIS-as-windows-1252 mojibake still resolve to their own
  correct pair only, with the new EUC-JP hypothesis never also firing
  alongside them.

  `REPAIR_PAIRS` grew from 9 to 10 entries. `fuzz_roundtrip.rs`'s
  `run_mojibake_reversibility_fuzz` has an exhaustive match over the
  array that panics at runtime (not a compile error) on any unhandled
  pair, so `MojibakePools` gained an `euc_jp` field (`euc_jp_pool()`
  already existed for the plain round-trip fuzz, just wasn't wired into
  the mojibake-specific pool struct) and the match gained a
  `("windows-1252", "EUC-JP")` arm — caught by actually running the fuzz
  test, not by inspection. 3,000-cases-per-pair manual fuzz
  (`large_mojibake_repair_reversibility_fuzz_3000cases_per_pair`) run
  explicitly for extra confidence given the danger-domain status. 501
  cargo test (+4, all in mojibake.rs), 871 vitest (unchanged — no
  frontend touched; `src/mojibake.ts` is pair-agnostic by design, it only
  ever renders whatever `detect_mojibake` returns).

**Track C — comfort**
- [x] C1 Command palette (Mod+Shift+P): a fuzzy-searchable overlay
  (src/palette.ts) over every dispatchable native-menu command — pure
  discoverability, no new capability. Rust: `menu::palette_commands(locale)`
  (menu.rs) returns LABELS as `(id, label)` pairs already resolved to the
  caller's locale (same "already-resolved, never system" contract as
  `retitle_menu` — the frontend passes `i18n.ts`'s `getLocale()`), filtered
  through a new `PALETTE_EXCLUDED_IDS`: the 6 pure submenu containers
  (file/edit/view/line_ops/theme/window, which have no `plume://menu` case
  of their own) plus the palette's own entry, since opening the palette
  from inside itself isn't useful. LABELS grew to 57 entries (the new
  `command_palette` id); 7 excluded, 50 real commands surfaced — both
  counts pinned by dedicated tests rather than asserted as a magic number.

  Frontend: `fuzzyMatch` (palette.ts) is a hand-rolled, case-insensitive,
  greedy-leftmost subsequence matcher (no new dependency) — each query
  character claims the earliest position in the label after the previous
  character's claim, a documented simplification over an optimal DP-based
  scorer, pinned by a dedicated test showing it is not always optimal
  ("ababc" vs query "abc"). Scoring weights consecutive matched-character
  runs (`CONSECUTIVE_RUN_WEIGHT = 1000`) heavily enough to dominate an
  earlier-position tiebreak, matching the plan's "connected runs
  preferred, earlier position preferred" spec exactly.
  `filterAndSortCommands`/`moveSelection`/`clampSelectedIndex` are
  extracted, pure, and fully vitest-covered (23 new tests) — an upgrade
  over quickopen.ts's own precedent, which inlines equivalent navigation
  math untested. `showPalette` otherwise mirrors `showQuickOpen`'s
  overlay/panel/input/list shape almost exactly (own `.palette-*` CSS
  namespace reusing styles.css tokens — same per-module-namespace
  convention as `.goto-*`/`.fif-*` alongside `.quickopen-*`), and stays
  DOM-untested like every other dialog module in this codebase.

  Dispatch: the `plume://menu` listener's switch body was extracted into a
  named `dispatchMenuCommand(id)` (main.ts) so the palette's `onRun`
  callback can call the exact same function the native menu calls — a
  direct synchronous call, not a simulated IPC round trip — guaranteeing
  the two entry points can never diverge. Danger-lite guard audit (the
  plan's acceptance criterion): every case was checked against no-active-
  doc/truncated/read-only. Every line-operation case already gates through
  `runLineOperation`'s `blockedByReadOnly` + no-doc check; `saveFlow`,
  `toggleReadOnly`, `handleGotoLine`, `toggleBookmarkFlow`/
  `nextBookmarkFlow`/`previousBookmarkFlow`, `stream_replace`, and
  `document_info` each already have their own no-doc (and, where
  relevant, truncated/read-only) check; the remaining cases are
  state-independent by construction (preference toggles; dialog openers
  not scoped to the active doc; non-mutating CM6 selection/search/fold
  commands, which self-no-op on an unmet precondition rather than throw —
  verified from source, not assumed). The one bare case found was `print`
  (no doc guard at all, though harmless in practice since
  `editor.content()` never throws) — given a defensive
  `if (!tabs.active) break;` for consistency with its
  `stream_replace`/`document_info` siblings.

  Shortcut: `CmdOrCtrl+Shift+P`, a native View-menu accelerator
  ("Command Palette…", first item, above a new separator) rather than a
  second JS-level keydown binding — mirrors this file's own "menu
  accelerators own the shortcut, the frontend must not also bind it"
  convention already used for the file shortcuts. Verified no collision:
  grepped the installed `@codemirror/*` bundles for any `Shift-p` keymap
  entry (none exist) and confirmed no other menu.rs accelerator uses
  Shift+P (`open_recent` already owns plain `CmdOrCtrl+P`). `retitle_menu`
  gained the new item to its relabel sweep. i18n: `command_palette` LABELS
  entry across en/zh-TW/ja/zh-CN with a pinned-translation test mirroring
  `read_only`'s; `palette.searchPlaceholder`/`palette.noResults` in
  i18n.ts across the same four locales (the palette's own chrome text —
  command labels themselves come from menu.rs, not this dictionary, same
  split as every other menu-adjacent feature per this file's header
  comment).

  Failing-test-first: palette.test.ts was written and run red (`Failed to
  resolve import "./palette"`) before palette.ts existed; menu.rs's new
  test-module additions (referencing not-yet-existing `palette_commands`/
  `PALETTE_EXCLUDED_IDS`) failed to compile before being implemented; both
  went green after. 504 cargo test (+7, all in menu.rs), 894 vitest (+23,
  all in palette.test.ts).
- [x] C2 join lines / reverse lines: `lineops.ts` gained `reverseLines`
  (`sort`/`unique`'s own "no selection = whole document" convention via
  `editor.transformLines` — no span logic of its own; a trailing newline is
  tracked as a flag, not a line of its own, same as `sortLines`/
  `uniqueLines`, so it never itself relocates: `"a\nb\nc\n"` reverses to
  `"c\nb\na\n"`, not `"\nc\nb\na"`) and `joinLines` (merges every line in
  the given span into one: each subsequent line's leading whitespace
  stripped, exactly one space at the seam, a trailing-whitespace run
  already at the seam collapsed rather than stacked with the inserted
  space, and a blank/whitespace-only line contributing nothing at all —
  not even a space — so joining across one never doubles up). Join Lines'
  selection semantics are deliberately unlike every other Line Operations
  item: mainstream editors conventionally join the
  cursor's line with the *next* one when there is no selection (or the
  selection is confined to a single line), never the whole document — a
  new `EditorHandle.joinLines(fn)` (editor.ts), sibling to
  `transformLines`/`transformSelection`, and its pure span helper
  `joinLinesSpanInDoc` (same to-1 issue #99 convention as
  `lineSpanForSelectionInDoc`, oracle-tested the same way) compute that,
  returning `null` (a no-op) only when the cursor/selection is already on
  the document's last line — including the subtlety that a document
  ending in "\n" has a genuine empty CM6 line after it, so the *previous*
  (content-bearing) line still has a next line to pull in; whether joining
  onto it is worth anything is `joinLines`'s own call once it sees the
  sliced text. Both new commands route through `dispatchMenuCommand`'s
  existing `runLineOperation` guard exactly like every other line op, and
  neither needed a dialog or `i18n.ts` entry — same "no chrome, no
  dictionary entry" precedent as sort/unique/trim/case/width. `menu.rs`
  LABELS gained `reverse_lines` ("Reverse Lines"/"反轉行"/"行を反転"/
  "反转行") and `join_lines` ("Join Lines"/"合併行"/"行を結合"/"合并行")
  across en/zh-TW/ja/zh-CN with pinned tests; neither is in
  `PALETTE_EXCLUDED_IDS` (both are real dispatchable commands), so both
  surface in the Command Palette for free, and
  `palette_commands_includes_every_non_excluded_label`'s dynamic count
  assertion picked them up with no test change needed.

  Failing-test-first: `joinLines`/`reverseLines` (lineops.test.ts) and
  `joinLinesSpanInDoc` (editor.test.ts) were run red (`joinLines`/
  `reverseLines`/`joinLinesSpanInDoc` is not a function) before the
  implementations existed; menu.rs's two new pinned-translation tests
  panicked on the not-yet-existing `"join_lines"`/`"reverse_lines"` ids
  before their `LABELS` entries were added. 510 cargo test (+2, both in
  menu.rs), 927 vitest (+33: 24 in lineops.test.ts, 9 in editor.test.ts).
- [x] C3 sort variants: `lineops.ts` gained `sortLinesCaseInsensitive`
  (same `compareCodePoints` comparison `sortLines` uses — locale-
  independent, not `localeCompare` — applied to each line's
  `toLowerCase()` form; lines that only differ by case keep their
  original relative order via `Array.prototype.sort`'s ES2019 stability)
  and `sortLinesNumeric` (sorts by the first embedded number in each line,
  `-?\d+(?:\.\d+)?` leftmost match: a `-` immediately adjacent to the
  digits reads as its sign, e.g. `"temp -5"` → -5 and `"chapter-5"` → -5
  via the same adjacency rule, but `"a - 5"` (space before the digit) →
  +5, the space breaking the sign association; a bare leading-dot decimal
  like `".5"` is deliberately not specially handled, matching only `"5"`,
  same "deliberately narrow" spirit as `toHalfWidth`/
  `trimTrailingWhitespace`'s own documented scope limits; lines with no
  number sort after every line that has one; ties — equal numbers or two
  number-less lines — keep their relative order via a `compareNumbers`
  comparator that returns exactly 0 for equal keys, deliberately not a
  bare `a - b`, since two `Infinity` "no number" sentinels would subtract
  to `NaN`, which `Array.prototype.sort` does not guarantee to treat as
  "equal"). Both are plain `splitLines`/`linesToText` transforms with no
  span logic of their own, same "no selection = whole document" scope via
  `editor.transformLines` as `sortLines`/`uniqueLines`/`reverseLines`
  above — no `editor.ts` changes needed. Routes through
  `dispatchMenuCommand`'s existing `runLineOperation` guard exactly like
  every other line op; no dialog or `i18n.ts` entry needed, same
  precedent as sort/unique/trim/case/width/join. `menu.rs` LABELS gained
  `sort_lines_case_insensitive` ("Sort Lines (Case-Insensitive)"/"排序行
  （不分大小寫）"/"行を並べ替え（大文字小文字を区別しない）"/"排序行
  （不区分大小写）") and `sort_lines_numeric` ("Sort Lines (Numeric)"/
  "排序行（數值）"/"行を並べ替え（数値）"/"排序行（数值）") across
  en/zh-TW/ja/zh-CN with pinned tests; neither is in
  `PALETTE_EXCLUDED_IDS`, so both surface in the Command Palette for free
  and `palette_commands_includes_every_non_excluded_label`'s dynamic
  count assertion picked them up with no test change needed.

  Failing-test-first: `sortLinesCaseInsensitive`/`sortLinesNumeric`
  (lineops.test.ts, 24 new cases covering mixed case, numeric prefixes
  anywhere in the line, no-number lines sorting last, negative/decimal
  numbers, the hyphen-adjacency sign rule, and stability for both
  case-only and numeric ties) were run red (`sortLinesCaseInsensitive`/
  `sortLinesNumeric is not a function`) before the implementations
  existed. 518 cargo test (+2, both in menu.rs), 951 vitest (+24, all in
  lineops.test.ts).
- [x] C4 clear recent files: clear_recent_files command + a File > Open
  Recent > Clear entry (recent.rs currently had only load/add). Clear
  writes an empty list through the same store::write_json path add uses
  and returns it so the frontend cache mirrors disk exactly. Went one
  step past the spec: the item is enabled/disabled dynamically
  (sync_clear_recent_menu, following syncReopenClosedTabMenu's existing
  plain-MenuItem sync precedent) — disabled when the list is already
  empty rather than a silent no-op click; initial state set at
  menu-build time straight from disk. LABELS ×4 with a pinned
  translation test

**Track V — robustness**
- [x] V1 session forward-compat fixtures: hand-written old-shape session
  JSONs (v0.1-era field sets) must load with correct defaults — pins
  the serde-default compatibility contract; no version field added
  (YAGNI). Three real eras established from actual tags (git show, not
  imagined): v0.1.0-alpha.1 had only required path/encoding; alpha.7
  through v0.3.0-alpha.1 added cursor/backup/title/withBom/lineEnding;
  v0.4.0-alpha.1+ added userReadOnly. Six new fixture tests in
  session.rs: per-era minimal + populated shapes, an
  all-defaults-when-absent sweep asserting every defaultable field, and
  an unknown-future-fields test pinning non-deny_unknown_fields
  behavior. Contract proven by mutation: removing one field's
  #[serde(default)] turns 7 of 9 session tests red, restored green.
  `encoding` has been required in every era — intentional, noted in a
  code comment
- [x] V2 IPC error-path audit: inventoried every #[tauri::command]'s
  frontend call sites for catch/error surfacing across all 45 commands —
  A20 already surfaced a dialog, B20 deliberate best-effort (ambient
  persistence/menu-sync where a silent failure never misrepresents
  anything, since the live UI already reflects the new value), C0
  silently swallowed with no fallback at all, D5 no-op/inert regardless
  of outcome. Fixed the 4 B-class sites where the existing silent catch
  reads as success to the user: load_backup (both main.ts call sites —
  restoreFromBackup's session-tracked restore and the orphan-recovery
  loop) and list_backups now warn once after session restore instead of
  silently resurrecting nothing or skipping the orphan safety net with
  zero signal (fired with `void`, not awaited, so the warning can't delay
  opening files an OS "Open With"/CLI launch passed in); take_pending_files
  warns instead of dropping those OS/CLI files with no clue why they
  never opened; the Preferences dialog's Save button now keeps the
  dialog open and shows the IPC error instead of closing as if the write
  had succeeded — its other six savePreferences call sites (ambient
  font/theme/view-toggle persistence) are untouched, same reasoning as
  the B-class calls left alone elsewhere. The remaining 16 B-class sites
  were reviewed and left as-is; no showIpcError abstraction was
  introduced (all 4 fixes reuse the existing messageDialog+String(error)
  convention). dialog.* i18n keys ×7 ×4 locales (en/zh-TW/ja/zh-CN); 955
  vitest (+4, new preferences.test.ts covering the Save-button failure
  path — main.ts's three fixes are IPC/DOM glue with no dedicated test,
  same as its other ~8 existing messageDialog call sites), 522 cargo test
  unchanged (no Rust touched)

**Track H — outward** (positioning red lines apply: no competitor names)
- [x] H1 CHANGELOG.md: Keep-a-Changelog backfill from v0.1.0-alpha.1
  through v0.5.0-alpha.2; DIRECTION §7 release checklist gains "update
  CHANGELOG in the same PR"
- [x] H2 docs/features.md: encoding-features guide (detection,
  reopen/save with encoding, mojibake wizard, batch conversion,
  side-by-side preview, hex preview, character inspector,
  normalization, large-file mode, find/replace in files); English; no
  screenshots (agents must not launch the GUI)

  Text-only user guide (250 lines), one section per feature — what it
  does, how to trigger it (menu path or status-bar click chain, with
  keyboard shortcut where one exists), and its behavior boundaries
  (disabled/hidden states, size thresholds, encoding-specific
  exclusions). Structured as intro → Encoding (14 features, including
  this cycle's new Document Info dialog and the existing detection
  diagnostics popup/truncated-sample warning) → Large files (preview
  mode, streaming find/replace, streaming convert) → Find and replace in
  files → Everyday editing (brief). Cross-links docs/encoding-detection.md
  for the full detection decision order rather than restating it.

  Every trigger path and boundary claim was verified against source
  (`menu.rs` LABELS/accelerators for native menu items and shortcuts,
  `main.ts`'s status-bar popup builders for the encoding/line-ending/
  decode-warning/char-inspector click chains, and the relevant frontend
  + Rust modules for behavior — e.g. `chunk.rs`/`chunkpolicy.ts` for the
  10 MB/2 MB/8-chunk large-file constants, `replaceinfiles.rs` for the
  5 MB/500-item find-in-files caps) — no UI path was written from
  memory. README.md's "What's there today" list gained a one-line
  pointer to this file. No screenshots; agents cannot launch the GUI.

- [x] Cycle close-out: version 0.6.0 bumped consistently across
  tauri.conf.json/package.json/Cargo.toml plus both lockfiles;
  CHANGELOG's Unreleased section finalized as v0.6.0-alpha.1 (with the
  post-backfill items — clear-recent, IPC error surfacing, docs —
  folded in); DIRECTION §2 updated to the v0.6 completion state in the
  same PR; tag v0.6.0-alpha.1 with zh-TW notes, prerelease published
  under the standing delegation (final releases remain user-gated).
  Cycle totals: 19 items (17 execution + planning + close-out) across
  five tracks, 20 PRs (#229–#249 range), every danger item
  adversarially reviewed, two P3 follow-ups filed (#231, #236), the
  whole inherited bug queue closed (#201/#203/#217/#221/#223/#225/
  #227), tests 831/476 → 955/522

## v0.7 — consistency, serialization & daily-driver closure (planned 2026-07-18, delegated)

Scope planned autonomously under the user's standing delegation (user
away until 2026-07-22; same model as v0.4–v0.6: plan the cycle, merge on
green CI, post-merge review). Planning was preceded by a four-agent
current-state audit, so nothing below re-plans something that already
exists (Enter auto-indent, move/duplicate line, status-bar text stats,
tab context-menu copy-path/reveal were all confirmed present and
excluded), and the plan passed an adversarial review before work started
(AGREE-WITH-CHANGES; every requested change adopted — see per-item
notes). One structural constraint shapes the cycle: **no GUI can be
launched** (user away, desktop possibly locked, standing caution), so
editor-UX items are built as pure-logic cores with thin CodeMirror
bindings, vitest-covered, and dual-WebView manual acceptance is
explicitly deferred to the user's return; only two such items (the trim
and in-selection ones) are admitted, per the review's cap. Theme: close
the remaining consistency gaps (snapshot reads, write serialization),
deepen the mojibake table by investigation, and finish the
daily-driver comfort backlog that needs no GUI. Items marked
**[danger]** follow judgment overlay §1: failing-test-first, round-trip
tests where encoding behavior changes, adversarial review before
commit; danger items are never worked in parallel. #89 stays open as
the good-first-issue surface.

**Track R — debt & correctness** (ordered by execution)

- [x] #231: clean doc's Save with Encoding leaves a spurious dirty flag
  after a non-stale write failure — the rollback branch restores
  encoding/withBom but not dirty; capture the revision at force time
  and restore dirty=false when the rollback condition holds and the
  revision is unchanged; also reconcile the backup flush already
  scheduled for the rolled-back state (adversarial-review addition)
  [danger]
- [x] #254 (remaining half): one consistent-snapshot backend command
  for Document Info — a single Rust command opens the file once and
  derives all three sections (file metadata, detection evidence,
  line-ending distribution) from that one read, replacing the three
  parallel IPC calls in docinfo.ts; the response keeps per-section
  Result fields so the dialog's existing per-section error degradation
  survives (adversarial-review addition); explain_detection itself
  stays, detectcard.ts uses it independently [danger]
- [x] #236: per-process fixture_dir isolation for the five listed test
  files (batch.rs, fsguard.rs, replaceinfiles.rs, search.rs,
  streamcodec.rs), applying the #237 pattern; sweep the other
  fixed-temp-name test files in the same PR where the same mechanical
  change applies
- [x] prefs + session write serialization: every savePreferences call
  site (preferences.ts, 7 sites) and persistSession path (main.ts, 8
  sites) goes through an op queue — per-file queue, snapshot captured
  at enqueue time (both adversarial-review additions) — closing the
  same late-write-overwrites-newer race #270 closed for recent files
  [danger]

**Track E — encoding trust**

- [x] mojibake-pair investigation batch: ran the dual gate (chardetng
  reachability + reverse-hypothesis rejection) over the candidates
  (WINDOWS_1251, UTF_8), (EUC_KR, UTF_8), (EUC_JP, UTF_8),
  (WINDOWS_1250, UTF_8), and — last, cheapest-death-first per the
  adversarial review — (KOI8_U, WINDOWS_1251); all five passed both
  gates and were admitted (unlike issue #182/v0.6 E2, this batch found
  no rejections — see `REPAIR_PAIRS`'s doc comment in mojibake.rs for
  each pair's written evaluation), with the mandatory
  fuzz_roundtrip.rs MojibakePools/match-arm sync done and verified via
  `cargo test fuzz` (known runtime-panic dead end, overlay §4);
  docs/encoding-detection.md updated in the same PR [danger]

**Track C — comfort** (no-GUI shapes; manual acceptance deferred where noted)

- [x] go to matching bracket: menu + palette wiring for the built-in
  cursorMatchingBracket command
- [x] encoding-picker alias search: typing an IANA/common alias
  (latin1, cp950, …) matches the canonical encoding in the picker;
  investigate the picker's existing filter mechanism first — if
  aliases already match, close with findings
- [x] trim trailing whitespace on save: opt-in preference (default
  off); the trim is applied as an editor edit before the normal save
  flow so buffer and disk stay identical — the spec must keep the
  caret stable and fold the trim into the save so one undo step
  reverts the user's last edit, not the trim (adversarial-review
  addition); round-trip tests; large-file mode is untouched (read-only
  preview cannot save); dual-WebView manual acceptance deferred
  [danger]. Undo trade-off (merge vs. isolate) documented in
  editor.ts's `trimTrailingWhitespaceOf`, not restated here.
- [x] find/replace in selection: replace / replace-all scoped to the
  current selection — built as a pure, vitest-covered core
  ((docText, ranges, query) → edits, including post-replace
  range-shift bookkeeping) with a thin CodeMirror binding, per the
  adversarial review; dual-WebView manual acceptance deferred [danger]
- [x] insert date/time (stretch — first to cut if the cycle runs
  long): Edit-menu + palette command inserting a localized timestamp
  at the caret

**Track V — robustness**

- [x] per-module corruption regression tests: session.rs, prefs.rs,
  recent.rs each get their own truncated/invalid-JSON tests against
  their real file name and real struct (today they only inherit
  store.rs's generic guarantee)
- [x] external delete/rename visibility: gap analysis found a confirmed
  on-disk deletion had zero UI signal for a clean doc (fetchAndApplyReload's
  bare catch silently swallowed it) and a misleading "Reload?" prompt for a
  dirty one (Reload was a silent no-op). Fixed within the vitest-testable
  scope: `doc.missingOnDisk`, set once a reload's openDocument failure is
  confirmed (not just guessed) via a documentMetadata re-check
  (missingondisk.ts), cleared by any subsequent successful open/reload/save;
  surfaced via a status-bar hint and a dedicated "file deleted" dialog
  (single acknowledgement button, not a reload offer). Known reactive-only
  limits (adversarial-review notes, accepted): a dirty doc whose user
  keeps cancelling the change prompt never triggers the failed reload
  that sets the badge, and a metadata re-check rejection is treated as
  missing even when the true cause is e.g. a permission loss —
  both mislead the label only, never the buffer, and self-heal on the
  next successful reload/save. Rename tracking is a separate,
  still-open concern (issue #280); zero Rust changes.

**Track H — outward**

- [x] keyboard-shortcut reference: one consolidated table
  (docs/features.md appendix or docs/shortcuts.md) sourced from
  menu.rs LABELS and the CM6 built-in keymap — never hand-recalled
- [x] CONTRIBUTING.md: links dev-setup.md, the Definition of Done, PR
  conventions, and the commit-language policy for external
  contributors (zh-TW preferred, English accepted); positioning red
  lines apply

**Close-out**

- [x] routine cargo-lockfile refresh (18 compatible updates pending at
  planning time) as a small chore PR
- [x] cycle close-out: CHANGELOG.md, version bump across
  tauri.conf.json / package.json / Cargo.toml, tag v0.7.0-alpha.1
  (pre-release authority), handoff memory update

## v0.8 — Mojidori rename + release pipeline (delegated, 2026-07-23)

Closes D1 (official naming) and delivers the macOS + auto-update
portion of D2 (signing, notarization, auto-update) — both carried over
from v0.3 Track D and left open through v0.4–v0.7. D2's Windows-signing
sub-decision remains undecided (see DIRECTION §3/D2). Five PRs, all
merged 2026-07-23: #307, #308, #309, #311, #312.

**D1 — official naming**

- [x] #307: product renamed to **Mojidori** across every platform — the
  bundle identifier changed from `app.plume.editor` to
  `app.mojidori.editor`, along with the window title, IPC event
  namespace, and internal crate name. A one-time, crash-safe migration
  moves an existing config directory to the new identifier's location
  on first launch: staged in a `.partial` directory and verified
  before an atomic rename, guarded by a durable completion marker so a
  failed or interrupted attempt is retried correctly rather than
  silently skipped or repeated. If the new directory already has some
  content (e.g. from a partial prior attempt), recovery merges in only
  the items still missing, never overwriting anything already there,
  and rolls back only what it copied on failure. Copies preserve
  source file permissions and are fsync'd before the directory is
  renamed; an OS-level lock prevents two launches from migrating
  concurrently. The old directory is kept alongside as a `.migrated`
  backup rather than deleted. Known limitation, documented rather than
  silently accepted: search history does not carry over, because it
  lives in the WebView's per-origin storage (keyed by the bundle
  identifier), which is outside the migrated config directory; users
  must also close the old Plume build before first launching Mojidori,
  since the two builds are not aware of each other's file locks.
- [x] #308: docs and URLs swept for the new name (second-phase
  cleanup after the code-level rename in #307).

**D2 — signing, notarization, and auto-update**

- [x] #309: release pipeline — `.github/workflows/release.yml` builds,
  signs, and notarizes macOS (arm64 + x64) on tag push, builds Windows
  unsigned (OS-level Windows signing deferred, no decision yet
  — remains open, see DIRECTION §3/D2), uploads updater artifacts, and
  opens a draft release for the maintainer to publish manually.
  `tauri-plugin-updater`/`tauri-plugin-process` wired in; the frontend
  (`src/updater.ts`) checks silently at startup and via File > Check
  for Updates, prompts before downloading, and offers Download &
  Restart. The editor freezes against further edits while the final
  pre-restart flush is in progress, funneled through one mutation
  guard shared by every input path (typing, line-ending and encoding
  pickers, mojibake/normalize wizards, and more) so none of them can
  slip a change past the flush; the flush itself is serialized with
  any other in-flight save so the two can't race. The updater endpoint
  is designed as a fixed rolling `updater` release
  (`.github/workflows/updater-json.yml`), not `releases/latest/...`
  (prerelease alphas would 404 there) — but that workflow only runs on
  a `release: published` event, and `v0.8.0-alpha.1` remains an
  unpublished draft, so the feed has not actually been created yet;
  known accepted limitation once it is live: the
  updater compares version numbers, so alphas sharing one version
  (e.g. two re-releases of `0.8.0-alpha.1`) never trigger an update
  between them — only an actual version bump does. Not yet exercised
  end-to-end at merge time — the first real `v*` tag push is this
  pipeline's actual test.
- [x] #311: migration state-machine hardening follow-up — durable
  completion marker, merge-recovery for a partial prior attempt,
  fsync ordering, and window-state timing fixes folded into the
  migration landed in #307 (found before the cycle's close-out, not a
  separate later incident).

**Close-out**

- [x] #312: cycle close-out — version bumped to 0.8.0 across
  `tauri.conf.json` / `package.json` / `Cargo.toml`, CHANGELOG.md's
  `[v0.8.0-alpha.1]` section written, tag `v0.8.0-alpha.1` created
  (pre-release authority) but **left as an unpublished draft** — the
  maintainer had not chosen to publish it as of the v0.9 cycle
  opening.

## 2026-07-26–27 issue sweep (delegated)

Not a checkbox cycle — a delegated pass clearing a backlog of filed
bugs and one security hardening item, all fixed under the existing
Definition of Done rather than planned as a ROADMAP track. Nine PRs
merged 2026-07-26 through 2026-07-27: #313, #315, #316, #317, #318,
#319, #326, #327, #328 (PR numbers in the #313–#328 range not listed
here were issues, not PRs).

- [x] #313: third-party GitHub Actions in the release workflow pinned
  to commit SHA instead of a floating tag, and their permissions
  minimized.
- [x] #315: macOS single-instance enforcement — a second launch now
  focuses the existing window instead of starting a second process
  that could overwrite session/preferences state from underneath the
  first.
- [x] #316: an explicit Content-Security-Policy replacing
  `security.csp: null` in `tauri.conf.json`, verified with a real-
  machine A/B check.
- [x] #317: saving to a path that is a symlink no longer replaces the
  link itself with a regular file — the atomic-write rename now
  targets the link's destination.
- [x] #318: replace-in-selection fixed two correctness bugs — a plain-
  string query that wasn't unquoted before matching, and a zero-length
  regexp match at a selection boundary that could duplicate a replacement.
- [x] #319: two external-change/save interaction edge cases — the #302
  suppression window and a #276 stale-vs-cancel race that could
  mislabel a document clean when it wasn't.
- [x] #326: a `saveDialog` rejection could escape the save error
  boundary, leaving a queued save permanently stuck and a speculative
  encoding marker behind; the rejection is now caught and folded back
  into the normal save-failure path.
- [x] #327: fixed a zero-length regexp match in replace-in-selection
  looping forever on astral (surrogate-pair) characters.
- [x] #328: the save path's several ad hoc atomic-write helpers
  converged onto a single durable, provenance-bound atomic-commit
  primitive — one code path now backs every save-family write.

## v0.9 — trust deepening + issue closure (delegated, 2026-07-27)

Planned 2026-07-27 under the user's standing overnight delegation;
adversarially reviewed before start (AGREE-WITH-CHANGES — all seven
required changes adopted, notably: #329's initial two hypotheses
(selection-layer stacking, `--bg-selection` opacity) were falsified
and the investigation was reopened onto the search-match theme rule
with a strengthened, fail-first regression-test requirement rather
than a settled root cause; #330 rescoped to the error split the
upstream updater plugin can actually deliver; a third aggregate-ranking
gate added to the mojibake batch; and a planned docs sweep was replaced
by the #280 rename-event probe after the sweep was verified to be a
no-op). Theme: no invented scope — every item traces to a filed issue
or an established recurring program. Cycle constraints: no GUI launch,
no release publishing, no visibility changes; good-first-issue items
(#278, #304, #236, #89) were deliberately left for community
contributors. PRs merged 2026-07-27→28: #331, #332, #333, #334, #335,
#340, plus this close-out PR.

**Track A — bug fixes**

- [x] #329 (P2, PR #333): the search match the cursor jumps to was
  unreadable in some themes — the issue's original two hypotheses
  (selection-layer stacking, `--bg-selection` opacity) were falsified
  in pre-cycle review, since `.cm-searchMatch.cm-searchMatch-selected`
  in `src/editor-theme.ts` already paired an opaque `var(--accent)`
  background with an explicit `var(--accent-fg)` foreground. The real
  defect: CodeMirror's own higher-specificity built-in default for the
  jumped-to-match selector was silently winning the cascade — the same
  failure mode `.cm-selectionBackground` a few lines above needed
  `!important` to avoid. Fix: a new `--bg-search-selected` translucent
  token (declared in all six theme blocks in `src/styles.css`) replaces
  the opaque background, keeping the underlying syntax-highlight text
  color legible instead of relying on a foreground override that CM6's
  cascade could out-rank again. Regression test written to fail against
  the pre-fix revision first (asserting only theme-spec structure that
  already existed would have passed without fixing anything), then
  pass once the real rule changed; `npm test` at merge: 53 files / 1227
  tests passed. Visual acceptance on both WebViews across all four
  themes stays with the user; the PR references, not closes, #329.
- [x] #330 (P3, PR #332): update-check error handling split into
  network-layer / "no update information available" (the
  `Error::ReleaseNotFound` bucket, which the upstream
  `tauri-plugin-updater` 2.10.1 collapses every non-2xx HTTP status
  into, verified against its source) / other errors, in all four
  locales. A Rust-side test (`updater_errors.rs`) pins the upstream
  error's `Display` string the frontend's `classifyUpdateCheckError`
  matches on, so an unpinned `tauri-plugin-updater` bump can't silently
  regress the classification — the only test that goes red on a
  version-string change. `npm test`: 1231 passed (9 new
  `updaterErrors.test.ts` cases + 3 new `updater.test.ts` cases);
  `cargo test`: 650 passed.

**Track B — encoding trust**

- [x] B1 (PR #335): mojibake `REPAIR_PAIRS` expansion batch, 15 → 18
  pairs: `(windows-1256, UTF-8)` Arabic, `(windows-1258, UTF-8)`
  Vietnamese, `(windows-1253, UTF-8)` Greek (batch capped at 3, as
  planned). windows-1255 deferred to a future batch purely on the cap;
  windows-1254 deprioritized as a low-marginal-value duplicate of the
  existing `(windows-1252, UTF-8)` pair; windows-1257 rejected
  (chardetng's own README calls its detection inaccurate, and its gap
  bytes land in the UTF-8 continuation-byte range). All three admission
  gates satisfied, including the new aggregate ranking-regression
  assertion (proven against the pre-batch 15 pairs first, then
  re-proven at 18); `fuzz_roundtrip.rs` pools/match arms synced in the
  same PR — confirmed the sync requirement is still a real, executable
  dead end by reproducing the unsynced-arm panic before fixing it (see
  judgment overlay). Independently re-verified before merge: adversarial
  harness re-derivation by a separate agent, plus a critic review
  (APPROVE-WITH-NOTES — four doc/test precision fixes applied), on top
  of Codex CI review. `cargo test`: 663 passed (666 running, 3
  ignored); `npm test`: 1221 passed, frontend untouched. Incidentally
  surfaced a pre-existing, unrelated dead entry, `(windows-1252,
  gb18030)` — chardetng has no distinct GB18030 detection candidate
  (its `Gbk` candidate's `encoding()` always returns `GBK`), so
  `detect_mojibake` can never confirm it — filed as issue #336, left
  unfixed as out of scope for this batch.

**Track C — filed-issue closure**

- [x] C1 (#292, PR #334): replace-in-selection now applies NFKD
  normalized matching with CM6's own precise-match gating, ported from
  `SearchCursor`'s per-code-point automaton (non-precise matches are
  skipped, exactly like upstream `replaceAll`; the upstream
  canonical-reordering limitation is inherited by design and pinned by
  test). Merge-gated on a differential property sweep against the real
  `SearchCursor` (12,000 single-range + 1,500 multi-range cases, mutation
  tested — 9/10 reachable mutations caught, the tenth structurally
  unreachable and documented as such) plus pre-merge adversarial review.
  Two fixes bundled into the same PR because the sweep surfaced them
  directly: a pre-existing synchronous infinite loop reachable from this
  module's contract (guarded with the same out-of-process,
  `execFileSync`-with-timeout termination test #320/#327 established,
  since a real sync infinite loop defeats vitest's own timeout), and a
  correction to #320/#327's own regression-test time budget, which had
  been silently counting esbuild bundling overhead against its limit —
  moved the bundle step outside the timed section. `npm test` at merge:
  52 files / 1239 tests passed (74 in `replacescope.test.ts` alone).
  Feasibility investigation posted to the issue 2026-07-27.
- [x] C2 (#292 follow-up, PR #340): scoped-replace result message —
  `replacescope.ts`'s scan now also reports `skippedNonPrecise` (always
  0 in regexp mode, since `RegExpCursor` never normalizes), plumbed end
  to end from `replaceAllInSelection`/`replaceInSelection` through
  `editor.ts`'s `dispatchScopedReplace` and `main.ts`'s
  `runLineOperation` (generalized to `<T>(action: () => T): T |
  undefined`) to the menu handler. UX choice, deliberately narrower
  than the feasibility investigation's "always report both counts"
  suggestion: a `messageDialog` appears only when at least one match
  was skipped, via a pure `buildReplaceScopeResultMessage` (four new
  locale keys). Two-round Codex review: round 1 landed the feature;
  round 2 caught a real defect before merge — repeatedly invoking
  single-step Replace against a selection with a persistent
  non-precise match (e.g. stepping through "f f ﬁ") re-popped the
  disclosure dialog on every click, turning normal one-at-a-time
  replacement into a barrage of interruptions. Fixed with a second pure
  function, `shouldShowReplaceScopeResult(mode, replaced,
  skippedNonPrecise)`: Replace All (a one-shot bulk operation) still
  reports the instant anything is skipped, but single-step Replace
  defers until a step replaces nothing further (`replaced === 0`) —
  only then is the skip count actually the reason nothing happened,
  rather than noise that a later step will still walk past normally.
  Both pure functions are vitest-covered, including a differential
  sweep against the real `SearchCursor`'s imprecise-match count and an
  integration test that replays the "f f ﬁ" repeated-click scenario
  against real `replaceInSelection` calls; C1's differential sweep and
  all prior tests are untouched. Full test suite at merge: 1269
  passed.
- [x] C3 (#280): watcher rename-event probe run on macOS + Windows CI
  (production-identical `notify::recommended_watcher` +
  `RecursiveMode::NonRecursive` configuration, plus a watch-parent-
  directory control group; Linux not measured, no CI runner available)
  — results posted to the issue; the old-path watch does not survive a
  rename on either platform, so the issue was escalated from P3 to P2
  per the pre-registered criterion. The probe branch was discarded
  (does not earn its keep as a permanent regression test, per plan).

**Track D — research & decision prep (no code)**

- [x] D1 (#314): CSP-nonce feasibility research posted to the issue
  (conditionally feasible via a placeholder `<style>` nonce carrier +
  `EditorView.cspNonce`; deferred until a real-machine verification
  window).
- [x] D2 (#303): decision-ready trim-on-save contract proposal posted
  to the issue for the maintainer's ruling (ties in PR #288's pending
  undo-semantics sign-off).

**Close-out**

- [x] E1: version bump to 0.9.0 across `tauri.conf.json` /
  `package.json` / `Cargo.toml` (+ both lockfiles), `CHANGELOG.md`'s
  `[v0.9.0-alpha.1]` section written, this section archived, DIRECTION
  §2 refreshed, three lessons written back to the judgment overlay, tag
  `v0.9.0-alpha.1` created (pre-release authority). Publishing stays
  user-held: the new draft release sits alongside the still-unpublished
  `v0.8.0-alpha.1` draft.

New issues filed during the cycle (beyond #280's P2 escalation):
#336 (mojibake dead entry, `(windows-1252, gb18030)`), #337 (NFKD scan
performance on large selections, ~10–19 MB/s, P3), #338 (a recurring
mojibake false-positive category affecting multiple pairs, P3), #339
(a Dependabot glib 0.18 unsoundness advisory, Linux Tier-2-only
exposure, P3).
