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
//! ## The accept loop can't wait for an `AppHandle` (PR #315's eighth review round)
//!
//! [`spawn_accept_loop`] starts the instant the socket is bound — inside
//! [`acquire_or_forward`] itself, before this process has even begun
//! `lib.rs`'s migration step, let alone built a `tauri::Builder` or
//! reached `.setup()` (the only point an `AppHandle` exists). An earlier
//! version instead deferred starting the accept loop until `.setup()`,
//! which sounded harmless (`.setup()` "usually" runs almost immediately)
//! but wasn't: `lib.rs`'s migration step can show a *blocking* dialog on
//! failure, and nothing bounds how long a user takes to dismiss it. Any
//! secondary launching in that window would find the socket already
//! bound (so `connect()` succeeds every time) but nobody ever calling
//! `accept()` on it — every ACK wait would time out, the secondary would
//! retry, and with the previous, more generous retry budget this added up
//! to roughly a minute of hanging before finally failing open. Worse:
//! once `.setup()` *did* eventually start the accept loop, every one of
//! those abandoned-but-still-buffered connections would still be sitting
//! in the kernel's backlog, fully readable — the accept loop would work
//! through all of them and process the *same* forwarded launch multiple
//! times.
//!
//! Starting the accept loop at bind time removes the dependency on
//! Tauri's lifecycle entirely, but its thread still can't call
//! [`handle_single_instance_launch`] directly — that needs an `AppHandle`,
//! which doesn't exist yet either. Parsed messages are instead recorded
//! via [`enqueue_or_deliver`] against a per-identifier [`DeliveryState`]:
//! buffered in an in-memory queue until [`install_app_handle`] (called
//! once `.setup()` has an `AppHandle`) drains it and switches future
//! messages to direct, live delivery — see that function's doc comment
//! for how the switch and the drain happen atomically under one lock, so
//! a message arriving right at the boundary is still delivered exactly
//! once. The ACK's meaning shifts accordingly: it now means "this process
//! has durably recorded the request and will act on it", not "the app has
//! visibly reacted yet" — a weaker guarantee than before, but the
//! alternative (waiting for the app to be fully ready) is exactly the bug
//! this section exists to describe.
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

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
/// Covers the brief window between a process winning the lock and its
/// accept loop's thread actually getting scheduled (now essentially
/// instantaneous — see this module's doc comment on why the accept loop
/// no longer waits for an `AppHandle` — so a small budget is enough; this
/// used to also have to cover the bind itself completing, before the
/// bind and the accept-loop spawn were merged into one atomic step).
const SECONDARY_CONNECT_ATTEMPTS: u32 = 3;
/// Delay between [`connect_and_forward`] retries within a round.
const SECONDARY_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);

/// How many times [`acquire_or_forward`] retries the *lock itself* after a
/// round's connect attempts are exhausted (see that function's doc
/// comment for the exit-race this covers) before giving up and failing
/// open. Each round after the first is preceded by a growing delay.
const LOCK_RETRY_ROUNDS: u32 = 3;
/// Delay before the second round; doubles each round after that (so:
/// 100ms, 200ms between the three rounds) — see [`acquire_or_forward`]'s
/// doc comment. Together with `SECONDARY_CONNECT_ATTEMPTS` and
/// `ACK_TIMEOUT`, this bounds the worst case (every attempt in every
/// round genuinely timing out) to roughly ten seconds — down from the
/// prior design's nearly a minute, now that the accept loop starting
/// promptly is the normal case rather than something these retries have
/// to routinely wait out (see this module's doc comment on the
/// eighth review round).
const LOCK_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(100);

/// A successful `write_all` only proves the bytes reached the OS socket
/// buffer, not that this process ever read, parsed, or acted on them — if
/// the primary is mid-exit right when it accepts the connection, the
/// kernel can tear down that accepted-but-unread connection (and whatever
/// was buffered in it) along with the rest of the dying process's file
/// descriptors, and the secondary's `write_all` may already have returned
/// `Ok` before that happens. [`send_and_await_ack`] treats the message as
/// delivered only once this process writes this single byte back, which
/// it only does after [`enqueue_or_deliver`] has durably recorded the
/// request — either queued or handed to a live `AppHandle` — not merely
/// received the bytes off the wire (caught in PR #315's seventh review
/// round).
const ACK_BYTE: u8 = 1;
/// How long [`send_and_await_ack`] waits for that byte before giving up.
/// Generous relative to how fast [`enqueue_or_deliver`] actually runs
/// (an in-memory queue push, or at most one window-focus call — no disk
/// I/O), so this essentially never fires unless this process is
/// genuinely gone or wedged.
const ACK_TIMEOUT: Duration = Duration::from_secs(1);

