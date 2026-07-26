import { describe, expect, it } from "vitest";
import { reloadEncodingFor } from "./asyncguard";
import { decideSaveCompletion } from "./savecompletion";
import {
  fingerprintsEqual,
  mustDefer,
  nextDrainStep,
  type LockOwner,
} from "./savemutex";

/** A promise plus its resolve/reject, exposed for manual settlement — lets
 *  a test hold a save/open IPC mock open across another synchronous action
 *  (e.g. a second request being issued) before deciding when it "arrives".
 *  Same shape as chunkguard.test.ts / savecompletion.test.ts's helper. */
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

describe("mustDefer — full branch table", () => {
  it("nothing in flight: proceeds", () => {
    expect(mustDefer({ inFlight: null })).toBe(false);
  });

  it("a save is in flight: defers", () => {
    expect(mustDefer({ inFlight: "save" })).toBe(true);
  });

  it("a reload is in flight: defers", () => {
    expect(mustDefer({ inFlight: "reload" })).toBe(true);
  });
});

describe("nextDrainStep — full branch table", () => {
  it("nothing pending: done, regardless of dirty", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: null, dirty: false, blockedByReadOnly: false }),
    ).toEqual({ kind: "done" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: null, dirty: true, blockedByReadOnly: false }),
    ).toEqual({ kind: "done" });
  });

  it("pending reload only: reload, regardless of dirty", () => {
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: null, dirty: false, blockedByReadOnly: false }),
    ).toEqual({ kind: "reload" });
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: null, dirty: true, blockedByReadOnly: false }),
    ).toEqual({ kind: "reload" });
  });

  it("pending save only, doc still dirty, not blocked: runs it, carrying the pending saveAs flag", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: true, blockedByReadOnly: false }),
    ).toEqual({ kind: "save", saveAs: false });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: true, blockedByReadOnly: false }),
    ).toEqual({ kind: "save", saveAs: true });
  });

  it("pending save only, doc already clean: dropped as a redundant no-op write, regardless of blockedByReadOnly", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: false, blockedByReadOnly: false }),
    ).toEqual({ kind: "dropSave" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: false, blockedByReadOnly: false }),
    ).toEqual({ kind: "dropSave" });
  });

  it("both a reload and a save pending: reload always drains first, regardless of the save's flag, dirty, or blockedByReadOnly", () => {
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: true, dirty: true, blockedByReadOnly: false }),
    ).toEqual({ kind: "reload" });
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: false, dirty: false, blockedByReadOnly: false }),
    ).toEqual({ kind: "reload" });
    expect(
      nextDrainStep({ pendingReload: true, pendingSaveAs: true, dirty: true, blockedByReadOnly: true }),
    ).toEqual({ kind: "reload" });
  });

  // Issue #217 (a critic-review finding against #208's own fix): a pending
  // save that's still dirty when the doc is also blocked (truncated or
  // userReadOnly) as of this exact recheck must be rejected, not run —
  // running it would write doc's current buffer over the real file despite
  // the doc having turned read-only during the defer window.
  it("pending save, still dirty, blocked: rejectBlocked, carrying neither a write nor the saveAs flag", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: true, blockedByReadOnly: true }),
    ).toEqual({ kind: "rejectBlocked" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: true, blockedByReadOnly: true }),
    ).toEqual({ kind: "rejectBlocked" });
  });

  // The precedence question issue #217's own fix report calls out
  // explicitly: dropSave (dirty=false) must win over blockedByReadOnly, not
  // the other way around, because dirty=false means whatever just released
  // the lock already covers this request (a matching-revision completion
  // wrote it, or a consented reload discarded it) independent of the doc's
  // read-only status a moment later — see nextDrainStep's own doc comment.
  // A implementation that checked blockedByReadOnly before dirty would
  // wrongly reject (and resolve `false` for) a request that in fact already
  // succeeded or was already knowingly abandoned.
  it("pending save, already clean, ALSO blocked: dropSave still wins — blockedByReadOnly never overrides a clean doc", () => {
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: false, dirty: false, blockedByReadOnly: true }),
    ).toEqual({ kind: "dropSave" });
    expect(
      nextDrainStep({ pendingReload: false, pendingSaveAs: true, dirty: false, blockedByReadOnly: true }),
    ).toEqual({ kind: "dropSave" });
  });
});

