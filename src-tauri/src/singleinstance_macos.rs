// Copyright (c) Mojidori contributors.
// SPDX-License-Identifier: MIT

//! Custom macOS single-instance coordination, used instead of
//! `tauri-plugin-single-instance` on this one platform — see `lib.rs`'s
//! `run()` for the Windows/Linux path, which still uses that plugin as-is.
//!
//! ## Why not the plugin, on macOS (issue #305 follow-up review)
//!
//! The plugin's own `src/platform_impl/macos.rs` (confirmed against the
//! published 2.4.3 — the newest version on crates.io as of 2026-07-26 —
//! and against the unreleased `v2` branch tip on GitHub, which has no fix
//! either) hardcodes its coordination socket as:
//!
//! ```text
//! PathBuf::from(format!("/tmp/{}_si.sock", identifier))
//! ```
//!
//! `/tmp` on macOS is a single, machine-wide, sticky-bit directory shared
//! by every local account — not the per-user `$TMPDIR` that
//! `std::env::temp_dir()` resolves to (a private, mode-0700-ish
//! `/var/folders/.../T/` per login session, set by launchd). Because the
//! path depends only on the bundle identifier, with no per-user
//! component at all, any other local, unprivileged user on the same Mac
//! can:
//!
//! - pre-create and hold open a listening socket at that exact
//!   predictable path *before* the real app ever runs. The legitimate
//!   user's own launch then "successfully connects" to the attacker's
//!   fake listener, forwards its own argv/cwd to it, and exits — the
//!   legitimate launch silently produces no window at all. That is an
//!   unprivileged, machine-wide denial of service, not a narrow edge
//!   case.
//! - or, on a genuinely shared/fast-user-switched Mac with two real
//!   accounts both running Mojidori, have one account's launch connect
//!   to the *other* account's already-running instance (same fixed path,
//!   no per-user separation), silently forwarding a file-open request
//!   across a session boundary.
//!
//! This module fixes that by keying the socket off `std::env::temp_dir()`
//! (the per-user directory) instead, and otherwise reimplements only the
//! minimal subset of the plugin's behavior this app actually needs: bind
//! vs. forward-and-exit, one round of argv+cwd forwarding, bounded-retry
//! recovery from a stale socket (see [`acquire_or_forward`]'s doc comment
//! for why a single attempt isn't enough), and fail-open only once that's
//! genuinely exhausted or the failure is unrelated to the race. No new
//! dependency — this is all `std`-only (`std::os::unix::net`,
//! `std::thread`).
//!
//! ## Known limitation shared with the plugin-based approach
//!
//! LaunchServices can still hand a document-open request to a genuinely
//! new process via an 'odoc' Apple Event (`open -n -a Mojidori file.txt`)
//! rather than through argv. Since that new process calls
//! [`acquire_or_forward`] and exits (in `lib.rs`'s `run()`, before any
//! window or event loop is ever created) as soon as it finds an existing
//! instance, that Apple Event is never pumped and the open request is
//! silently lost — this hand-rolled version has no more ability to
//! intercept it than the plugin did. Narrow: ordinary Finder
//! double-click / plain `open` never spawns a second process at all (the
//! Apple Event goes straight to the sole running instance's
//! `RunEvent::Opened` handler in `lib.rs`), and `open -n --args /path`
//! forwards over argv like any other case, handled below. Fixing the
//! odoc case would need a custom AppKit delegate intercepting Apple
//! Events ahead of Tauri's own event loop setup — well beyond this fix's
//! scope, not attempted here.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Hard cap on a single forwarded message. Bounds the read in
/// [`read_forwarded_argv_cwd`] against a misbehaving or hostile peer —
/// nothing this app forwards (a cwd and a handful of file paths) should
/// ever approach this, so hitting the cap just means the message is
/// truncated/dropped, not that legitimate use is constrained.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Bound on how many times [`acquire_or_forward`] will retry after losing
/// a stale-socket recovery race (see that function's doc comment) before
/// giving up and failing open. Three is enough to absorb an ordinary race
/// between a couple of launches without risking a real, unbounded retry
/// loop if something is persistently wrong with the socket path.
const MAX_ACQUIRE_ATTEMPTS: u32 = 3;

