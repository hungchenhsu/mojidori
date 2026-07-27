// Issue #329: pressing Enter in the search panel moves CM6's real selection
// onto the current match, so `.cm-searchMatch.cm-searchMatch-selected` used
// to paint a fully opaque `backgroundColor: var(--accent)` over the match's
// own text. A real user on WKWebView reported the text becoming completely
// invisible under that block. The fix swaps the opaque background for a
// translucent, dedicated `--bg-search-selected` token (see the rule's own
// comment in editor-theme.ts and the token's comment in styles.css) so the
// document's own text color always shows through, the same defensive
// pattern already used for `--bg-selection`.
//
// These are structural assertions on the plain spec object / the raw
// styles.css text, not getComputedStyle probes: jsdom does not resolve
// `var()` or evaluate `rgba()` alpha at all, so any getComputedStyle-based
// check here would pass unconditionally no matter what the rule actually
// says — it would prove nothing about a regression back to an opaque
// background. See CLAUDE.md's Definition of done and this fix's PR
// description for why that kind of test is explicitly out for #329.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editorBaseThemeSpec } from "./editor-theme";

// `import.meta.url` isn't a plain `file://` URL under Vitest (Vite serves
// test files through its own module graph), so it can't be turned back
// into a real filesystem path here — see replacescope.test.ts's
// `runReplaceAllInSelectionInChildProcess` for the same workaround.
// `process.cwd()` is reliable instead: `npm test`/`vitest run` (locally and
// in CI, see .github/workflows/ci.yml) are always invoked from the project
// root.
const stylesCssPath = join(process.cwd(), "src", "styles.css");

describe("editorBaseThemeSpec search-match rules (issue #329)", () => {
  const plainMatch = editorBaseThemeSpec[".cm-searchMatch"];
  const selectedMatch = editorBaseThemeSpec[".cm-searchMatch.cm-searchMatch-selected"];

  it("leaves the plain (non-selected) match untouched — out of scope for #329", () => {
    expect(plainMatch.backgroundColor).toBe("var(--accent-soft)");
    expect(plainMatch.outline).toBe("1px solid var(--accent)");
  });

  it("no longer uses the opaque --accent background that caused #329", () => {
    expect(selectedMatch.backgroundColor).not.toBe("var(--accent)");
  });

  it("references a CSS custom property token, not a literal color", () => {
    expect(selectedMatch.backgroundColor).toMatch(/^var\(--[a-z-]+\)$/);
  });

  it("uses a background token distinct from the plain match's, so it still reads as more prominent", () => {
    expect(selectedMatch.backgroundColor).not.toBe(plainMatch.backgroundColor);
  });

  it("does not force a foreground color — text keeps its own, already-legible color", () => {
    expect("color" in selectedMatch).toBe(false);
  });

  it("--bg-search-selected is translucent (0 < alpha < 1) in every built-in theme", () => {
    const token = selectedMatch.backgroundColor.match(/^var\((--[a-z-]+)\)$/)?.[1];
    expect(token).toBe("--bg-search-selected");

    const css = readFileSync(stylesCssPath, "utf8");
    const declarations = [...css.matchAll(new RegExp(`${token}:\\s*([^;]+);`, "g"))].map(
      (m) => m[1].trim(),
    );

    // :root (light default) + the @media (prefers-color-scheme: dark)
    // override + the four explicit html[data-theme="..."] blocks.
    expect(declarations.length).toBe(6);

    for (const value of declarations) {
      const alphaMatch = value.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)$/);
      expect(alphaMatch, `expected an rgba(...) value, got "${value}"`).not.toBeNull();
      const alpha = Number(alphaMatch![1]);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
    }
  });
});
