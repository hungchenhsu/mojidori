// Classifies an update-check failure so updater.ts can show an accurate
// dialog instead of always blaming the network (issue #330: a draft,
// unpublished release leaves `updater-json.yml`'s feed 404ing, and the
// previous single "check failed, check your connection" message misread
// that as a connectivity problem).
//
// `updater.ts` calls `plugin:updater|check` directly via raw `invoke` (see
// its own module doc comment — no `@tauri-apps/plugin-updater` guest
// bindings involved), so a failed check rejects with whatever
// `tauri_plugin_updater::Error`'s `Serialize` impl produces — just
// `self.to_string()` (tauri-plugin-updater-2.10.1 src/error.rs:96-103).
// The frontend therefore only ever sees a plain string, never the Rust
// enum itself; this module classifies purely by matching substrings of
// that string. It intentionally does not try to further split "the feed
// doesn't exist" (404) from other non-2xx statuses (403, 500, …) — see
// `RELEASE_NOT_FOUND_ERROR_TEXT` below for why that split isn't
// constructible from this string at all.
export type UpdateCheckErrorClass = "network" | "releaseNotFound" | "other";

/**
 * Exact `Display` text of `tauri_plugin_updater::Error::ReleaseNotFound`
 * (tauri-plugin-updater-2.10.1 src/error.rs:24-26:
 * `#[error("Could not fetch a valid release JSON from the remote")]`).
 *
 * `Updater::check` (src/updater.rs:483-528) only ever records a
 * `last_error` for a transport-level failure (line 514-517,
 * `Err(err) => last_error = Some(err.into())`) or a malformed JSON *body*
 * (line 503-506, deserializing into `RemoteRelease`) — a non-success HTTP
 * status is only logged, never recorded as `last_error` (line 508-512).
 * So once every configured endpoint has been tried without a successful
 * parse, it's line 528 (`remote_release.ok_or(Error::ReleaseNotFound)`)
 * that actually fires — identically for a 404 (unpublished release, this
 * issue's trigger), a 403, or a 500. There is no way to tell those apart
 * from this string alone.
 *
 * Pinned against the real upstream string by
 * `src-tauri/src/updater_errors.rs`'s
 * `release_not_found_display_matches_frontend_classifier_literal` test —
 * that test is the only thing that would catch upstream rewording this on
 * a routine `cargo update` (`src-tauri/Cargo.toml` pins
 * `tauri-plugin-updater = "2"`, no patch pin).
 */
const RELEASE_NOT_FOUND_ERROR_TEXT = "Could not fetch a valid release JSON from the remote";

/**
 * Literal prefixes `reqwest::Error`'s `Display` impl always emits,
 * regardless of the underlying cause (DNS failure, connection refused,
 * TLS handshake, timeout, redirect loop, malformed body bytes…) — see
 * reqwest-0.13.4 src/error.rs:236-280 (the reqwest version
 * tauri-plugin-updater 2.10.1 actually pins, per src-tauri/Cargo.lock).
 * `tauri_plugin_updater::Error::Reqwest` and `Error::Io` are both
 * `#[error(transparent)]` (error.rs:16-17, 39-41), so any transport-layer
 * failure `Updater::check` hits (updater.rs:514-517) comes through as one
 * of these. reqwest's `Display` deliberately never writes its `source()`
 * chain (error.rs:236-280 never touches `self.inner.source`), so the
 * underlying OS/DNS text is never part of the string — matching these
 * fixed prefixes is exhaustive for this crate's pinned reqwest version,
 * not a guess at arbitrary OS error text.
 */
const NETWORK_ERROR_MARKERS = [
  "error sending request", // reqwest Kind::Request — connect/DNS/timeout
  "builder error", // reqwest Kind::Builder
  "request or response body error", // reqwest Kind::Body
  "error decoding response body", // reqwest Kind::Decode
  "error following redirect", // reqwest Kind::Redirect
  "error upgrading connection", // reqwest Kind::Upgrade
  "(os error ", // std::io::Error's OS-error Display suffix (Error::Io)
] as const;

/** Extracts the text to classify from whatever the rejection actually is:
 *  a plain string in production (see this module's doc comment above),
 *  but tests — and any future misbehaving plugin/mock — may hand this an
 *  `Error` instance or something else entirely. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyUpdateCheckError(error: unknown): UpdateCheckErrorClass {
  const text = errorText(error);
  if (text.includes(RELEASE_NOT_FOUND_ERROR_TEXT)) return "releaseNotFound";
  if (NETWORK_ERROR_MARKERS.some((marker) => text.includes(marker))) return "network";
  return "other";
}
