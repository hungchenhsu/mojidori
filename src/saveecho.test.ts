import { describe, expect, it } from "vitest";
import {
  isLikelySaveEcho,
  sameSaveRecord,
  SAVE_ECHO_WINDOW_MS,
  type SaveEchoRecord,
} from "./saveecho";

// Fingerprints are opaque from this module's perspective (fsguard.rs's
// Fingerprint, compared via savemutex.ts's fingerprintsEqual — a
// JSON.stringify comparison) — plain fixture objects stand in for them
// here, same as savemutex.test.ts's own fingerprintsEqual fixtures.
const record: SaveEchoRecord = {
  time: 1_000,
  fingerprint: { len: 42, modified: { secs: 1_000, nanos: 0 } },
};

describe("isLikelySaveEcho", () => {
  it("no record at all: never suppresses", () => {
    expect(
      isLikelySaveEcho({ now: 1_000, record: undefined, current: null }),
    ).toBe(false);
  });

  it("outside the window: never suppresses, regardless of fingerprint", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + SAVE_ECHO_WINDOW_MS,
        record,
        current: { len: 999, modified: { secs: 999, nanos: 0 } },
      }),
    ).toBe(false);
  });

  it("inside the window, caller skipped the fingerprint fetch: suppresses (pre-#302 time-only behavior)", () => {
    expect(
      isLikelySaveEcho({ now: record.time + 100, record, current: undefined }),
    ).toBe(true);
  });

  it("inside the window, current fetch failed (file gone/replaced): does not suppress", () => {
    expect(isLikelySaveEcho({ now: record.time + 100, record, current: null })).toBe(
      false,
    );
  });

  it("inside the window, no baseline fingerprint recorded (contract violation): fails closed, suppresses", () => {
    const noBaseline: SaveEchoRecord = { time: 1_000, fingerprint: null };
    expect(
      isLikelySaveEcho({
        now: 1_100,
        record: noBaseline,
        current: { len: 42, modified: { secs: 1_000, nanos: 0 } },
      }),
    ).toBe(true);
  });

  it("inside the window, current fingerprint matches recorded exactly: suppresses (genuine echo)", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { len: 42, modified: { secs: 1_000, nanos: 0 } },
      }),
    ).toBe(true);
  });

  it("inside the window, len differs: does not suppress (issue #302's own reproduction)", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { len: 43, modified: { secs: 1_000, nanos: 0 } },
      }),
    ).toBe(false);
  });

  it("inside the window, only sub-millisecond/nanos differ (would alias under a millisecond-truncated mtime): does not suppress", () => {
    // Codex P2 finding #2 against an earlier version of this fix: a
    // size+modifiedMs comparison could not see this difference at all.
    // The opaque fingerprint's full-precision `modified` can.
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { len: 42, modified: { secs: 1_000, nanos: 500_000 } },
      }),
    ).toBe(false);
  });

  it("boundary: exactly at the window edge counts as outside (>=), never suppresses", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + SAVE_ECHO_WINDOW_MS,
        record,
        current: undefined,
      }),
    ).toBe(false);
  });
});

// PR #319 fourth-round Codex review (P2): main.ts's handleExternalChange
// captures `record` before its documentFingerprint(path) await, then used
// to compare `record` against `current` (fetched during that await). If
// this app completes a *second* save to the same path while that fetch is
// in flight, recordOwnSave replaces recentSaves' entry with the second
// save's own fresher record — but `current` (a live disk read taken after
// that second save landed) reflects the *second* save's fingerprint, not
// the first's. main.ts's own fix re-reads recentSaves.get(path) right
// before calling isLikelySaveEcho rather than reusing the captured
// `record`. isLikelySaveEcho itself takes whatever `record` its caller
// hands it — there is no bug in the pure function to fix — so this test
// exists to pin the caller-facing contract: it must be given the freshest
// record, or exactly this false-mismatch happens.
describe("isLikelySaveEcho — must be given the freshest record across an await gap (PR #319 fourth-round review)", () => {
  const firstSave: SaveEchoRecord = {
    time: 1_000,
    fingerprint: { len: 10, modified: { secs: 1_000, nanos: 0 } },
  };
  const secondSave: SaveEchoRecord = {
    time: 1_050,
    fingerprint: { len: 20, modified: { secs: 1_050, nanos: 0 } },
  };
  // The live disk read taken once the watcher-event handler's await
  // resolves, after this app's own second save already landed.
  const currentAfterSecondSave = { len: 20, modified: { secs: 1_050, nanos: 0 } };

  it("using the stale first-save record against post-second-save disk state: false mismatch, would NOT suppress (the bug)", () => {
    expect(
      isLikelySaveEcho({
        now: 1_100,
        record: firstSave,
        current: currentAfterSecondSave,
      }),
    ).toBe(false);
  });

  it("using the freshest (second-save) record against the same disk state: correctly recognized as our own echo", () => {
    expect(
      isLikelySaveEcho({
        now: 1_100,
        record: secondSave,
        current: currentAfterSecondSave,
      }),
    ).toBe(true);
  });
});

