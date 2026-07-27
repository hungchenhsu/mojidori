// Issue #329: pressing Enter in the search panel moves CM6's real selection
// onto the current match, so `.cm-searchMatch.cm-searchMatch-selected` used
// to paint a fully opaque `backgroundColor: var(--accent)` over the match's
// own text. A real user on WKWebView reported the text becoming completely
// invisible under that block.
//
// Two fix attempts were superseded within this same PR after adversarial
// review before landing on the current one:
//
// 1. A second translucent background layer of its own. Worse, not better:
//    because `.cm-searchMatch-selected` and `.cm-selectionBackground`
//    always paint the same range at once (@codemirror/search only adds the
//    "-selected" class when the range exactly matches an actual selection
//    range — see the comment on this rule in editor-theme.ts), stacking a
//    second same-hue translucent layer on top compounds to a much higher
//    effective opacity than either layer alone, tanking contrast for muted
//    syntax colors (e.g. `--syn-comment`) even worse than the original
//    opaque background did.
// 2. Simply omitting `backgroundColor` from this rule, intending to rely
//    only on `.cm-selectionBackground`. Still wrong: CM6 renders a selected
//    match with *both* `cm-searchMatch` and `cm-searchMatch-selected` on
//    the same span, so the plain `.cm-searchMatch` rule's own
//    `backgroundColor: var(--accent-soft)` still cascades onto the same
//    element — an unset property on a more specific rule does not cancel a
//    value a different, less specific rule sets on that same element. That
//    silently left a second (smaller, but real) layer on top of
//    `.cm-selectionBackground` again.
//
// The actual fix: `backgroundColor: "transparent"` explicitly, so this
// rule's higher specificity (two classes vs. `.cm-searchMatch`'s one) wins
// and cancels the inherited fill outright. The only background the
// selected match ends up with is `.cm-selectionBackground`'s existing,
// already-shipped fill — the exact one every ordinary text selection
// already uses — plus a bolder outline as an independent "this one is
// current" cue.
//
// These are structural assertions on the plain spec object, not
// getComputedStyle probes: jsdom does not resolve `var()` at all, so a
// getComputedStyle-based check here would pass unconditionally no matter
// what the rule actually says — it would prove nothing about a regression
// back to an opaque (or compounded-translucent, or silently-inherited)
// background. See CLAUDE.md's Definition of done and this fix's PR
// description for why that kind of test is explicitly out for #329.
import { describe, expect, it } from "vitest";
import { editorBaseThemeSpec } from "./editor-theme";

describe("editorBaseThemeSpec search-match rules (issue #329)", () => {
  const plainMatch = editorBaseThemeSpec[".cm-searchMatch"];
  const selectedMatch = editorBaseThemeSpec[".cm-searchMatch.cm-searchMatch-selected"];

  it("leaves the plain (non-selected) match untouched — out of scope for #329", () => {
    expect(plainMatch.backgroundColor).toBe("var(--accent-soft)");
    expect(plainMatch.outline).toBe("1px solid var(--accent)");
  });

  it("explicitly cancels the plain match's inherited background, rather than merely omitting its own", () => {
    // A selected match's DOM element carries *both* `cm-searchMatch` and
    // `cm-searchMatch-selected` classes at once, so the plain match rule
    // above still applies to it too — leaving this key out would silently
    // inherit `var(--accent-soft)` back in (see the file-level comment).
    // Only an explicit override, on a rule strictly more specific than
    // `.cm-searchMatch`, actually cancels it.
    expect(selectedMatch.backgroundColor).toBe("transparent");
    expect(selectedMatch.backgroundColor).not.toBe(plainMatch.backgroundColor);
  });

  it("does not force a foreground color — text keeps its own, already-legible color", () => {
    expect("color" in selectedMatch).toBe(false);
  });

  it("uses a bolder outline than the plain match, as the sole distinguishing cue", () => {
    expect(selectedMatch.outline).toBe("2px solid var(--accent)");
    expect(selectedMatch.outline).not.toBe(plainMatch.outline);
  });
});
