import { describe, expect, it } from "vitest";

import { classifyUpdateCheckError } from "./updaterErrors";

describe("classifyUpdateCheckError", () => {
  it("classifies the exact ReleaseNotFound Display string as releaseNotFound (issue #330: draft/unpublished release, 404)", () => {
    // Literal from tauri-plugin-updater-2.10.1 src/error.rs:24-26 — pinned
    // Rust-side by src-tauri/src/updater_errors.rs.
    expect(classifyUpdateCheckError("Could not fetch a valid release JSON from the remote")).toBe(
      "releaseNotFound",
    );
  });

  it("classifies a ReleaseNotFound string with extra wrapping as releaseNotFound (substring match, not exact-equality)", () => {
    expect(
      classifyUpdateCheckError(
        "Error: Could not fetch a valid release JSON from the remote (some wrapper)",
      ),
    ).toBe("releaseNotFound");
  });

  it("classifies reqwest-shaped transport errors as network", () => {
    expect(
      classifyUpdateCheckError("error sending request for url (https://example.com/latest.json)"),
    ).toBe("network");
    expect(classifyUpdateCheckError("builder error")).toBe("network");
    expect(classifyUpdateCheckError("request or response body error")).toBe("network");
  });

  it("classifies a reqwest Decode error (malformed release JSON body) as other, not network (issue #345)", () => {
    // Exact production shape: a successful HTTP response whose body is
    // syntactically invalid JSON makes updater.rs's `res.json().await?`
    // fail with reqwest Kind::Decode, whose Display is
    // "error decoding response body" plus the url suffix
    // (reqwest-0.13.4 src/error.rs:242,279-281 and
    // src/async_impl/response.rs:269-273). Telling the user to check
    // their connection here misdiagnoses a feed-content problem.
    expect(
      classifyUpdateCheckError(
        "error decoding response body for url (https://github.com/hungchenhsu/mojidori/releases/latest/download/latest.json)",
      ),
    ).toBe("other");
    expect(classifyUpdateCheckError("error decoding response body")).toBe("other");
  });

  it("classifies an io::Error-shaped OS error as network", () => {
    expect(classifyUpdateCheckError("Connection refused (os error 61)")).toBe("network");
  });

  it("classifies an unrecognized error (e.g. a parse/semver error) as other", () => {
    expect(classifyUpdateCheckError("missing field `version` at line 1 column 42")).toBe("other");
  });

  it("classifies a plain Error instance by its message, same as the raw string", () => {
    expect(
      classifyUpdateCheckError(new Error("Could not fetch a valid release JSON from the remote")),
    ).toBe("releaseNotFound");
    expect(classifyUpdateCheckError(new Error("error sending request"))).toBe("network");
    expect(classifyUpdateCheckError(new Error("something else entirely"))).toBe("other");
  });

  it("never throws on non-string, non-Error input", () => {
    expect(classifyUpdateCheckError(undefined)).toBe("other");
    expect(classifyUpdateCheckError(null)).toBe("other");
    expect(classifyUpdateCheckError(42)).toBe("other");
  });
});