/// Set once this process becomes the primary instance, so
/// [`cleanup_if_primary`] only ever unlinks a socket this process itself
/// created — never a different (possibly still-live) instance's.
static IS_PRIMARY: AtomicBool = AtomicBool::new(false);

/// The result of trying to become (or find) the single instance.
#[derive(Debug)]
pub(crate) enum SingleInstanceOutcome {
    /// This process holds the single-instance lock and is the primary
    /// instance. `acquire_or_forward` has already bound the socket and
    /// spawned its accept loop (see this module's doc comment on the
    /// eighth review round for why that can't wait for `.setup()`); the
    /// caller's only remaining job is to keep `lock` alive for the
    /// lifetime of the process (`lib.rs` does this via `app.manage(lock)`)
    /// and, once an `AppHandle` exists, call
    /// [`install_app_handle`] — dropping `lock` early would release the
    /// OS advisory lock immediately, letting a later launch become
    /// primary too, defeating the whole point.
    Primary {
        /// The open, locked lock file. Never read from again after this
        /// point — its only remaining job is to stay open.
        lock: File,
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
                        // Spawned here, synchronously, right after the
                        // bind succeeds — not deferred until `lib.rs`'s
                        // `.setup()` gets an `AppHandle`. See this
                        // module's doc comment on the eighth review round
                        // for why that gap was itself a bug (a bound but
                        // not-yet-serviced socket, for as long as
                        // migration/setup happened to take).
                        spawn_accept_loop(identifier.to_string(), listener);
                        SingleInstanceOutcome::Primary { lock: lock_file }
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
/// launches. Called synchronously from [`acquire_or_forward`] right after
/// the socket is bound — *not* deferred until an `AppHandle` exists (see
/// this module's doc comment on the eighth review round for why that
/// used to be a bug). Runs for the lifetime of the process; not joined
/// anywhere, same as the plugin's own `tauri::async_runtime::spawn`
/// accept loop never was.
///
/// Writes the ACK byte only *after* [`enqueue_or_deliver`] returns — i.e.
/// after the request has been durably recorded (queued or delivered),
/// not right after parsing. See [`ACK_BYTE`]'s doc comment for why the
/// secondary waits for this rather than treating its own successful
/// `write_all` as proof the request was actually handled.
fn spawn_accept_loop(identifier: String, listener: UnixListener) {
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(mut stream) => {
                    if let Some((cwd, args)) = read_forwarded_argv_cwd(&mut stream) {
                        enqueue_or_deliver(&identifier, cwd, args);
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

/// What happens to a launch forwarded to this process, keyed by
/// identifier (so tests using distinct identifiers never share state —
/// in real use there is only ever one identifier per process, since a
/// process only ever calls [`acquire_or_forward`] once, for its own fixed
/// bundle identifier).
enum DeliveryState {
    /// No `AppHandle` yet: [`enqueue_or_deliver`] queues messages here.
    /// [`install_app_handle`] drains this once one becomes available.
    Buffering(VecDeque<(String, Vec<String>)>),
    /// An `AppHandle` is available (wrapped so [`install_app_handle`] can
    /// build it once, from a real `tauri::AppHandle`, while tests build
    /// one directly from a plain closure — see [`install_deliver`]).
    /// New messages are delivered through it immediately.
    Live(Deliver),
}

/// A queued message's eventual handler: `(cwd, args)`. In production this
/// always ends up calling `crate::handle_single_instance_launch`; wrapping
/// it behind a closure (rather than storing a raw `AppHandle` directly)
/// lets tests exercise the queue/flush/live-delivery machinery in
/// [`DeliveryState`] deterministically, without needing a real Tauri
/// `AppHandle` (which needs a running app to construct at all) just to
/// prove no message is ever delivered twice or dropped.
type Deliver = Arc<dyn Fn(String, Vec<String>) + Send + Sync>;

/// Per-identifier delivery state, lazily initialized (`HashMap::new()`
/// isn't `const`, hence the `OnceLock` wrapper rather than a bare
/// `static Mutex<HashMap<..>>`).
static DELIVERY: OnceLock<Mutex<HashMap<String, DeliveryState>>> = OnceLock::new();

fn delivery_map() -> &'static Mutex<HashMap<String, DeliveryState>> {
    DELIVERY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Records one parsed forwarded message: queues it if no `AppHandle` is
/// available yet for this identifier, or delivers it immediately if one
/// already is. Called from the accept loop, which ACKs the sender right
/// after this returns either way — see [`ACK_BYTE`]'s doc comment for why
/// "durably recorded" (queued counts) is an acceptable meaning of "acked"
/// here.
fn enqueue_or_deliver(identifier: &str, cwd: String, args: Vec<String>) {
    let mut map = delivery_map().lock().unwrap();
    match map
        .entry(identifier.to_string())
        .or_insert_with(|| DeliveryState::Buffering(VecDeque::new()))
    {
        DeliveryState::Buffering(queue) => queue.push_back((cwd, args)),
        DeliveryState::Live(deliver) => {
            // Clone the `Arc` out and release the lock before calling
            // into arbitrary (in production, Tauri) code — this function
            // must not be held up, or held responsible for a deadlock,
            // by whatever the delivery callback happens to do.
            let deliver = Arc::clone(deliver);
            drop(map);
            deliver(cwd, args);
        }
    }
}

/// Makes `deliver` the handler for this identifier's future messages, and
/// runs it (in FIFO order) for whatever was queued before this point —
/// all while holding the same lock [`enqueue_or_deliver`] does for the
/// whole "check state, then act" sequence, so a message arriving
/// concurrently is resolved unambiguously one way or the other:
///
/// - If [`enqueue_or_deliver`] gets the lock first, it finds `Buffering`
///   and queues the message — which this function, running next, then
///   drains and delivers.
/// - If this function gets the lock first, it drains whatever was
///   already queued and switches the state to `Live` before releasing
///   the lock — so when [`enqueue_or_deliver`] then gets its turn, it
///   finds `Live` already and delivers the message directly.
///
/// Either way, every message is delivered exactly once — never queued
/// forever, never delivered twice. [`install_app_handle`] is the
/// production entry point; this lower-level version exists so tests can
/// drive the same state machine with a plain recording closure instead of
/// a real `tauri::AppHandle`.
fn install_deliver(identifier: &str, deliver: Deliver) {
    let mut map = delivery_map().lock().unwrap();
    let queued = match map.get_mut(identifier) {
        Some(DeliveryState::Buffering(queue)) => std::mem::take(queue),
        // `None`: nothing has arrived for this identifier yet, nothing to
        // drain. `Live(_)`: this function already ran once (it's only
        // ever called once, from `.setup()`) — either way, no backlog.
        Some(DeliveryState::Live(_)) | None => VecDeque::new(),
    };
    map.insert(
        identifier.to_string(),
        DeliveryState::Live(Arc::clone(&deliver)),
    );
    drop(map);
    for (cwd, args) in queued {
        deliver(cwd, args);
    }
}

/// Production entry point for [`install_deliver`]: wraps a real
/// `tauri::AppHandle` (available once `lib.rs`'s `.setup()` runs) as the
/// delivery callback. Called exactly once, right after
/// `acquire_or_forward` returned [`SingleInstanceOutcome::Primary`] back
/// in `run()`.
pub(crate) fn install_app_handle(identifier: &str, app: tauri::AppHandle) {
    let deliver: Deliver = Arc::new(move |cwd, args| {
        crate::handle_single_instance_launch(&app, args.into_iter(), &cwd);
    });
    install_deliver(identifier, deliver);
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

    /// A test-only recorder for messages `install_deliver`/`enqueue_or_deliver`
    /// hand to a delivery closure, shared with the closure via `Arc` so the
    /// test can inspect it afterward.
    type Recorded = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    /// Every fixture below builds its identifier through this, rather
    /// than a bare literal, so two `cargo test` processes running
    /// concurrently (CI plus a local run, a flaky-test detector invoking
    /// the suite more than once, etc.) never collide on the same
    /// `lock_path`/`socket_path` in the shared per-user temp dir — both
    /// are keyed only by identifier, with no process-level separation of
    /// their own. Same lesson as issue #317. Stable and predictable
    /// *within* one process (every test still gets a fixed, distinct name
    /// per fixture); just no longer shared *across* processes.
    fn test_identifier(name: &str) -> String {
        format!("com.mojidori.test.{name}.{}", std::process::id())
    }

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
        let path = lock_path(&test_identifier("lock-semantics"));
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

    /// Regression test for PR #315's eighth review round: `acquire_or_forward`
    /// spawns the real accept loop itself, synchronously, the moment it
    /// wins the lock — no `AppHandle`, no `install_app_handle` call, no
    /// `.setup()` involved at all yet. A secondary connecting in exactly
    /// this window (which used to be the bug: nothing was servicing the
    /// socket until `.setup()` eventually ran) must still get ACKed
    /// promptly, and the message it sent must be sitting in this
    /// identifier's `Buffering` queue — not lost, not delivered to
    /// anything (there's nothing to deliver it *to* yet).
    #[test]
    fn primary_accepts_and_buffers_a_forwarded_launch_before_any_app_handle_is_installed() {
        let identifier = test_identifier("roundtrip");
        let identifier = identifier.as_str();
        let _ = std::fs::remove_file(lock_path(identifier));
        let _ = std::fs::remove_file(socket_path(identifier));

        let lock = match acquire_or_forward(identifier) {
            SingleInstanceOutcome::Primary { lock } => lock,
            _ => panic!("expected to become primary against a clean lock/socket path"),
        };

        // The real accept loop is already running (spawned inside the
        // `acquire_or_forward` call above) — no manual `listener.accept()`
        // simulation needed, unlike before this round's fix.
        let outcome = acquire_or_forward(identifier);
        assert!(
            matches!(outcome, SingleInstanceOutcome::ForwardedToRunning),
            "a second acquire while the first still holds the lock must forward and exit, \
             not also become primary — and must have been ACKed promptly by the already-running \
             accept loop to get here at all, not time out"
        );

        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let args = std::env::args().collect::<Vec<String>>();
        {
            let mut map = delivery_map().lock().unwrap();
            match map.remove(identifier) {
                Some(DeliveryState::Buffering(queue)) => {
                    assert_eq!(
                        queue.into_iter().collect::<Vec<_>>(),
                        vec![(cwd, args)],
                        "the forwarded message must be sitting in this identifier's buffer, \
                         exactly as sent, with no `AppHandle` ever having been installed for it"
                    );
                }
                other => panic!(
                    "expected a Buffering queue holding exactly the one forwarded message, \
                     found {}",
                    match other {
                        Some(DeliveryState::Live(_)) => "a Live delivery state instead",
                        None => "no entry at all",
                        Some(DeliveryState::Buffering(_)) => unreachable!(),
                    }
                ),
            }
        }

        drop(lock); // release before cleanup, mirroring a normal process exit
        let _ = std::fs::remove_file(lock_path(identifier));
        let _ = std::fs::remove_file(socket_path(identifier));
    }

    /// Regression test for PR #315's eighth review round:
    /// `install_deliver` (the core of `install_app_handle`, minus needing
    /// a real `tauri::AppHandle`) must drain everything queued before it
    /// ran and deliver each exactly once, then continue delivering any
    /// later message directly, live — not queue it again.
    #[test]
    fn install_deliver_drains_the_buffer_once_and_then_delivers_live() {
        let identifier = test_identifier("install-deliver");
        let identifier = identifier.as_str();
        let delivered: Recorded = Arc::new(Mutex::new(Vec::new()));

        enqueue_or_deliver(identifier, "/a".to_string(), vec!["one".to_string()]);
        enqueue_or_deliver(identifier, "/b".to_string(), vec!["two".to_string()]);

        let recorder = Arc::clone(&delivered);
        install_deliver(
            identifier,
            Arc::new(move |cwd, args| recorder.lock().unwrap().push((cwd, args))),
        );

        assert_eq!(
            *delivered.lock().unwrap(),
            vec![
                ("/a".to_string(), vec!["one".to_string()]),
                ("/b".to_string(), vec!["two".to_string()]),
            ],
            "both messages queued before install_deliver must be delivered exactly once, in \
             the order they arrived"
        );

        enqueue_or_deliver(identifier, "/c".to_string(), vec!["three".to_string()]);
        assert_eq!(
            *delivered.lock().unwrap(),
            vec![
                ("/a".to_string(), vec!["one".to_string()]),
                ("/b".to_string(), vec!["two".to_string()]),
                ("/c".to_string(), vec!["three".to_string()]),
            ],
            "a message arriving after install_deliver must be delivered live, immediately — \
             not silently re-queued where nothing will ever drain it again"
        );

        delivery_map().lock().unwrap().remove(identifier);
    }

    /// Regression test for PR #315's eighth review round: a message
    /// enqueued concurrently with the flush (`install_deliver`) that
    /// drains and switches the delivery state must still be delivered
    /// exactly once — never lost (if it raced in just as the buffer was
    /// taken) and never delivered twice (if it landed in the live path
    /// right as the switch happened). The two possible lock-acquisition
    /// orderings are exercised directly rather than relying on real
    /// thread-timing luck to force one of them:
    #[test]
    fn install_deliver_and_a_concurrent_new_message_never_lose_or_duplicate_it() {
        for order in [ConcurrentOrder::EnqueueFirst, ConcurrentOrder::InstallFirst] {
            let identifier = test_identifier(&format!("concurrent-flush-{order:?}"));
            let delivered: Recorded = Arc::new(Mutex::new(Vec::new()));

            enqueue_or_deliver(&identifier, "/pre".to_string(), vec!["pre".to_string()]);

            // A `Barrier` forces both threads to actually start their real
            // work at the same moment, rather than one trivially finishing
            // before the other even begins — the point is to exercise both
            // branches of `install_deliver`'s doc comment (which thread's
            // lock acquisition wins), not to prove a specific one always
            // does.
            let barrier = Arc::new(std::sync::Barrier::new(2));

            let install_barrier = Arc::clone(&barrier);
            let recorder = Arc::clone(&delivered);
            let install_identifier = identifier.clone();
            let install_thread = std::thread::spawn(move || {
                install_barrier.wait();
                install_deliver(
                    &install_identifier,
                    Arc::new(move |cwd, args| recorder.lock().unwrap().push((cwd, args))),
                );
            });

            let enqueue_barrier = Arc::clone(&barrier);
            let enqueue_identifier = identifier.clone();
            let enqueue_thread = std::thread::spawn(move || {
                enqueue_barrier.wait();
                if matches!(order, ConcurrentOrder::InstallFirst) {
                    // Give the installing thread a head start without
                    // making the outcome deterministic on timing — if it
                    // already won the lock, this changes nothing further
                    // (`enqueue_or_deliver` still resolves correctly
                    // either way); it just biases which branch this
                    // particular run is likelier to exercise.
                    std::thread::sleep(Duration::from_millis(5));
                }
                enqueue_or_deliver(
                    &enqueue_identifier,
                    "/concurrent".to_string(),
                    vec!["concurrent".to_string()],
                );
            });

            install_thread.join().unwrap();
            enqueue_thread.join().unwrap();

            // Whichever branch actually ran, exactly these two messages
            // must have been delivered — no more, no fewer. The
            // concurrent message may be delivered either by
            // `install_deliver`'s own drain (if it arrived in time to be
            // queued) or directly by `enqueue_or_deliver` (if the switch
            // to `Live` had already happened) — both are correct; a
            // `HashSet`-style unordered comparison is used because which
            // of those two happened isn't itself part of the invariant.
            let mut got = delivered.lock().unwrap().clone();
            got.sort();
            let mut expected = vec![
                ("/pre".to_string(), vec!["pre".to_string()]),
                ("/concurrent".to_string(), vec!["concurrent".to_string()]),
            ];
            expected.sort();
            assert_eq!(
                got, expected,
                "order {order:?}: every message must be delivered exactly once, regardless \
                 of which thread won the lock first"
            );

            delivery_map().lock().unwrap().remove(&identifier);
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum ConcurrentOrder {
        EnqueueFirst,
        InstallFirst,
    }

    /// Regression test for PR #315's seventh review round: a successful
    /// `write_all` alone is not proof the primary ever processed the
    /// message — this directly exercises [`send_and_await_ack`] (the
    /// low-level piece, not the full retrying `connect_and_forward`) so
    /// it's fast and precise. A peer that reads the message and then
    /// promptly ACKs must make the send succeed.
    #[test]
    fn send_and_await_ack_succeeds_once_the_peer_acks_after_processing() {
        let identifier = test_identifier("ack-success");
        let identifier = identifier.as_str();
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
        let identifier = test_identifier("ack-missing");
        let identifier = identifier.as_str();
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
        let identifier = test_identifier("stale-socket");
        let identifier = identifier.as_str();
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

        let lock = match acquire_or_forward(identifier) {
            SingleInstanceOutcome::Primary { lock } => lock,
            other => panic!(
                "a free lock (crashed holder already exited) must let this process become \
                 primary with a fresh listener, got {other:?} instead"
            ),
        };

        drop(lock);
        delivery_map().lock().unwrap().remove(identifier);
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
        let identifier = test_identifier("oversize-header");
        let identifier = identifier.as_str();
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
        let identifier = test_identifier("exact-cap");
        let identifier = identifier.as_str();
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
        let identifier = test_identifier("exit-race");
        let identifier = identifier.as_str();
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
