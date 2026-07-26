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
