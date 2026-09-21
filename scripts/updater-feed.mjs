#!/usr/bin/env node
// scripts/updater-feed.mjs
//
// Decision logic for .github/workflows/updater-json.yml (issue #343).
//
// Every `release: published` event starts its own workflow run, and they
// all write the same rolling `updater/latest.json` asset. Without a guard,
// completion order — not version order — decides what the feed ends up
// pointing at, so a slow run for an older release can roll every installed
// client's feed back. This script makes the outcome order-independent:
//
//   1. `order-tags` ranks every published release by its tag's semver, so a
//      run syncs the feed to the newest published release that carries a
//      latest.json — not merely to the release that happened to trigger it.
//      A run cancelled by the workflow's concurrency queue therefore loses
//      nothing: whichever run survives computes the same answer.
//   2. `should-publish` is the monotonic guard: the candidate replaces the
//      current feed only if it is strictly newer (by `version`, then by
//      `pub_date` for two builds sharing a version — see release.yml's note
//      on alphas sharing one plain semver). The feed can never go backwards.
//
// Compatibility: the workflow YAML runs from the published tag's commit,
// but this script is checked out from the default branch. Every post-fix
// tag's YAML calls this CLI, so its subcommands, arguments, and exit codes
// (0 publish / 10 skip / other = error) must stay backward compatible.
//
// Usage:
//   node scripts/updater-feed.mjs order-tags <releases.json>
//     <releases.json> is `gh release list --json tagName,isDraft` output.
//     Prints candidate tags newest-first, one per line.
//   node scripts/updater-feed.mjs should-publish <current.json> <candidate.json>
//     <current.json> may be a missing path (no feed yet). Exits 0 when the
//     candidate should be published, 10 when it should be skipped, and 1 on
//     an invalid candidate. The reason is printed either way.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Exit code for "valid input, nothing to publish". */
export const EXIT_SKIP = 10;

/**
 * @param {unknown} text
 * @returns {{ core: number[], pre: string[] } | null}
 */
export function parseSemver(text) {
  if (typeof text !== "string") return null;
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
}

/**
 * SemVer 2.0.0 precedence (build metadata ignored).
 * @param {{ core: number[], pre: string[] }} a
 * @param {{ core: number[], pre: string[] }} b
 * @returns {number} negative, zero, or positive
 */
export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  // A release outranks any prerelease of the same core version.
  if (a.pre.length === 0 || b.pre.length === 0) {
    return b.pre.length - a.pre.length;
  }
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

/**
 * Published (non-draft) release tags with a semver tag, newest first. The
 * rolling `updater` tag and any non-semver tag are never candidates.
 * @param {unknown} releases
 * @returns {string[]}
 */
export function orderCandidateTags(releases) {
  if (!Array.isArray(releases)) {
    throw new Error("release list is not a JSON array");
  }
  return releases
    .filter((r) => r && typeof r.tagName === "string" && r.isDraft !== true)
    .map((r) => ({ tag: r.tagName, ver: parseSemver(r.tagName) }))
    .filter((r) => r.ver !== null)
    .sort((a, b) => compareSemver(b.ver, a.ver))
    .map((r) => r.tag);
}

/**
 * @param {unknown} feed parsed latest.json
 * @returns {{ ver: { core: number[], pre: string[] }, pubDate: number } | null}
 */
function readFeed(feed) {
  if (!feed || typeof feed !== "object") return null;
  const ver = parseSemver(/** @type {any} */ (feed).version);
  if (!ver) return null;
  const pubDate = Date.parse(/** @type {any} */ (feed).pub_date);
  return { ver, pubDate };
}

/**
 * The monotonic guard. `current` is the parsed feed now being served, or
 * null when there is none (or it is unreadable — a broken feed serves no one,
 * so replacing it with a valid one is always an improvement).
 * @param {unknown} current
 * @param {unknown} candidate
 * @returns {{ publish: boolean, reason: string }}
 */
export function decidePublish(current, candidate) {
  const cand = readFeed(candidate);
  if (!cand) {
    throw new Error("candidate latest.json has no valid semver `version`");
  }
  const cur = readFeed(current);
  if (!cur) {
    return { publish: true, reason: "no valid current feed" };
  }
  const byVersion = compareSemver(cand.ver, cur.ver);
  if (byVersion > 0) return { publish: true, reason: "newer version" };
  if (byVersion < 0) {
    return { publish: false, reason: "older version; refusing downgrade" };
  }
  // Same version (e.g. alpha.1 and alpha.2 both built as 0.9.0): only a
  // strictly later build may replace the feed. Missing/invalid dates can't
  // prove "later", so they never win a tie.
  if (Number.isFinite(cand.pubDate) && Number.isFinite(cur.pubDate)) {
    if (cand.pubDate > cur.pubDate) {
      return { publish: true, reason: "same version, later pub_date" };
    }
  }
  return { publish: false, reason: "same version, not a later build" };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "order-tags" && rest.length === 1) {
    for (const tag of orderCandidateTags(readJson(rest[0]))) {
      console.log(tag);
    }
    return 0;
  }
  if (command === "should-publish" && rest.length === 2) {
    let current = null;
    if (existsSync(rest[0])) {
      try {
        current = readJson(rest[0]);
      } catch {
        current = null;
      }
    }
    const { publish, reason } = decidePublish(current, readJson(rest[1]));
    console.log(`${publish ? "publish" : "skip"}: ${reason}`);
    return publish ? 0 : EXIT_SKIP;
  }
  console.error(
    "usage: updater-feed.mjs order-tags <releases.json>\n" +
      "       updater-feed.mjs should-publish <current.json> <candidate.json>",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
