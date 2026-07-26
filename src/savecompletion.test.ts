import { describe, expect, it } from "vitest";
import {
  decideSaveCompletion,
  shouldRollbackForceDirty,
  type EncodingRollbackInput,
  type SaveCompletionInput,
} from "./savecompletion";

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold a save IPC call open across a synchronous "user kept
 *  typing" mutation before deciding when it "arrives". Same shape as
 *  batchconvert.test.ts / streamreplace.test.ts's helper. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal stand-in for the parts of tabs.ts's Doc that saveFlow's
 *  completion block touches, plus a fake backup registry so "dropBackup"
 *  is observable without pulling in ipc.ts. `lineEnding` is only read by
 *  the issue #160 scenarios below; every other test in this file ignores
 *  it. */
function makeDocState() {
  return {
    revision: 0,
    dirty: true,
    backupName: "bk-1.txt" as string | null,
    fingerprint: "fp-0" as unknown,
    lineEnding: "LF",
  };
}

function applyDecision(
  doc: ReturnType<typeof makeDocState>,
  decision: ReturnType<typeof decideSaveCompletion>,
  newFingerprint: unknown,
): void {
  if (decision.updateFingerprint) doc.fingerprint = newFingerprint;
  if (decision.clearDirty) doc.dirty = false;
  if (decision.dropBackup) doc.backupName = null;
}

const base: SaveCompletionInput = {
  written: true,
  stale: false,
  revisionAtStart: 5,
  currentRevision: 5,
  pathChanged: false,
};

describe("decideSaveCompletion — full branch table", () => {
  it("not written: never touches dirty/backup/fingerprint, regardless of other fields", () => {
    expect(
      decideSaveCompletion({ ...base, written: false, stale: false }),
    ).toEqual({ clearDirty: false, dropBackup: false, updateFingerprint: false });
    expect(
      decideSaveCompletion({
        ...base,
        written: false,
        stale: true,
        revisionAtStart: 1,
        currentRevision: 99,
      }),
    ).toEqual({ clearDirty: false, dropBackup: false, updateFingerprint: false });
  });

  it("written but reported stale (contract-violating combination): fails closed", () => {
    // ipc.ts's SaveResult contract says written:true always implies
    // stale:false — this input combination should never occur in
    // practice, but the guard must not clear dirty/drop the backup on the
    // strength of a self-contradictory result.
    expect(decideSaveCompletion({ ...base, written: true, stale: true })).toEqual({
      clearDirty: false,
      dropBackup: false,
      updateFingerprint: false,
    });
  });

  it("written, same revision, same path: clears dirty and drops the backup", () => {
    expect(decideSaveCompletion(base)).toEqual({
      clearDirty: true,
      dropBackup: true,
      updateFingerprint: true,
    });
  });

  it("written, revision advanced (edit landed mid-flight): keeps dirty and the backup, still updates fingerprint", () => {
    expect(
      decideSaveCompletion({ ...base, revisionAtStart: 5, currentRevision: 6 }),
    ).toEqual({ clearDirty: false, dropBackup: false, updateFingerprint: true });
  });

  it("written, path changed (concurrent flow moved the doc): keeps dirty and the backup, still updates fingerprint", () => {
    expect(decideSaveCompletion({ ...base, pathChanged: true })).toEqual({
      clearDirty: false,
      dropBackup: false,
      updateFingerprint: true,
    });
  });

  it("written, both revision and path diverged: keeps dirty and the backup, still updates fingerprint", () => {
    expect(
      decideSaveCompletion({
        ...base,
        revisionAtStart: 5,
        currentRevision: 6,
        pathChanged: true,
      }),
    ).toEqual({ clearDirty: false, dropBackup: false, updateFingerprint: true });
  });
});

