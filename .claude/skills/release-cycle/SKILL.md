---
name: release-cycle
description: Mojidori version-cycle close-out and pre-release tagging — close-out PR composition, tag → draft-release pipeline, final reconciliation, session handoff. Use when ending a feature cycle, tagging an alpha, or drafting a release.
---

# Release cycle close-out

The canonical per-tag checklist is DIRECTION.md §7 "Release checklist" —
follow it. This skill adds the operational sequence and repo-specific
traps learned across cycles v0.4–v0.9, and points to where each detail
lives instead of restating it. Pre-release tags and draft releases are
delegated to the agent; **publishing a release is user-gated (Red tier),
always** (judgment overlay §3).

## 1. Close-out PR (one PR, merged last in the cycle)

- Version bump in three files, consistently: `tauri.conf.json`,
  `package.json`, `src-tauri/Cargo.toml`.
- `CHANGELOG.md`: move the `Unreleased` entries under a new dated heading
  (`[vX.Y.Z-alpha.N] - YYYY-MM-DD`).
- ROADMAP.md: move the completed cycle's item-level record to
  `docs/archive/roadmap-completed-cycles.md`, leaving a summary line.
- DIRECTION.md §2 current-state entry updated in the same PR
  (docs discipline, DIRECTION.md §7).
- Judgment overlay: write back the cycle's lessons and dead ends.
- Give the close-out PR the same review loop as feature PRs — close-out
  documents carry numbers (PR ranges, test counts, versions) and review
  has caught errors in them before (v0.9: three).

## 2. Tag and draft release

- Tag the merged close-out commit on `main` (CI green first), push the
  tag; the pipeline produces a **draft** release with all installers —
  verify the workflow run actually started.
- Release notes in zh-TW, written from the CHANGELOG entry.
- Publishing is what activates the auto-updater feed
  (`updater-json.yml` runs on `release: published`) — one more reason
  publish stays user-held.

## 3. Final reconciliation (before ending the session)

Verify with actual command output: `git ls-remote --heads origin` lists
only `main`; `git worktree list` shows only the main checkout;
`gh pr list` shows zero open PRs; the version string is identical in all
three files. The `--delete-branch`-vs-worktree trap that makes this
necessary is in the judgment overlay's known dead ends.

## 4. Session handoff

Write or update the cycle handoff memory in the auto-memory directory:
delivered PRs + tag, findings-only deliverables, new issues filed, and
the pending-user checklist. New sessions start from that file
(DIRECTION.md §8).
