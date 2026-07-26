// Save-echo suppression policy (issue #302): main.ts's handleExternalChange
// ignores a watcher event for `path` within a short window after our own
// save landed there, so the file-system echo that write itself causes never
// gets mistaken for an external change. A blind elapsed-time check, though,
// can't tell that guaranteed self-echo apart from a genuine external write
// landing in the same short window — it swallows both alike, so a real
// change right after a save could sit un-reloaded (and the user unnotified)
// until some unrelated later event happens to re-trigger the check.
//
// Pulled out as a pure function for the same reason savecompletion.ts's
// decideSaveCompletion was: main.ts is wired directly into IPC/DOM/editor
// and isn't unit-testable on its own, so the decision table itself gets
// full-branch vitest coverage instead.

/** Fresh on-disk size/mtime — ipc.ts's DocumentMetadata shape, duplicated
 *  here as a structural type (not imported) so this module stays a pure
 *  leaf with no runtime dependency on ipc.ts, matching missingondisk.ts's
 *  own preference for structural typing over a hard import where only the
 *  shape is actually needed. */
export interface SaveEchoMetadata {
  size: number;
  modifiedMs: number;
}

/** How long a watcher event for a just-saved path is treated as *possibly*
 *  our own echo — main.ts's original (pre-#302) constant, unchanged: it's
 *  still the first, cheapest filter, just no longer the only one. */
export const SAVE_ECHO_WINDOW_MS = 1500;

/** What main.ts records right after a successful save completes. `metadata`
 *  is a best-effort documentMetadata(path) snapshot taken immediately after
 *  the write — null if that read hasn't resolved yet or failed, in which
 *  case suppression below falls back to time alone, exactly like before
 *  this fix (never worse than the pre-#302 behavior). */
export interface SaveEchoRecord {
  /** Date.now() when this save's write landed. */
  time: number;
  metadata: SaveEchoMetadata | null;
}

export interface SaveEchoInput {
  now: number;
  /** recentSaves.get(path) — undefined when nothing has been saved to this
   *  path this session (or the record aged out), which alone means this
   *  can't be a save echo. */
  record: SaveEchoRecord | undefined;
  /** A fresh documentMetadata(path) read taken in response to the watcher
   *  event under consideration, fetched only once `now` is already inside
   *  the record's window (no need to pay for it otherwise). `undefined`
   *  when the caller deliberately skips that fetch (time-only fast path);
   *  `null` when the fetch itself was attempted and failed (most plausibly
   *  the file is gone) — distinct from `undefined` because a failed stat is
   *  itself a signal something changed, the opposite of `undefined`'s "no
   *  extra information yet, trust time alone" meaning. */
  current?: SaveEchoMetadata | null;
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
 * 4. No baseline to compare (`record.metadata` is null — our own post-save
 *    stat hasn't resolved yet or failed): suppress, same fail-closed
 *    fallback as before this fix.
 * 5. Both snapshots present: suppress only if size and mtime both match —
 *    anything else means the file moved since our own write, even though
 *    we're still inside the nominal window.
 */
export function isLikelySaveEcho(input: SaveEchoInput): boolean {
  const { record } = input;
  if (!record || input.now - record.time >= SAVE_ECHO_WINDOW_MS) return false;
  if (input.current === undefined) return true;
  if (input.current === null) return false;
  if (record.metadata === null) return true;
  return (
    record.metadata.size === input.current.size &&
    record.metadata.modifiedMs === input.current.modifiedMs
  );
}