// Issue #112: saveFlow snapshots doc.revision before the IPC round trip and
// compares it again once the promise resolves. These scenarios mirror that
// shape with a deferred save IPC call so a "the user kept typing" mutation
// can land in the gap, exactly like main.ts's async saveFlow would see it.
describe("save completion race — deferred IPC scenarios", () => {
  it("(a) an edit lands while save is in flight: dirty and backup survive, fingerprint still updates", async () => {
    const doc = makeDocState();
    const revisionAtStart = doc.revision;
    const call = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();

    const completion = call.promise.then((result) => {
      const decision = decideSaveCompletion({
        written: result.written,
        stale: result.stale,
        revisionAtStart,
        currentRevision: doc.revision,
        pathChanged: false,
      });
      applyDecision(doc, decision, result.fingerprint);
      return decision;
    });

    // The user keeps typing while saveDocument's IPC call is still in
    // flight — the editor's onDocChanged hook bumps doc.revision.
    doc.revision += 1;
    call.resolve({ written: true, stale: false, fingerprint: "fp-1" });
    const decision = await completion;

    expect(decision).toEqual({
      clearDirty: false,
      dropBackup: false,
      updateFingerprint: true,
    });
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-1.txt");
    expect(doc.fingerprint).toBe("fp-1");
  });

  it("(b) control — no edit during the save: dirty clears and the backup drops", async () => {
    const doc = makeDocState();
    const revisionAtStart = doc.revision;
    const call = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();

    const completion = call.promise.then((result) => {
      const decision = decideSaveCompletion({
        written: result.written,
        stale: result.stale,
        revisionAtStart,
        currentRevision: doc.revision,
        pathChanged: false,
      });
      applyDecision(doc, decision, result.fingerprint);
      return decision;
    });

    call.resolve({ written: true, stale: false, fingerprint: "fp-1" });
    const decision = await completion;

    expect(decision).toEqual({
      clearDirty: true,
      dropBackup: true,
      updateFingerprint: true,
    });
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.fingerprint).toBe("fp-1");
  });

  it("(c) lossy two-phase save: an edit during the confirm wait still survives the retry that reuses the original snapshot", async () => {
    const doc = makeDocState();
    const revisionAtStart = doc.revision;

    // Phase 1: allowLossy:false comes back unmappable/not written — the UI
    // would show the lossy-encoding confirm dialog here.
    const firstCall = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();
    const firstResult = firstCall.promise;
    firstCall.resolve({ written: false, stale: false, fingerprint: null });
    await firstResult;

    // While the (simulated) confirm dialog is up, the user keeps editing —
    // still the same doc, same content snapshot pending as far as saveFlow
    // is concerned (it never re-reads editor.content() for the retry).
    doc.revision += 1;

    // Phase 2: allowLossy:true retry, reusing the *original* content
    // snapshot and therefore the same revisionAtStart captured before
    // phase 1 — never re-snapshotted for a retry.
    const secondCall = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();
    const completion = secondCall.promise.then((result) => {
      const decision = decideSaveCompletion({
        written: result.written,
        stale: result.stale,
        revisionAtStart,
        currentRevision: doc.revision,
        pathChanged: false,
      });
      applyDecision(doc, decision, result.fingerprint);
      return decision;
    });
    secondCall.resolve({ written: true, stale: false, fingerprint: "fp-lossy-1" });
    const decision = await completion;

    expect(decision).toEqual({
      clearDirty: false,
      dropBackup: false,
      updateFingerprint: true,
    });
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-1.txt");
    expect(doc.fingerprint).toBe("fp-lossy-1");
  });
});

// Issue #160: main.ts's setLineEnding only ever touched doc.lineEnding and
// doc.dirty — never doc.revision. runSaveFlow snapshots doc.lineEnding into
// saveParams alongside content and revisionAtStart, so a line-ending switch
// mid-flight makes this save's bytes stale the instant it happens, exactly
// like a content edit does. But because doc.revision never moved, the
// revisionAtStart/currentRevision comparison below (issue #112's own guard)
// couldn't tell the two apart from "nothing changed" — clearDirty/dropBackup
// would wrongly fire, leaving disk with the *old* line ending while the tab
// reports saved. setLineEndingSim mirrors main.ts's setLineEnding (kept in
// sync with it by hand, the same way this file's deferred-IPC harness mirrors
// saveFlow's completion step instead of reimplementing decideSaveCompletion's
// own branch logic) — the pre-fix version is exactly main.ts's current body;
// the fix adds the doc.revision bump main.ts's editor onChange handler,
// applyOpenedForReload, and reopenWithEncoding already perform for every
// other save-relevant mutation.
function setLineEndingSim(
  doc: ReturnType<typeof makeDocState>,
  lineEnding: string,
): void {
  if (doc.lineEnding === lineEnding) return;
  doc.lineEnding = lineEnding;
  // The fix under test (issue #160): draws a new revision from the same
  // shared sequence main.ts's editor onChange handler, applyOpenedForReload,
  // and reopenWithEncoding already use for every other save-relevant
  // mutation. Delete this line to reproduce the pre-fix bug — the scenario
  // below fails without it (decideSaveCompletion wrongly clears dirty).
  doc.revision += 1;
  if (!doc.dirty) doc.dirty = true;
}