/// Set once this process becomes the primary instance, so
/// [`cleanup_if_primary`] only ever unlinks a socket this process itself
/// created — never a different (possibly still-live) instance's.
static IS_PRIMARY: AtomicBool = AtomicBool::new(false);

/// The result of trying to become (or find) the single instance.
pub(crate) enum SingleInstanceOutcome {
    /// This process is the primary instance. The listener is bound and
    /// ready; pass it to [`spawn_accept_loop`] once an `AppHandle` is
    /// available to actually service incoming connections.
    Primary(UnixListener),
    /// Another instance was already running and has been sent this
    /// process's argv/cwd; this process should exit immediately, exactly
    /// as it would have on the second-instance path through
    /// `tauri_plugin_single_instance` (Windows/Linux, `lib.rs`).
    ForwardedToRunning,
    /// Single-instance coordination could not be established, for a
    /// reason other than "another instance is genuinely running" (e.g. a
    /// stale socket that couldn't be cleared, or a permission error).
    /// Fail-open: the caller should continue starting up normally, simply
    /// without single-instance protection for this run, rather than
    /// block the user out of the app entirely over a coordination hiccup.
    Unavailable,
}

/// Mirrors `tauri-plugin-single-instance`'s own naming convention
/// (`<identifier>_si.sock`) but under the per-user temp dir instead of a
/// hardcoded `/tmp` — see this module's doc comment for why.
///
/// `std::env::temp_dir()` reads `$TMPDIR` (falling back to `/tmp` only if
/// that's unset). On a normal macOS GUI/login session, launchd sets
/// `$TMPDIR` to a per-user, mode-0700-ish directory under
/// `/var/folders/...`, so this is private to the user by construction in
/// the common case. The residual case where `$TMPDIR` is unset (some
/// non-standard/manual launch context, e.g. a bare `ssh` shell with no
/// login session) falls back to the same machine-wide `/tmp` the plugin
/// always used unconditionally — no worse than upstream's status quo,
/// and not the common path for a GUI app.
fn socket_path(identifier: &str) -> PathBuf {
    let sanitized = identifier.replace(['.', '-'], "_");
    std::env::temp_dir().join(format!("{sanitized}_si.sock"))
}

/// One bind-or-connect attempt against `path`. Factored out of
/// [`acquire_or_forward`] so that function can retry it in a bounded loop
/// (see that function's doc comment for why a single attempt isn't
/// enough), and so a test can drive it directly to reconstruct a specific
/// race deterministically instead of relying on real thread timing.
enum AttemptOutcome {
    /// Bound and ready to become the primary instance.
    Primary(UnixListener),
    /// Connected to a live peer and forwarded this process's argv/cwd to
    /// it.
    Forwarded,
    /// The socket file existed but nothing was listening (a stale
    /// leftover). It's been unlinked; the caller should try again — the
    /// next attempt's `bind()` either wins outright, or (if another
    /// launch is racing the exact same recovery) sees `AddrInUse` again,
    /// in which case *that* attempt's `connect()` finds the winner
    /// actually listening by then and forwards to it instead.
    RetryAfterClearingStaleSocket,
    /// A failure unrelated to the stale-socket race (e.g. a permission
    /// error) — retrying won't help, the caller should fail open.
    Unavailable(String),
}

