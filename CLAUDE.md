# CLAUDE.md

Operational guidance for working in this repo. The task queue is
[ROADMAP.md](ROADMAP.md); design principles and hard constraints are in
[ARCHITECTURE.md](ARCHITECTURE.md); strategy, open decision gates, and
the session handoff protocol are in [DIRECTION.md](DIRECTION.md). Read
them before making changes.
Agent judgment specifics — danger domains, verification matrix, permission
tiers, known dead ends — live in
[.claude/judgment-overlay.md](.claude/judgment-overlay.md); on conflict,
this file wins and the overlay gets updated. The recurring version-cycle
close-out workflow lives in the `release-cycle` skill
(`.claude/skills/release-cycle/SKILL.md`).

## Commands

Dev/build/test commands are the standard `package.json` scripts
(`npm run tauri dev` runs the app) plus the cargo gates listed under
"Definition of done" below.

Note: on a fresh clone, run `npm install && npm run build` before any cargo
command — `tauri::generate_context!` requires `dist/` to exist.

## Definition of done

A change is complete only when all of these pass locally:

1. `npm run build` (tsc strict + vite) and `npm test` (vitest)
2. In `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
3. New core logic in `src-tauri/src/` has unit tests; any encoding behavior
   change has round-trip tests. Frontend logic that doesn't need the WebView
   (tab store, pure helpers) gets vitest unit tests in `src/*.test.ts`.
4. The relevant ROADMAP.md checkbox is updated in the same change.

## Workflow

- Never commit to `main`. Feature branch → PR → CI green → squash merge.
- **Immediately after every merge, clean up the local branch, the remote
  branch, and any worktree.** Before ending a work session, verify
  `git ls-remote --heads origin` lists only `main` and `git worktree list`
  shows only the main checkout. The worktree pitfall that motivates this
  is recorded in the judgment overlay's known dead ends.
- One ROADMAP item (or one coherent fix) per PR.
- Commit messages and PR titles in Traditional Chinese (zh-TW); code,
  comments, and docs in English.

## Hard constraints

- All disk I/O happens in the Rust core. Raw bytes never cross IPC; the
  frontend only sees LF-normalized text plus metadata (encoding, BOM,
  line ending).
- Keep CodeMirror usage isolated (a dedicated editor module as the frontend
  grows) so the editor surface stays swappable.
- Platform-correct UX: use `Mod-` shortcut abstraction and native menus.
  macOS and Windows are Tier 1; verify UI changes against both WebViews
  (WKWebView / WebView2).
- No new runtime dependencies without strong justification — small bundle
  size and fast startup are features.
- Decode errors are surfaced to the user, never silently rendered as if
  the text were fine.