describe("issue #160 — a line-ending switch during an in-flight save must count as a revision-worthy edit", () => {
  it("LF -> CRLF lands while save is in flight: dirty and the backup survive (pre-fix this was wrongly cleared)", async () => {
    const doc = makeDocState();
    const revisionAtStart = doc.revision;
    const call = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();

    const completion = call.promise.then((result) => {
      const decision = decideSaveCompletion({
        written: result.written,
        stale: result.stale,
        revisionAtStart,
        currentRevision: doc.revision,
        pathChanged: false,
      });
      applyDecision(doc, decision, result.fingerprint);
      return decision;
    });

    // The save's IPC round trip already captured doc.lineEnding ("LF") into
    // its saveParams before this — main.ts's runSaveFlow reads doc.lineEnding
    // synchronously, before the first await. Switching it now (Format menu,
    // still mid-flight) means whatever this save writes is stale line-ending
    // bytes the moment it lands.
    setLineEndingSim(doc, "CRLF");

    call.resolve({ written: true, stale: false, fingerprint: "fp-1" });
    const decision = await completion;

    expect(decision).toEqual({
      clearDirty: false,
      dropBackup: false,
      updateFingerprint: true,
    });
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-1.txt");
    expect(doc.fingerprint).toBe("fp-1"); // fingerprint still updates: disk really did change
  });

  it("control — line ending changes only after the save has already resolved: ordinary dirty semantics apply, no race", async () => {
    const doc = makeDocState();
    const revisionAtStart = doc.revision;
    const call = deferred<{ written: boolean; stale: boolean; fingerprint: unknown }>();

    const completion = call.promise.then((result) => {
      const decision = decideSaveCompletion({
        written: result.written,
        stale: result.stale,
        revisionAtStart,
        currentRevision: doc.revision,
        pathChanged: false,
      });
      applyDecision(doc, decision, result.fingerprint);
      return decision;
    });

    call.resolve({ written: true, stale: false, fingerprint: "fp-1" });
    await completion;
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();

    // Only now — after the save has fully settled — does the user switch
    // line ending. No save in flight, so this is just an ordinary edit.
    setLineEndingSim(doc, "CRLF");
    expect(doc.dirty).toBe(true);
  });
});

// Issue #276: the Save with Encoding write-failure rollback must not
// restore dirty:false when the failure was specifically a stale rejection
// the user cancelled out of — disk is proven to differ from the buffer at
// that point, so a "clean" doc would be lying about being in sync.
describe("shouldRollbackForceDirty — full branch table", () => {
  const base: EncodingRollbackInput = {
    written: false,
    stale: false,
    wasClean: true,
    identity: "apply",
  };

  it("ordinary (non-stale) write failure, clean doc, identity holds: rolls back", () => {
    expect(shouldRollbackForceDirty(base)).toBe(true);
  });

  it("issue #276: stale failure (cancel path) — never rolls back, even with every other gate green", () => {
    expect(shouldRollbackForceDirty({ ...base, stale: true })).toBe(false);
  });

  it("doc was already dirty entering the action (wasClean false): never rolls back, stale or not", () => {
    expect(shouldRollbackForceDirty({ ...base, wasClean: false })).toBe(false);
    expect(shouldRollbackForceDirty({ ...base, wasClean: false, stale: true })).toBe(
      false,
    );
  });

  it("an edit landed mid-flight (identity 'edited'): never rolls back", () => {
    expect(shouldRollbackForceDirty({ ...base, identity: "edited" })).toBe(false);
  });

  it("tab closed mid-flight (identity 'closed'): never rolls back", () => {
    expect(shouldRollbackForceDirty({ ...base, identity: "closed" })).toBe(false);
  });

  it("written:true (contract-violating combination): fails closed regardless of other fields", () => {
    expect(shouldRollbackForceDirty({ ...base, written: true })).toBe(false);
    expect(
      shouldRollbackForceDirty({ ...base, written: true, stale: false, identity: "apply" }),
    ).toBe(false);
  });
});

