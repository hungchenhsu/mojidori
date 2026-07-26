import { describe, expect, it } from "vitest";
import { isLikelySaveEcho, SAVE_ECHO_WINDOW_MS, type SaveEchoRecord } from "./saveecho";

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
