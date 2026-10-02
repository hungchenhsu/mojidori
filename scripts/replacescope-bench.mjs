#!/usr/bin/env node
// Informational CPU benchmark for scoped plain-string replacement (#337).
// Run with: node scripts/replacescope-bench.mjs
// Bundling and one warmup per case are outside the five measured runs.
// Reports UTF-16 units and UTF-8 bytes separately; this is not WebView UI
// acceptance and has no machine-dependent pass/fail timing threshold.

import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/replacescope.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
const { replaceAllInSelection } = await import(moduleUrl);
const cases = [
  ["ASCII", "The quick brown fox jumps over the lazy dog.\n", "missing needle"],
  ["Latin", "Café déjà vu naïve e\u0301 ﬁ.\n", "missing needle"],
  ["CJK", "這是一段測試中文與日本語のテスト。\n", "missing needle"],
  ["ASCII matches", "Record status=OK. ", "OK"],
];

for (const [name, unit, search] of cases) {
  const text = unit.repeat(Math.ceil(2_000_000 / unit.length)).slice(0, 2_000_000);
  const ranges = [{ from: 0, to: text.length }];
  for (const caseSensitive of [true, false]) {
    const query = { search, replace: "X", regexp: false, wholeWord: false, caseSensitive };
    replaceAllInSelection(text, ranges, query);
    const times = [];
    let matches = 0;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      const result = replaceAllInSelection(text, ranges, query);
      times.push(performance.now() - start);
      matches = result.edits.length;
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({
      name,
      caseSensitive,
      utf16Units: text.length,
      utf8Bytes: Buffer.byteLength(text),
      medianMs: Number(times[2].toFixed(2)),
      matches,
    }));
  }
}