describe("fingerprintsEqual", () => {
  it("equal primitives (including both null — no verified baseline yet)", () => {
    expect(fingerprintsEqual("fp-1", "fp-1")).toBe(true);
    expect(fingerprintsEqual(null, null)).toBe(true);
  });

  it("different primitives", () => {
    expect(fingerprintsEqual("fp-1", "fp-2")).toBe(false);
    expect(fingerprintsEqual(null, "fp-1")).toBe(false);
  });

  it("structurally equal Fingerprint-shaped objects (fsguard.rs's actual camelCase shape)", () => {
    const a = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    const b = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    expect(fingerprintsEqual(a, b)).toBe(true);
  });

  it("differs in one nested field", () => {
    const a = { len: 42, modified: { secs: 100, nanos: 0 }, identity: [1, 2] };
    const b = { len: 42, modified: { secs: 100, nanos: 1 }, identity: [1, 2] };
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main.ts-shaped simulation. main.ts itself has no *.test.ts — it's wired
// directly into IPC/DOM/editor and isn't unit-testable on its own (see
// savecompletion.ts's header comment) — so, same as chunkguard.test.ts for
// issue #120, this harness mirrors main.ts's planned withLock/drainLock/
// saveFlow/reloadFromDisk control flow closely enough to reproduce issue
// #124's race, wired to the real mustDefer/nextDrainStep/fingerprintsEqual
// (and the real decideSaveCompletion) rather than reimplementing their
// logic independently — a wrong or missing defer check here fails exactly
// like it would in production.

interface OpenedFixture {
  content: string;
  fingerprint: unknown;
  /** Optional — only the issue #161 scenarios below care about encoding at
   *  all; every pre-existing fixture omits these three and applyOpened
   *  leaves the matching doc field untouched, same as it always has. */
  encoding?: string;
  hadBom?: boolean;
  malformed?: boolean;
}

interface SaveIpcResult {
  written: boolean;
  stale: boolean;
  fingerprint: unknown;
  writtenContent: string;
}

/** Minimal stand-in for the slice of tabs.ts's Doc this simulation
 *  exercises, plus the three new lock fields main.ts's saveFlow/
 *  reloadFromDisk read and write (issue #124), the encoding/
 *  speculativeEncoding fields issue #161's scenarios below add, and the
 *  truncated/userReadOnly pair issue #217's scenarios further below add —
 *  both default false, so every pre-#217 fixture that never mentions them
 *  keeps hitting drainLock's normal "save" branch exactly as before. */
function makeDocState() {
  return {
    dirty: false,
    backupName: null as string | null,
    fingerprint: "fp-0" as unknown,
    buffer: "",
    revision: 0,
    saveReloadInFlight: null as LockOwner,
    pendingReload: false,
    pendingSaveAs: null as boolean | null,
    encoding: "UTF-8",
    withBom: false,
    malformed: false,
    speculativeEncoding: null as { encoding: string; withBom: boolean } | null,
    truncated: false,
    userReadOnly: false,
  };
}
type DocState = ReturnType<typeof makeDocState>;

/** Fake disk backing the save/open IPC mocks — the ground truth this
 *  simulation checks doc.fingerprint/buffer against once a scenario
 *  settles (issue #124's "(b) fingerprint 與 buffer 一致" requirement).
 *  `trueEncoding` (issue #161, optional — defaults to "UTF-8", matching
 *  makeDocState's own default, so every pre-existing fixture that never
 *  mentions encoding at all keeps decoding as a same-encoding, always-
 *  matches no-op exactly as before) is the encoding the disk bytes
 *  *actually* are; fetchDisk below decodes correctly only when asked for
 *  that same encoding — anything else is the wrong-decode hazard issue
 *  #161 is about, stood in for directly rather than via a real Big5 byte
 *  fixture: main.ts's speculative-encoding bug is entirely about *which
 *  encoding argument* a reload passes, never about encoding_rs's own
 *  decode tables, which lib.rs's own Rust tests already cover — so a
 *  frontend stand-in that's merely encoding-aware, not byte-accurate, is
 *  the right-sized fixture here. */
interface FakeDisk {
  content: string;
  fingerprint: unknown;
  trueEncoding?: string;
}

function writeDisk(disk: FakeDisk, content: string, fingerprint: unknown): void {
  disk.content = content;
  disk.fingerprint = fingerprint;
}

/** Mirrors backup.ts's dropBackup for this simulation — backup.test.ts
 *  already covers the real delete-then-null behavior in isolation, so this
 *  only needs to be observable, not IPC-backed. */
function dropBackupSim(doc: DocState): void {
  doc.backupName = null;
}

/** Mirrors reloadFromDisk's state-mutation body (main.ts's
 *  applyOpenedForReload, after its openDocument await): unconditional
 *  apply. encoding/hadBom/malformed are only ever set on an OpenedFixture
 *  by the issue #161 scenarios below (see its own optional fields) — every
 *  pre-existing caller omits them, so those three assignments are no-ops
 *  there, same as before this issue's fixture additions. Clearing
 *  doc.speculativeEncoding unconditionally mirrors applyOpenedForReload's
 *  own fix for the same issue: from this point on doc.encoding/withBom
 *  hold fresh, disk-verified truth (whenever this fixture actually carries
 *  it) that no later speculative-save rollback may stomp. */
function applyOpened(doc: DocState, opened: OpenedFixture): void {
  doc.dirty = false;
  dropBackupSim(doc);
  doc.revision += 1;
  doc.fingerprint = opened.fingerprint;
  doc.buffer = opened.content;
  if (opened.encoding !== undefined) doc.encoding = opened.encoding;
  if (opened.hadBom !== undefined) doc.withBom = opened.hadBom;
  if (opened.malformed !== undefined) doc.malformed = opened.malformed;
  doc.speculativeEncoding = null;
}

/** Hooks a test can inject into the harness. */
interface HarnessOptions {
  /** Mirrors main.ts reevaluateReload's dirty-confirm dialog (issue #124
   *  critic-review P2): consulted when a drained pending reload finds
   *  genuine external changes AND the doc went dirty while the reload sat
   *  in the pending slot. Defaults to throwing so a test that reaches the
   *  dialog without expecting to fails loudly instead of silently
   *  resolving one way or the other. */
  confirmReload?: () => Promise<boolean>;
  /** Fired synchronously right after a save's bytes land on the fake disk
   *  — the hook point for simulating an external third party rewriting
   *  the file immediately after our own write, before the drain's
   *  reevaluation gets to read it. */
  onDiskWritten?: () => void;
  /** Mirrors main.ts's showStaleFileConfirm (issue #161): consulted by
   *  runSave whenever a save IPC comes back `stale && !written`. Defaults
   *  to throwing, same convention as confirmReload — a test that doesn't
   *  expect a stale rejection should never silently resolve one way or the
   *  other. */
  staleChoice?: () => Promise<"reload" | "overwrite" | "cancel">;
  /** Issue #217: fired synchronously whenever drainLock's own read-only
   *  recheck blocks a coalesced save. Stands in for main.ts's
   *  blockedByReadOnly showing its rejection dialog (main.ts's own
   *  messageDialog calls) — this harness has no reason to invoke a real
   *  dialog, same convention as confirmReload/staleChoice standing in for
   *  main.ts's other dialogs above. Optional and uncalled by default, since
   *  most existing fixtures never expect to reach it at all. */
  onReadOnlyBlocked?: () => void;
}

/** One doc's harness. `disk` backs the default fetch used whenever a test
 *  doesn't inject its own controllable one (drainLock's reload
 *  reevaluation always reads current disk truth — see the module doc
 *  comment on why that specifically must not be blindly re-applied). */
function createHarness(doc: DocState, disk: FakeDisk, options: HarnessOptions = {}) {
  let pendingResolvers: Array<(written: boolean) => void> = [];
  let currentSaveIpc: () => Promise<SaveIpcResult> = () =>
    Promise.resolve({ written: false, stale: false, fingerprint: null, writtenContent: "" });
  const confirmReload =
    options.confirmReload ??
    (() => {
      throw new Error(
        "reached the dirty-confirm dialog but the test injected no confirmReload",
      );
    });
  const staleChoice =
    options.staleChoice ??
    (() => {
      throw new Error(
        "reached the stale-save dialog but the test injected no staleChoice",
      );
    });

  /** `encoding` mirrors main.ts's `openDocument(path, encoding)` explicit
   *  argument — decodes correctly only when it matches disk.trueEncoding
   *  (issue #161's stand-in; see FakeDisk's own doc comment). Every
   *  pre-#161 call site now threads reloadEncodingFor(doc) through here
   *  instead of a bare doc.encoding, same as the real fetchAndApplyReload/
   *  reevaluateReload fix. */
  function fetchDisk(encoding: string): Promise<OpenedFixture> {
    const trueEncoding = disk.trueEncoding ?? "UTF-8";
    if (encoding === trueEncoding) {
      return Promise.resolve({
        content: disk.content,
        fingerprint: disk.fingerprint,
        encoding,
        hadBom: false,
        malformed: false,
      });
    }
    // Wrong-encoding stand-in: a real decode would run disk.content's bytes
    // through the wrong codec and most likely hit invalid sequences partway
    // through (encoding_rs's own decode tables — not this harness's
    // concern; see FakeDisk's doc comment). Deterministic and clearly
    // distinct from any real fixture content, so a test asserting on it
    // can't accidentally pass for an unrelated reason.
    return Promise.resolve({
      content: `mojibake(${encoding}<-${trueEncoding}):${disk.content}`,
      fingerprint: disk.fingerprint,
      encoding,
      hadBom: false,
      malformed: true,
    });
  }

  /** Mirrors reloadFromDisk's own call into the per-doc lock (issue #124):
   *  defers (pendingReload) if a save or another reload already holds it —
   *  always true when called from runSave's own stale-branch below, since
   *  that always runs from inside the save's own withLock — otherwise
   *  applies directly. Shared by the public issueReload entry point and
   *  runSave's stale-dialog "reload" choice so both go through exactly one
   *  defer-or-apply decision, same as main.ts's single reloadFromDisk. */
  async function requestReload(fetchOpen: () => Promise<OpenedFixture>): Promise<void> {
    if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
      doc.pendingReload = true;
      return;
    }
    await withLock("reload", async () => {
      applyOpened(doc, await fetchOpen());
    });
  }

  async function runSave(ipc: () => Promise<SaveIpcResult>): Promise<boolean> {
    const revisionAtStart = doc.revision;
    const result = await ipc();
    if (result.stale && !result.written) {
      // Mirrors runSaveFlow's own stale-branch (issue #161): showStaleFileConfirm,
      // then — on "reload" — reloadFromDisk(doc), which (see requestReload's
      // own doc comment) always defers here since this is still running
      // inside the save's own withLock. Only "reload" is modeled beyond
      // "not written" — no existing or #161 scenario in this file drives
      // "overwrite" through this particular mock.
      const choice = await staleChoice();
      if (choice === "reload") {
        await requestReload(() => fetchDisk(reloadEncodingFor(doc)));
      }
      return false;
    }
    if (!result.written) return false;
    writeDisk(disk, result.writtenContent, result.fingerprint);
    options.onDiskWritten?.();
    const decision = decideSaveCompletion({
      written: result.written,
      stale: result.stale,
      revisionAtStart,
      currentRevision: doc.revision,
      pathChanged: false,
    });
    if (decision.updateFingerprint) doc.fingerprint = result.fingerprint;
    if (decision.clearDirty) doc.dirty = false;
    if (decision.dropBackup) dropBackupSim(doc);
    return true;
  }

  /** Drained pending reload only ever re-validates against current disk
   *  truth (issue #124) — never the direct/unconditional apply a fresh
   *  entry uses (see fetchAndApplyReload below). Critic-review P2: if the
   *  doc went dirty while the reload sat in the pending slot, applying
   *  would silently discard those edits — the buffer side needs consent
   *  too, not just the disk side, so this walks the same confirm dialog
   *  handleExternalChange already shows dirty docs, and a confirmed
   *  reload applies a FRESH read (disk may move again mid-dialog).
   *  reloadEncodingFor(doc), not a bare doc.encoding, on both fetches
   *  (issue #161) — this is the path a stale-save dialog's own "Reload"
   *  choice actually drains through (requestReload defers into
   *  pendingReload, drainLock runs this once the save's lock releases), so
   *  it's the call site most exposed to Save with Encoding's speculative
   *  window. */
  async function reevaluateReload(): Promise<void> {
    const opened = await fetchDisk(reloadEncodingFor(doc));
    if (fingerprintsEqual(opened.fingerprint, doc.fingerprint)) return; // no-op: nothing changed beyond what already landed
    if (doc.dirty) {
      const reload = await confirmReload();
      if (!reload) return;
      applyOpened(doc, await fetchDisk(reloadEncodingFor(doc)));
      return;
    }
    applyOpened(doc, opened);
  }

  async function withLock(owner: "save" | "reload", body: () => Promise<void>): Promise<void> {
    doc.saveReloadInFlight = owner;
    try {
      await body();
    } finally {
      doc.saveReloadInFlight = null;
      await drainLock();
    }
  }

  /** Pure truncated||userReadOnly check, no dialog — mirrors tabs.ts's real
   *  isEffectivelyReadOnly (issue #217), which is what feeds nextDrainStep
   *  its own blockedByReadOnly input in main.ts's real drainLock too. This
   *  is deliberately NOT a decision of its own: unlike the previous attempt
   *  at this fix, this harness must not re-decide whether a blocked doc
   *  gets rejected — that decision belongs entirely to the real
   *  nextDrainStep exercised in drainLock below, so a wrong or missing
   *  branch there fails exactly like it would in production instead of
   *  only failing a decision this file reimplemented independently. */
  function isReadOnlyBlocked(): boolean {
    return doc.truncated || doc.userReadOnly;
  }

  async function drainLock(): Promise<void> {
    const step = nextDrainStep({
      pendingReload: doc.pendingReload,
      pendingSaveAs: doc.pendingSaveAs,
      dirty: doc.dirty,
      blockedByReadOnly: isReadOnlyBlocked(),
    });
    if (step.kind === "done") return;
    if (step.kind === "reload") {
      doc.pendingReload = false;
      await withLock("reload", reevaluateReload);
      return;
    }
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    doc.pendingSaveAs = null;
    if (step.kind === "dropSave") {
      for (const resolve of resolvers) resolve(true);
      await drainLock(); // something else may have queued up meanwhile
      return;
    }
    if (step.kind === "rejectBlocked") {
      // Issue #217's own fix: the real nextDrainStep above has already
      // decided this drained save must not run — stands in for main.ts's
      // own blockedByReadOnly dialog call at this branch (see
      // onReadOnlyBlocked's own doc comment on HarnessOptions above).
      // Resolves false (never written), never calls runSave.
      options.onReadOnlyBlocked?.();
      for (const resolve of resolvers) resolve(false);
      await drainLock(); // something else may have queued up meanwhile
      return;
    }
    let result = false;
    await withLock("save", async () => {
      result = await runSave(currentSaveIpc);
    });
    for (const resolve of resolvers) resolve(result);
  }

  return {
    async issueSave(saveAs: boolean, ipc: () => Promise<SaveIpcResult>): Promise<boolean> {
      currentSaveIpc = ipc;
      if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
        return new Promise<boolean>((resolve) => {
          doc.pendingSaveAs = saveAs;
          pendingResolvers.push(resolve);
        });
      }
      let result = false;
      await withLock("save", async () => {
        result = await runSave(ipc);
      });
      return result;
    },
    async issueReload(
      fetchOpen: () => Promise<OpenedFixture> = () => fetchDisk(reloadEncodingFor(doc)),
    ): Promise<void> {
      await requestReload(fetchOpen);
    },
  };
}

describe("issue #124 — save in flight blocks a reload request (failing-test-first: reproduces the critic-review race)", () => {
  it("defers the reload instead of applying it concurrently, then re-validates against disk once the save releases the lock — no orphan backup, no fingerprint/buffer desync, no fake staleness on the next save", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "local-edit";
    doc.fingerprint = "fp-0";
    doc.revision = 5;
    const disk: FakeDisk = { content: "disk-0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const saveCall = deferred<SaveIpcResult>();

    // 1. User hits Save; its IPC round trip is still in flight.
    const savePromise = harness.issueSave(false, () => saveCall.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // 2. While the save is in flight, the watcher (or saveFlow's own
    //    stale-confirm "reload" choice — same call site, same guard) fires
    //    a reload request for the same doc. Pre-fix this ran
    //    reloadFromDisk immediately, concurrently with the save; the fix
    //    must defer it instead.
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);
    expect(doc.buffer).toBe("local-edit"); // untouched — not applied yet

    // 3. The save's IPC resolves: it wrote "local-edit" successfully.
    //    doc.revision never moved (the deferred reload never got to bump
    //    it), so #112's own guard clears dirty and drops the backup.
    saveCall.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "local-edit",
    });
    const written = await savePromise;

    expect(written).toBe(true);
    // (a) No orphan backup: dirty and backupName still agree with each
    //     other all the way through — this is what #124 calls out as
    //     surviving the reload/save interleaving unguarded.
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    // (b) fingerprint matches what's actually on disk, and the buffer
    //     wasn't clobbered by the deferred reload once it drained — its
    //     stale-recheck (fingerprintsEqual) found the watcher's
    //     notification was just this save's own write and skipped
    //     applying, instead of blindly overwriting fresher content with
    //     the disk snapshot it originally would have fetched.
    expect(doc.pendingReload).toBe(false);
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.fingerprint).toBe(disk.fingerprint);
    expect(doc.buffer).toBe("local-edit");
    expect(disk.content).toBe("local-edit");
  });

  it("control — a reload deferred behind a save that turns out to be genuinely stale (a real external change) does apply once drained", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "local-edit";
    doc.fingerprint = "fp-0";
    doc.revision = 5;
    const disk: FakeDisk = { content: "disk-0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const saveCall = deferred<SaveIpcResult>();
    const savePromise = harness.issueSave(false, () => saveCall.promise);
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);

    saveCall.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "local-edit" });
    await savePromise;

    // Unlike the scenario above, something *else* wrote to disk after the
    // save (not modeled by writeDisk — an independent external actor).
    disk.content = "genuinely-newer-external-content";
    disk.fingerprint = "fp-2";

    // The drain's reevaluation only runs once, right when the save's lock
    // releases (already happened by the time savePromise resolved above,
    // per withLock's finally awaiting drainLock) — so re-issue a reload to
    // observe the still-current disk state directly, proving the
    // reevaluation path itself (not just the no-op branch) is exercised
    // elsewhere. This call runs immediately since nothing is in flight.
    await harness.issueReload();

    expect(doc.buffer).toBe("genuinely-newer-external-content");
    expect(doc.fingerprint).toBe("fp-2");
  });
});

