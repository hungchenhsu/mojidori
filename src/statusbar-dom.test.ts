// Status bar DOM wiring against the real index.html shell. statusbar.ts
// looks its elements up at module load, so the shell is installed first and
// the module is imported fresh.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
  vi.resetModules();
});

describe("status bar cursor position", () => {
  it("is a button that names its Go to Line action, in the current locale", async () => {
    const { setLocale } = await import("./i18n");
    const { updateStatusBar } = await import("./statusbar");
    const cursor = document.querySelector<HTMLElement>("#status-cursor")!;
    expect(cursor.tagName).toBe("BUTTON");
    expect(cursor.classList.contains("status-action")).toBe(true);

    setLocale("en");
    updateStatusBar(null);
    expect(cursor.title).toBe("Go to Line…");
    setLocale("zh-TW");
    updateStatusBar(null);
    expect(cursor.title).toBe("跳至行號…");
    setLocale("en");
  });
});
