// Issue #329: pressing Enter in the search panel moves CM6's real selection
// onto the current match, so `.cm-searchMatch.cm-searchMatch-selected` used
// to paint a fully opaque `backgroundColor: var(--accent)` over the match's
// own text. A real user on WKWebView reported the text becoming completely
// invisible under that block.
//
// The first fix attempted here (superseded within this same PR after
// adversarial review) added a second translucent background layer of its
// own. That turned out to be worse, not better: because
// `.cm-searchMatch-selected` and `.cm-selectionBackground` always paint the
// same range at once (@codemirror/search only adds the "-selected" class
// when the range exactly matches an actual selection range — see the
// comment on this rule in editor-theme.ts), stacking a second same-hue
// translucent layer on top compounds to a much higher effective opacity
// than either layer alone, which tanks contrast for muted syntax colors
// (e.g. `--syn-comment`) even worse than the original opaque background did.
//
// The actual fix: this rule adds no background of its own at all. It
// relies entirely on `.cm-selectionBackground`'s existing, already-shipped
// fill — the exact one every ordinary text selection already uses — and
// only adds a bolder outline as an independent "this one is current" cue.
//
// These are structural assertions on the plain spec object, not
// getComputedStyle probes: jsdom does not resolve `var()` at all, so a
// getComputedStyle-based check here would pass unconditionally no matter
// what the rule actually says — it would prove nothing about a regression
// back to an opaque (or compounded-translucent) background. See CLAUDE.md's
// Definition of done and this fix's PR description for why that kind of
// test is explicitly out for #329.
import { describe, expect, it } from "vitest";
import { editorBaseThemeSpec } from "./editor-theme";

describe("editorBaseThemeSpec search-match rules (issue #329)", () => {
  const plainMatch = editorBaseThemeSpec[".cm-searchMatch"];
  const selectedMatch = editorBaseThemeSpec[".cm-searchMatch.cm-searchMatch-selected"];

  it("leaves the plain (non-selected) match untouched — out of scope for #329", () => {
    expect(plainMatch.backgroundColor).toBe("var(--accent-soft)");
    expect(plainMatch.outline).toBe("1px solid var(--accent)");
  });

  it("no longer sets any background of its own on the selected match", () => {
    // The opaque `var(--accent)` background that caused #329, and any
    // translucent replacement for it, are both regression risks: whatever
    // value this key might hold, painting *any* second layer on top of the
    // always-simultaneous `.cm-selectionBackground` risks the same class of
    // contrast bug (see the file-level comment above and the rule's own
    // comment in editor-theme.ts).
    expect("backgroundColor" in selectedMatch).toBe(false);
  });

  it("does not force a foreground color — text keeps its own, already-legible color", () => {
    expect("color" in selectedMatch).toBe(false);
  });

  it("uses a bolder outline than the plain match, as the sole distinguishing cue", () => {
    expect(selectedMatch.outline).toBe("2px solid var(--accent)");
    expect(selectedMatch.outline).not.toBe(plainMatch.outline);
  });
});
