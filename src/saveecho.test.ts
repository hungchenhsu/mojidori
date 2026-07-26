import { describe, expect, it } from "vitest";
import { isLikelySaveEcho, SAVE_ECHO_WINDOW_MS, type SaveEchoRecord } from "./saveecho";

const record: SaveEchoRecord = {
  time: 1_000,
  metadata: { size: 42, modifiedMs: 1_000 },
};

describe("isLikelySaveEcho", () => {
  it("no record at all: never suppresses", () => {
    expect(
      isLikelySaveEcho({ now: 1_000, record: undefined, current: null }),
    ).toBe(false);
  });

  it("outside the window: never suppresses, regardless of metadata", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + SAVE_ECHO_WINDOW_MS,
        record,
        current: { size: 999, modifiedMs: 999 },
      }),
    ).toBe(false);
  });

  it("inside the window, caller skipped the metadata fetch: suppresses (pre-#302 time-only behavior)", () => {
    expect(
      isLikelySaveEcho({ now: record.time + 100, record, current: undefined }),
    ).toBe(true);
  });

  it("inside the window, current fetch failed (file gone/replaced): does not suppress", () => {
    expect(isLikelySaveEcho({ now: record.time + 100, record, current: null })).toBe(
      false,
    );
  });

  it("inside the window, no baseline metadata recorded yet: fails closed, suppresses", () => {
    const noBaseline: SaveEchoRecord = { time: 1_000, metadata: null };
    expect(
      isLikelySaveEcho({
        now: 1_100,
        record: noBaseline,
        current: { size: 42, modifiedMs: 1_000 },
      }),
    ).toBe(true);
  });

  it("inside the window, current metadata matches recorded: suppresses (genuine echo)", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { size: 42, modifiedMs: 1_000 },
      }),
    ).toBe(true);
  });

  it("inside the window, size differs: does not suppress (issue #302's own reproduction)", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { size: 43, modifiedMs: 1_000 },
      }),
    ).toBe(false);
  });

  it("inside the window, mtime differs: does not suppress", () => {
    expect(
      isLikelySaveEcho({
        now: record.time + 100,
        record,
        current: { size: 42, modifiedMs: 1_234 },
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
