// dev/ui-harness.html (the browser-only visual review page, see
// docs/dev-setup.md) duplicates index.html's static shell so main.ts finds
// the same element ids. Pin the two together so a status-bar or layout
// change to index.html can't silently leave the harness reviewing stale UI.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function body(file: string): string {
  const html = readFileSync(resolve(process.cwd(), file), "utf8");
  const match = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!match) throw new Error(`${file} has no <body>`);
  return match[1].trim();
}

describe("dev/ui-harness.html", () => {
  it("keeps the same body markup as index.html", () => {
    expect(body("dev/ui-harness.html")).toBe(body("index.html"));
  });

  it("loads the IPC mock before main.ts", () => {
    const html = readFileSync(
      resolve(process.cwd(), "dev/ui-harness.html"),
      "utf8",
    );
    const mock = html.indexOf('src="/dev/mock-tauri.js"');
    const main = html.indexOf('src="/src/main.ts"');
    expect(mock).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(mock);
  });
});
