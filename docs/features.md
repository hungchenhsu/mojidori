# Features

Mojidori is a fast, lightweight, encoding-first text editor. This guide
covers its encoding and large-file tooling feature by feature: what it
does, how to reach it, and where it stops working. See the
[README](../README.md) for install and background, and
[encoding-detection.md](encoding-detection.md) for the full story behind
automatic detection. Below, `>` chains native File/Edit/View menu items;
"status bar →" opens a popup from the window's bottom edge. Shortcuts are
`Cmd/Ctrl`-prefixed; unlisted means there is none. The
[Keyboard shortcuts](#keyboard-shortcuts) section at the end collects
every shortcut in one table.

## Encoding

### Encoding detection

On open, Mojidori checks in order for a byte-order mark (BOM), runs a
statistical detector (chardetng) over the file's bytes, falls back to a
per-extension default if one is set, then UTF-8. Decode errors are always
surfaced, never silently rendered as clean text.

- **Trigger:** automatic on open. Status bar → encoding segment → "Why
  {encoding}?" shows the evidence behind it (disabled for untitled
  documents — no file on disk to re-read).
- **Limits:** for files over the large-file threshold, detection only
  sees a bounded sample rather than the whole file — disclosed in the
  diagnostics popup, and (for one narrow case: a single very long line
  with no breaks) can occasionally guess the wrong encoding family
  outright. Full decision order and per-encoding boundaries:
  [encoding-detection.md](encoding-detection.md).

### Reopen with Encoding / Save with Encoding

Reopen re-reads the file from disk under a different encoding, discarding
the editor's contents (with a confirm if the tab is dirty). Save with
Encoding instead sets what the *next* save will write — encoding, and for
Unicode targets, whether a BOM is included — then saves immediately.

- **Trigger:** status bar → encoding → "Reopen with Encoding" / "Save
  with Encoding".
- **Behavior:** UTF-8 offers plain and "with BOM" entries; UTF-16LE/BE
  are BOM-only; other encodings have no BOM option. Save with Encoding
  marks the document dirty immediately, even with no text changes, and
  rolls back if the save is cancelled or fails (e.g. a declined
  lossy-save warning, below); it works even on an untitled document.
- **Limits:** Reopen is disabled for untitled documents, and never offers
  "UTF-8 with BOM" as a target — BOM presence is auto-detected on reopen,
  not chosen by hand.

### Per-extension default encoding

A fallback ("always open `.txt` as Big5") for files the detector can't
confidently place, e.g. legacy Windows codepages with no recognizable
byte pattern.

- **Trigger:** Preferences… (`Cmd/Ctrl+,`; macOS: Mojidori application menu;
  elsewhere: File menu) → "Per-extension encodings" table.
- **Behavior:** a hint, not an override — ignored whenever the file has a
  BOM, decodes as confident non-ASCII UTF-8, or would decode with errors
  under the mapping, so a wrong entry never becomes silent mojibake. The
  separate "Encoding for new files" setting nearby is unrelated: it's the
  default for a brand-new untitled tab, not for opening existing files.

### Mojibake repair wizard

Scans the current buffer for text that looks like it was already decoded
with the wrong encoding once, and offers to fix it in place.

- **Trigger:** status bar → encoding → "Repair mojibake…", or status bar
  → ⚠ decode-warning button (shown only once a document has decoded with
  errors) → "Repair mojibake…".
- **Behavior:** lists candidate repairs with a before/after preview and
  replacement count; applying one replaces the buffer as a single
  undoable edit — nothing reaches disk until you save separately. Editing
  the document or switching tabs while the wizard stays open drops or
  blocks the pending repair rather than applying it to stale text.
- **Limits:** disabled for large-file previews. Repair pairs are curated,
  not exhaustive — an unusual mis-encoding may have no candidate.

### Batch encoding and line-ending conversion

Converts encoding and/or line endings for every matching file in a
folder, in one pass, with a review step before anything is written.

- **Trigger:** Edit > Batch Encoding Conversion…
- **Behavior:** pick a folder and an optional extension filter, then a
  target encoding, target line ending, or both. Scanning is a dry run —
  every file is classified (convertible, already at target, would lose
  characters, undecodable, or too large) before you commit, and
  convertible files can be deselected individually. Writes one atomic
  file at a time; an open tab is untouched and picks up the change
  afterward.
