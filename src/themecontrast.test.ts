// WCAG contrast floor for the theme tokens that carry text (styles.css).
// Secondary/tertiary text (--fg-muted, --fg-faint) and status text
// (--danger, --warning) are used for real information — paths, scan
// errors, "No matches" — so each must clear AA (4.5:1) against every
// surface it appears on, and --fg-muted keeps a step above --fg-faint.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

function tokens(selector: string): Record<string, string> {
  return Object.fromEntries(
    [...block(selector).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
}

/** `--name: rgba(r, g, b, a)` composited over an opaque `#rrggbb`. */
function composite(selector: string, name: string, over: string): string {
  const m = new RegExp(`--${name}:\\s*rgba\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)\\)`).exec(
    block(selector),
  );
  if (!m) throw new Error(`missing --${name} in ${selector}`);
  const [r, g, b, a] = m.slice(1).map(Number);
  return (
    "#" +
    [r, g, b]
      .map((c, i) => {
        const base = parseInt(over.slice(1 + i * 2, 3 + i * 2), 16);
        return Math.round(a * c + (1 - a) * base)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
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
      // Status badges draw --warning text on a --warning-soft tint
      // (styles.css #status-warning etc.), so check the composite too.
      for (const bg of ["bg-base", "bg-surface", "bg-raised"]) {
        const tinted = composite(selector, "warning-soft", t[bg]);
        expect(
          contrast(t.warning, tinted),
          `${name} --warning on --warning-soft over --${bg} (${tinted})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t["fg-muted"], t["bg-base"])).toBeGreaterThanOrEqual(6.5);
      expect(
        contrast(t["fg-muted"], t["bg-base"]) / contrast(t["fg-faint"], t["bg-base"]),
      ).toBeGreaterThanOrEqual(1.3);
    });
  }
});