describe("issue #124 critic-review P2 — a doc that went dirty while its reload sat in the pending slot must not be silently clobbered by the drain", () => {
  /** The full counterexample sequence from the critic review: clean doc →
   *  Cmd+S (save1 holds the lock) → external third-party write lands on
   *  disk → watcher fires → handleExternalChange takes its no-prompt
   *  clean-doc branch → reloadFromDisk hits mustDefer → pendingReload →
   *  THE USER TYPES in this window (dirty=true, revision bumps, hot-exit
   *  backup flushes) → save1 resolves written (revision moved, so #112's
   *  guard correctly keeps dirty) → drainLock runs the pending reload.
   *  Pre-fix, reevaluateReload saw only the disk-side fingerprint
   *  mismatch and applied unconditionally: dirty=false, backup dropped,
   *  buffer replaced — the user's fresh keystrokes silently gone with no
   *  dialog and no backup left covering them. */
  function typedWhilePendingScenario(confirmReload: () => Promise<boolean>) {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "clean-content";
    doc.revision = 5;
    const disk: FakeDisk = { content: "clean-content", fingerprint: "fp-0" };
    let externalWritePending = true;
    const harness = createHarness(doc, disk, {
      confirmReload,
      // The external third party rewrites the file immediately after
      // save1's own bytes land — so the drain's fresh read sees a genuine
      // fingerprint mismatch, not just save1's own write.
      onDiskWritten: () => {
        if (!externalWritePending) return;
        externalWritePending = false;
        writeDisk(disk, "external-content", "fp-ext");
      },
    });
    return { doc, disk, harness };
  }

  async function driveScenario(
    doc: DocState,
    harness: ReturnType<typeof createHarness>,
  ): Promise<void> {
    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // Watcher fires for the external change; clean doc → no prompt →
    // reloadFromDisk → mustDefer → pending slot.
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);

    // The user types in exactly this window: dirty flips on, revision
    // bumps (editor onDocChanged), the hot-exit backup cycle flushes.
    doc.dirty = true;
    doc.revision += 1;
    doc.buffer = "clean-content-plus-typing";
    doc.backupName = "bk-typed.txt";

    // save1 resolves; its revision snapshot no longer matches, so #112's
    // completion guard keeps dirty/backup (verified below implicitly —
    // if it cleared them, the drain would take the dropSave path and the
    // assertions would fail differently).
    save1.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "clean-content",
    });
    await p1;
  }

  it("user declines the dialog: buffer, dirty, and the hot-exit backup all survive — nothing is silently discarded", async () => {
    const confirmCalls: number[] = [];
    const { doc, harness } = typedWhilePendingScenario(() => {
      confirmCalls.push(1);
      return Promise.resolve(false);
    });

    await driveScenario(doc, harness);

    // The dialog was actually consulted — a silent apply OR a silent skip
    // would both be wrong; the user decides.
    expect(confirmCalls.length).toBe(1);
    expect(doc.buffer).toBe("clean-content-plus-typing");
    expect(doc.dirty).toBe(true);
    expect(doc.backupName).toBe("bk-typed.txt");
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingReload).toBe(false);
  });

  it("user confirms the dialog: the reload applies a FRESH disk read (disk may have moved again while the dialog was up)", async () => {
    const { doc, disk, harness } = typedWhilePendingScenario(() => {
      // While the dialog sat open, the external file changed yet again —
      // confirming must apply what's on disk NOW, not the snapshot the
      // reevaluation fetched before asking.
      writeDisk(disk, "external-content-v2", "fp-ext-2");
      return Promise.resolve(true);
    });

    await driveScenario(doc, harness);

    expect(doc.buffer).toBe("external-content-v2");
    expect(doc.fingerprint).toBe("fp-ext-2");
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull(); // user explicitly chose to discard
    expect(doc.saveReloadInFlight).toBeNull();
  });

  it("control — a doc that stayed clean through the pending window still reloads without any dialog", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "clean-content";
    doc.revision = 5;
    const disk: FakeDisk = { content: "clean-content", fingerprint: "fp-0" };
    let externalWritePending = true;
    // No confirmReload injected: reaching the dialog here would throw.
    const harness = createHarness(doc, disk, {
      onDiskWritten: () => {
        if (!externalWritePending) return;
        externalWritePending = false;
        writeDisk(disk, "external-content", "fp-ext");
      },
    });

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    await harness.issueReload();
    expect(doc.pendingReload).toBe(true);
    // No typing this time — the doc stays clean through the window.
    save1.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "clean-content",
    });
    await p1;

    expect(doc.buffer).toBe("external-content");
    expect(doc.fingerprint).toBe("fp-ext");
    expect(doc.dirty).toBe(false);
  });
});

describe("issue #124 — reload in flight blocks a save request", () => {
  it("defers the save instead of running it concurrently, then reruns it fresh once the reload releases the lock — a clean post-reload doc drops the redundant write", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "old-content";
    doc.revision = 1;
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const openCall = deferred<OpenedFixture>();
    const reloadPromise = harness.issueReload(() => openCall.promise);
    expect(doc.saveReloadInFlight).toBe("reload");

    // The user hits Save while the reload's own IPC call is still in
    // flight (e.g. it was triggered by a watcher event moments earlier).
    const savePromise = harness.issueSave(false, () =>
      Promise.resolve({
        written: true,
        stale: false,
        fingerprint: "fp-should-not-be-used",
        writtenContent: "should-not-be-written",
      }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    openCall.resolve({ content: "new-external-content", fingerprint: "fp-ext" });
    await reloadPromise;

    // Reload replaced the buffer and left the doc clean; the deferred
    // save, once drained, finds nothing dirty to write and is dropped
    // rather than clobbering the just-reloaded content.
    expect(doc.buffer).toBe("new-external-content");
    expect(doc.dirty).toBe(false);

    const written = await savePromise;
    expect(written).toBe(true); // told "covered" even though the write was dropped
    // Unchanged: reload only ever reads — neither it nor the dropped save
    // wrote anything to disk, so the fake disk's own content never moved
    // (only doc.buffer, in memory, reflects what the reload fetched).
    expect(disk.content).toBe("old-content");
    expect(doc.fingerprint).toBe("fp-ext"); // still the reload's baseline, not clobbered
  });

  // No "genuine edit lands mid-flight, so the drained save actually reruns"
  // counterpart here (unlike double-save's below): applyOpened (reload)
  // clears dirty unconditionally and runs entirely synchronously once its
  // own fetch resolves, right through drainLock's next-step check — there
  // is no real await point in between for a keystroke to land at. A save
  // deferred behind a reload can only ever see a clean doc once drained,
  // exactly as issue #124's own text expects ("實務上 reload 後 doc 是
  // clean"). A fresh edit arriving after the reload has already fully
  // settled starts its own new saveFlow call later — a separate scenario,
  // not this pending slot's drain.
});

describe("issue #124 — double-save determinism", () => {
  it("a second save requested while the first is in flight is dropped once the first already wrote the latest content — deterministic outcome, not resolve-order-dependent", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // A second Save request for the same doc arrives before the first's
    // IPC round trip resolves (double Cmd+S, or Close-with-save racing a
    // manual Save). Pre-fix each ran its own concurrent saveDocument call;
    // post-fix the second coalesces into the single pending slot.
    const p2 = harness.issueSave(false, () => {
      throw new Error(
        "save2's own ipc must never be invoked — save1 already wrote the latest content, so the drain must drop it, not re-run it",
      );
    });
    expect(doc.pendingSaveAs).toBe(false);

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    // save2 was coalesced, not re-run — the content it wanted saved is
    // already on disk, so its caller still sees success.
    expect(r2).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.fingerprint).toBe("fp-1");
    expect(disk.content).toBe("edit-1");
  });

  it("a second save actually reruns once a genuine edit lands before the first completes — not silently dropped just because a save was already pending", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({ written: true, stale: false, fingerprint: "fp-2", writtenContent: "edit-2" }),
    );

    // An edit lands after save1 snapshotted its content but before it
    // resolved — mirrors #112's own scenario (savecompletion.test.ts).
    doc.revision += 1;
    doc.buffer = "edit-2";

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // save1's own completion must not have cleared dirty/dropped the
    // backup (#112's revision guard) — the drained save2 is what finally
    // does, once it actually runs against the newer content.
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.fingerprint).toBe("fp-2");
    expect(disk.content).toBe("edit-2");
  });
});

describe("issue #124 — lock releases and drains even when the in-flight op throws/rejects", () => {
  it("a save whose IPC call rejects still releases the lock and drains a pending reload — never stuck forever", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.fingerprint = "fp-0";
    doc.buffer = "local-edit";
    const disk: FakeDisk = { content: "external", fingerprint: "fp-ext" };
    // The doc is dirty and the disk genuinely differs, so the drained
    // reload consults the dirty-confirm dialog (critic-review P2) — this
    // test's subject is the lock draining at all after a rejection, so
    // the user just confirms.
    const harness = createHarness(doc, disk, {
      confirmReload: () => Promise.resolve(true),
    });

    const saveCall = deferred<SaveIpcResult>();
    // No try/catch around this in the harness (mirrors withLock's finally
    // being the actual safety net, not an inner catch) — isolates that the
    // *lock's own* release doesn't depend on saveFlow's outer try/catch
    // existing, only on withLock's finally running regardless of outcome.
    const p = harness.issueSave(false, () => saveCall.promise).catch(() => "caught" as const);

    await harness.issueReload(); // watcher fires while the save is in flight
    expect(doc.pendingReload).toBe(true);

    saveCall.reject(new Error("IPC transport error"));
    const outcome = await p;

    expect(outcome).toBe("caught");
    // The lock must not be stuck on "save" forever, and the reload that
    // was waiting on it must actually have run once released.
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingReload).toBe(false);
    expect(doc.buffer).toBe("external");
    expect(doc.fingerprint).toBe("fp-ext");
  });

  it("a reload whose IPC call rejects still releases the lock and drains a pending save", async () => {
    const doc = makeDocState();
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "old-content";
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const openCall = deferred<OpenedFixture>();
    const reloadPromise = harness.issueReload(() => openCall.promise).catch(() => "caught" as const);

    const savePromise = harness.issueSave(false, () =>
      Promise.resolve({ written: true, stale: false, fingerprint: "fp-2", writtenContent: "edit-after-failed-reload" }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    openCall.reject(new Error("file vanished mid-read"));
    const reloadOutcome = await reloadPromise;

    expect(reloadOutcome).toBe("caught");
    expect(doc.saveReloadInFlight).toBeNull();

    // The failed reload never touched dirty/buffer, so the doc is still
    // clean as far as the drain can tell — the pending save is dropped as
    // a redundant no-op, exactly like the "reload succeeded and left the
    // doc clean" case above. (main.ts's real reloadFromDisk swallows this
    // exact failure itself — see its own try/catch — so in production the
    // pending save would in practice run against whatever doc.dirty
    // already was; this simulation isolates that the *lock* still drains
    // correctly regardless.)
    const written = await savePromise;
    expect(written).toBe(true);
    expect(disk.content).toBe("old-content");
  });
});