- **Limits:** files over the large-file threshold (10 MB) are reported
  "too large" and skipped.

### Side-by-side encoding preview and hex preview

Two read-only ways to inspect a file's bytes: "Compare encodings" decodes
it under two encodings at once; "View raw bytes" is a hex dump — offset,
hex bytes, ASCII gutter — instead of a decoded interpretation.

- **Trigger:** status bar → encoding → "Compare encodings…"; status bar →
  ⚠ decode-warning button → "View raw bytes…".
- **Behavior:** Compare encodings shows decoded text and error flags per
  column, with a "Reopen with this encoding" button per side. Both read
  only a bounded slice of the file — Compare a prefix, hex preview capped
  at 64 KB regardless of file size.
- **Limits:** both disabled for untitled documents.

### Character-level trust tools

Three ways to see characters Mojidori would otherwise render invisibly: the
character inspector shows exactly what one character is, byte for byte;
"Show Invisibles" renders whitespace and line-ending glyphs; "Suspicious
Characters" highlights a curated set used in real-world spoofing
tricks — bidirectional-control characters, zero-width characters, and
lookalike whitespace.

- **Trigger:** click the character-inspector segment in the status bar
  (shows the character just before the cursor); View > Show Invisibles /
  View > Suspicious Characters (checkboxes, no shortcut) for the others.
- **Behavior:** the inspector shows the character, its code point, its
  UTF-8 bytes, and — if the save encoding isn't UTF-8 — that encoding's
  bytes too, or a "cannot be represented" warning. The status bar also
  runs a live count of suspicious characters whenever non-zero, staying
  visible even with the highlight toggled off — an independent signal,
  not a byproduct of it.
- **Limits:** the inspector segment is hidden with no document, an empty
  document, or the cursor at a line start (works normally in a large-file
  preview). The suspicious-character count is hidden entirely — not
  shown as zero — in a large-file preview, since a partial window can't
  represent a whole-file count honestly.

### Unicode normalization and the lossy-save guard

Two safety nets for the same risk: a character that exists in Unicode but
has no equivalent in the document's save encoding.

- **Trigger:** Edit > Line Operations > Normalize to NFC / NFD
  (deliberately no shortcut) rewrites the whole document — never a
  selection — to a normalized form. The lossy-save preview instead fires
  automatically, no menu item, during any Save / Save As / Save with
  Encoding that targets a non-Unicode encoding.
- **Behavior:** Normalize confirms first, naming how many sequences would
  change; for a non-Unicode save encoding it then dry-runs
  representability and, if anything would become unrepresentable, shows a
  second warning naming the encoding and sampling the affected characters
  before you can proceed. A save that can't represent every buffer
  character shows the same kind of warning — affected characters with
  line/column, sampled if long — before you cancel (nothing written) or
  proceed anyway (writes the lossy result). UTF-8/UTF-16 skip both checks
  entirely, since both are always fully representable.
- **Limits:** Normalize is blocked on read-only or large-file-preview
  documents.

### Document Info and line endings

Document Info is a read-only trust panel with everything Mojidori currently
knows about the active document, including a full line-ending breakdown;
the status bar's line-ending segment is the quick way to change it.

- **Trigger:** File > Document Info… (no shortcut) for the full panel;
  status bar → line-ending segment → LF / CRLF / CR to change it directly.
- **Behavior:** the panel shows path/size/last-modified, the same
  encoding evidence as "Why {encoding}?", a line-ending count, and
  word/character/line counts — each section loads independently, so one
  failure shows its own inline error instead of blanking the dialog; the
  snapshot is taken once, on open, with no live refresh. The status-bar
  picker instead just sets the ending for the document's *next* save.
- **Limits:** an untitled tab gets a reduced panel (no size/modified/
  detection evidence). Line-ending counts aren't available for UTF-16.
  Text stats are omitted for a large-file preview, and the line-ending
  count is bounded to the first 10 MB of a huge file, labeled as such.

## Large files

### Large-file mode

Files over 10 MB open as a read-only preview instead of loading the whole
file, so opening a huge file is still instant.

- **Trigger:** automatic, by file size.
- **Behavior:** the status bar shows a preview badge with its real
  size. Mojidori loads 2 MB chunks (up to 8 in memory at once): scrolling
  near either edge of what's loaded quietly pulls in the next chunk, and
  the ◀ / ▶ status-bar buttons page a full chunk at a time manually. Go
  to Line and bookmarks still reach past the loaded window — Mojidori builds
  a line-offset index on demand ("building line index…" in the status
  bar) and jumps straight to the right chunk.
