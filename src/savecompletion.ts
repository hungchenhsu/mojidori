// Save-completion policy (issue #112): a document can keep changing while
// its IPC save round trip is in flight (including the lossy-encoding
// confirm and stale-overwrite force retries in main.ts's saveFlow), so the
// completion handler must not blindly trust a successful write to mean
// "the buffer the user sees right now is on disk". Pulled out as a pure
// function — main.ts's saveFlow is wired directly into the DOM/editor/IPC
// and isn't unit-testable on its own (see chunkpolicy.ts/mojibake.ts's
// isMojibakeSnapshotStale for the same pattern) — so the decision table
// itself gets full-branch vitest coverage instead.

export interface SaveCompletionInput {
  /** Whether this save attempt's bytes actually reached disk. */
  written: boolean;
  /** Whether the backend reported the on-disk fingerprint no longer
   *  matched `expectedFingerprint` (issue #113). Contractually this is
   *  always false when `written` is true (see ipc.ts SaveResult) — carried
   *  here anyway so a caller that violates that contract fails closed
   *  instead of this function silently trusting `written` alone. */
  stale: boolean;
  /** doc.revision captured at the moment saveFlow read editor.content(),
   *  before any IPC round trip (including retries — a lossy-confirm or
   *  stale-overwrite retry re-sends the same content snapshot, so it
   *  reuses this same value rather than re-reading it). */
  revisionAtStart: number;
  /** doc.revision as of right now, i.e. once the save's IPC promise (or
   *  its last retry) has resolved. */
  currentRevision: number;
  /** Whether doc.path changed since the flow started (a concurrent flow —
   *  e.g. an overlapping Save As — moved the doc to a different path).
   *  Not the ordinary Save As of *this* flow, which reassigns doc.path
   *  unconditionally regardless of this decision. */
  pathChanged: boolean;
}

export interface SaveCompletionDecision {
  /** Clear doc.dirty — safe only when nothing new landed since the
   *  content snapshot this save actually wrote. */
  clearDirty: boolean;
  /** Delete the hot-exit backup — must stay false whenever clearDirty is
   *  false, so the backup cycle keeps covering unsaved edits. */
  dropBackup: boolean;
  /** Update doc.fingerprint to the backend's post-write value. Unconditional
   *  whenever written: disk now holds exactly what this call wrote, so the
   *  next save's staleness check (issue #113) needs this as its baseline
   *  regardless of whether the edit happened concurrently. */
  updateFingerprint: boolean;
}

/**
 * Decide what a successful (or not) save IPC round trip is allowed to do to
 * the tab's dirty/backup/fingerprint state. Revision and path are compared
 * as of "now" (after the await) against the snapshot taken before the IPC
 * call; a mismatch means the user kept editing (or a concurrent flow moved
 * the doc) while bytes were in flight, so the *new* content is still only
 * in the editor buffer, not on disk — dirty and the backup must survive so
 * hot exit keeps covering it. Nothing auto-retries and nothing prompts
 * here; the next explicit Save naturally writes the newer content.
 */
export function decideSaveCompletion(
  input: SaveCompletionInput,
): SaveCompletionDecision {
  if (!input.written || input.stale) {
    return { clearDirty: false, dropBackup: false, updateFingerprint: false };
  }
  const revisionMatches =
    input.revisionAtStart === input.currentRevision && !input.pathChanged;
  return {
    clearDirty: revisionMatches,
    dropBackup: revisionMatches,
    updateFingerprint: true,
  };
}

/**
 * Issue #276 (a pre-existing cosmetic edge #275's own adversarial review
 * flagged, not fixed there): the "Save with Encoding" menu action's write-
 * failure rollback (main.ts's reopenWithEncoding-adjacent action, `.then`
 * handler on its own `saveFlow` call) undoes the force-dirty transition
 * issue #221/#231 require — but only when it's safe to, per two gates
 * already established there: `wasClean` (the force actually fired) and an
 * `asyncguard.ts` identity check (nothing else touched the doc while the
 * save's IPC round trip was in flight). Neither gate says anything about
 * *why* the write failed. A **stale** failure (`written: false, stale:
 * true` — the user saw the stale-file dialog and chose "cancel", the only
 * stale outcome that reaches this rollback at all; "reload" already clears
 * `doc.speculativeEncoding` via `applyOpenedForReload`, which excludes it
 * before this function would even run) means the disk was already proven
 * to differ from what this doc's save assumed. Restoring `dirty: false` in
 * that case tells the user "buffer matches disk" when it provably doesn't
 * — the opposite of what `wasClean`/identity were protecting: real edits
 * never at risk, but a false "clean" signal painted over a known external
 * change instead of letting main.ts's ordinary fileChanged/reload flow
 * (handleExternalChange, reevaluateReload) surface it.
 *
 * `written` is checked here too, even though every real call site already
 * gates on `!written` before reaching this decision — same
 * fails-closed-on-a-contract-violation defense decideSaveCompletion's own
 * `stale` field docs above describe, not a case any caller is expected to
 * exercise.
 */
export interface EncodingRollbackInput {
  /** Whether this Save with Encoding attempt's bytes reached disk. */
  written: boolean;
  /** Whether the failure was specifically the stale-file gate rejecting a
   *  write the user then cancelled out of, rather than any other failure
   *  (permission, disk full, lossy-encode declined, dialog cancelled). */
  stale: boolean;
  /** Whether the force-dirty transition actually fired for this action —
   *  false means the doc was already dirty before this call started, so
   *  its dirty/backup state belongs to real unsaved edits this rollback
   *  must never touch regardless of `stale` (issue #231). */
  wasClean: boolean;
  /** asyncguard.ts's validateIdentity(...) result for the doc, checked
   *  against the guard captured right after the force-dirty transition. */
  identity: "apply" | "closed" | "edited";
}

export function shouldRollbackForceDirty(input: EncodingRollbackInput): boolean {
  return (
    !input.written && !input.stale && input.wasClean && input.identity === "apply"
  );
}
