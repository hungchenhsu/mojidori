// Issue #329: pressing Enter in the search panel moves CM6's real selection
// onto the current match, so `.cm-searchMatch.cm-searchMatch-selected` used
// to paint a fully opaque `backgroundColor: var(--accent)` over the match's
// own text. A real user on WKWebView reported the text becoming completely
// invisible under that block.
//
// Three fix attempts were superseded within this same PR after adversarial
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
//    value a different, less specific rule sets on that same element.
// 3. `backgroundColor: "transparent"` alone (correct, still true below),
//    but with no forced foreground — leaving whatever color the matched
//    text already had. A match landing inside syntax-highlighted text
//    (e.g. a comment) inherits that syntax color as-is, and this app's
//    syntax colors are not all guaranteed to contrast well against
//    `--bg-selection` (`--syn-comment` especially, a deliberately muted
//    color to begin with) — so the exact "current match is unreadable"
//    complaint could still occur for that content.
//
// The actual fix, both parts load-bearing:
//   - `backgroundColor: "transparent"` on the exact rule, explicit (not
//     omitted) so its higher specificity than `.cm-searchMatch` actually
//     cancels the inherited fill. Only `.cm-selectionBackground` is left
//     — the same single layer every ordinary text selection already uses.
//   - `color: var(--fg) !important` on a second, wider rule that also
//     targets any nested descendant, so it wins regardless of whether CM6
//     nests a partially-overlapping syntax-highlight decoration inside the
//     selected match or flattens it onto the same element. `--fg` was
//     picked over `--accent-fg` here specifically because it is verified
//     to contrast well (>=5.6:1) against the single `--bg-selection` layer
//     in all four themes, while `--accent-fg` (tuned for a fully opaque
//     `--accent`) does not.
//
// These are structural assertions on the plain spec object, not
// getComputedStyle probes: jsdom does not resolve `var()` at all, so a
// getComputedStyle-based check here would pass unconditionally no matter
// what the rule actually says — it would prove nothing about a regression
// back to an opaque background, a compounded translucent one, a silently
// inherited one, or a missing foreground guarantee. See CLAUDE.md's
// Definition of done and this fix's PR description for why that kind of
// test is explicitly out for #329.
import { describe, expect, it } from "vitest";
import { editorBaseThemeSpec } from "./editor-theme";

describe("editorBaseThemeSpec search-match rules (issue #329)", () => {
  const plainMatch = editorBaseThemeSpec[".cm-searchMatch"];
  const selectedMatch = editorBaseThemeSpec[".cm-searchMatch.cm-searchMatch-selected"];
  const selectedMatchAndDescendants =
    editorBaseThemeSpec[
      ".cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch.cm-searchMatch-selected *"
    ];

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

  it("uses a bolder outline than the plain match, as an independent distinguishing cue", () => {
    expect(selectedMatch.outline).toBe("2px solid var(--accent)");
    expect(selectedMatch.outline).not.toBe(plainMatch.outline);
  });

  it("forces the plain document foreground color, !important, on the match and any nested descendant", () => {
    // Guards against reverting to no forced foreground at all (fix attempt
    // 3 above) and against forcing a color not actually verified to
    // contrast against `--bg-selection` (e.g. `--accent-fg`, which this
    // fix deliberately rejected — see the file-level comment).
    expect(selectedMatchAndDescendants.color).toBe("var(--fg) !important");
  });

  it("the forced-color rule's selector reaches nested descendants, not just the match element itself", () => {
    // This is what makes the previous test's guarantee hold regardless of
    // how @codemirror/language and @codemirror/search happen to nest or
    // flatten a partially-overlapping syntax-highlight decoration inside a
    // selected match.
    expect(
      ".cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch.cm-searchMatch-selected *" in
        editorBaseThemeSpec,
    ).toBe(true);
  });
});