- **Limits:** paging (automatic or manual) doesn't work for UTF-16 or
  ISO-2022-JP files large enough to need preview mode — the page buttons
  simply don't appear, so those two are stuck at the initial window.
  Editing is disabled entirely in preview mode.

### Streaming find/replace and streaming encoding conversion

Two tools that act on the whole file on disk, not just the loaded window,
for when a normal in-editor Find and Replace or "Save with Encoding"
can't reach past a large-file preview.

- **Trigger:** Edit > Replace in Large File… (plain-text find/replace; on
  a document *not* in preview mode it points you to the regular Find and
  Replace instead of doing anything), or status bar → encoding → "Convert
  File to Encoding…" (large-file previews only).
- **Behavior:** Replace takes a search term, a replacement, and a
  case-sensitivity toggle (off = ASCII-only case-insensitive); Convert
  takes a target encoding and applies the same lossy-save warning a
  normal save would. Both stream the file in bounded chunks, write the
  result atomically, and reload the tab afterward; neither has a dry-run
  preview or a way to cancel once started — Replace's count and Convert's
  completion only show once the operation finishes.
- **Limits:** neither works on a UTF-16 document — Replace refuses
  outright to avoid a silent corruption, and Convert simply doesn't list
  UTF-16 as a target.

## Find and replace in files

Search and replace across every file in a folder, decoding each file with
its own encoding rather than assuming UTF-8.

- **Trigger:** Edit > Find in Files… (`Cmd/Ctrl+Shift+F`); Replace is a
  second field in the same panel, not a separate command.
- **Behavior:** pick a folder (no project/workspace concept to search
  "within" instead); optional regex and case-sensitivity toggles apply to
  the search term, but replacement text is always literal, even in regex
  mode — `$1`-style backreferences are never expanded. Each file is
  decoded with its own detected (or per-extension default) encoding, so
  one search can span files of several encodings at once. Scanning is a
  dry run: a per-file, per-match checklist to review and prune, plus a
  confirmation if any change would be lossy. Undecodable files are
  skipped and disclosed, never silently corrupted or treated as UTF-8.
- **Limits:** files over 5 MB are quietly skipped by a plain search, or
  listed as "too large" by a replace scan; results are capped per search
  (500 matches for find, 500 files for a replace scan), marked truncated
  when hit. Operates directly on disk — independent of open tabs or
  large-file preview mode.

## Everyday editing

Beyond encoding, Mojidori has the basics: multi-cursor selection, code
folding, indent guides, auto-detected indentation shown in the status
bar, a line-operations toolbox (sort — including case-insensitive and
numeric variants — deduplicate, reverse, trim, tab/space conversion,
move/duplicate/delete/join lines, case and full/half-width conversion,
plus the normalization commands above), regex-capable in-editor Find and
Replace (`Cmd/Ctrl+F`), a fuzzy-searchable Command Palette
(`Cmd/Ctrl+Shift+P`), and tab drag-to-reorder with a right-click tab
menu. All live in the Edit and View menus, or search by name in the
Command Palette.

### Trim trailing whitespace on save

An opt-in preference that strips trailing whitespace from every line
before a save writes its content to disk.

- **Trigger:** Preferences… (`Cmd/Ctrl+,`) → "Trim trailing whitespace on
  save" checkbox.
- **Limits:** whichever tab is active at the moment this save captures
  its content decides the outcome — right after any Save As dialog, or a
  wait behind another in-flight save/reload for the same document — not
  whichever tab is active once the write to disk actually finishes. A
  save that reaches that capture point while its tab is already inactive
  writes the content as-is, untrimmed; switching tabs afterward, while
  the write itself is still in flight, doesn't change the outcome either
  way.

## Keyboard shortcuts

A single reference table for every bound shortcut in the app, grouped to
match the native File/Edit/View menus (`src-tauri/src/menu.rs`).
`Cmd/Ctrl` elsewhere in this doc is shorthand for the pair spelled out
here: macOS uses `⌘` Command (plus `⌃` Control, `⌥` Option, `⇧` Shift
where noted); Windows/Linux uses `Ctrl` (plus `Alt`, `Shift`). Actions
with no bound shortcut — reachable only through a menu or the Command
Palette — are omitted, matching the "unlisted means there is none"
convention above.

