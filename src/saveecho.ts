// Save-echo suppression policy (issue #302; hardened per PR #319's Codex
// P2 review). main.ts's handleExternalChange ignores a watcher event for
// `path` within a short window after our own save landed there, so the
// filesystem echo that write itself causes never gets mistaken for an
// external change. A blind elapsed-time check, though, can't tell that
// guaranteed self-echo apart from a genuine external write landing in the
// same short window — it swallows both alike, so a real change right
// after a save could sit un-reloaded (and the user unnotified) until some
// unrelated later event happens to re-trigger the check.
//
// Comparison uses the exact opaque `Fingerprint` (fsguard.rs) every other
// staleness check in this codebase already uses (savemutex.ts's
// fingerprintsEqual), not a separately-read size/mtime pair — an earlier
// version of this fix used the latter and two review findings killed it:
// (1) a size/mtime snapshot fetched via a *second*, later IPC call
// (documentMetadata, run after the save's own IPC call had already
// resolved) has its own await gap a third-party write can land in,
// corrupting the very baseline this module compares against, and
// reproducing the bug this fix exists to close. Using the fingerprint
// `save_document` already returns — captured synchronously by main.ts's
// recordOwnSave from that same response, no separate fetch at all — has no
// such gap. (2) `documentMetadata`'s `modifiedMs` is millisecond-truncated
// (coarser still on some filesystems), so a fast same-size external
// rewrite could alias onto an unrelated file version under that
// comparison; `Fingerprint` carries full mtime precision plus, on Unix,
// inode identity, so it can't.
//
// Pulled out as a pure function for the same reason savecompletion.ts's
// decideSaveCompletion was: main.ts is wired directly into IPC/DOM/editor
// and isn't unit-testable on its own, so the decision table itself gets
// full-branch vitest coverage instead.

import { fingerprintsEqual } from "./savemutex";

/** How long a watcher event for a just-saved path is treated as *possibly*
 *  our own echo — main.ts's original (pre-#302) constant, unchanged: it's
 *  still the first, cheapest filter, just no longer the only one. */
export const SAVE_ECHO_WINDOW_MS = 1500;

/** What main.ts records right after a successful save completes.
 *  `fingerprint` is the exact opaque `Fingerprint` `save_document`
 *  returned for that write (ipc.ts's `SaveResult.fingerprint`), captured
 *  synchronously from that response — never a separate stat call, so
 *  there is no gap for a third-party write to race into before the
 *  baseline is set (Codex P2 finding #1). */
export interface SaveEchoRecord {
  /** Date.now() when this save's write landed. */
  time: number;
  fingerprint: unknown;
}

export interface SaveEchoInput {
  now: number;
  /** recentSaves.get(path) — undefined when nothing has been saved to this
   *  path this session (or the record aged out), which alone means this
   *  can't be a save echo. */
  record: SaveEchoRecord | undefined;
  /** A fresh documentFingerprint(path) read taken in response to the
   *  watcher event under consideration, fetched only once `now` is already
   *  inside the record's window (no need to pay for it otherwise).
   *  `undefined` when the caller deliberately skips that fetch (time-only
   *  fast path some callers may still want); `null` when the fetch itself
   *  was attempted and failed (most plausibly the file is gone) — distinct
   *  from `undefined` because a failed stat is itself a signal something
   *  changed, the opposite of `undefined`'s "no extra information yet,
   *  trust time alone" meaning. */
  current?: unknown;
}

/**
 * Should this watcher event for `path` be suppressed as our own save's
 * echo? `false` means main.ts's handleExternalChange should proceed exactly
 * as it would outside the window — including for a doc still inside the
 * window, since a confirmed mismatch below means something external landed
 * before the window even closed.
 *
 * Branch order matters:
 * 1. No record, or already outside the window: never suppress — the
 *    original, unconditional time gate.
 * 2. Inside the window but the caller didn't fetch `current` (time-only
 *    fast path some callers may still want): suppress, matching pre-#302
 *    behavior exactly.
 * 3. `current` fetch failed (`null`): don't suppress. A stat failure most
 *    likely means the file was removed or replaced out from under the
 *    watch — never our own echo, and exactly the case the downstream
 *    missing-file flow (main.ts's markMissingIfConfirmed) exists to
 *    surface, so this must not hide it behind the window.
 * 4. No baseline to compare (`record.fingerprint` is null/undefined —
 *    the write that produced it somehow reported no fingerprint): *don't*
 *    suppress (issue #324) — this used to fail closed (suppress) here,
 *    but a missing baseline means this module has no proof at all that
 *    the current watcher event is our own echo, and suppressing anyway
 *    would hide a real external change behind that unproven assumption.
 *    `save_document` itself (`lib.rs`) now makes this branch essentially
 *    unreachable in practice — its returned fingerprint is captured from
 *    the write's own still-open temp handle before the rename, so a
 *    successful write can no longer come back with `fingerprint: null` at
 *    all — but this module doesn't get to assume that invariant holds
 *    forever just because it currently does; failing open here is the
 *    correct default in its own right, independent of what the backend
 *    guarantees.
 * 5. Both snapshots present: suppress only if the opaque fingerprints are
 *    exactly equal (savemutex.ts's fingerprintsEqual) — anything else
 *    means the file moved since our own write, even though we're still
 *    inside the nominal window.
 */
export function isLikelySaveEcho(input: SaveEchoInput): boolean {
  const { record } = input;
  if (!record || input.now - record.time >= SAVE_ECHO_WINDOW_MS) return false;
  if (input.current === undefined) return true;
  if (input.current === null) return false;
  if (record.fingerprint === null || record.fingerprint === undefined) return false;
  return fingerprintsEqual(record.fingerprint, input.current);
}

