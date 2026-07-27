// Test-only pin (issue #330): the frontend (`src/updaterErrors.ts`,
// `RELEASE_NOT_FOUND_ERROR_TEXT`) classifies an update-check failure as
// "no update info available" (as opposed to "network problem") by matching
// the *literal* `Display` string of `tauri_plugin_updater::Error::ReleaseNotFound`
// — the frontend never sees the Rust enum itself, only whatever string the
// `plugin:updater|check` command's `Err` serializes to (`Error`'s `Serialize`
// impl just calls `self.to_string()` — tauri-plugin-updater-2.10.1
// src/error.rs:96-103).
//
// `Cargo.toml` pins `tauri-plugin-updater = "2"` (no patch pin), so a
// routine `cargo update` could silently reword this message and desync it
// from the frontend's copy of the literal — this test is the only thing
// that would catch that drift; it has nothing to do with runtime behavior.
#[cfg(test)]
mod tests {
    // Kept in sync by hand with `RELEASE_NOT_FOUND_ERROR_TEXT` in
    // `src/updaterErrors.ts` — that constant's doc comment points back here.
    const RELEASE_NOT_FOUND_DISPLAY: &str = "Could not fetch a valid release JSON from the remote";

    #[test]
    fn release_not_found_display_matches_frontend_classifier_literal() {
        // tauri-plugin-updater-2.10.1 src/error.rs:24-26:
        //   /// Could not fetch a valid response from the server.
        //   #[error("Could not fetch a valid release JSON from the remote")]
        //   ReleaseNotFound,
        // The enum is `#[non_exhaustive]` (error.rs:10) but that only
        // restricts downstream *matching*, not constructing a field-less
        // variant — this direct construction is what proves the literal
        // below is still exactly what upstream emits today.
        let err = tauri_plugin_updater::Error::ReleaseNotFound;
        assert_eq!(err.to_string(), RELEASE_NOT_FOUND_DISPLAY);
    }
}