A few rows come from CodeMirror 6's own default keymaps (bundled
unmodified via `basicSetup` in `src/editor.ts`) instead of a native menu
accelerator — the action still has a menu item, just no second,
competing OS-level accelerator on the same key. These are marked
*(editor default)* below.

### File

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| New Tab | `⌘T` | `Ctrl+T` |
| Open… | `⌘O` | `Ctrl+O` |
| Open Recent… (quick open) | `⌘P` | `Ctrl+P` |
| Save | `⌘S` | `Ctrl+S` |
| Save As… | `⇧⌘S` | `Ctrl+Shift+S` |
| Close Tab | `⌘W` | `Ctrl+W` |
| Reopen Closed Tab | `⇧⌘T` | `Ctrl+Shift+T` |
| Print… | `⌥⌘P` | `Ctrl+Alt+P` |
| Preferences… | `⌘,` | `Ctrl+,` |
| Quit | `⌘Q` | *(none)* |

Preferences… lives in the **Mojidori** application menu on macOS and in the
File menu everywhere else — same shortcut either way. Quit has no bound
accelerator on Windows/Linux; File > Exit still works by menu click, and
the window's own close control is the usual way out.

### Edit

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Undo | `⌘Z` | `Ctrl+Z` |
| Redo | `⇧⌘Z` | `Ctrl+Y` |
| Cut | `⌘X` | `Ctrl+X` |
| Copy | `⌘C` | `Ctrl+C` |
| Paste | `⌘V` | `Ctrl+V` |
| Select All | `⌘A` | `Ctrl+A` |

### Search

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Find and Replace… | `⌘F` | `Ctrl+F` |
| Find in Files… | `⇧⌘F` | `Ctrl+Shift+F` |
| Select Next Occurrence *(editor default)* | `⌘D` | `Ctrl+D` |
| Select All Occurrences *(editor default)* | `⇧⌘L` | `Ctrl+Shift+L` |

### Navigation

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Go to Line… | `⌘L` | `Ctrl+L` |
| Go to Matching Bracket *(editor default)* | `⇧⌘\` | `Ctrl+Shift+\` |
| Next Tab | `⌃Tab` | `Ctrl+Tab` |
| Previous Tab | `⌃⇧Tab` | `Ctrl+Shift+Tab` |

Tab cycling is bound to the literal Control key on every platform
(`src/main.ts`), not the Cmd/Ctrl pair used everywhere else in this
table — macOS reserves plain `⌘Tab` for switching applications.

### Line Operations

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Move Line Up *(editor default)* | `⌥↑` | `Alt+Up` |
| Move Line Down *(editor default)* | `⌥↓` | `Alt+Down` |
| Duplicate Line *(editor default)* | `⌥⇧↓` | `Alt+Shift+Down` |
| Delete Line *(editor default)* | `⇧⌘K` | `Ctrl+Shift+K` |

Every other Line Operations command (sort, deduplicate, reverse, trim,
tab/space conversion, case and width conversion, normalization) is
menu/palette-only by design — see [Everyday editing](#everyday-editing)
above.

### View

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Command Palette… | `⇧⌘P` | `Ctrl+Shift+P` |
| Word Wrap | `⌥Z` | `Alt+Z` |
| Fold All *(editor default)* | `⌃⌥[` | `Ctrl+Alt+[` |
| Unfold All *(editor default)* | `⌃⌥]` | `Ctrl+Alt+]` |
| Zoom In | `⌘=` | `Ctrl+=` |
| Zoom Out | `⌘-` | `Ctrl+-` |
| Actual Size (reset zoom) | `⌘0` | `Ctrl+0` |

### Window & App (macOS only)

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Minimize | `⌘M` | *(n/a — no Window menu)* |
| Toggle Full Screen | `⌃⌘F` | *(n/a — no Window menu)* |
| Hide | `⌘H` | *(n/a — no Window menu)* |
| Hide Others | `⌥⌘H` | *(n/a — no Window menu)* |

The Window menu and the "Mojidori" application menu (which also carries
these plus About/Services, neither of which has a shortcut) only exist
on macOS — see the `#[cfg(target_os = "macos")]` guards in `menu.rs`.