describe("issue #161 — Save with Encoding's speculative doc.encoding must not leak into a stale-save's own Reload (failing-test-first)", () => {
  /** Mirrors main.ts's saveWithEncoding menu action: applies the target
   *  encoding/BOM speculatively so the save encodes with the new choice,
   *  mirrors the protected original onto doc.speculativeEncoding (issue
   *  #161) so a reload landing before this save resolves — most commonly
   *  the stale-save dialog's own "Reload" choice below — decodes with it
   *  instead of the not-yet-written target, and rolls the two metadata
   *  fields back on a `false` result. The rollback is guarded by
   *  *reference* equality against `original`, not mere nullness: if a
   *  reload already applied (applyOpened clears the marker), or a newer
   *  overlapping speculative save already replaced it with its own, this
   *  call's rollback must not stomp state that isn't its own to roll back. */
  async function saveWithEncoding(
    doc: DocState,
    harness: ReturnType<typeof createHarness>,
    target: { encoding: string; withBom: boolean },
    ipc: () => Promise<SaveIpcResult>,
  ): Promise<boolean> {
    const original = { encoding: doc.encoding, withBom: doc.withBom };
    doc.encoding = target.encoding;
    doc.withBom = target.withBom;
    doc.speculativeEncoding = original;
    // Issue #221: forces dirty=true when the doc was fully clean, mirroring
    // main.ts's saveWithEncoding action's own fix alongside its #210
    // revision bump (this helper predates #210/#221 and never modeled
    // revision — see the #210/#221 describe blocks' own separate helpers
    // below for that). A drained reload landing later while this save is
    // still in flight now sees a dirty doc, same as a real edit would —
    // exercised by the two tests right below, which route through exactly
    // that path.
    if (!doc.dirty) doc.dirty = true;
    const written = await harness.issueSave(false, ipc);
    if (!written && doc.speculativeEncoding === original) {
      doc.encoding = original.encoding;
      doc.withBom = original.withBom;
    }
    // Ownership-checked (issue #212): only this call's own marker, not one
    // a newer overlapping Save with Encoding request already replaced it
    // with — see that issue's own describe block further down for the
    // scenario this guards against.
    if (doc.speculativeEncoding === original) {
      doc.speculativeEncoding = null;
    }
    return written;
  }

  it("Big5 doc, Save with Encoding to UTF-8, an external edit makes the save stale, user picks Reload: the reload decodes with the protected original Big5, not the speculative UTF-8 target", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5";
    doc.withBom = false;
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "big5-original-content";
    doc.revision = 3;
    // The external edit that makes the save stale — still genuinely Big5
    // bytes, just different content and a moved fingerprint.
    const disk: FakeDisk = {
      content: "big5-externally-edited-content",
      fingerprint: "fp-1",
      trueEncoding: "Big5",
    };
    // Issue #221: saveWithEncoding above now forces doc.dirty = true before
    // ever calling issueSave, so the drained reload's own dirty-check finds
    // a dirty doc (same as a real edit would) and walks the confirm dialog
    // instead of applying silently — confirmReload must be supplied or the
    // harness's default throws (see createHarness's own doc comment).
    let confirmReloadCalls = 0;
    const harness = createHarness(doc, disk, {
      staleChoice: () => Promise.resolve("reload"),
      confirmReload: () => {
        confirmReloadCalls++;
        return Promise.resolve(true);
      },
    });

    const written = await saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-8", withBom: false },
      () => Promise.resolve({ written: false, stale: true, fingerprint: null, writtenContent: "" }),
    );

    expect(written).toBe(false);
    // Issue #221: the dirty-confirm dialog was actually consulted once —
    // pins the new second-confirmation behavior in place rather than
    // leaving it to pass incidentally.
    expect(confirmReloadCalls).toBe(1);
    // FAIL target pre-#161-fix: reevaluateReload/fetchAndApplyReload passed
    // doc.encoding as it stood at that moment — still the speculative
    // "UTF-8" nothing on disk had adopted — so fetchDisk's stand-in
    // returned the wrong-decode mojibake fixture with malformed: true,
    // exactly mirroring encoding_rs decoding real Big5 bytes as UTF-8.
    // Post-fix, reloadEncodingFor resolves the protected original "Big5"
    // instead, so the buffer is the real (correctly "decoded") external
    // content and malformed is false — unchanged by #221's later dirty
    // force, since the user's consent above is what gates applying at all,
    // not *which* encoding a since-consented apply then reads with.
    expect(doc.buffer).toBe("big5-externally-edited-content");
    expect(doc.malformed).toBe(false);
  });

  it("rollback ordering: once the reload has applied, the metadata-only rollback must not stomp doc.encoding/withBom back out of sync with the buffer/fingerprint/malformed it just set together", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5";
    // Deliberately true here, and different from fetchDisk's own
    // hardcoded hadBom: false (see its doc comment) — so a rollback that
    // wrongly stomps doc.withBom back to this pre-save value is
    // observably different from one that correctly leaves the reload's
    // own fresh value alone, rather than coincidentally landing on the
    // same boolean either way.
    doc.withBom = true;
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "big5-original-content";
    doc.revision = 3;
    const disk: FakeDisk = {
      content: "big5-externally-edited-content",
      fingerprint: "fp-1",
      trueEncoding: "Big5",
    };
    // Issue #221: same dirty-force-forces-the-confirm-dialog consequence as
    // the test above — see its own comment for the full explanation.
    let confirmReloadCalls = 0;
    const harness = createHarness(doc, disk, {
      staleChoice: () => Promise.resolve("reload"),
      confirmReload: () => {
        confirmReloadCalls++;
        return Promise.resolve(true);
      },
    });

    const written = await saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-8", withBom: false },
      () => Promise.resolve({ written: false, stale: true, fingerprint: null, writtenContent: "" }),
    );

    expect(written).toBe(false);
    expect(confirmReloadCalls).toBe(1);
    // The reload already established a fully coherent state from one
    // single disk read: buffer, fingerprint, encoding, and withBom all
    // agree with each other (issue #161's own "(b) fingerprint 與 buffer
    // 一致" requirement, extended to withBom). A rollback that stomped
    // doc.withBom back to the pre-speculative `true` here — the pre-fix,
    // unconditional-on-`!written` shape — would desync it from a buffer
    // that was actually decoded with hadBom: false, and stomping
    // doc.encoding back (even though, in this scenario, it happens to
    // land on the same "Big5" value either way) is equally wrong in
    // principle: applyOpened already cleared doc.speculativeEncoding,
    // which is this rollback's own signal to leave both alone.
    expect(doc.encoding).toBe("Big5");
    expect(doc.withBom).toBe(false);
    expect(doc.buffer).toBe("big5-externally-edited-content");
    expect(doc.fingerprint).toBe("fp-1");
    expect(doc.malformed).toBe(false);
    expect(doc.speculativeEncoding).toBeNull();
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingReload).toBe(false);
  });

  it("control — Save with Encoding succeeds outright (no staleness): doc.encoding/withBom keep the new target, nothing rolled back", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5";
    doc.withBom = false;
    doc.dirty = true;
    doc.fingerprint = "fp-0";
    doc.buffer = "some content";
    const disk: FakeDisk = {
      content: "old-big5-content",
      fingerprint: "fp-0",
      trueEncoding: "Big5",
    };
    const harness = createHarness(doc, disk);

    const written = await saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-8", withBom: false },
      () =>
        Promise.resolve({
          written: true,
          stale: false,
          fingerprint: "fp-2",
          writtenContent: "utf8-bytes-content",
        }),
    );

    expect(written).toBe(true);
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.withBom).toBe(false);
    expect(doc.speculativeEncoding).toBeNull();
    expect(doc.dirty).toBe(false);
    expect(disk.content).toBe("utf8-bytes-content");
  });

  it("control — a plain (non-speculative) save's stale-Reload keeps using doc.encoding directly, exactly as before this issue", async () => {
    const doc = makeDocState();
    doc.encoding = "UTF-8";
    doc.withBom = false;
    doc.dirty = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "utf8-original-content";
    const disk: FakeDisk = {
      content: "utf8-externally-edited-content",
      fingerprint: "fp-1",
      trueEncoding: "UTF-8",
    };
    const harness = createHarness(doc, disk, {
      staleChoice: () => Promise.resolve("reload"),
    });

    // A plain Cmd+S, not Save with Encoding — doc.speculativeEncoding is
    // never touched, so reloadEncodingFor has nothing to protect and falls
    // back to doc.encoding, same as every #124 test above already relies
    // on implicitly.
    const written = await harness.issueSave(false, () =>
      Promise.resolve({ written: false, stale: true, fingerprint: null, writtenContent: "" }),
    );

    expect(written).toBe(false);
    expect(doc.speculativeEncoding).toBeNull();
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.buffer).toBe("utf8-externally-edited-content");
    expect(doc.malformed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #208 — runSaveFlow must never write another tab's live content into
// doc.path. Separate, smaller harness from the one above: reproducing this
// needs an ingredient the single-doc harness has no reason to model — a
// *shared* editor surface. Real main.ts holds exactly one CodeMirror view
// (editor.ts's module-level `view`, wrapped by editor.content()/.swap()),
// reassigned between docs by activate() (main.ts:560-575), which syncs the
// outgoing doc's buffer from that view *before* handing the surface over to
// the incoming doc. The single-doc harness above bakes "whatever content the
// test wants written" directly into each ipc mock's `writtenContent` —
// sufficient for #124/#161's lock/staleness scenarios, but it never
// exercises *which doc's* content actually gets read in the first place,
// which is exactly what #208 is about: pre-fix, runSaveFlow (main.ts:1572)
// read `editor.content()` unconditionally, with no check that `doc` was
// still the tab that content belonged to — exposed both when a save had to
// defer behind another in-flight save/reload for the same doc (issue #124's
// own mechanism) and, independently, across the Save As dialog's own await.

/** Minimal stand-in for the slice of tabs.ts's Doc this harness exercises —
 *  distinct from DocState above (which has no notion of `id` or of a doc
 *  that isn't the only one in play): #208 is specifically about *which*
 *  doc's content a shared editor surface belongs to at any given moment. */
interface TabDoc {
  id: number;
  buffer: string;
  dirty: boolean;
  saveReloadInFlight: LockOwner;
  pendingSaveAs: boolean | null;
}

function makeTabDoc(id: number, buffer: string): TabDoc {
  return { id, buffer, dirty: true, saveReloadInFlight: null, pendingSaveAs: null };
}

/** Stand-in for editor.ts's single shared CodeMirror view: `content` is
 *  whatever the *currently active* doc's live text is right now. A doc that
 *  isn't active has no representation here at all — its last-synced text
 *  lives on `doc.buffer` instead (activateTab below keeps the two in sync at
 *  every switch), mirroring the real EditorBuffer/`editor.content()` split. */
function makeEditorSurface(initial: string): { content: string } {
  return { content: initial };
}
type EditorSurface = ReturnType<typeof makeEditorSurface>;

interface ActiveTabs {
  activeId: number;
}

/** Mirrors main.ts's activate() (main.ts:560-575): the outgoing doc's
 *  buffer is synced from the live editor surface *before* the surface is
 *  handed over to show the incoming doc's own last-synced content. This
 *  sync-before-switch is what makes a non-active doc's `.buffer` a
 *  trustworthy stand-in for "its real, current content" at all — every real
 *  switch call site (activate/newTab/cycleTab) does it the same way. */
function activateTab(
  tabs: ActiveTabs,
  editorSurface: EditorSurface,
  outgoing: TabDoc,
  incoming: TabDoc,
): void {
  outgoing.buffer = editorSurface.content;
  tabs.activeId = incoming.id;
  editorSurface.content = incoming.buffer;
}

/**
 * Mirrors main.ts's runSaveFlow content capture (main.ts:1572). Content
 * written for `doc` must come from doc's own state, never from whatever the
 * shared editor surface happens to be showing right now, unless `doc`
 * actually *is* the active tab. Same active-tab check as onCloseRequested's
 * backup flush (main.ts:2818) and closeTab's cursorOf call (main.ts:2348).
 */
function captureSaveContent(
  doc: TabDoc,
  tabs: ActiveTabs,
  editorSurface: EditorSurface,
): string {
  // Live surface content only when doc IS the active tab (the surface
  // shows nothing else); otherwise the last buffer activateTab synced for
  // it when the user switched away. Pre-fix, this read the shared surface
  // unconditionally (exactly main.ts:1572 before issue #208's fix) — the
  // "red" run above confirmed both scenarios below fail against that
  // shape before falling back to doc.buffer here restores them to green.
  return doc.id === tabs.activeId ? editorSurface.content : doc.buffer;
}

interface SharedSurfaceSaveResult {
  written: boolean;
  writtenContent: string;
}

/** Records every `content` a doc's ipc mock actually received, in order —
 *  the observable this harness's tests check against. */
function capturingIpc(): {
  ipc: (content: string) => Promise<SharedSurfaceSaveResult>;
  received: string[];
} {
  const received: string[] = [];
  return {
    received,
    ipc: (content: string) => {
      received.push(content);
      return Promise.resolve({ written: true, writtenContent: content });
    },
  };
}

/** withLock/drainLock/saveFlow trio mirroring main.ts's real shape
 *  (main.ts:1158-1218, 1541-1572) closely enough to reproduce issue #208's
 *  two exposure windows, wired to the real mustDefer/nextDrainStep — same
 *  intent as createHarness above, scoped to the extra ingredient #208
 *  needs that the single-doc harness has no reason to carry: a shared
 *  editor surface plus the active-tab-aware content capture itself.
 *  `showSaveDialog` mirrors main.ts's `saveDialog(...)` call (main.ts:1568)
 *  for the Save As exposure window; defaults to an immediate path so tests
 *  that don't care about that window (saveAs: false) never need to supply
 *  one. */
function createSharedSurfaceHarness(
  tabs: ActiveTabs,
  editorSurface: EditorSurface,
  showSaveDialog: () => Promise<string | null> = () => Promise.resolve("chosen/path.txt"),
) {
  const pendingResolvers = new Map<number, Array<(written: boolean) => void>>();
  const ipcs = new Map<number, (content: string) => Promise<SharedSurfaceSaveResult>>();

  function ipcFor(id: number): (content: string) => Promise<SharedSurfaceSaveResult> {
    const ipc = ipcs.get(id);
    if (!ipc) throw new Error(`no ipc mock registered for doc ${id}`);
    return ipc;
  }

  async function runSaveFlow(doc: TabDoc, saveAs: boolean): Promise<boolean> {
    if (saveAs) {
      const path = await showSaveDialog();
      if (path === null) return false;
    }
    const content = captureSaveContent(doc, tabs, editorSurface);
    const result = await ipcFor(doc.id)(content);
    if (result.written) doc.dirty = false;
    return result.written;
  }

  async function withLock(doc: TabDoc, owner: "save" | "reload", body: () => Promise<void>): Promise<void> {
    doc.saveReloadInFlight = owner;
    try {
      await body();
    } finally {
      doc.saveReloadInFlight = null;
      await drainLock(doc);
    }
  }

  async function drainLock(doc: TabDoc): Promise<void> {
    const step = nextDrainStep({
      pendingReload: false,
      pendingSaveAs: doc.pendingSaveAs,
      dirty: doc.dirty,
      // TabDoc carries no truncated/userReadOnly of its own — this harness
      // is scoped to issue #208's shared-editor-surface concern only, never
      // a blocked doc (see TabDoc's own definition above).
      blockedByReadOnly: false,
    });
    if (step.kind === "done") return;
    if (step.kind === "reload") {
      throw new Error("this harness never issues a reload of its own — #208 is a save-only concern");
    }
    if (step.kind === "rejectBlocked") {
      // Unreachable in practice — blockedByReadOnly is hardcoded false
      // above, since TabDoc has no truncated/userReadOnly of its own — but
      // TypeScript's DrainStep union still includes it here, same reasoning
      // as the "reload" throw just above.
      throw new Error("this harness never marks a doc blocked — #208 is a save-only concern");
    }
    const resolvers = pendingResolvers.get(doc.id) ?? [];
    pendingResolvers.delete(doc.id);
    doc.pendingSaveAs = null;
    if (step.kind === "dropSave") {
      for (const resolve of resolvers) resolve(true);
      await drainLock(doc); // something else may have queued up meanwhile
      return;
    }
    let result = false;
    await withLock(doc, "save", async () => {
      result = await runSaveFlow(doc, step.saveAs);
    });
    for (const resolve of resolvers) resolve(result);
  }

  return {
    /** Registers/overwrites the ipc mock this doc's *eventual* runSaveFlow
     *  call will use — set here rather than threaded through issueSave's
     *  return value, since a deferred call's own runSaveFlow only actually
     *  runs later, from inside drainLock, with no direct caller to hand a
     *  mock to at that point (mirrors createHarness's single `currentSaveIpc`
     *  slot above, keyed per-doc since #208 needs more than one doc live at
     *  once). */
    setIpc(id: number, ipc: (content: string) => Promise<SharedSurfaceSaveResult>): void {
      ipcs.set(id, ipc);
    },
    async issueSave(doc: TabDoc, saveAs: boolean): Promise<boolean> {
      if (mustDefer({ inFlight: doc.saveReloadInFlight })) {
        return new Promise<boolean>((resolve) => {
          doc.pendingSaveAs = saveAs;
          const resolvers = pendingResolvers.get(doc.id) ?? [];
          resolvers.push(resolve);
          pendingResolvers.set(doc.id, resolvers);
        });
      }
      let result = false;
      await withLock(doc, "save", async () => {
        result = await runSaveFlow(doc, saveAs);
      });
      return result;
    },
    /** Simulates something else — a watcher-triggered reload, in issue
     *  #208's own report — already holding `doc`'s lock for a while, the
     *  reason a concurrent Save request on the same doc must defer instead
     *  of running immediately. Resolves once `release()` is called; await
     *  `settled` afterward to let the lock's own finally (and therefore
     *  drainLock) actually run. */
    holdLock(doc: TabDoc, owner: "save" | "reload"): { release: () => void; settled: Promise<void> } {
      const gate = deferred<void>();
      const settled = withLock(doc, owner, () => gate.promise);
      return { release: () => gate.resolve(), settled };
    },
  };
}

describe("issue #208 — a deferred/in-flight save must write the doc it belongs to, never whatever tab the shared editor surface currently shows (failing-test-first)", () => {
  it("a save deferred behind an in-flight reload writes the deferring doc's own last-synced buffer, not the tab the user switched to while it waited", async () => {
    const docA = makeTabDoc(1, "A-buffer-before-request");
    const docB = makeTabDoc(2, "B-buffer-initial");
    const tabs: ActiveTabs = { activeId: docA.id };
    const editorSurface = makeEditorSurface("A-buffer-before-request");
    const harness = createSharedSurfaceHarness(tabs, editorSurface);
    const { ipc: ipcA, received: receivedByA } = capturingIpc();
    harness.setIpc(docA.id, ipcA);

    // Something else (e.g. a watcher-triggered reload) already holds A's
    // lock — the reason the Save request below must defer instead of
    // running immediately (issue #124's own mechanism).
    const hold = harness.holdLock(docA, "reload");
    expect(docA.saveReloadInFlight).toBe("reload");

    // The user edits A a little more, then hits Cmd+S while still on A —
    // this is the content that must eventually be written.
    editorSurface.content = "A-live-content-at-save-request";
    const savePromise = harness.issueSave(docA, false);
    expect(docA.pendingSaveAs).toBe(false); // deferred, not run yet
    expect(receivedByA).toEqual([]); // nothing sent to the ipc mock yet

    // The user switches to tab B while A's save is still queued —
    // activateTab syncs A's buffer from the live surface first, exactly
    // like main.ts's real activate().
    activateTab(tabs, editorSurface, docA, docB);
    expect(docA.buffer).toBe("A-live-content-at-save-request");
    expect(tabs.activeId).toBe(docB.id);

    // ...and keeps typing in B while A's reload is still resolving.
    editorSurface.content = "B-live-content-after-switch";

    // The reload finally resolves, releasing A's lock; withLock's finally
    // drains the pending save, which actually runs runSaveFlow(A) now —
    // with B, not A, the active tab.
    hold.release();
    await hold.settled;

    const written = await savePromise;
    expect(written).toBe(true);
    // The bug: pre-fix, runSaveFlow read the shared editor surface
    // unconditionally and would have sent B's live content to A's ipc
    // mock. Post-fix, since A is no longer tabs.active, it must fall back
    // to A's own last-synced buffer.
    expect(receivedByA).toEqual(["A-live-content-at-save-request"]);
  });

  it("Save As's own dialog await is itself a window the active tab can change during — the resolved path still belongs to the doc that opened the dialog, not whatever tab is active once it resolves", async () => {
    const docA = makeTabDoc(1, "A-buffer-initial");
    const docB = makeTabDoc(2, "B-buffer-initial");
    const tabs: ActiveTabs = { activeId: docA.id };
    const editorSurface = makeEditorSurface("A-content-at-saveas-time");
    const dialogGate = deferred<string | null>();
    const harness = createSharedSurfaceHarness(tabs, editorSurface, () => dialogGate.promise);
    const { ipc: ipcA, received: receivedByA } = capturingIpc();
    harness.setIpc(docA.id, ipcA);

    // Save As on A: nothing else holds A's lock, so this runs immediately
    // and reaches the saveDialog await right away (main.ts:1568).
    const savePromise = harness.issueSave(docA, true);
    expect(docA.saveReloadInFlight).toBe("save");
    expect(receivedByA).toEqual([]); // still waiting on the dialog

    // The user switches to B while the native Save dialog is still open.
    activateTab(tabs, editorSurface, docA, docB);
    expect(docA.buffer).toBe("A-content-at-saveas-time");
    editorSurface.content = "B-content-while-dialog-open";

    // The dialog finally resolves with a chosen path.
    dialogGate.resolve("chosen/A-path.txt");
    const written = await savePromise;

    expect(written).toBe(true);
    // The bug: pre-fix, content was read only after this await, but still
    // unconditionally from the shared surface — which by now shows B, not
    // A. Post-fix, A is no longer active by the time content is captured,
    // so it must fall back to A's own buffer.
    expect(receivedByA).toEqual(["A-content-at-saveas-time"]);
  });

  it("control — a doc that stays active throughout still saves the editor's own live content, not a stale buffer", async () => {
    const docA = makeTabDoc(1, "A-STALE-BUFFER-must-not-be-used");
    const tabs: ActiveTabs = { activeId: docA.id };
    const editorSurface = makeEditorSurface("A-LIVE-CONTENT-must-be-used");
    const harness = createSharedSurfaceHarness(tabs, editorSurface);
    const { ipc, received } = capturingIpc();
    harness.setIpc(docA.id, ipc);

    const written = await harness.issueSave(docA, false);

    expect(written).toBe(true);
    expect(received).toEqual(["A-LIVE-CONTENT-must-be-used"]);
  });
});

// ---------------------------------------------------------------------------
// Issue #210 — Save with Encoding's speculative doc.encoding/withBom mutation
// must bump doc.revision in the same synchronous tick, exactly like
// setLineEnding's own bump (main.ts:1916, issue #160). Without it, a plain
// save already in flight for this doc (unrelated to the encoding change) can
// resolve, see its own revisionAtStart snapshot still match doc.revision
// (nothing bumped it), and have decideSaveCompletion wrongly clear dirty for
// bytes that never carried the new encoding. Once dirty is wrongly clear,
// drainLock's nextDrainStep (savemutex.ts:117-125) sees a "clean" doc and
// drops the coalesced Save with Encoding request outright (dropSave) instead
// of running it — the caller is told it succeeded and the tab shows the new
// encoding, but disk still holds the old bytes. Reuses createHarness/
// makeDocState/FakeDisk from the #124/#161 harness above — same
// mustDefer/nextDrainStep/decideSaveCompletion wiring, just a different
// local saveWithEncoding helper (deliberately separate from issue #161's own
// above: adding this fix's revision bump to *that* shared helper would also
// change doc.dirty's value by the time reevaluateReload's own dirty-check
// runs in tests 903/942 above, which is a real, separate behavioral question
// this issue's fix deliberately leaves alone — see this file's own commit
// message / the issue #210 fix report for why).
describe("issue #210 — Save with Encoding must bump doc.revision so an in-flight save's completion can't silently drop it via dropSave (failing-test-first)", () => {
  /** Mirrors main.ts's saveWithEncoding menu action (same shape as issue
   *  #161's own saveWithEncoding helper above) plus this issue's fix: the
   *  doc.revision bump right alongside the encoding/withBom mutation. */
  async function saveWithEncoding(
    doc: DocState,
    harness: ReturnType<typeof createHarness>,
    target: { encoding: string; withBom: boolean },
    ipc: () => Promise<SaveIpcResult>,
  ): Promise<boolean> {
    const original = { encoding: doc.encoding, withBom: doc.withBom };
    doc.encoding = target.encoding;
    doc.withBom = target.withBom;
    doc.speculativeEncoding = original;
    doc.revision += 1; // the fix — see main.ts's saveWithEncoding action
    const written = await harness.issueSave(false, ipc);
    if (!written && doc.speculativeEncoding === original) {
      doc.encoding = original.encoding;
      doc.withBom = original.withBom;
    }
    // Ownership-checked (issue #212) — see issue #161's own helper above.
    if (doc.speculativeEncoding === original) {
      doc.speculativeEncoding = null;
    }
    return written;
  }

  it("a plain save already in flight for a real edit: the coalesced Save with Encoding request is not dropped, and actually writes the new encoding once drained", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.encoding = "UTF-8";
    doc.withBom = false;
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // While save1's IPC round trip is in flight, the user opens Save with
    // Encoding and picks UTF-16LE. Applied speculatively right away,
    // regardless of the lock — main.ts's action handler mutates doc state
    // before ever consulting saveFlow's own mustDefer.
    const p2 = saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-16LE", withBom: true },
      () =>
        Promise.resolve({
          written: true,
          stale: false,
          fingerprint: "fp-enc",
          writtenContent: "edit-1-as-utf16",
        }),
    );
    expect(doc.pendingSaveAs).toBe(false); // deferred behind save1's lock
    expect(doc.encoding).toBe("UTF-16LE"); // speculative mutation, not deferred

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // FAIL target pre-fix: save1's completion saw a revision that never
    // moved, wrongly cleared dirty, and the drain then dropped the
    // coalesced request as a redundant no-op — disk would still hold
    // "edit-1" (save1's own write) even though doc.encoding already
    // reports UTF-16LE and the caller was told `true`.
    expect(disk.content).toBe("edit-1-as-utf16");
    expect(doc.fingerprint).toBe("fp-enc");
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.encoding).toBe("UTF-16LE");
    expect(doc.withBom).toBe(true);
    expect(doc.speculativeEncoding).toBeNull();
  });

  it("BOM-only change (same encoding, withBom flips) is bumped exactly the same way — not gated on the encoding value itself changing", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "edit-1";
    doc.encoding = "UTF-8";
    doc.withBom = false;
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);

    const p2 = saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-8", withBom: true }, // same encoding, BOM only
      () =>
        Promise.resolve({
          written: true,
          stale: false,
          fingerprint: "fp-bom",
          writtenContent: "edit-1-with-bom",
        }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(disk.content).toBe("edit-1-with-bom");
    expect(doc.fingerprint).toBe("fp-bom");
    expect(doc.dirty).toBe(false);
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.withBom).toBe(true);
  });

  it("control — an uncontended Save with Encoding (nothing else in flight) still completes normally and clears dirty", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.backupName = "bk-1.txt";
    doc.buffer = "content";
    doc.encoding = "UTF-8";
    doc.withBom = false;
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    const written = await saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-16LE", withBom: true },
      () =>
        Promise.resolve({
          written: true,
          stale: false,
          fingerprint: "fp-1",
          writtenContent: "content-as-utf16",
        }),
    );

    expect(written).toBe(true);
    expect(doc.dirty).toBe(false);
    expect(doc.backupName).toBeNull();
    expect(doc.encoding).toBe("UTF-16LE");
    expect(doc.withBom).toBe(true);
    expect(doc.speculativeEncoding).toBeNull();
    expect(disk.content).toBe("content-as-utf16");
  });
});