/**
 * Core invariant this whole suppression scheme depends on — worth stating
 * once, explicitly, because an await-race breaking it is what issue #302's
 * PR #319 review caught in this exact area *four* separate times: the
 * `record`/`current` pair fed to isLikelySaveEcho must describe the *same
 * instant*. `record` (a synchronous `recentSaves.get(path)` read) and
 * `current` (an async `documentFingerprint(path)` stat) are read through
 * two entirely different channels with no shared clock between them, so
 * sampling one of them *before* the other's async gap and trusting it to
 * still describe the same moment once that gap closes is never safe on its
 * own — no matter which side of the gap you pick, and no matter how many
 * signals you add on that same "compare two point-in-time reads" footing:
 *
 * - Sample `record` before the fetch, use it as-is once the fetch
 *   resolves: a second save landing anywhere during the fetch replaces
 *   `recentSaves`' entry, so the `current` this fetch eventually returns
 *   can describe disk *after* that second save while `record` still
 *   describes the first (round four's bug, fixed by re-reading
 *   afterward — but only by half).
 * - Re-read `record` *after* the fetch resolves instead (round four's
 *   fix): still broken if the second save's own `recordOwnSave` call lands
 *   *after* the fetch's underlying disk read already happened but
 *   *before* this app's continuation resumes to do that re-read — `current`
 *   then describes disk as of the *first* save while the re-read `record`
 *   already reflects the second (round five's bug: the same race, mirrored).
 * - Verify `record` didn't change across the fetch (`sameSaveRecord` below,
 *   round five's fix): closes both of the above, but still broken if
 *   Rust has already written a second save's bytes to disk — so `current`
 *   can already reflect them — before that save's own `recordOwnSave` call
 *   has had a chance to run at all. `recentSaves` genuinely hasn't changed
 *   yet in this window, so the before/after comparison reports "stable"
 *   even though disk has already moved past what `record` describes
 *   (round six's bug: `recentSaves` and disk-derived `current` were never
 *   the same clock to begin with, and "record" alone can't see a write that
 *   hasn't been recorded yet).
 *
 * Three point patches, three new variants of the same race. The
 * convergent fix (round six) stops trying to infer consistency purely from
 * `recentSaves` and instead asks the one thing that actually governs
 * whether a write for this doc could be landing right now:
 * `doc.saveReloadInFlight` (savemutex.ts's existing per-doc save/reload
 * lock — set synchronously the instant `saveFlow` starts, *before* any IPC
 * call, and cleared only after `recordOwnSave` has already run). A sample
 * is trustworthy only when *both* hold: no save/reload was in flight when
 * checked, right after the fetch resolves (rules out round six: a write
 * still landing right now, recorded or not), *and* `record` didn't change
 * across the fetch (rules out rounds four/five: a save that started *and*
 * fully finished within the fetch's duration, invisible to the in-flight
 * check by the time it's read). `isFetchAttemptTrustworthy` below is that
 * combined check. Neither signal alone is sufficient — the in-flight flag
 * misses a save that both started and completed inside one fetch; the
 * record-stability check alone misses round six's not-yet-recorded write —
 * but together they cover every interleaving a single overlapping save can
 * produce, because between them there is no window left where disk can
 * have moved without *either* the lock being held *or* `recentSaves`
 * having already changed.
 */
export function sameSaveRecord(
  a: SaveEchoRecord | undefined,
  b: SaveEchoRecord | undefined,
): boolean {
  return a === b;
}

export interface FetchAttemptStability {
  /** recentSaves.get(path) read immediately before starting the fetch. */
  recordBefore: SaveEchoRecord | undefined;
  /** recentSaves.get(path) read immediately after the fetch resolves. */
  recordAfter: SaveEchoRecord | undefined;
  /** doc.saveReloadInFlight !== null, read immediately after the fetch
   *  resolves (savemutex.ts's LockOwner, narrowed to a plain boolean here
   *  since this module has no reason to know *which* operation — main.ts
   *  is the only caller and it always means "don't trust this sample"
   *  either way). */
  saveOrReloadInFlight: boolean;
}

/**
 * Is this attempt's `(record, current)` pair trustworthy — i.e. proven to
 * describe the same instant — per sameSaveRecord's own doc comment above?
 * `false` means main.ts must not feed this attempt's `current` to
 * isLikelySaveEcho at all: retry (capturing a fresh `recordBefore` for the
 * next attempt) up to `MAX_FINGERPRINT_RESAMPLE_ATTEMPTS`, or, once that's
 * exhausted, defer to savemutex.ts's own pendingReload/drainLock machinery
 * (main.ts's handleExternalChange) rather than guess from an unstable
 * pair — that machinery already waits for whatever is in flight to
 * actually finish and then re-checks via reevaluateReload's own
 * `fingerprintsEqual(opened.fingerprint, doc.fingerprint)`, computed only
 * once nothing is in flight any more, so it can never race the very
 * save/reload it's waiting on.
 */
export function isFetchAttemptTrustworthy(input: FetchAttemptStability): boolean {
  if (input.saveOrReloadInFlight) return false;
  return sameSaveRecord(input.recordBefore, input.recordAfter);
}

/** Bound on main.ts's handleExternalChange stabilizing-fetch retry (see
 *  isFetchAttemptTrustworthy's own doc comment) — small enough that a
 *  pathological run of back-to-back saves to the same path can't spin this
 *  indefinitely, large enough that the overwhelmingly common case (no
 *  concurrent save at all) never needs more than its first attempt. */
export const MAX_FINGERPRINT_RESAMPLE_ATTEMPTS = 3;