// PR #319 second-round Codex review (P2): main.ts's backupFlush.schedule()
// debounces on a fixed 2-second timer, entirely independent of how long the
// stale/lossy/byte-drift confirm dialogs the Save with Encoding action can
// show stay open. If that debounce fires while one of those dialogs is
// still up, its flush->persistSession chain (see main.ts's backupFlush
// wiring) writes session.json with whatever doc.encoding/withBom are *at
// that moment* — the speculative target this action set before the dialog
// ever opened, not the original the rollback below is about to restore.
// On the stale-cancel path in particular, shouldRollbackForceDirty (issue
// #276, just above) deliberately keeps dirty/the backup alive, so that
// stale session entry keeps pointing at a real backup file a crash before
// any *other* persistSession() call would restore tagged with the wrong
// encoding. sessionEncodingSim below mirrors main.ts's rollback closure by
// hand (same "kept in sync manually" pattern as setLineEndingSim above) to
// pin that a persistSession() call after the encoding/withBom revert
// closes this window, regardless of which shouldRollbackForceDirty branch
// ran.
interface SessionEncodingDoc {
  encoding: string;
  withBom: boolean;
  dirty: boolean;
}

/** Mirrors main.ts's Save with Encoding menu action up through setting the
 *  speculative encoding/withBom and forcing dirty (issues #221/#231) —
 *  returns the pre-action snapshot the eventual rollback needs, exactly
 *  like that action's own local `original` constant. */
function beginSaveWithEncodingSim(
  doc: SessionEncodingDoc,
  target: { encoding: string; withBom: boolean },
): { encoding: string; withBom: boolean } {
  const original = { encoding: doc.encoding, withBom: doc.withBom };
  doc.encoding = target.encoding;
  doc.withBom = target.withBom;
  if (!doc.dirty) doc.dirty = true;
  return original;
}

/** Mirrors main.ts's saveFlow(false).then(...) rollback handler: reverts
 *  encoding/withBom on any write failure, applies shouldRollbackForceDirty
 *  for the dirty/backup decision, then — the fix under test here —
 *  re-persists the session once those fields have settled, regardless of
 *  which branch ran. `persistSession` is injected so the test can observe
 *  every call's snapshot instead of main.ts's own IPC-backed version. */
function resolveSaveWithEncodingSim(
  doc: SessionEncodingDoc,
  original: { encoding: string; withBom: boolean },
  wasClean: boolean,
  outcome: { written: boolean; stale: boolean },
  persistSession: () => void,
): void {
  if (outcome.written) return;
  doc.encoding = original.encoding;
  doc.withBom = original.withBom;
  if (
    shouldRollbackForceDirty({
      written: outcome.written,
      stale: outcome.stale,
      wasClean,
      identity: "apply",
    })
  ) {
    doc.dirty = false;
  }
  persistSession();
}

describe("Save with Encoding rollback re-persists session once encoding reverts (PR #319 second-round review)", () => {
  it("stale-cancel: a debounce flush mid-dialog persisted the speculative encoding — rollback re-persists the reverted one, dirty/backup left alone", () => {
    const doc: SessionEncodingDoc = { encoding: "UTF-8", withBom: false, dirty: false };
    const snapshots: Array<{ encoding: string; withBom: boolean }> = [];
    const persistSession = (): void => {
      snapshots.push({ encoding: doc.encoding, withBom: doc.withBom });
    };

    const original = beginSaveWithEncodingSim(doc, { encoding: "Big5", withBom: false });

    // The 2-second backup debounce fires while the stale dialog is still
    // open — session.json is written with the speculative target.
    persistSession();
    expect(snapshots[snapshots.length - 1]).toEqual({ encoding: "Big5", withBom: false });

    // User cancels the stale dialog.
    resolveSaveWithEncodingSim(
      doc,
      original,
      /* wasClean */ true,
      { written: false, stale: true },
      persistSession,
    );

    expect(doc.encoding).toBe("UTF-8");
    expect(doc.dirty).toBe(true); // issue #276: stale-cancel keeps dirty
    expect(snapshots[snapshots.length - 1]).toEqual({ encoding: "UTF-8", withBom: false });
  });

  it("control — non-stale failure on a doc that started clean: also re-persists after the full rollback (dirty cleared)", () => {
    const doc: SessionEncodingDoc = { encoding: "UTF-8", withBom: false, dirty: false };
    const snapshots: Array<{ encoding: string; withBom: boolean }> = [];
    const persistSession = (): void => {
      snapshots.push({ encoding: doc.encoding, withBom: doc.withBom });
    };

    const original = beginSaveWithEncodingSim(doc, { encoding: "Big5", withBom: false });
    persistSession(); // debounce fires mid-flight here too

    resolveSaveWithEncodingSim(
      doc,
      original,
      /* wasClean */ true,
      { written: false, stale: false },
      persistSession,
    );

    expect(doc.encoding).toBe("UTF-8");
    expect(doc.dirty).toBe(false);
    expect(snapshots[snapshots.length - 1]).toEqual({ encoding: "UTF-8", withBom: false });
  });

  it("no debounce fired at all: rollback still re-persists once (not a no-op skip)", () => {
    const doc: SessionEncodingDoc = { encoding: "UTF-8", withBom: false, dirty: false };
    const snapshots: Array<{ encoding: string; withBom: boolean }> = [];
    const persistSession = (): void => {
      snapshots.push({ encoding: doc.encoding, withBom: doc.withBom });
    };

    const original = beginSaveWithEncodingSim(doc, { encoding: "Big5", withBom: false });
    resolveSaveWithEncodingSim(
      doc,
      original,
      /* wasClean */ true,
      { written: false, stale: true },
      persistSession,
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ encoding: "UTF-8", withBom: false });
  });
});