// ---------------------------------------------------------------------------
// Issue #221 — a residual gap in #210's own fix: bumping doc.revision alone
// stops decideSaveCompletion from wrongly *clearing* dirty on an unrelated
// in-flight save/reload's completion, but does nothing when dirty was never
// true to begin with. A doc that's fully clean (dirty=false) start to finish
// — the blocking save/reload is itself a no-op re-save/no-op reload, and the
// Save with Encoding mutation only ever bumps revision, never dirty — comes
// out of the lock still clean, so savemutex.ts's nextDrainStep (117-125)
// sees pendingSaveAs !== null && dirty === false and drops the coalesced
// Save with Encoding request outright (dropSave) instead of running it: the
// caller is told it succeeded and the tab shows the new encoding, but disk
// never receives the new bytes. Same reasoning, and the same fix shape
// (setLineEnding's own clean->dirty force, main.ts:1985-1992, issue #160),
// as #210's revision bump — see that block's own doc comment for why this
// was deliberately left to its own issue rather than folded into #210's fix
// directly. Reuses createHarness/makeDocState/FakeDisk from the #124/#161
// harness above; own local saveWithEncoding helper, same deliberate-
// duplication reasoning as #210's own block above.
describe("issue #221 — Save with Encoding on a fully clean doc must force dirty=true, not just bump revision, or an in-flight save/reload's drain still drops it (failing-test-first)", () => {
  /** Mirrors main.ts's saveWithEncoding menu action as it stood right after
   *  #210's own fix (revision bump, no dirty force) — see issue #210's own
   *  local helper above, same shape. The dirty-force line below is this
   *  issue's own fix, added once main.ts's mutation point gets it too (same
   *  "doc.revision += 1; // the fix" convention #210's own helper uses). */
  async function saveWithEncoding(
    doc: DocState,
    harness: ReturnType<typeof createHarness>,
    target: { encoding: string; withBom: boolean },
    ipc: () => Promise<SaveIpcResult>,
  ): Promise<boolean> {
    const original = { encoding: doc.encoding, withBom: doc.withBom };
    doc.encoding = target.encoding;
    doc.withBom = target.withBom;
    doc.speculativeEncoding = original;
    doc.revision += 1; // issue #210's own fix
    if (!doc.dirty) doc.dirty = true; // issue #221's own fix
    const written = await harness.issueSave(false, ipc);
    if (!written && doc.speculativeEncoding === original) {
      doc.encoding = original.encoding;
      doc.withBom = original.withBom;
    }
    if (doc.speculativeEncoding === original) {
      doc.speculativeEncoding = null;
    }
    return written;
  }

  it("a redundant save already in flight on a fully clean doc: the coalesced Save with Encoding request is not dropped, and actually writes the new encoding once drained", async () => {
    const doc = makeDocState();
    doc.dirty = false; // clean start to finish — no real edit anywhere
    doc.buffer = "clean-content";
    doc.encoding = "UTF-8";
    doc.withBom = false;
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "clean-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);

    // 1. A redundant manual save on the already-clean doc (main.ts's "save"
    //    action has no dirty guard — a duplicate Cmd+S is allowed) takes the
    //    lock; its IPC round trip is still in flight.
    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");
    expect(doc.dirty).toBe(false);

    // 2. While save1 is in flight, the user opens Save with Encoding and
    //    picks UTF-16LE — applied speculatively right away regardless of the
    //    lock (main.ts mutates doc state before ever consulting saveFlow's
    //    own mustDefer), same as #210's own test above. Only the underlying
    //    saveFlow(false) call defers.
    const p2 = saveWithEncoding(
      doc,
      harness,
      { encoding: "UTF-16LE", withBom: true },
      () =>
        Promise.resolve({
          written: true,
          stale: false,
          fingerprint: "fp-enc",
          writtenContent: "clean-content-as-utf16",
        }),
    );
    expect(doc.pendingSaveAs).toBe(false); // deferred behind save1's lock
    expect(doc.encoding).toBe("UTF-16LE"); // speculative mutation, not deferred

    // 3. save1 resolves: it wrote the same clean content back out (a
    //    genuine no-op write). decideSaveCompletion sees its own
    //    revisionAtStart no longer matches doc.revision (the encoding
    //    mutation's #210 bump), so it correctly refuses to re-clear dirty —
    //    but dirty was false the whole time anyway, so that refusal is
    //    itself a no-op (the #221 gap: #210's fix alone can't protect a
    //    dirty flag that was never turned on in the first place).
    save1.resolve({
      written: true,
      stale: false,
      fingerprint: "fp-1",
      writtenContent: "clean-content",
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // FAIL target pre-fix: drainLock's nextDrainStep saw pendingSaveAs !==
    // null and dirty still false (the #210 revision bump never touches
    // dirty), so it took the dropSave branch — the coalesced request's own
    // ipc callback above was never invoked, disk never received the new
    // encoding's bytes, and the caller was told `true` anyway.
    expect(disk.content).toBe("clean-content-as-utf16");
    expect(doc.fingerprint).toBe("fp-enc");
    expect(doc.dirty).toBe(false);
    expect(doc.encoding).toBe("UTF-16LE");
    expect(doc.withBom).toBe(true);
    expect(doc.speculativeEncoding).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #212 — main.ts's saveWithEncoding menu action attaches
// .then(rollback).finally(clear) to its own saveFlow(false) call. The
// .then() rollback is guarded by *reference* equality against this call's
// own `original` (issue #161's own fix, mirrored by both saveWithEncoding
// helpers above) — but the .finally() right below it drops
// doc.speculativeEncoding unconditionally, with no such guard. Two
// overlapping Save with Encoding calls each install their own marker (the
// later one replacing the earlier one's — working as intended, same as the
// #161/#210 scenarios above); each also attaches its own independent
// .then().finally() pair to its own saveFlow(false) call. Since .finally()
// never checks whether the marker it's about to null is still its own,
// whichever of the two calls' chains happens to run its .finally() first
// wipes the marker out from under the *other* one — even while that other
// call is still genuinely in flight and still needs it: for its own
// eventual .then() rollback decision (which reads a now-null marker and
// silently skips a rollback it should have performed) and for any reload
// landing in the same window (reloadEncodingFor falls back to doc.encoding
// directly, which at that point is the *other* call's own not-yet-written
// speculative target, not disk truth).
//
// savemutex.ts's own withLock/drainLock nesting (the #124/#161 harness
// above) happens to make this hard to observe through createHarness's own
// issueSave: a request coalesced behind another one via doc.pendingSaveAs
// always has its *entire* .then().finally() chain settle before the request
// it coalesced behind gets to run its own — drainLock is awaited from
// inside withLock's own finally, so the outer call's promise can't resolve
// until everything queued behind it, recursively, already has (see this
// suite's own "real mutex" control test at the bottom, which records and
// pins down that observed order). That's a real property of *today's*
// specific coalescing implementation, but main.ts's own action never
// actually relies on it — that's exactly why its .then() already carries a
// defensive reference-equality check instead of trusting call order — so
// this suite tests the .then().finally() ownership contract directly, by
// controlling each call's own saveFlow(false) stand-in independently. A
// real save's IPC round trip can legitimately settle in either order (a
// big file, a slow disk, or a lossy-encode/stale-file dialog awaiting the
// user can all make one overlapping call outlast another), so the fix must
// hold regardless of which of the two settles first — this suite checks
// both directions rather than assuming one.
describe("issue #212 — Save with Encoding's finally must only clear its own speculativeEncoding marker, not one a newer overlapping request already installed (failing-test-first)", () => {
  /** Mirrors main.ts's saveWithEncoding menu action's actual
   *  .then().finally() shape — issue #161's and #210's own saveWithEncoding
   *  helpers above use a plain sequential `await` instead, which behaves
   *  identically for a single non-overlapping call but can't express two
   *  overlapping calls settling in a caller-chosen order the way this suite
   *  needs. `saveFlow` stands in for the real saveFlow(false) call; callers
   *  control exactly when it settles via their own deferred(). */
  function saveWithEncoding(
    doc: DocState,
    target: { encoding: string; withBom: boolean },
    saveFlow: () => Promise<boolean>,
  ): Promise<void> {
    const original = { encoding: doc.encoding, withBom: doc.withBom };
    doc.encoding = target.encoding;
    doc.withBom = target.withBom;
    doc.speculativeEncoding = original;
    return saveFlow()
      .then((written) => {
        if (!written && doc.speculativeEncoding === original) {
          doc.encoding = original.encoding;
          doc.withBom = original.withBom;
        }
      })
      .finally(() => {
        // The fix (issue #212): only clear a marker that's still this
        // call's own. A newer overlapping call may already have replaced
        // it with its own (issue #161's own "coalesce" scenario above), or
        // a reload that landed and applied in between may already have
        // cleared it (applyOpened's own *unconditional* clear above is
        // correct there, since an applied reload always establishes
        // fresher, disk-verified truth no pending speculative save's own
        // rollback may second-guess — this finally has no such standing
        // over a *different*, still-pending call's own marker).
        if (doc.speculativeEncoding === original) {
          doc.speculativeEncoding = null;
        }
      });
  }

  it("a request that settles while a second, still-pending overlapping request is in flight: its finally must not clear the second's still-live marker", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5";
    doc.withBom = false;
    doc.dirty = true;

    const firstFlow = deferred<boolean>();
    const first = saveWithEncoding(doc, { encoding: "UTF-8", withBom: false }, () => firstFlow.promise);
    expect(doc.speculativeEncoding).toEqual({ encoding: "Big5", withBom: false });

    // The second request overlaps while the first is still genuinely in
    // flight (its own saveFlow(false) hasn't settled yet) — same as issue
    // #161's own "coalesce" scenario: it installs its own marker,
    // protecting the value the first request's own speculative apply left
    // behind, not the true pre-first-click original.
    const secondFlow = deferred<boolean>();
    const second = saveWithEncoding(doc, { encoding: "UTF-16LE", withBom: true }, () => secondFlow.promise);
    expect(doc.speculativeEncoding).toEqual({ encoding: "UTF-8", withBom: false });

    // The first request settles now — its own save succeeded, which is
    // irrelevant to what happens to the *marker*, since a written:true
    // result never even reaches the .then()'s reference-equality check.
    // The second request's own saveFlow(false) is still unresolved.
    firstFlow.resolve(true);
    await first;

    // FAIL target pre-fix: the first's finally cleared
    // doc.speculativeEncoding unconditionally, even though it currently
    // holds the second request's own marker, not the first's — the second
    // request is still genuinely in flight and still needs it.
    expect(doc.speculativeEncoding).toEqual({ encoding: "UTF-8", withBom: false });

    // The second request now fails to write.
    secondFlow.resolve(false);
    await second;

    // Its own rollback must fire, using its own protected original — not
    // silently skipped because some other request's finally already wiped
    // the marker it was reading.
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.withBom).toBe(false);
    expect(doc.speculativeEncoding).toBeNull(); // the second's own finally cleans up its own marker
  });

  it("coalesced failure — both overlapping requests resolve false: the doc ends up on the value right before the SECOND request, not stuck on its own never-written target", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5"; // the true original, before either request
    doc.withBom = false;
    doc.dirty = true;

    const firstFlow = deferred<boolean>();
    const first = saveWithEncoding(doc, { encoding: "UTF-8", withBom: false }, () => firstFlow.promise);
    const secondFlow = deferred<boolean>();
    const second = saveWithEncoding(doc, { encoding: "UTF-16LE", withBom: true }, () => secondFlow.promise);

    firstFlow.resolve(false); // the first request's own save also failed/was cancelled
    await first;
    secondFlow.resolve(false);
    await second;

    // Not "Big5" (the true original — the *first* request's own baseline,
    // not the second's) and not stuck on "UTF-16LE" (the second request's
    // own never-written target) — the second request's own `original`
    // recorded doc.encoding as it stood right before *its own* action ran,
    // i.e. "UTF-8", the first request's speculative target.
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.withBom).toBe(false);
    expect(doc.speculativeEncoding).toBeNull();
  });

  it("a reload landing after the first request's finally has run, while the second request is still pending, must still decode with the second's protected original — not the second's own not-yet-written speculative target", async () => {
    const doc = makeDocState();
    doc.encoding = "Big5";
    doc.withBom = false;
    doc.dirty = true;

    const firstFlow = deferred<boolean>();
    const first = saveWithEncoding(doc, { encoding: "UTF-8", withBom: false }, () => firstFlow.promise);
    const secondFlow = deferred<boolean>();
    const second = saveWithEncoding(doc, { encoding: "UTF-16LE", withBom: true }, () => secondFlow.promise);

    // The first request's own save actually succeeds and writes UTF-8
    // bytes to disk — so by the time it settles, "UTF-8" (the second
    // request's own protected original, captured as doc.encoding right
    // after the first request's own speculative apply) is exactly what a
    // reload landing now should decode with.
    firstFlow.resolve(true);
    await first;

    // FAIL target pre-fix: the marker the second request still needs is
    // already gone, so a reload landing in exactly this window falls back
    // to doc.encoding directly — currently "UTF-16LE", the second
    // request's own not-yet-written target, not what's actually on disk.
    expect(reloadEncodingFor(doc)).toBe("UTF-8");

    secondFlow.resolve(false);
    await second;
    expect(doc.speculativeEncoding).toBeNull();
  });

  it("control — a lone, non-overlapping Save with Encoding still cleans up its own marker on both success and failure", async () => {
    const successDoc = makeDocState();
    successDoc.encoding = "Big5";
    successDoc.withBom = false;
    await saveWithEncoding(successDoc, { encoding: "UTF-8", withBom: true }, () => Promise.resolve(true));
    expect(successDoc.encoding).toBe("UTF-8");
    expect(successDoc.withBom).toBe(true);
    expect(successDoc.speculativeEncoding).toBeNull();

    const failDoc = makeDocState();
    failDoc.encoding = "Big5";
    failDoc.withBom = false;
    await saveWithEncoding(failDoc, { encoding: "UTF-8", withBom: true }, () => Promise.resolve(false));
    expect(failDoc.encoding).toBe("Big5");
    expect(failDoc.withBom).toBe(false);
    expect(failDoc.speculativeEncoding).toBeNull();
  });

  it("control — the real mutex's own coalescing (createHarness) settles a request queued behind an in-flight one before the in-flight one's own finally runs, so the ownership check is a no-op there today; pinned down so a future change to that ordering doesn't silently reopen issue #212 unnoticed", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.encoding = "Big5";
    doc.withBom = false;
    doc.fingerprint = "fp-0";
    doc.buffer = "content";
    const disk: FakeDisk = { content: "old-content", fingerprint: "fp-0" };
    const harness = createHarness(doc, disk);
    const settleOrder: string[] = [];

    function saveWithEncodingViaHarness(
      label: string,
      target: { encoding: string; withBom: boolean },
      ipc: () => Promise<SaveIpcResult>,
    ): Promise<void> {
      const original = { encoding: doc.encoding, withBom: doc.withBom };
      doc.encoding = target.encoding;
      doc.withBom = target.withBom;
      doc.speculativeEncoding = original;
      return harness
        .issueSave(false, ipc)
        .then((written) => {
          if (!written && doc.speculativeEncoding === original) {
            doc.encoding = original.encoding;
            doc.withBom = original.withBom;
          }
        })
        .finally(() => {
          settleOrder.push(label);
          if (doc.speculativeEncoding === original) doc.speculativeEncoding = null;
        });
    }

    const save1 = deferred<SaveIpcResult>();
    const p1 = saveWithEncodingViaHarness("first", { encoding: "UTF-8", withBom: false }, () => save1.promise);
    const p2 = saveWithEncodingViaHarness("second", { encoding: "UTF-16LE", withBom: true }, () =>
      Promise.resolve({ written: false, stale: false, fingerprint: null, writtenContent: "" }),
    );

    save1.resolve({ written: false, stale: false, fingerprint: null, writtenContent: "" });
    await Promise.all([p1, p2]);

    // Empirically observed order (not merely asserted): the request
    // coalesced behind the in-flight one (drainLock's own nested
    // withLock/finally, see this file's module doc comment) fully settles
    // — .then() *and* .finally() — before the in-flight one's own .then()
    // ever runs, because withLock's finally awaits drainLock() before its
    // own promise resolves, and drainLock's "save" branch awaits the
    // coalesced request's entire nested withLock call before returning.
    expect(settleOrder).toEqual(["second", "first"]);
    // Both requests failed to write; the doc still lands on the second
    // request's own baseline ("UTF-8", the first request's target) —
    // correct today even with the pre-#212-fix unconditional clear, since
    // by the time "first"'s finally runs, "second" has already used its
    // own still-valid marker to roll itself back and self-cleaned. This is
    // exactly the accidental protection the suite above doesn't rely on.
    expect(doc.encoding).toBe("UTF-8");
    expect(doc.withBom).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #217 — a critic-review finding against #208's own fix. saveFlow's
// blockedByReadOnly gate (main.ts's blockedByReadOnly) runs exactly once, at
// saveFlow's own entry, before deciding whether to run immediately or
// coalesce into doc.pendingSaveAs because something else already holds the
// per-doc lock (issue #124's own mechanism). Pre-fix, drainLock (main.ts's
// drainLock) never reran that gate once the lock actually freed up and it
// was time to run the coalesced request for real via runSaveFlow — so a doc
// that turned read-only *during* the defer window had its now-current
// read-only status silently ignored, and the drained save wrote doc's
// current buffer over the real file regardless.
//
// Constructing a fully causally-realistic reproduction through an actual
// reload turns out to be impossible with today's control flow, not just
// awkward: applyOpenedForReload — the only place doc.truncated is ever set —
// unconditionally clears doc.dirty in that very same synchronous call, and
// nextDrainStep's own save-vs-dropSave choice (savemutex.ts:117-125) is
// re-checked immediately afterward with no async gap in between for a fresh
// edit to land (confirmed by reading both directly rather than assumed). So
// a reload that actually applies and sets truncated=true always leaves
// dirty=false for the very next drain check, which takes dropSave — a real
// write never happens, just not for the reason this issue is about. The
// tests below instead hold the lock with a second in-flight save (this
// suite's own "double-save" skeleton, issue #124's own block above) and flip
// the read-only flag via direct state mutation while the coalesced save sits
// pending — same convention this file already uses for "the user types in
// this window" (issue #124 critic-review P2's own describe block above) —
// isolating the read-only recheck gap itself from whichever exact call chain
// flips the flag. doc.userReadOnly's own toggle (View menu) is in fact
// reachable exactly this directly in production: it's a plain, ungated state
// flip never routed through the save/reload lock at all, so it can land in
// this window for real, not just as a stand-in.
//
// The fix itself lives entirely in savemutex.ts's nextDrainStep (a new
// blockedByReadOnly input, a new rejectBlocked step) — createHarness's own
// drainLock below feeds it a plain isReadOnlyBlocked() predicate and then
// branches on the real step.kind it returns, exactly like main.ts's real
// drainLock does, rather than re-deciding anything on its own. That means
// every scenario below actually exercises production's decision logic, not
// a description of it: stashing savemutex.ts's fix reverts nextDrainStep to
// its pre-#217 branch table and these tests fail for the same reason
// production would. The last scenario below also pins the precedence
// nextDrainStep resolves between dropSave and rejectBlocked when a
// coalesced save is both clean *and* blocked — see nextDrainStep's own doc
// comment for why dropSave must win.
describe("issue #217 — drainLock must recheck blockedByReadOnly before executing a coalesced save, not just once at saveFlow's own entry (failing-test-first)", () => {
  it("doc turns userReadOnly while a save sits coalesced behind an in-flight save: the drain blocks it instead of writing, and the coalesced caller sees false", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    let blockedCalls = 0;
    const harness = createHarness(doc, disk, {
      onReadOnlyBlocked: () => {
        blockedCalls++;
      },
    });

    // 1. save1 already holds the lock — its IPC round trip is still in
    //    flight (e.g. a slow disk write).
    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // 2. A genuine edit lands, and the user hits Cmd+S again while save1 is
    //    still in flight — saveFlow's own entry gate sees a normal,
    //    writable doc at this exact moment and lets it through; mustDefer
    //    then coalesces it into doc.pendingSaveAs (issue #124's own
    //    mechanism) since save1 already holds the lock.
    doc.revision += 1;
    doc.buffer = "edit-2";
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({
        written: true,
        stale: false,
        fingerprint: "fp-should-not-be-used",
        writtenContent: "edit-2-should-not-reach-disk",
      }),
    );
    expect(doc.pendingSaveAs).toBe(false); // coalesced, not run yet

    // 3. While the coalesced save sits pending, the user toggles View >
    //    Read-Only for this tab — a plain state flip, never routed through
    //    the save/reload lock, so it can land in exactly this window.
    doc.userReadOnly = true;

    // 4. save1 resolves; #112's revision guard keeps dirty (edit-2 landed
    //    after save1's own snapshot), so drainLock's nextDrainStep picks
    //    "save" for the coalesced request, not "dropSave".
    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    // FAIL target pre-fix: drainLock ran the coalesced save's own ipc
    // unconditionally, writing "edit-2-should-not-reach-disk" over disk
    // despite doc.userReadOnly having turned true while it sat pending.
    expect(r2).toBe(false);
    expect(blockedCalls).toBe(1);
    expect(disk.content).toBe("edit-1"); // the coalesced save never wrote
    expect(doc.saveReloadInFlight).toBeNull(); // lock not stuck
    expect(doc.pendingSaveAs).toBeNull(); // no zombie pending left behind
  });

  it("doc turns truncated (large-file preview) while a save sits coalesced behind an in-flight save: the drain blocks it instead of writing a preview slice over the real file", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    let blockedCalls = 0;
    const harness = createHarness(doc, disk, {
      onReadOnlyBlocked: () => {
        blockedCalls++;
      },
    });

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    doc.revision += 1;
    doc.buffer = "edit-2-preview-slice";
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({
        written: true,
        stale: false,
        fingerprint: "fp-should-not-be-used",
        writtenContent: "edit-2-preview-slice-should-not-reach-disk",
      }),
    );
    expect(doc.pendingSaveAs).toBe(false);

    // Simulates the *effect* of a watcher-triggered reload discovering the
    // file grew past the large-file threshold during the defer window
    // (issue #217's own report) — see this describe block's own header
    // comment for why a real reload chain can't actually reach this drain
    // branch with dirty still true, and why direct mutation is used here
    // instead.
    doc.truncated = true;

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    // FAIL target pre-fix: drainLock ran the coalesced save's own ipc
    // unconditionally, writing the preview-slice buffer over disk despite
    // doc.truncated having turned true while it sat pending.
    expect(r2).toBe(false);
    expect(blockedCalls).toBe(1);
    expect(disk.content).toBe("edit-1");
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingSaveAs).toBeNull();
  });

  it("control — a coalesced save that drains while the doc is still perfectly writable runs normally, unaffected by the new recheck", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    let blockedCalls = 0;
    const harness = createHarness(doc, disk, {
      onReadOnlyBlocked: () => {
        blockedCalls++;
      },
    });

    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);

    doc.revision += 1;
    doc.buffer = "edit-2";
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({ written: true, stale: false, fingerprint: "fp-2", writtenContent: "edit-2" }),
    );

    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(blockedCalls).toBe(0);
    expect(disk.content).toBe("edit-2");
    expect(doc.dirty).toBe(false);
    expect(doc.saveReloadInFlight).toBeNull();
  });

  it("a coalesced save that comes out of the lock already clean (dropSave) resolves true even if the doc also turned read-only while it sat pending — dropSave wins, no rejection dialog fires", async () => {
    const doc = makeDocState();
    doc.dirty = true;
    doc.buffer = "edit-1";
    doc.fingerprint = "fp-0";
    doc.revision = 1;
    const disk: FakeDisk = { content: "d0", fingerprint: "fp-0" };
    let blockedCalls = 0;
    const harness = createHarness(doc, disk, {
      onReadOnlyBlocked: () => {
        blockedCalls++;
      },
    });

    // 1. save1 holds the lock, in flight.
    const save1 = deferred<SaveIpcResult>();
    const p1 = harness.issueSave(false, () => save1.promise);
    expect(doc.saveReloadInFlight).toBe("save");

    // 2. A second, redundant Save request — no new edit; main.ts's save
    //    action has no dirty guard — coalesces behind save1's lock at the
    //    SAME revision. Its own ipc mock must never actually run.
    const p2 = harness.issueSave(false, () =>
      Promise.resolve({
        written: true,
        stale: false,
        fingerprint: "fp-should-not-be-used",
        writtenContent: "should-not-reach-disk",
      }),
    );
    expect(doc.pendingSaveAs).toBe(false); // coalesced, not run yet

    // 3. While the coalesced save sits pending, the doc turns read-only —
    //    same trigger as the userReadOnly scenario above.
    doc.userReadOnly = true;

    // 4. save1 resolves, writing "edit-1". doc.revision never moved (no
    //    edit landed after save1's own snapshot), so decideSaveCompletion's
    //    revisionMatches clears dirty — nextDrainStep sees pendingSaveAs !==
    //    null && dirty === false and takes dropSave *before* ever
    //    consulting blockedByReadOnly (nextDrainStep's own precedence).
    save1.resolve({ written: true, stale: false, fingerprint: "fp-1", writtenContent: "edit-1" });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    // dropSave, not rejectBlocked: save1 already wrote exactly what the
    // coalesced request wanted, so it's told `true` (covered) — unlike the
    // dirty scenarios above, and the rejection dialog must not fire, since
    // nothing about this request was actually rejected.
    expect(r2).toBe(true);
    expect(blockedCalls).toBe(0);
    expect(disk.content).toBe("edit-1"); // save1's own write only — save2's ipc never ran
    expect(doc.saveReloadInFlight).toBeNull();
    expect(doc.pendingSaveAs).toBeNull();
  });
});