fn attempt(path: &std::path::Path) -> AttemptOutcome {
    match UnixListener::bind(path) {
        Ok(listener) => AttemptOutcome::Primary(listener),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Either a live instance is listening, or a stale socket file
            // was left behind (e.g. by a process that crashed instead of
            // running its `RunEvent::Exit` cleanup) — connecting is what
            // tells these two apart.
            match UnixStream::connect(path) {
                Ok(mut stream) => {
                    forward_this_process(&mut stream);
                    AttemptOutcome::Forwarded
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    let _ = std::fs::remove_file(path);
                    AttemptOutcome::RetryAfterClearingStaleSocket
                }
                Err(e) => AttemptOutcome::Unavailable(format!(
                    "could not connect to or safely replace an existing socket: {e}"
                )),
            }
        }
        Err(e) => {
            AttemptOutcome::Unavailable(format!("could not bind the single-instance socket: {e}"))
        }
    }
}

/// Try to become the primary instance; if one already exists, forward
/// this process's argv/cwd to it instead. Never calls `process::exit`
/// itself — that's the caller's job (`lib.rs`'s `run()`), which keeps
/// this function a plain, testable value-returning one.
///
/// Retries up to [`MAX_ACQUIRE_ATTEMPTS`] times when recovering a stale
/// socket, to cover a race between two launches doing that recovery at
/// the same time: both can observe the same stale socket, both unlink it,
/// but only one wins the immediate rebind — the loser's rebind sees
/// `AddrInUse` again. Failing open at that point (the original
/// implementation's bug, caught in PR #315's fourth review round) would
/// let the "loser" carry on starting up as a second fully-writing
/// instance — exactly the concurrent-write problem issue #305 exists to
/// prevent. Retrying instead lets the loser's very next attempt connect
/// to the winner (who is, by then, actually listening) and forward to it
/// like any ordinary second launch.
pub(crate) fn acquire_or_forward(identifier: &str) -> SingleInstanceOutcome {
    let path = socket_path(identifier);

    for remaining_attempts in (0..MAX_ACQUIRE_ATTEMPTS).rev() {
        match attempt(&path) {
            AttemptOutcome::Primary(listener) => return become_primary(listener),
            AttemptOutcome::Forwarded => return SingleInstanceOutcome::ForwardedToRunning,
            AttemptOutcome::RetryAfterClearingStaleSocket => {
                if remaining_attempts == 0 {
                    return unavailable(&format!(
                        "gave up after {MAX_ACQUIRE_ATTEMPTS} attempts racing other launches \
                         to recover the same stale socket"
                    ));
                }
                // Loop back and try again — see this function's doc
                // comment for what the next attempt resolves to.
            }
            AttemptOutcome::Unavailable(reason) => return unavailable(&reason),
        }
    }
    unreachable!("the loop above always returns on or before its last iteration")
}

fn become_primary(listener: UnixListener) -> SingleInstanceOutcome {
    IS_PRIMARY.store(true, Ordering::SeqCst);
    SingleInstanceOutcome::Primary(listener)
}

/// Fail-open: log and continue starting up normally rather than block the
/// user out of the app over a single-instance coordination hiccup.
fn unavailable(reason: &str) -> SingleInstanceOutcome {
    eprintln!(
        "singleinstance_macos: {reason} — continuing without single-instance protection this run"
    );
    SingleInstanceOutcome::Unavailable
}

/// Send this process's own argv/cwd to the primary instance. Wire format
/// matches `tauri-plugin-single-instance`'s own macOS implementation
/// (`cwd`, then `"\0\0"`, then NUL-joined argv) — no reason to invent a
/// different one. Best-effort: if the running instance goes away
/// mid-write there's nothing more useful to do than let this process exit
/// anyway, which the caller does immediately after this returns.
fn forward_this_process(stream: &mut UnixStream) {
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let args = std::env::args().collect::<Vec<String>>().join("\0");
    let _ = stream.write_all(cwd.as_bytes());
    let _ = stream.write_all(b"\0\0");
    let _ = stream.write_all(args.as_bytes());
}