// PR #319 third-round Codex review (P2): main.ts's runSaveFlow wraps its
// entire body — the initial save attempt, the lossy retry, the stale gate,
// and the user's "overwrite" (force: true) retry — in one try/catch. Once
// the stale gate has actually fired for this attempt (result.stale &&
// !result.written), disk is proven to differ from the buffer; that fact
// doesn't stop being true just because the user's chosen "overwrite" retry
// then *throws* instead of resolving with written:false (the target
// became unwritable, its directory disappeared, ...). Hardcoding
// `stale: false` in the catch block erases that already-observed fact —
// exactly the "buffer matches disk" false signal issue #276's
// shouldRollbackForceDirty exists to prevent, just reached via a throw
// instead of a resolved failure. runSaveFlowCatchStaleSim mirrors main.ts's
// own try/catch shape (the "kept in sync by hand" pattern this file
// already uses for setLineEndingSim/the Save with Encoding rollback sims
// above) to pin that the catch preserves whatever staleness this attempt
// already observed, rather than hardcoding false.
async function runSaveFlowCatchStaleSim(
  attempt: () => Promise<{ written: boolean; stale: boolean }>,
  onStale?: () => Promise<void>,
): Promise<{ written: boolean; stale: boolean }> {
  let observedStale = false;
  try {
    const result = await attempt();
    if (result.stale && !result.written) {
      observedStale = true;
      if (onStale) await onStale();
    }
    return result;
  } catch {
    // The fix under test: observedStale, not a hardcoded false.
    return { written: false, stale: observedStale };
  }
}

describe("runSaveFlow catch preserves already-observed staleness (PR #319 third-round review)", () => {
  it("stale gate fired, then the overwrite retry throws: catch still reports stale:true", async () => {
    const outcome = await runSaveFlowCatchStaleSim(
      () => Promise.resolve({ written: false, stale: true }),
      () => Promise.reject(new Error("EACCES: permission denied")),
    );

    expect(outcome).toEqual({ written: false, stale: true });

    // Fed into the Save with Encoding rollback gate exactly like main.ts's
    // own .then handler would: a clean doc, identity still "apply" — must
    // NOT roll back dirty, the same protection issue #276 established for
    // the ordinary stale-cancel path, now also holding for this
    // throw-during-overwrite-retry path.
    expect(
      shouldRollbackForceDirty({
        written: outcome.written,
        stale: outcome.stale,
        wasClean: true,
        identity: "apply",
      }),
    ).toBe(false);
  });

  it("control — the initial attempt itself throws, before any staleness was ever observed: catch reports stale:false", async () => {
    const outcome = await runSaveFlowCatchStaleSim(() =>
      Promise.reject(new Error("ENOENT: no such file or directory")),
    );

    expect(outcome).toEqual({ written: false, stale: false });
  });

  it("control — a non-stale failure, no retry needed: resolves normally, no catch involved", async () => {
    const outcome = await runSaveFlowCatchStaleSim(() =>
      Promise.resolve({ written: false, stale: false }),
    );

    expect(outcome).toEqual({ written: false, stale: false });
  });
});