// PR #319 seventh-round Codex review (P2): main.ts's handleExternalChange
// falls back to `doc.pendingReload = true` whenever fetchStableFingerprint
// never stabilizes (issue #302 review, sixth round) — normally safe
// because reloadFromDisk's own identical pattern only ever sets that flag
// right after synchronously confirming an owner via mustDefer, so that
// owner's own eventual withLock/finally is guaranteed to still be pending
// and will drain it. But fetchStableFingerprint's own awaits mean the save
// that made the last attempt unstable may already have fully finished —
// and already run its own drain — by the time handleExternalChange reaches
// this fallback, leaving nobody left to drain the flag it's about to set.
// deferAfterUnstableFetchSim mirrors main.ts's exact fix: set the flag
// first, *then* recheck mustDefer, self-draining only if that recheck
// finds no owner at all.
describe("issue #302 review, seventh round — a caller deferring via pendingReload after an async gap must self-drain when no owner is left to (failing-test-first)", () => {
  async function deferAfterUnstableFetchSim(
    doc: { saveReloadInFlight: LockOwner; pendingReload: boolean },
    drainLock: () => Promise<void>,
  ): Promise<void> {
    doc.pendingReload = true;
    if (!mustDefer({ inFlight: doc.saveReloadInFlight })) {
      await drainLock();
    }
  }

  it("no owner left at the recheck (the culprit save already finished and already drained): self-drains", async () => {
    const doc: { saveReloadInFlight: LockOwner; pendingReload: boolean } = {
      saveReloadInFlight: null,
      pendingReload: false,
    };
    let drainCalls = 0;
    await deferAfterUnstableFetchSim(doc, async () => {
      drainCalls += 1;
    });

    expect(doc.pendingReload).toBe(true);
    expect(drainCalls).toBe(1);
  });

  it("an owner still holds the lock at the recheck: does not self-drain — that owner's own withLock/finally will see the flag and drain it", async () => {
    const doc: { saveReloadInFlight: LockOwner; pendingReload: boolean } = {
      saveReloadInFlight: "save",
      pendingReload: false,
    };
    let drainCalls = 0;
    await deferAfterUnstableFetchSim(doc, async () => {
      drainCalls += 1;
    });

    expect(doc.pendingReload).toBe(true);
    expect(drainCalls).toBe(0);
  });

  it("ordering invariant: set-then-check tolerates a new owner grabbing the lock between the two steps; check-then-set would race it", async () => {
    // Fixed order (set, then check) — a microtask boundary (awaiting
    // Promise.resolve()) between the two simulates a new save grabbing
    // the lock in exactly that gap.
    const fixed: { saveReloadInFlight: LockOwner; pendingReload: boolean } = {
      saveReloadInFlight: null,
      pendingReload: false,
    };
    fixed.pendingReload = true;
    await Promise.resolve().then(() => {
      fixed.saveReloadInFlight = "save"; // a new save grabs the lock here
    });
    const fixedSelfDrains = !mustDefer({ inFlight: fixed.saveReloadInFlight });

    expect(fixed.pendingReload).toBe(true); // already visible to the new owner
    expect(fixedSelfDrains).toBe(false); // correctly defers to it instead of racing it

    // Buggy order (check, then set) reaches the opposite, wrong
    // conclusion from the exact same timeline: it reads the lock as free
    // *before* the new owner grabs it, decides to self-drain, and only
    // sets the flag afterwards.
    const buggy: { saveReloadInFlight: LockOwner; pendingReload: boolean } = {
      saveReloadInFlight: null,
      pendingReload: false,
    };
    const buggySelfDrains = !mustDefer({ inFlight: buggy.saveReloadInFlight });
    await Promise.resolve().then(() => {
      buggy.saveReloadInFlight = "save"; // the same new save grabs the lock
    });
    buggy.pendingReload = true;

    expect(buggySelfDrains).toBe(true); // wrongly self-drains despite the new owner
  });
});

