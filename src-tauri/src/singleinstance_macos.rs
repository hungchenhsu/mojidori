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
//! This module fixes that by keying coordination off `std::env::temp_dir()`
//! (the per-user directory) instead of a hardcoded `/tmp`. No new
//! dependency — this is all `std`-only (`std::fs`'s `File::try_lock`,
//! stable since Rust 1.89; `std::os::unix::net`; `std::thread`).
//!
//! ## Design: a lock file decides primary/secondary, a socket only carries messages
//!
//! An earlier version of this module (PR #315's third and fourth review
//! rounds) used the coordination *socket itself* — `bind()` succeeding vs.
//! failing with `AddrInUse` — to decide who's primary, the same technique
//! `tauri-plugin-single-instance` uses. That has a structural problem no
//! amount of extra bookkeeping fixes: recovering a *stale* socket (left
//! behind by a process that crashed without unlinking it) requires
//! `unlink()` then `bind()` as two separate syscalls, and two launches
//! racing to do that recovery at the same time can both `unlink()` before
//! either `bind()`s — whoever's `bind()` loses gets `AddrInUse` right back,
//! with no way to tell "a live peer already won" apart from "I'm still
//! racing" from that error alone. PR #315's fourth round fixed the first
//! occurrence of this (bounded retry), and the fifth round found a second,
//! narrower recurrence in the same retry logic (a losing process could
//! still unlink a winner's already-live socket out from under it). Rather
//! than keep patching timing windows in hand-rolled socket-based mutual
//! exclusion, this version uses the OS's own advisory file lock
//! (`File::try_lock`, i.e. `flock(2)` under the hood on macOS) as the
//! single source of truth for who's primary:
//!
//! - `try_lock()` succeeding is unambiguous and atomic — there is no
//!   two-step "check, then act" for two processes to race inside.
//! - A lock is held per *open file description*: if the process that held
//!   it dies (crash or otherwise) without explicitly unlocking, the OS
//!   releases the lock the moment its file descriptors are closed at
//!   process exit. There is no such thing as a "stale" advisory lock the
//!   way there's a stale socket file — the next `try_lock()` on that path
//!   just succeeds, no unlink-and-retry dance needed at all.
//!
//! The socket is demoted to a pure message-passing channel: only the
//! *current lock holder* ever touches it (clearing any leftover file and
//! rebinding fresh, synchronously, in the same moment it wins the lock),
//! so the unlink/bind race is gone by construction rather than bounded
//! away. A process that loses the lock race connects to that socket to
//! forward its argv/cwd; since winning the lock and finishing the rebind
//! aren't quite the same instant, connecting retries a bounded number of
//! times with a short delay (see [`acquire_or_forward`]'s doc comment) to
//! ride out that brief window, rather than needing to be instantaneous.
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

use std::fs::{File, OpenOptions, TryLockError};
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

/// How many times [`connect_and_forward`] retries connecting to the
/// current lock holder's socket before giving up. Covers the brief window
/// between a process winning the lock and finishing its own bind — see
/// [`acquire_or_forward`]'s doc comment.
const SECONDARY_CONNECT_ATTEMPTS: u32 = 10;
/// Delay between [`connect_and_forward`] retries. Ten attempts at this
/// delay bound the total wait to half a second — long enough to ride out
/// scheduling jitter between winning the lock and finishing the bind,
/// short enough that a genuinely wedged primary doesn't visibly hang a
/// second launch.
const SECONDARY_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Set once this process becomes the primary instance, so
/// [`cleanup_if_primary`] only ever unlinks a socket this process itself
/// created — never a different (possibly still-live) instance's.
static IS_PRIMARY: AtomicBool = AtomicBool::new(false);