/// Parse one forwarded message off an accepted connection. Returns
/// `None` on any I/O error, timeout, or malformed message — the caller
/// (the accept loop) just moves on to the next connection either way, the
/// same as a dropped/ignored packet would be.
fn read_forwarded_argv_cwd(stream: UnixStream) -> Option<(String, Vec<String>)> {
    // A slow or hostile peer must not be able to wedge the accept loop
    // open indefinitely.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    stream
        .take(MAX_MESSAGE_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (cwd, args) = text.split_once("\0\0")?;
    Some((
        cwd.to_string(),
        args.split('\0').map(String::from).collect(),
    ))
}

/// Spawn the background thread that services connections from later
/// launches, once an `AppHandle` is available (called from `lib.rs`'s
/// `.setup()`, after `acquire_or_forward` returned
/// [`SingleInstanceOutcome::Primary`] back in `run()`). Runs for the
/// lifetime of the process; not joined anywhere, same as the plugin's own
/// `tauri::async_runtime::spawn` accept loop never is.
pub(crate) fn spawn_accept_loop(app: tauri::AppHandle, listener: UnixListener) {
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    if let Some((cwd, args)) = read_forwarded_argv_cwd(stream) {
                        crate::handle_single_instance_launch(&app, args.into_iter(), &cwd);
                    }
                }
                Err(e) => {
                    eprintln!("singleinstance_macos: accept failed: {e}");
                }
            }
        }
    });
}