// Issue #325: runSaveFlow's saveDialog await (Save As, or an untitled
// doc's first Save) used to sit *outside* its own try/catch, so a
// rejection from it — the dialog plugin's own IPC failing, never an
// ordinary user Cancel, which resolves with `null` instead — escaped
// runSaveFlow entirely instead of becoming an ordinary SaveFlowResult.
// That broke saveFlow's never-rejects contract, which drainLock's
// coalesced-save branch (above in this file) and the Save with Encoding
// menu action's `.then` rollback (savecompletion.test.ts) both depend on:
// a direct caller got an unhandled rejection instead of the save-failed
// dialog; a caller already queued in pendingSaveResolvers before this
// throw would never have its resolver called at all, since drainLock's
// own resolve loop sits textually after the point that now throws.
//
// main.ts's fix wraps just the saveDialog await in its own try/catch
// (rather than moving it inside the function's main try) — TypeScript's
// narrowing of the reassigned `path` through the closures the rest of
// runSaveFlow passes it into (e.g. checkByteDrift's callback) only
// survives when that reassignment happens outside the main try, so
// merging the two would have reintroduced a build break, not just been a
// style choice. The externally observable contract is identical either
// way: runSaveFlowDialogSim below mirrors exactly that shape, and
// runSaveFlowDialogSimBuggy mirrors the pre-fix (unguarded) shape to pin
// the regression it closes.
// Codex P1 follow-up on the fix above: the error dialog runSaveFlow shows
// once saveDialog rejects (`reportSaveFailureBestEffort` in main.ts) uses
// the *same* dialog plugin/IPC channel that can be exactly why saveDialog
// itself just failed — the whole plugin being unavailable, not something
// specific to the save picker. Awaiting that unguarded would let *its*
// rejection escape instead, silently reintroducing all three #325 symptoms
// one layer further in. `showErrorDialog` below defaults to a no-op
// success so every existing call site is unaffected; passing a rejecting
// one exercises this exact follow-up.
async function runSaveFlowDialogSim(
  path: string | null,
  saveDialog: () => Promise<string | null>,
  showErrorDialog: () => Promise<void> = () => Promise.resolve(),
): Promise<{
  result: { written: boolean; stale: boolean };
  errorShown: boolean;
  errorDialogFailed: boolean;
}> {
  if (path === null) {
    try {
      path = await saveDialog();
    } catch {
      let errorDialogFailed = false;
      try {
        await showErrorDialog();
      } catch {
        errorDialogFailed = true;
      }
      return {
        result: { written: false, stale: false },
        errorShown: true,
        errorDialogFailed,
      };
    }
    if (path === null) {
      return {
        result: { written: false, stale: false },
        errorShown: false,
        errorDialogFailed: false,
      };
    }
  }
  // Stands in for the rest of runSaveFlow's own try/catch — this sim only
  // cares about the dialog boundary, so a resolved path is treated as an
  // immediate (stand-in) success.
  return { result: { written: true, stale: false }, errorShown: false, errorDialogFailed: false };
}

