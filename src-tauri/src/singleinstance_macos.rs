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

/// Hard cap on a single forwarded message (the 8-byte length-prefix
/// framing in [`read_forwarded_argv_cwd`]/[`build_forward_payload_from`]
/// means this can be generous without any truncation risk — see those
/// functions' doc comments — so it's sized for "someone opened an
/// enormous number of files at once", not "the absolute minimum a cwd and
/// a couple of paths need").
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// How many times [`connect_and_forward`] retries connecting to the
/// current lock holder's socket before giving up on *this* round — see
/// [`acquire_or_forward`]'s doc comment for what "this round" means.
/// Covers the brief window between a process winning the lock and
/// finishing its own bind.
const SECONDARY_CONNECT_ATTEMPTS: u32 = 10;
/// Delay between [`connect_and_forward`] retries within a round. Ten
/// attempts at this delay bound one round's connect attempts to half a
/// second — long enough to ride out scheduling jitter between winning the
/// lock and finishing the bind, short enough that a genuinely wedged
/// primary doesn't visibly hang a second launch for long before
/// [`acquire_or_forward`] tries the lock itself again.
const SECONDARY_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);

/// How many times [`acquire_or_forward`] retries the *lock itself* after a
/// round's connect attempts are exhausted (see that function's doc
/// comment for the exit-race this covers) before giving up and failing
/// open. Four rounds, each preceded (after the first) by a growing delay,
/// is enough to ride out an ordinary process-exit teardown without
/// visibly hanging a launch for long if something is genuinely wedged.
const LOCK_RETRY_ROUNDS: u32 = 4;
/// Delay before the second round; doubles each round after that (so:
/// 100ms, 200ms, 400ms between the four rounds) — see
/// [`acquire_or_forward`]'s doc comment.
const LOCK_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(100);

/// A successful `write_all` only proves the bytes reached the OS socket
/// buffer, not that the primary ever read, parsed, or acted on them — if
/// the primary is mid-exit right when it accepts the connection, the
/// kernel can tear down that accepted-but-unread connection (and whatever
/// was buffered in it) along with the rest of the dying process's file
/// descriptors, and the secondary's `write_all` may already have returned
/// `Ok` before that happens. [`send_and_await_ack`] treats the message as
/// delivered only once the primary writes this single byte back, which it
/// only does after [`spawn_accept_loop`] has finished calling
/// `handle_single_instance_launch` — i.e. after the request has actually
/// been processed, not merely received into a buffer (caught in PR #315's
/// seventh review round).
const ACK_BYTE: u8 = 1;
/// How long [`send_and_await_ack`] waits for that byte before giving up.
/// Generous relative to how fast `handle_single_instance_launch` actually
/// runs (focusing a window and pushing onto an in-memory queue — no disk
/// I/O), so this essentially never fires unless the primary is genuinely
/// gone or wedged.
const ACK_TIMEOUT: Duration = Duration::from_secs(2);

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
/// bounded number of times with a short delay within one "round" rather
/// than needing the winner to already be listening on the very first
/// attempt.
///
/// Retries the whole round (lock *and* connect) up to [`LOCK_RETRY_ROUNDS`]
/// times, growing the delay between rounds. This covers a second exit
/// race, caught in PR #315's sixth review round: `cleanup_if_primary`
/// unlinks the socket *before* the process holding it actually terminates
/// (which is what releases the lock) — a launch landing in that narrow
/// window would see the lock as held (`WouldBlock`) but find no socket to
/// connect to at all, and every one of [`connect_and_forward`]'s retries
/// would fail for that reason alone, not because the winner is merely
/// slow to bind. Treating that as permanent and failing open immediately
/// would be worse than the bug this whole module exists to fix: this
/// process would carry on as a second, *permanently unprotected* instance
/// even after the old one fully exits and its lock frees up — nothing
/// would ever try to reacquire it. Looping back to `try_lock()` again
/// instead means the very next round succeeds as soon as the old process
/// actually finishes exiting, which (being an ordinary process exit, not
/// a wedged one) should happen well within a few hundred milliseconds.
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

    let socket = socket_path(identifier);
    let mut retry_delay = LOCK_RETRY_INITIAL_DELAY;

    for round in 0..LOCK_RETRY_ROUNDS {
        match lock_file.try_lock() {
            Ok(()) => {
                // Safe to unconditionally clear: only the lock holder is
                // ever allowed to touch the socket, and we just
                // established that's us. `remove_file` failing (e.g. the
                // path didn't exist) is expected and fine — there was
                // simply nothing to clear.
                let _ = std::fs::remove_file(&socket);
                return match UnixListener::bind(&socket) {
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
                };
            }
            Err(TryLockError::WouldBlock) => {
                let Some(payload) = build_this_process_forward_payload() else {
                    // Too large to send safely (see
                    // `build_forward_payload_from`'s doc comment) — no
                    // amount of retrying changes that, so fail open right
                    // away rather than looping pointlessly.
                    return unavailable(&format!(
                        "this process's argv/cwd is too large to forward safely (over \
                         {MAX_MESSAGE_BYTES} bytes)"
                    ));
                };
                match connect_and_forward(&socket, &payload) {
                    Ok(()) => return SingleInstanceOutcome::ForwardedToRunning,
                    Err(e) => {
                        if round + 1 == LOCK_RETRY_ROUNDS {
                            return unavailable(&format!(
                                "the single-instance lock is held but its socket was \
                                 unreachable after {LOCK_RETRY_ROUNDS} rounds (last error: {e})"
                            ));
                        }
                        std::thread::sleep(retry_delay);
                        retry_delay *= 2;
                    }
                }
            }
            Err(TryLockError::Error(e)) => {
                return unavailable(&format!("could not acquire the single-instance lock: {e}"));
            }
        }
    }
    unreachable!("the loop above always returns on or before its last round")
}

