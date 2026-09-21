// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXIT_SKIP,
  compareSemver,
  decidePublish,
  orderCandidateTags,
  parseSemver,
} from "./updater-feed.mjs";

const SCRIPT = fileURLToPath(new URL("./updater-feed.mjs", import.meta.url));

function feed(version, pubDate = "2026-07-27T18:26:42.341Z") {
  return { version, notes: "", pub_date: pubDate, platforms: {} };
}

function cmp(a, b) {
  return Math.sign(compareSemver(parseSemver(a), parseSemver(b)));
}

describe("compareSemver", () => {
  it("orders core versions numerically, not lexically", () => {
    expect(cmp("0.10.0", "0.9.0")).toBe(1);
    expect(cmp("1.0.0", "0.99.99")).toBe(1);
    expect(cmp("0.9.0", "0.9.0")).toBe(0);
  });

  it("follows SemVer prerelease precedence", () => {
    // The example chain from the SemVer 2.0.0 spec, section 11.
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 1; i < chain.length; i++) {
      expect(cmp(chain[i], chain[i - 1])).toBe(1);
      expect(cmp(chain[i - 1], chain[i])).toBe(-1);
    }
  });

  it("accepts a leading v and ignores build metadata", () => {
    expect(cmp("v0.9.0-alpha.1", "0.9.0-alpha.1+build.5")).toBe(0);
  });

  it("rejects non-semver strings", () => {
    for (const bad of ["updater", "0.9", "01.2.3", "", "v1.2.3.4", null]) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
});

describe("orderCandidateTags", () => {
  it("ranks by tag semver and drops drafts, updater, and non-semver tags", () => {
    const releases = [
      { tagName: "updater", isDraft: false },
      { tagName: "v0.8.0-alpha.1", isDraft: false },
      { tagName: "v0.10.0-alpha.1", isDraft: true },
      { tagName: "v0.9.0-alpha.1", isDraft: false },
      { tagName: "v0.9.0-alpha.2", isDraft: false },
      { tagName: "nightly", isDraft: false },
    ];
    expect(orderCandidateTags(releases)).toEqual([
      "v0.9.0-alpha.2",
      "v0.9.0-alpha.1",
      "v0.8.0-alpha.1",
    ]);
  });

  it("throws on a non-array list", () => {
    expect(() => orderCandidateTags({})).toThrow();
  });
});

describe("decidePublish (monotonic guard)", () => {
  it("publishes when there is no current feed or it is unreadable", () => {
    expect(decidePublish(null, feed("0.8.0")).publish).toBe(true);
    expect(decidePublish({ version: "garbage" }, feed("0.8.0")).publish).toBe(
      true,
    );
  });

  it("publishes a newer version and refuses a downgrade", () => {
    expect(decidePublish(feed("0.8.0"), feed("0.9.0")).publish).toBe(true);
    expect(decidePublish(feed("0.9.0"), feed("0.8.0")).publish).toBe(false);
    expect(decidePublish(feed("0.9.0"), feed("0.10.0")).publish).toBe(true);
  });

  it("breaks same-version ties only with a strictly later pub_date", () => {
    const early = feed("0.9.0", "2026-07-27T18:00:00Z");
    const late = feed("0.9.0", "2026-07-28T09:00:00Z");
    expect(decidePublish(early, late).publish).toBe(true);
    expect(decidePublish(late, early).publish).toBe(false);
    expect(decidePublish(late, late).publish).toBe(false);
    expect(decidePublish(early, feed("0.9.0", "not a date")).publish).toBe(
      false,
    );
  });

  it("throws on an invalid candidate", () => {
    expect(() => decidePublish(feed("0.9.0"), { version: "x" })).toThrow();
    expect(() => decidePublish(null, null)).toThrow();
  });
});

// Models the workflow under its `concurrency` group: runs execute one at a
// time, in whatever order they happen to be scheduled or finish. Each run
// picks the newest published release that has a latest.json, then applies
// the guard against the feed left by earlier runs.
function runWorkflow(state, published) {
  const tags = orderCandidateTags(
    published.map((tagName) => ({ tagName, isDraft: false })),
  );
  const tag = tags.find((t) => state.assets[t] !== undefined);
  if (tag === undefined) return;
  if (decidePublish(state.feed, state.assets[tag]).publish) {
    state.feed = state.assets[tag];
  }
}

describe("workflow outcome is independent of run completion order (#343)", () => {
  const assets = {
    "v0.8.0-alpha.1": feed("0.8.0", "2026-07-23T10:00:00Z"),
    "v0.9.0-alpha.1": feed("0.9.0", "2026-07-27T18:26:42.341Z"),
    "v0.7.0-alpha.1": undefined, // pre-updater release: no latest.json
  };

  it.each([
    ["older run finishes last", ["v0.9.0-alpha.1", "v0.8.0-alpha.1"]],
    ["newer run finishes last", ["v0.8.0-alpha.1", "v0.9.0-alpha.1"]],
  ])("%s", (_label, order) => {
    // The 2026-07-28 incident: both releases were already published by the
    // time either run executed.
    const state = { feed: feed("0.7.0"), assets };
    for (const _trigger of order) {
      runWorkflow(state, ["v0.8.0-alpha.1", "v0.9.0-alpha.1"]);
    }
    expect(state.feed.version).toBe("0.9.0");
  });

  it.each([
    ["older published last", ["v0.9.0-alpha.1", "v0.8.0-alpha.1"]],
    ["newer published last", ["v0.8.0-alpha.1", "v0.9.0-alpha.1"]],
  ])("sequential publishes: %s", (_label, publishOrder) => {
    // Each run sees only the releases published so far.
    const state = { feed: null, assets };
    const published = [];
    for (const tag of publishOrder) {
      published.push(tag);
      runWorkflow(state, published);
    }
    expect(state.feed.version).toBe("0.9.0");
  });

  it.each([
    ["older run finishes last", ["v0.9.0-alpha.1", "v0.8.0-alpha.1"]],
    ["newer run finishes last", ["v0.8.0-alpha.1", "v0.9.0-alpha.1"]],
  ])("guard alone holds when a run only sees its trigger: %s", (_l, order) => {
    // Defense in depth: even if selection regressed to "the triggering
    // release" (the pre-#343 behavior), the guard alone forbids a rollback.
    const state = { feed: null, assets };
    for (const trigger of order) {
      runWorkflow(state, [trigger]);
    }
    expect(state.feed.version).toBe("0.9.0");
  });

  it("a release without latest.json leaves the feed unchanged", () => {
    const state = { feed: assets["v0.9.0-alpha.1"], assets };
    runWorkflow(state, ["v0.7.0-alpha.1"]);
    expect(state.feed).toBe(assets["v0.9.0-alpha.1"]);
  });
});

describe("CLI", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function write(name, value) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  function run(...args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
    });
  }

  it("maps guard decisions to exit codes", () => {
    dir = mkdtempSync(join(tmpdir(), "updater-feed-"));
    const v8 = write("v8.json", feed("0.8.0"));
    const v9 = write("v9.json", feed("0.9.0"));
    const bad = write("bad.json", { version: "nope" });

    expect(run("should-publish", v8, v9).status).toBe(0);
    expect(run("should-publish", v9, v8).status).toBe(EXIT_SKIP);
    expect(run("should-publish", join(dir, "missing.json"), v8).status).toBe(
      0,
    );
    const invalid = run("should-publish", v8, bad);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/candidate/);
  });

  it("prints ordered tags", () => {
    dir = mkdtempSync(join(tmpdir(), "updater-feed-"));
    const list = write("releases.json", [
      { tagName: "updater", isDraft: false },
      { tagName: "v0.8.0-alpha.1", isDraft: false },
      { tagName: "v0.9.0-alpha.1", isDraft: false },
    ]);
    const out = run("order-tags", list);
    expect(out.status).toBe(0);
    expect(out.stdout.trim().split("\n")).toEqual([
      "v0.9.0-alpha.1",
      "v0.8.0-alpha.1",
    ]);
  });

  it("rejects unknown usage", () => {
    expect(run("bogus").status).toBe(1);
  });
});
