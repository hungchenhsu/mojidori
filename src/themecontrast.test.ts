// WCAG contrast floor for the theme tokens that carry text (styles.css).
// Secondary/tertiary text (--fg-muted, --fg-faint) and status text
// (--danger, --warning) are used for real information — paths, scan
// errors, "No matches" — so each must clear AA (4.5:1) against every
// surface it appears on, and --fg-muted keeps a step above --fg-faint.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: Record<string, string> = {
  "default (light)": "\n:root {",
  "default (OS dark)": "@media (prefers-color-scheme: dark) {\n  :root {",
  light: 'html[data-theme="light"],',
  dark: 'html[data-theme="dark"],',
  paper: 'html[data-theme="paper"],',
  dusk: 'html[data-theme="dusk"],',
};

describe("theme text contrast", () => {
  it("computes WCAG ratios correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const [name, selector] of Object.entries(THEMES)) {
    it(`${name}: text tokens clear AA on every surface`, () => {
      const t = tokens(selector);
      for (const fg of ["fg", "fg-muted", "fg-faint", "danger", "warning"]) {
        for (const bg of ["bg-base", "bg-surface", "bg-raised"]) {
          expect(
            contrast(t[fg], t[bg]),
            `${name} --${fg} ${t[fg]} on --${bg} ${t[bg]}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(t["fg-muted"], t["bg-base"])).toBeGreaterThanOrEqual(6.5);
      expect(
        contrast(t["fg-muted"], t["bg-base"]) / contrast(t["fg-faint"], t["bg-base"]),
      ).toBeGreaterThanOrEqual(1.3);
    });
  }
});
