# Development environment setup

Everything you need to build and run Mojidori locally on macOS or Windows
(both Tier 1). Read [CONTRIBUTING.md](../CONTRIBUTING.md) for process and
code rules; this file is environment only.

> Maintenance note: this document is a living reference. When tooling,
> CI, or repository conventions change, update it in the same PR. Keep it
> short — prefer linking upstream docs over restating them; archive
> obsolete sections instead of letting them pile up.

## Prerequisites

| Requirement | macOS | Windows |
| --- | --- | --- |
| Node.js ≥ 20 (LTS) | [nodejs.org](https://nodejs.org/) or `brew install node` | [nodejs.org](https://nodejs.org/) installer |
| Rust stable | [rustup.rs](https://rustup.rs/) | [rustup.rs](https://rustup.rs/) — pick the default **MSVC** host toolchain |
| C/C++ build tools | Xcode Command Line Tools (`xcode-select --install`) | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **"Desktop development with C++"** workload |
| System WebView | WKWebView (built into macOS) | WebView2 Runtime — preinstalled on Windows 11 and most updated Windows 10; otherwise install the [Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |

No global npm packages are needed; the Tauri CLI runs via `npx` from
devDependencies.

## First build

```sh
git clone https://github.com/hungchenhsu/mojidori.git
cd mojidori
npm install
npm run build     # required once before any cargo command:
                  # tauri::generate_context! needs dist/ to exist
npm run tauri dev # run the app
```

The first `cargo` build compiles the full dependency tree and takes a few
minutes; subsequent builds are incremental.

## Everyday commands

```sh
npm run tauri dev    # run the app with hot frontend reload
npm run build        # typecheck (tsc strict) + bundle frontend
npm test             # frontend unit tests (vitest, jsdom)
cd src-tauri && cargo test                                   # Rust tests
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

All five checks above must pass before a PR — see the Definition of Done
in [CLAUDE.md](../CLAUDE.md) / [CONTRIBUTING.md](../CONTRIBUTING.md).

## Content Security Policy (dev mode)

`src-tauri/tauri.conf.json`'s `devCsp` pins `connect-src` to
`ws://localhost:1420` for Vite HMR — the fixed origin `vite.config.ts`
uses when `TAURI_DEV_HOST` is unset (`server.port: 1420`, `hmr:
undefined` falls back to Vite's default same-origin HMR client). This
project only develops desktop-locally on macOS/Windows; the
`TAURI_DEV_HOST` path (LAN/mobile dev, which moves HMR to
`ws://${TAURI_DEV_HOST}:1421`) is not used and is intentionally **not**
pre-allowed in the CSP, since a wildcard `ws:` scheme source would let
the dev window open a WebSocket to any host — an exfiltration path not
worth accepting for a workflow this repo doesn't exercise.

If you ever need `TAURI_DEV_HOST` locally: add
`ws://<host>:1421` (or, narrower still, the specific host you're using)
to `devCsp.connect-src` for that session. Without it, HMR fails
loudly — a CSP violation in the WebView console, not a silent hang —
so the failure mode is easy to diagnose and the temporary change is
easy to spot in a diff and back out.

## Windows notes

- **Line endings:** configure git before cloning so the working tree keeps
  LF (this project's core feature is line-ending/encoding handling; CRLF
  conversion in fixtures causes phantom test differences):

  ```sh
  git config --global core.autocrlf false
  ```

  (Tracked: [#48](https://github.com/hungchenhsu/mojidori/issues/48) will pin
  this repo-side with `.gitattributes`.)
- **Shell:** examples in this repo assume a POSIX-ish shell; on Windows,
  PowerShell works for all `npm`/`cargo` commands as written except the
  `cd src-tauri && …` chains — run the `cd` separately.
- **Antivirus / Defender:** the first Rust build writes thousands of files
  under `target/`; excluding the repo folder from real-time scanning
  speeds builds up noticeably.
- Verify UI changes against **WebView2** rendering, not just a regular
  browser — Windows menu/shortcut behavior is Tier 1
  (see Hard constraints in [CLAUDE.md](../CLAUDE.md)).

## macOS notes

- Verify UI changes against **WKWebView** (`npm run tauri dev`), not just
  Chromium — WebKit has known quirks (e.g. `::selection` handling).
- Local startup benchmark: `node scripts/startup-bench.mjs` (requires an
  unlocked desktop session — WKWebView does not execute frontend JS while
  the screen is locked, and the same silence occurs on CI runners, which
  is why there is no startup-bench CI job; see the script header).
- Local open-file benchmark: `node scripts/openfile-bench.mjs` (same
  unlocked-desktop requirement and no-CI reason as the startup benchmark
  above; generates its own synthetic 1 MiB / 50 MiB fixtures and cleans
  them up — see the script header).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `cargo build` fails with `dist/ not found` / `generate_context` error | Run `npm run build` once first |
| `link.exe not found` (Windows) | Install the VS Build Tools C++ workload, then restart the shell |
| Blank window on `tauri dev` (Windows) | Install/repair the WebView2 Evergreen runtime |
| Rust tests fail only on Windows with line-ending diffs | Check `core.autocrlf` (see Windows notes) |