// PR #319 fifth-round Codex review (P2): the mirror image of the fourth
// round above. main.ts's fourth-round fix re-read `record` *after* the
// documentFingerprint(path) fetch resolved — but if this app's own second
// save completes *after* that fetch's underlying disk read already
// happened, and *before* this app's continuation actually resumes to do
// that re-read, `current` still describes disk as of the *first* save
// while the freshly re-read `record` already reflects the second. Neither
// "read record before the fetch" nor "read record after the fetch" is
// sound in isolation — see saveecho.ts's sameSaveRecord doc comment for
// the full invariant and why main.ts now verifies stability with a bounded
// retry loop instead. isLikelySaveEcho itself is unchanged by either round
// (it just compares whatever `record`/`current` its caller hands it); this
// describe block is the full 2x2 matrix (record old/new x fingerprint
// old/new) proving the function's own behavior is exactly right for every
// combination a caller could ever hand it — the fourth- and fifth-round
// bugs were both caller-side (main.ts feeding it an inconsistent pair),
// never something isLikelySaveEcho needed to change to fix.
describe("isLikelySaveEcho — record/fingerprint interleaving matrix (PR #319 fifth-round review)", () => {
  const firstSave: SaveEchoRecord = {
    time: 1_000,
    fingerprint: { len: 10, modified: { secs: 1_000, nanos: 0 } },
  };
  const secondSave: SaveEchoRecord = {
    time: 1_050,
    fingerprint: { len: 20, modified: { secs: 1_050, nanos: 0 } },
  };
  const diskAfterFirstSave = { len: 10, modified: { secs: 1_000, nanos: 0 } };
  const diskAfterSecondSave = { len: 20, modified: { secs: 1_050, nanos: 0 } };

  it("record=old, fingerprint=old (consistent — a stable fetch that observed the first save throughout): suppresses", () => {
    expect(
      isLikelySaveEcho({ now: 1_100, record: firstSave, current: diskAfterFirstSave }),
    ).toBe(true);
  });

  it("record=new, fingerprint=new (consistent — a stable fetch that observed the second save throughout): suppresses", () => {
    expect(
      isLikelySaveEcho({ now: 1_100, record: secondSave, current: diskAfterSecondSave }),
    ).toBe(true);
  });

  it("record=old, fingerprint=new (round four's exact shape — record sampled before the fetch, disk sampled after a second save): does not suppress", () => {
    expect(
      isLikelySaveEcho({ now: 1_100, record: firstSave, current: diskAfterSecondSave }),
    ).toBe(false);
  });

  it("record=new, fingerprint=old (round five's exact shape — disk sampled before a second save, record re-read after it): does not suppress", () => {
    expect(
      isLikelySaveEcho({ now: 1_100, record: secondSave, current: diskAfterFirstSave }),
    ).toBe(false);
  });
});

describe("sameSaveRecord", () => {
  it("the same object reference: stable", () => {
    expect(sameSaveRecord(record, record)).toBe(true);
  });

  it("undefined on both sides: stable (nothing has ever been saved to this path)", () => {
    expect(sameSaveRecord(undefined, undefined)).toBe(true);
  });

  it("a structurally identical but distinct object: not stable — recentSaves.set always installs a fresh object, so a different reference always means something replaced it", () => {
    const clone: SaveEchoRecord = { time: record.time, fingerprint: record.fingerprint };
    expect(sameSaveRecord(record, clone)).toBe(false);
  });

  it("undefined on one side only: not stable", () => {
    expect(sameSaveRecord(record, undefined)).toBe(false);
    expect(sameSaveRecord(undefined, record)).toBe(false);
  });
});
