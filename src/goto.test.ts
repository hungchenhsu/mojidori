import { afterEach, describe, expect, it, vi } from "vitest";
import { goToHint, parseGoToInput, showGoToLine } from "./goto";

describe("parseGoToInput", () => {
  it("parses a bare line number, with no column (line-start, pre-existing behavior)", () => {
    expect(parseGoToInput("123")).toEqual({ line: 123, column: null });
  });

  it("parses line:column", () => {
    expect(parseGoToInput("123:45")).toEqual({ line: 123, column: 45 });
  });

  it("treats a trailing bare colon the same as no column at all", () => {
    expect(parseGoToInput("123:")).toEqual({ line: 123, column: null });
  });

  it("rejects a colon with no leading line", () => {
    expect(parseGoToInput(":45")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseGoToInput("")).toBeNull();
  });

  it("rejects whitespace-only input", () => {
    expect(parseGoToInput("   ")).toBeNull();
  });

  it("rejects non-numeric garbage", () => {
    expect(parseGoToInput("abc")).toBeNull();
  });

  it("rejects garbage mixed with digits", () => {
    expect(parseGoToInput("12a:45")).toBeNull();
    expect(parseGoToInput("12:4a")).toBeNull();
  });

  it("rejects a space between the colon and the column", () => {
    expect(parseGoToInput("123: 45")).toBeNull();
  });

  it("accepts a very large but still-finite line number, unclamped (the editor clamps it)", () => {
    expect(parseGoToInput("99999999999999")).toEqual({
      line: 99999999999999,
      column: null,
    });
  });

  it("rejects a line number so large it overflows to Infinity", () => {
    expect(parseGoToInput("9".repeat(400))).toBeNull();
  });

  it("rejects a column so large it overflows to Infinity", () => {
    expect(parseGoToInput(`12:${"9".repeat(400)}`)).toBeNull();
  });

  it("rejects a zero line", () => {
    expect(parseGoToInput("0")).toBeNull();
  });

  it("rejects a zero column", () => {
    expect(parseGoToInput("12:0")).toBeNull();
  });

  it("rejects a negative line", () => {
    expect(parseGoToInput("-5")).toBeNull();
  });

  it("rejects a negative column", () => {
    expect(parseGoToInput("12:-5")).toBeNull();
  });

  it("trims surrounding whitespace around an otherwise-valid input", () => {
    expect(parseGoToInput("  123:45  ")).toEqual({ line: 123, column: 45 });
  });
});

describe("Go to Line hint and invalid input", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("describes the current position, with the total when known", () => {
    expect(goToHint(undefined)).toBeNull();
    expect(goToHint({ currentLine: null, lineCount: 10 })).toBeNull();
    expect(goToHint({ currentLine: 12, lineCount: 340 })).toBe(
      "Current line 12 of 340. Type a line, or line:column.",
    );
    expect(goToHint({ currentLine: 12, lineCount: null })).toBe(
      "Current line 12. Type a line, or line:column.",
    );
  });

  it("keeps the panel open and explains an invalid entry", () => {
    const onGo = vi.fn();
    showGoToLine(onGo, { currentLine: 3, lineCount: 9 });
    const input = document.querySelector<HTMLInputElement>(".goto-panel input")!;
    const hint = document.querySelector<HTMLElement>(".goto-hint")!;
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.textContent).toBe("Current line 3 of 9. Type a line, or line:column.");

    input.value = "12x";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onGo).not.toHaveBeenCalled();
    expect(document.querySelector(".goto-overlay")).not.toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(hint.textContent).toBe("Enter a line number, or line:column (e.g. 120:4).");

    // Editing clears the error back to the position hint.
    input.value = "12";
    input.dispatchEvent(new Event("input"));
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(hint.textContent).toContain("Current line 3");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onGo).toHaveBeenCalledWith(12, null);
    expect(document.querySelector(".goto-overlay")).toBeNull();
  });

  it("still closes quietly on an empty Enter", () => {
    const onGo = vi.fn();
    showGoToLine(onGo);
    const input = document.querySelector<HTMLInputElement>(".goto-panel input")!;
    expect(document.querySelector<HTMLElement>(".goto-hint")!.hidden).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onGo).not.toHaveBeenCalled();
    expect(document.querySelector(".goto-overlay")).toBeNull();
  });
});