/// Connect to the current lock holder's socket and forward `payload`
/// (built by [`build_forward_payload_from`]), retrying with a short delay
/// if the holder hasn't finished its bind yet (see
/// [`acquire_or_forward`]'s doc comment). Success requires the peer's ACK
/// (see [`send_and_await_ack`]), not just a successful write — a write
/// failure partway through, or no ACK within [`ACK_TIMEOUT`], are both
/// treated the same as a connect failure — worth retrying (either another
/// connection here, or eventually the lock itself again back in
/// `acquire_or_forward`) — rather than silently swallowed as the
/// previous, best-effort version of this function did.
fn connect_and_forward(path: &std::path::Path, payload: &[u8]) -> std::io::Result<()> {
    let mut last_err = None;
    for attempt in 0..SECONDARY_CONNECT_ATTEMPTS {
        match UnixStream::connect(path)
            .and_then(|mut stream| send_and_await_ack(&mut stream, payload))
        {
            Ok(()) => return Ok(()),
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

/// Builds the wire payload (`cwd`, then `"\0\0"`, then NUL-joined `args`
/// — matching `tauri-plugin-single-instance`'s own macOS implementation,
/// no reason to invent a different inner format) from explicit values, so
/// it's testable without depending on this test process's own real
/// `std::env::args()`/`current_dir()`. `None` means the payload would
/// exceed `MAX_MESSAGE_BYTES`: PR #315's sixth review round found that
/// the previous version silently truncated an oversized message instead
/// of rejecting it, parsing whatever cwd/prefix-of-args happened to fit
/// and dropping the rest with no error at all. Sending nothing and
/// letting the caller fail open (see [`acquire_or_forward`]) is strictly
/// better than that: this launch becomes its own extra, unprotected
/// instance, but at least it still opens every file it was asked to.
fn build_forward_payload_from(cwd: &str, args: &[String]) -> Option<Vec<u8>> {
    let joined_args = args.join("\0");
    let mut payload = Vec::with_capacity(cwd.len() + 2 + joined_args.len());
    payload.extend_from_slice(cwd.as_bytes());
    payload.extend_from_slice(b"\0\0");
    payload.extend_from_slice(joined_args.as_bytes());
    (payload.len() <= MAX_MESSAGE_BYTES).then_some(payload)
}

/// This process's own cwd/argv, wrapped for forwarding — see
/// [`build_forward_payload_from`]'s doc comment for the format and the
/// `None` case.
fn build_this_process_forward_payload() -> Option<Vec<u8>> {
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let args: Vec<String> = std::env::args().collect();
    build_forward_payload_from(&cwd, &args)
}

/// Writes `payload` behind an explicit 8-byte little-endian length
/// prefix. Paired with [`read_forwarded_argv_cwd`]'s framed read — see
/// that function's doc comment for why a prefix, rather than "read until
/// EOF or a byte cap", is what makes an oversized message reliably
/// detectable instead of silently truncated.
fn send_framed(stream: &mut UnixStream, payload: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(payload.len() as u64).to_le_bytes())?;
    stream.write_all(payload)
}

/// Sends `payload` framed (see [`send_framed`]) and then blocks (up to
/// [`ACK_TIMEOUT`]) waiting for the single-byte ACK
/// [`spawn_accept_loop`] writes back once it has *finished processing*
/// the message, not merely received it — see [`ACK_BYTE`]'s doc comment
/// for why a successful `write_all` alone isn't proof of delivery. Any
/// failure here (write error, timeout, or the peer closing the
/// connection without ever writing the byte) is reported as an `Err`, the
/// same as a connect failure — [`connect_and_forward`]'s caller treats
/// "sent but never acked" exactly like "couldn't reach the peer at all":
/// worth retrying, up to and including trying the lock itself again in
/// case the old primary is gone for good.
fn send_and_await_ack(stream: &mut UnixStream, payload: &[u8]) -> std::io::Result<()> {
    send_framed(stream, payload)?;
    stream.set_read_timeout(Some(ACK_TIMEOUT))?;
    let mut ack = [0u8; 1];
    stream.read_exact(&mut ack)
}

/// Parse one forwarded message off an accepted connection. Returns
/// `None` on any I/O error, timeout, oversized declared length, or
/// malformed message — the caller (the accept loop) just moves on to the
/// next connection either way, the same as a dropped/ignored packet would
/// be. Takes the stream by mutable reference, not by value: the caller
/// (`spawn_accept_loop`) still owns it afterward, needed to write the ACK
/// back once it's done processing whatever this returns.
///
/// Reads an explicit 8-byte length prefix first, then reads *exactly*
/// that many bytes with `read_exact` — never more, never fewer, and never
/// treats "the peer stopped sending early" as "the message is exactly
/// this long". The previous version instead capped a single
/// `Read::take(..).read_to_end(..)` at `MAX_MESSAGE_BYTES` and could not
/// tell "the peer sent fewer bytes than that and is done" apart from "the
/// peer sent more and got cut off mid-message" — a genuinely oversized
/// message (e.g. opening a very large number of files at once) was
/// silently parsed as whatever truncated prefix fit, quietly dropping
/// every path past the cutoff with no error at all (caught in PR #315's
/// sixth review round). Here, a declared length over `MAX_MESSAGE_BYTES`
/// is rejected outright, before ever attempting to read a body that size
/// — both bounding memory against a hostile/broken peer and, unlike
/// silently truncating, actually surfacing the rejection (via the caller
/// logging it, see `spawn_accept_loop`) instead of pretending a partial
/// message was the whole thing.
fn read_forwarded_argv_cwd(stream: &mut UnixStream) -> Option<(String, Vec<String>)> {
    // A slow or hostile peer must not be able to wedge the accept loop
    // open indefinitely.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let mut len_buf = [0u8; 8];
    stream.read_exact(&mut len_buf).ok()?;
    let len = u64::from_le_bytes(len_buf);
    if len > MAX_MESSAGE_BYTES as u64 {
        eprintln!(
            "singleinstance_macos: rejecting a forwarded message declaring {len} bytes, over \
             the {MAX_MESSAGE_BYTES}-byte cap — refusing to parse a partial prefix of it"
        );
        return None;
    }

    // `len` is already checked against `MAX_MESSAGE_BYTES` (a modest,
    // fixed constant) above, so this allocation is bounded regardless of
    // what a hostile peer's length prefix claims.
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).ok()?;

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
///
/// Writes the ACK byte only *after* `handle_single_instance_launch`
/// returns — i.e. after the window has been focused and the files queued
/// — not right after parsing. See [`ACK_BYTE`]'s doc comment for why the
/// secondary waits for this rather than treating its own successful
/// `write_all` as proof the request was actually handled.
pub(crate) fn spawn_accept_loop(app: tauri::AppHandle, listener: UnixListener) {
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(mut stream) => {
                    if let Some((cwd, args)) = read_forwarded_argv_cwd(&mut stream) {
                        crate::handle_single_instance_launch(&app, args.into_iter(), &cwd);
                        let _ = stream.write_all(&[ACK_BYTE]);
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
    /// `spawn_accept_loop`'s body, without needing a real `AppHandle` —
    /// including writing the ACK back afterward, or the secondary's
    /// `acquire_or_forward` call below would time out waiting for one)
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
            let (mut stream, _) = listener.accept().expect("accept should succeed");
            let parsed = read_forwarded_argv_cwd(&mut stream);
            if parsed.is_some() {
                stream
                    .write_all(&[ACK_BYTE])
                    .expect("acking should succeed");
            }
            tx.send(parsed).unwrap();
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

    /// Regression test for PR #315's seventh review round: a successful
    /// `write_all` alone is not proof the primary ever processed the
    /// message — this directly exercises [`send_and_await_ack`] (the
    /// low-level piece, not the full retrying `connect_and_forward`) so
    /// it's fast and precise. A peer that reads the message and then
    /// promptly ACKs must make the send succeed.
    #[test]
    fn send_and_await_ack_succeeds_once_the_peer_acks_after_processing() {
        let identifier = "com.mojidori.test.ack-success";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let accept_thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept should succeed");
            let parsed = read_forwarded_argv_cwd(&mut stream);
            assert!(
                parsed.is_some(),
                "the test's own well-formed payload must parse"
            );
            // Standing in for `handle_single_instance_launch` running to
            // completion before the real accept loop acks.
            stream
                .write_all(&[ACK_BYTE])
                .expect("acking should succeed");
        });

        let mut client = UnixStream::connect(&path).unwrap();
        let payload = build_forward_payload_from("/ack-test", &["file.txt".to_string()])
            .expect("a small payload must not be rejected by the cap check");
        send_and_await_ack(&mut client, &payload)
            .expect("must succeed once the peer both reads and acks");

        accept_thread.join().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    /// Counterpart to the test above: a peer that reads the message but
    /// closes the connection *without* ever writing the ACK byte — e.g.
    /// simulating a primary dying between accepting the connection and
    /// finishing `handle_single_instance_launch` — must make
    /// `send_and_await_ack` report failure. Silently treating this as
    /// delivered (the bug this round's review caught) would mean the
    /// secondary exits believing its file-open request went through when
    /// nobody ever actually processed it.
    #[test]
    fn send_and_await_ack_fails_when_the_peer_closes_without_acking() {
        let identifier = "com.mojidori.test.ack-missing";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let accept_thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept should succeed");
            let parsed = read_forwarded_argv_cwd(&mut stream);
            assert!(
                parsed.is_some(),
                "the test's own well-formed payload must parse"
            );
            // Deliberately no ACK write here — `stream` is simply dropped,
            // closing the connection, standing in for the primary process
            // dying right after receiving the message.
        });

        let mut client = UnixStream::connect(&path).unwrap();
        let payload = build_forward_payload_from("/ack-test", &["file.txt".to_string()])
            .expect("a small payload must not be rejected by the cap check");
        let result = send_and_await_ack(&mut client, &payload);
        assert!(
            result.is_err(),
            "a peer that never acks must be reported as a failure, not treated as \
             successful delivery"
        );

        accept_thread.join().unwrap();
        let _ = std::fs::remove_file(&path);
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

    /// Regression test for PR #315's sixth review round: a message
    /// declaring a length over `MAX_MESSAGE_BYTES` must be rejected
    /// outright, from the length prefix alone, without ever attempting to
    /// read a body that size — proven here by never sending that body at
    /// all (a hostile/broken peer might not either) and still getting a
    /// prompt `None`, not a hang waiting for bytes that will never come.
    #[test]
    fn read_forwarded_argv_cwd_rejects_a_declared_length_over_the_cap() {
        let identifier = "com.mojidori.test.oversize-header";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let accept_thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept should succeed");
            read_forwarded_argv_cwd(&mut stream)
        });

        let mut stream = UnixStream::connect(&path).unwrap();
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let declared_len = MAX_MESSAGE_BYTES as u64 + 1;
        stream.write_all(&declared_len.to_le_bytes()).unwrap();
        // No body follows at all — a real oversized sender would still
        // send one, but rejection must happen before that would even
        // matter, which not sending it here proves directly.
        drop(stream);

        let result = accept_thread
            .join()
            .expect("must return promptly on a declared-oversized length, not hang");
        assert!(
            result.is_none(),
            "a declared length over the cap must be rejected outright"
        );

        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// A message whose *actual* size lands exactly on `MAX_MESSAGE_BYTES`
    /// — the boundary the cap check in both
    /// [`read_forwarded_argv_cwd`] and [`build_forward_payload_from`]
    /// must treat as still acceptable, not off-by-one reject.
    #[test]
    fn read_forwarded_argv_cwd_accepts_a_message_exactly_at_the_cap() {
        let identifier = "com.mojidori.test.exact-cap";
        let path = socket_path(identifier);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let cwd = "/exact-cap-test";
        let filler_len = MAX_MESSAGE_BYTES - cwd.len() - 2;
        let filler_arg = "a".repeat(filler_len);
        let payload = build_forward_payload_from(cwd, std::slice::from_ref(&filler_arg)).expect(
            "a payload built to land exactly on the cap must not be rejected by the \
             sender-side check either",
        );
        assert_eq!(payload.len(), MAX_MESSAGE_BYTES);

        let accept_thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept should succeed");
            read_forwarded_argv_cwd(&mut stream)
        });

        let mut stream = UnixStream::connect(&path).unwrap();
        send_framed(&mut stream, &payload).unwrap();
        drop(stream);

        let (received_cwd, received_args) = accept_thread
            .join()
            .unwrap()
            .expect("a message exactly at the cap must parse successfully, not be rejected");
        assert_eq!(received_cwd, cwd);
        assert_eq!(received_args, vec![filler_arg]);

        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// Sender-side counterpart of the two tests above: a payload that
    /// would land exactly on the cap must be built and sendable, and one
    /// byte over must be refused (`None`) rather than sent and silently
    /// truncated on the receiving end — the core fix for PR #315's sixth
    /// review round. Uses `build_forward_payload_from` directly (rather
    /// than `build_this_process_forward_payload`) so this is a pure,
    /// deterministic check against explicit inputs, independent of this
    /// test process's own real argv/cwd.
    #[test]
    fn build_forward_payload_from_accepts_exactly_at_cap_and_rejects_one_byte_over() {
        let cwd = "/cap-test";
        let base_len = cwd.len() + 2; // the "\0\0" separator

        let at_cap_arg = "b".repeat(MAX_MESSAGE_BYTES - base_len);
        let payload = build_forward_payload_from(cwd, &[at_cap_arg])
            .expect("a payload landing exactly on the cap must be accepted");
        assert_eq!(payload.len(), MAX_MESSAGE_BYTES);

        let one_over_arg = "b".repeat(MAX_MESSAGE_BYTES - base_len + 1);
        assert!(
            build_forward_payload_from(cwd, &[one_over_arg]).is_none(),
            "a payload one byte over the cap must be refused, not sent and silently truncated"
        );
    }

    /// Regression test for PR #315's sixth review round: a launch landing
    /// in the window where the lock is held but its socket has already
    /// been unlinked (simulating `cleanup_if_primary` having run just
    /// before the old process actually terminates and releases the lock)
    /// must retry the *lock* once the socket proves unreachable — not
    /// fail open permanently the first time `connect_and_forward` runs
    /// out of attempts. Releasing the simulated holder partway through
    /// proves `acquire_or_forward` is still actively retrying rather than
    /// having already given up.
    #[test]
    fn retries_the_lock_after_its_socket_is_unreachable_and_recovers_once_released() {
        let identifier = "com.mojidori.test.exit-race";
        let lock = lock_path(identifier);
        let socket = socket_path(identifier);
        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_file(&socket);

        // Simulate the exit race directly: hold the lock but never bind
        // any socket at all, so every connect attempt within a round
        // fails immediately and deterministically (no timing dependency
        // on a real bind/unbind sequence needed to reproduce it).
        let holder = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock)
            .unwrap();
        holder.try_lock().unwrap();

        let released = std::sync::Arc::new(AtomicBool::new(false));
        let released_writer = std::sync::Arc::clone(&released);
        let releaser = std::thread::spawn(move || {
            // Well within the first round's ~500ms of connect retries, so
            // by the time the second round's try_lock() runs, the lock is
            // already free — see this test's doc comment for why the
            // exact timing isn't delicate here.
            std::thread::sleep(Duration::from_millis(50));
            drop(holder);
            released_writer.store(true, Ordering::SeqCst);
        });

        let outcome = acquire_or_forward(identifier);
        releaser.join().unwrap();

        assert!(
            released.load(Ordering::SeqCst),
            "the test setup itself is broken if the lock was somehow still held when \
             acquire_or_forward returned"
        );
        match outcome {
            SingleInstanceOutcome::Primary { lock, .. } => drop(lock),
            other => panic!(
                "must retry past a temporarily unreachable socket and become primary once \
                 the lock is actually released, got {other:?} instead"
            ),
        }

        let _ = std::fs::remove_file(&lock);
        let _ = std::fs::remove_file(&socket);
    }
}