/// The result of trying to become (or find) the single instance.
#[derive(Debug)]
pub(crate) enum SingleInstanceOutcome {
    /// This process holds the single-instance lock and is the primary
    /// instance. Both fields must be kept alive for the lifetime of the
    /// process (`lib.rs` does this via `app.manage(lock)`): dropping
    /// `lock` releases the OS advisory lock immediately, which would let
    /// a later launch become primary too, defeating the whole point.
    Primary {
        /// The open, locked lock file. Never read from again after this
        /// point — its only remaining job is to stay open.
        lock: File,
        /// Bound and ready; pass it to [`spawn_accept_loop`] once an
        /// `AppHandle` is available to actually service connections.
        listener: UnixListener,
    },
    /// Another instance was already running and has been sent this
    /// process's argv/cwd; this process should exit immediately, exactly
    /// as it would have on the second-instance path through
    /// `tauri_plugin_single_instance` (Windows/Linux, `lib.rs`).
    ForwardedToRunning,
    /// Single-instance coordination could not be established, for a
    /// reason other than "another instance is genuinely running" (e.g. a
    /// permission error opening the lock file, or the socket couldn't be
    /// reached after retrying). Fail-open: the caller should continue
    /// starting up normally, simply without single-instance protection
    /// for this run, rather than block the user out of the app entirely
    /// over a coordination hiccup.
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

/// Companion to [`socket_path`], same per-user directory and naming
/// convention, `.lock` instead of `.sock`. See this module's doc comment
/// for why *this* file, not the socket, is what actually decides
/// primary-vs-secondary.
fn lock_path(identifier: &str) -> PathBuf {
    let sanitized = identifier.replace(['.', '-'], "_");
    std::env::temp_dir().join(format!("{sanitized}_si.lock"))
}

/// Try to become the primary instance; if one already exists, forward
/// this process's argv/cwd to it instead. Never calls `process::exit`
/// itself — that's the caller's job (`lib.rs`'s `run()`), which keeps
/// this function a plain, testable value-returning one.
///
/// Winning `try_lock()` on the lock file is unambiguous and atomic (see
/// this module's doc comment for why that's the whole design here): at
/// most one process can ever observe success for a given path, with no
/// two-step "check, then act" for two processes to race inside the way
/// the previous, socket-only design did. Having won it, this process is
/// free to unconditionally clear and rebind the socket — no other process
/// can be doing that at the same time, because any other process trying
/// right now is, by definition, still blocked on (or has already failed)
/// `try_lock()` instead.
///
/// A process that loses the lock race connects to the socket to forward
/// its argv/cwd instead. Winning the lock and finishing the socket rebind
/// aren't quite the same instant, so [`connect_and_forward`] retries a
/// bounded number of times with a short delay rather than needing the
/// winner to already be listening on the very first attempt.
pub(crate) fn acquire_or_forward(identifier: &str) -> SingleInstanceOutcome {
    let lock_file = match OpenOptions::new()
        .create(true)
        // The lock file's *contents* are never read or written — only its
        // existence and lock state matter — so explicitly not truncating
        // makes that intent clear rather than leaving it implicit.
        .truncate(false)
        .write(true)
        .open(lock_path(identifier))
    {
        Ok(f) => f,
        Err(e) => {
            return unavailable(&format!(
                "could not open the single-instance lock file: {e}"
            ))
        }
    };

    match lock_file.try_lock() {
        Ok(()) => {
            let socket = socket_path(identifier);
            // Safe to unconditionally clear: only the lock holder is ever
            // allowed to touch the socket, and we just established that's
            // us. `remove_file` failing (e.g. the path didn't exist) is
            // expected and fine — there was simply nothing to clear.
            let _ = std::fs::remove_file(&socket);
            match UnixListener::bind(&socket) {
                Ok(listener) => {
                    IS_PRIMARY.store(true, Ordering::SeqCst);
                    SingleInstanceOutcome::Primary {
                        lock: lock_file,
                        listener,
                    }
                }
                Err(e) => unavailable(&format!(
                    "won the single-instance lock but could not bind its socket: {e}"
                )),
            }
        }
        Err(TryLockError::WouldBlock) => match connect_and_forward(&socket_path(identifier)) {
            Ok(()) => SingleInstanceOutcome::ForwardedToRunning,
            Err(e) => unavailable(&format!(
                "lost the single-instance lock to another process but could not reach its \
                 socket after {SECONDARY_CONNECT_ATTEMPTS} attempts: {e}"
            )),
        },
        Err(TryLockError::Error(e)) => {
            unavailable(&format!("could not acquire the single-instance lock: {e}"))
        }
    }
}

/// Connect to the current lock holder's socket and forward this
/// process's argv/cwd, retrying with a short delay if the holder hasn't
/// finished its bind yet (see [`acquire_or_forward`]'s doc comment).
fn connect_and_forward(path: &std::path::Path) -> std::io::Result<()> {
    let mut last_err = None;
    for attempt in 0..SECONDARY_CONNECT_ATTEMPTS {
        match UnixStream::connect(path) {
            Ok(mut stream) => {
                forward_this_process(&mut stream);
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < SECONDARY_CONNECT_ATTEMPTS {
                    std::thread::sleep(SECONDARY_CONNECT_RETRY_DELAY);
                }
            }
        }
    }
    Err(last_err.expect("the loop above runs at least once since SECONDARY_CONNECT_ATTEMPTS > 0"))
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

    /// Validates the semantic assumption the whole design in this module's
    /// doc comment rests on: `File::try_lock` is held per *open file
    /// description*, so two genuinely independent `open()`s of the same
    /// path (standing in for two separate processes, since real processes
    /// can't share a `File` value) are mutually exclusive — one succeeds,
    /// the other observes `TryLockError::WouldBlock` — and releasing the
    /// first (dropping its `File`, standing in for that process exiting or
    /// crashing) lets the second immediately succeed where it previously
    /// couldn't. If this ever stopped holding on some future toolchain,
    /// every other test in this module would be building on sand.
    #[test]
    fn two_independent_opens_of_the_same_lock_file_are_mutually_exclusive() {
        let path = lock_path("com.mojidori.test.lock-semantics");
        let _ = std::fs::remove_file(&path);

        let open = || {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .unwrap()
        };

        let first = open();
        first
            .try_lock()
            .expect("the first open should lock cleanly");

        let second = open();
        assert!(
            matches!(second.try_lock(), Err(TryLockError::WouldBlock)),
            "a second, independent open of the same path must not also succeed while the \
             first is still held"
        );

        drop(first);
        assert!(
            second.try_lock().is_ok(),
            "releasing the first open (e.g. its process exiting) must free the lock for \
             the next contender immediately, with no stale-lock recovery needed"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Round-trips a real primary/secondary pair: the "secondary" (a
    /// second `acquire_or_forward` call against the same identifier,
    /// while the first's `Primary { lock, .. }` is still held) must
    /// observe `TryLockError::WouldBlock` on the lock and report
    /// `ForwardedToRunning`, having sent this test process's own argv/cwd,
    /// which the "primary" side (simulating one connection of
    /// `spawn_accept_loop`'s body, without needing a real `AppHandle`)
    /// must parse back out correctly.
    #[test]
    fn primary_secondary_round_trip_forwards_argv_and_cwd() {
        let identifier = "com.mojidori.test.roundtrip";
        let _ = std::fs::remove_file(lock_path(identifier));
        let _ = std::fs::remove_file(socket_path(identifier));

        let (lock, listener) = match acquire_or_forward(identifier) {
            SingleInstanceOutcome::Primary { lock, listener } => (lock, listener),
            _ => panic!("expected to become primary against a clean lock/socket path"),
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let accept_thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept should succeed");
            tx.send(read_forwarded_argv_cwd(stream)).unwrap();
        });

        let outcome = acquire_or_forward(identifier);
        assert!(
            matches!(outcome, SingleInstanceOutcome::ForwardedToRunning),
            "a second acquire while the first still holds the lock must forward and exit, \
             not also become primary"
        );

        let received = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("primary should receive the forwarded message promptly");
        accept_thread.join().unwrap();

        let (cwd, args) = received.expect("a well-formed forwarded message must parse");
        assert_eq!(cwd, std::env::current_dir().unwrap().to_string_lossy());
        assert_eq!(args, std::env::args().collect::<Vec<String>>());

        drop(lock); // release before cleanup, mirroring a normal process exit
        let _ = std::fs::remove_file(lock_path(identifier));
        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// A crashed primary's socket file (left behind because a crash skips
    /// `cleanup_if_primary`) must not stop the *lock's* next winner from
    /// getting a fresh, working listener — the lock's own release on
    /// process exit is what makes recovery possible at all here (unlike
    /// the previous, socket-only design, there's no unlink/rebind race to
    /// even consider: only the lock winner ever touches the socket, and
    /// this test's later `acquire_or_forward` call is that winner).
    #[test]
    fn recovers_a_stale_socket_left_by_a_crashed_primary_once_its_lock_is_free() {
        let identifier = "com.mojidori.test.stale-socket";
        let lock = lock_path(identifier);
        let socket = socket_path(identifier);
        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_file(&socket);

        // Simulate a crashed primary: hold the lock and bind the socket,
        // then drop both without running any cleanup — exactly what a
        // crash does. Dropping the lock file releases the OS advisory
        // lock immediately (this module's whole reason for existing);
        // dropping the listener does NOT remove the socket file, which is
        // the "stale leftover" this test is about.
        {
            let crashed_lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&lock)
                .unwrap();
            crashed_lock.try_lock().unwrap();
            let _crashed_listener = UnixListener::bind(&socket).unwrap();
            // both drop here, simulating the crash
        }
        assert!(
            socket.exists(),
            "dropping a UnixListener must not remove its socket file, or this test isn't \
             exercising the stale-socket path at all"
        );

        let (lock, _listener) = match acquire_or_forward(identifier) {
            SingleInstanceOutcome::Primary { lock, listener } => (lock, listener),
            other => panic!(
                "a free lock (crashed holder already exited) must let this process become \
                 primary with a fresh listener, got {other:?} instead"
            ),
        };

        drop(lock);
        let _ = std::fs::remove_file(lock_path(identifier));
        let _ = std::fs::remove_file(&socket);
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