/** The pre-#325 shape: the dialog await is unguarded. Used only to pin the
 *  regression the fix above closes — never as a stand-in for current
 *  behavior. */
async function runSaveFlowDialogSimBuggy(
  path: string | null,
  saveDialog: () => Promise<string | null>,
): Promise<{ written: boolean; stale: boolean }> {
  if (path === null) {
    path = await saveDialog();
    if (path === null) return { written: false, stale: false };
  }
  return { written: true, stale: false };
}

/** The pre-follow-up shape: saveDialog is guarded (issue #325's own fix),
 *  but the error dialog it shows on rejection is not (the Codex P1 follow-
 *  up). Used only to pin the regression the best-effort wrapping above
 *  closes. */
async function runSaveFlowDialogSimBuggyErrorDialog(
  path: string | null,
  saveDialog: () => Promise<string | null>,
  showErrorDialog: () => Promise<void>,
): Promise<{ written: boolean; stale: boolean }> {
  if (path === null) {
    try {
      path = await saveDialog();
    } catch {
      await showErrorDialog(); // unguarded — the follow-up's exact shape
      return { written: false, stale: false };
    }
    if (path === null) return { written: false, stale: false };
  }
  return { written: true, stale: false };
}

describe("issue #325 — saveDialog rejection must not escape runSaveFlow/saveFlow's never-reject contract (failing-test-first)", () => {
  it("direct: a rejecting saveDialog resolves as an ordinary failed SaveFlowResult, with the error surfaced — never an unhandled rejection", async () => {
    const { result, errorShown } = await runSaveFlowDialogSim(null, () =>
      Promise.reject(new Error("dialog plugin IPC failed")),
    );

    expect(result).toEqual({ written: false, stale: false });
    expect(errorShown).toBe(true);
  });

  it("deferred/coalesced: a save queued in pendingSaveResolvers behind an in-flight lock still resolves once drained, even though the drained attempt's own saveDialog rejects", async () => {
    // Mirrors main.ts's saveFlow deferring into a Promise executor (issue
    // #124) plus drainLock's coalesced-save branch taking the queued
    // resolvers array (its own `.get` + `.delete`) before running the
    // actual attempt and resolving every one of them with whatever it
    // returns.
    const resolvers: Array<(r: { written: boolean; stale: boolean }) => void> = [];
    const queued = new Promise<{ written: boolean; stale: boolean }>((resolve) => {
      resolvers.push(resolve);
    });

    const taken = resolvers.splice(0, resolvers.length);
    const { result } = await runSaveFlowDialogSim(null, () =>
      Promise.reject(new Error("dialog plugin IPC failed")),
    );
    for (const resolve of taken) resolve(result);

    await expect(queued).resolves.toEqual({ written: false, stale: false });
  });

  it("regression pin — the pre-fix (unguarded) shape would have left a queued caller's promise permanently unresolved", async () => {
    const resolvers: Array<(r: { written: boolean; stale: boolean }) => void> = [];
    const queued = new Promise<{ written: boolean; stale: boolean }>((resolve) => {
      resolvers.push(resolve);
    });

    const drainAttempt = async (): Promise<void> => {
      const taken = resolvers.splice(0, resolvers.length);
      const result = await runSaveFlowDialogSimBuggy(null, () =>
        Promise.reject(new Error("dialog plugin IPC failed")),
      );
      // Never reached pre-fix: the await above throws first, exactly
      // issue #325's "queued caller taken off the map but never resolved"
      // report.
      for (const resolve of taken) resolve(result);
    };

    await expect(drainAttempt()).rejects.toThrow("dialog plugin IPC failed");
    const settled = await Promise.race([
      queued.then(() => "settled" as const),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 20);
      }),
    ]);
    expect(settled).toBe("still-pending");
  });

  it("both saveDialog and the error dialog it triggers reject: contract still holds — resolves with a failed SaveFlowResult, never an unhandled rejection", async () => {
    const { result, errorShown, errorDialogFailed } = await runSaveFlowDialogSim(
      null,
      () => Promise.reject(new Error("dialog plugin IPC failed")),
      () => Promise.reject(new Error("dialog plugin is completely unavailable")),
    );

    expect(result).toEqual({ written: false, stale: false });
    expect(errorShown).toBe(true);
    expect(errorDialogFailed).toBe(true); // logged, not surfaced a second way
  });

  it("regression pin — without best-effort wrapping around the error dialog, its own rejection would re-escape and reject the whole attempt a second time", async () => {
    await expect(
      runSaveFlowDialogSimBuggyErrorDialog(
        null,
        () => Promise.reject(new Error("dialog plugin IPC failed")),
        () => Promise.reject(new Error("dialog plugin is completely unavailable")),
      ),
    ).rejects.toThrow("dialog plugin is completely unavailable");
  });
});