/// Best-effort socket cleanup on app exit (called from `lib.rs`'s
/// `RunEvent::Exit` handling). A no-op unless this process actually
/// became the primary instance — never unlinks a path some other,
/// possibly still-live, instance owns. Idempotent (safe to call more than
/// once): the `swap` only unlinks on the call that actually observes
/// `true`.
pub(crate) fn cleanup_if_primary(identifier: &str) {
    if IS_PRIMARY.swap(false, Ordering::SeqCst) {
        let _ = std::fs::remove_file(socket_path(identifier));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a real primary/secondary pair over an actual Unix
    /// socket: the "secondary" (a second `acquire_or_forward` call
    /// against the same identifier) must report `ForwardedToRunning` and
    /// have sent this test process's own argv/cwd, which the "primary"
    /// side (simulating one connection of `spawn_accept_loop`'s body,
    /// without needing a real `AppHandle`) must parse back out correctly.
    #[test]
    fn primary_secondary_round_trip_forwards_argv_and_cwd() {
        let identifier = "com.mojidori.test.roundtrip";
        let _ = std::fs::remove_file(socket_path(identifier));

        let listener = match acquire_or_forward(identifier) {
            SingleInstanceOutcome::Primary(listener) => listener,
            _ => panic!("expected to become primary against a clean socket path"),
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let accept_thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept should succeed");
            tx.send(read_forwarded_argv_cwd(stream)).unwrap();
        });

        let outcome = acquire_or_forward(identifier);
        assert!(
            matches!(outcome, SingleInstanceOutcome::ForwardedToRunning),
            "a second acquire against a bound primary must forward and exit, not rebind"
        );

        let received = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("primary should receive the forwarded message promptly");
        accept_thread.join().unwrap();

        let (cwd, args) = received.expect("a well-formed forwarded message must parse");
        assert_eq!(cwd, std::env::current_dir().unwrap().to_string_lossy());
        assert_eq!(args, std::env::args().collect::<Vec<String>>());

        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// A socket file left behind by a process that never reached
    /// `cleanup_if_primary` (e.g. it crashed) must be recovered from —
    /// not mistaken for a live instance, and not given up on as
    /// `Unavailable`.
    #[test]
    fn recovers_from_a_stale_socket_left_by_a_crashed_process() {
        let identifier = "com.mojidori.test.stale";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);

        // Simulate a crash: bind, then drop without unlinking. The
        // socket *file* stays on disk even though nothing is listening.
        drop(UnixListener::bind(&path).unwrap());
        assert!(
            path.exists(),
            "dropping a UnixListener must not remove its socket file, \
             or this test isn't exercising the stale-socket path at all"
        );

        let outcome = acquire_or_forward(identifier);
        assert!(
            matches!(outcome, SingleInstanceOutcome::Primary(_)),
            "a stale socket (file exists, nothing listening) must be recovered from"
        );

        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// Regression test for PR #315's fourth review round: two launches
    /// racing to recover the *same* stale socket, where this process
    /// loses the rebind, must retry and connect to the winner — not fail
    /// open as a second, fully-writing "Unavailable" instance (exactly
    /// the concurrent-write problem issue #305 exists to prevent).
    ///
    /// Reconstructs the race deterministically via `attempt()` (the
    /// per-iteration helper `acquire_or_forward` retries) instead of
    /// relying on real thread-timing luck to land two `acquire_or_forward`
    /// calls in the narrow unlink-then-rebind window:
    ///
    /// 1. A stale socket exists (crash leftover), as in the test above.
    /// 2. This process's first `attempt()` observes it, confirms nothing
    ///    is listening, unlinks it, and reports
    ///    `RetryAfterClearingStaleSocket` — exactly like the plain
    ///    stale-socket case so far.
    /// 3. Before this process's *retry*, another launch wins: bind the
    ///    now-clear path directly, standing in for a racing process that
    ///    completed its own recovery first.
    /// 4. This process's retry attempt must now see `AddrInUse` again
    ///    (the winner from step 3) and connect to it, reporting
    ///    `Forwarded` — not `Unavailable`.
    #[test]
    fn retries_after_losing_a_stale_socket_recovery_race_instead_of_failing_open() {
        let identifier = "com.mojidori.test.stale-race";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);

        // Step 1: crash leftover, same as the plain stale-socket test.
        drop(UnixListener::bind(&path).unwrap());

        // Step 2: this process's first attempt clears the stale socket
        // and asks to be retried.
        assert!(
            matches!(
                attempt(&path),
                AttemptOutcome::RetryAfterClearingStaleSocket
            ),
            "the first attempt against a stale socket must clear it and ask to retry"
        );
        assert!(
            !path.exists(),
            "the stale socket must actually be unlinked before the race window below"
        );

        // Step 3: another launch wins the race in the window between this
        // process's unlink and its retry — it binds the now-clear path
        // and becomes the (simulated) live primary.
        let winner = UnixListener::bind(&path).expect("the racing winner should bind cleanly");
        let accept_thread = std::thread::spawn(move || winner.accept());

        // Step 4: this process's retry must see AddrInUse (the winner)
        // and connect to it instead of giving up.
        let outcome = attempt(&path);
        assert!(
            matches!(outcome, AttemptOutcome::Forwarded),
            "losing the rebind race must fall through to connecting to the winner \
             and forwarding, not report Unavailable"
        );

        accept_thread
            .join()
            .unwrap()
            .expect("the winner should have accepted this process's forwarded connection");

        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// A peer sending far more than `MAX_MESSAGE_BYTES` must not make the
    /// primary side read unboundedly — reaching the assertions below at
    /// all (instead of the test hanging) is most of the proof; the size
    /// check documents the expected shape of whatever *is* parsed.
    #[test]
    fn oversized_forwarded_message_is_bounded_not_unbounded_read() {
        let identifier = "com.mojidori.test.oversize";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let accept_thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept should succeed");
            read_forwarded_argv_cwd(stream)
        });

        let mut stream = UnixStream::connect(&path).unwrap();
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let oversized = vec![b'a'; MAX_MESSAGE_BYTES * 4];
        // Ignored on purpose: once the reader's `.take(cap)` is satisfied
        // and the primary side drops the stream, this write can legally
        // fail with a broken pipe / connection reset — that failure is
        // itself evidence the read didn't keep draining unboundedly.
        let _ = stream.write_all(&oversized);
        drop(stream);

        let result = accept_thread
            .join()
            .expect("accept thread must finish promptly, proving the read was bounded");
        if let Some((_, args)) = &result {
            let total: usize = args.iter().map(String::len).sum();
            assert!(
                total <= MAX_MESSAGE_BYTES,
                "must never parse more than the cap's worth of data"
            );
        }

        let _ = std::fs::remove_file(socket_path(identifier));
    }
}
