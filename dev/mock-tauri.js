// Dev-only Tauri IPC stand-in so the frontend can run in a plain browser
// (vite dev server + Playwright) for visual/UX review. Never bundled: only
// dev/ui-harness.html loads it, and `vite build` only builds index.html.
//
// Usage (vite dev running on :1420):
//   http://localhost:1420/dev/ui-harness.html?theme=dark&lang=en&doc=sample
// From the page / Playwright:
//   window.__mock.menu("find")            -> dispatch a native menu command
//   window.__mock.emit(event, payload)    -> emit any Tauri event
//   window.__mock.calls                   -> recorded [cmd, args] invocations
(() => {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") || "light";
  const lang = params.get("lang") || "en";
  const docKind = params.get("doc") || "sample";

  const SAMPLES = {
    sample: {
      path: "/Users/demo/Projects/notes/README.md",
      content: [
        "# Mojidori sample",
        "",
        "A small Markdown file used to review the editor chrome.",
        "",
        "## Encoding notes",
        "",
        "- UTF-8 is the default; Big5 / Shift_JIS / GB18030 are detected.",
        "- 繁體中文：文字編碼與換行符號的顯示測試。",
        "- 日本語：文字化けの修復ウィザード。",
        "",
        "```json",
        '{ "name": "mojidori", "version": "0.9.0", "tags": ["editor", "encoding"] }',
        "```",
        "",
        "> Search for `encoding` to see match highlighting.",
        "",
        ...Array.from({ length: 40 }, (_, i) => `Line ${i + 19}: the quick brown fox jumps over the lazy dog.`),
      ].join("\n"),
    },
    code: {
      path: "/Users/demo/Projects/app/src/main.ts",
      content: [
        "// Entry point",
        'import { invoke } from "@tauri-apps/api/core";',
        "",
        "export async function openFile(path: string): Promise<string> {",
        "  const text = await invoke<string>(\"open\", { path });",
        "  if (text.length === 0) {",
        "    return \"\"; // empty file",
        "  }",
        "  return text.replace(/\\r\\n/g, \"\\n\");",
        "}",
        "",
        "const answer = 42;",
        "",
      ].join("\n"),
    },
    empty: null,
  };

  const sample = SAMPLES[docKind] ?? null;

  const prefs = {
    fontFamily: "",
    fontSize: 14,
    theme,
    language: lang,
    defaultEncoding: "UTF-8",
    defaultBom: false,
    wordWrap: true,
    showInvisibles: false,
    indentGuides: true,
    suspiciousChars: true,
    indentWidth: 4,
    extensionEncodings: [],
    trimTrailingWhitespaceOnSave: false,
  };

  const callbacks = new Map();
  let nextId = 1;
  const listeners = new Map(); // event -> Set<handlerId>
  const calls = [];

  function fingerprint() {
    return { len: 1, modified: 0 };
  }

  function opened(doc) {
    return {
      path: doc.path,
      content: doc.content,
      encoding: "UTF-8",
      hadBom: false,
      malformed: false,
      lineEnding: "LF",
      truncated: false,
      totalSize: doc.content.length,
      nextOffset: null,
      fingerprint: fingerprint(),
    };
  }

  const handlers = {
    load_preferences: () => prefs,
    save_preferences: () => null,
    load_session: () =>
      sample
        ? {
            files: [
              {
                path: sample.path,
                encoding: "UTF-8",
                backup: null,
                cursor: 0,
                title: sample.path.split("/").pop(),
                withBom: false,
                lineEnding: "LF",
                userReadOnly: false,
              },
              ...(params.get("tabs") === "many"
                ? ["/Users/demo/Projects/app/src/main.ts", "/Users/demo/Projects/app/Cargo.toml", "/Users/demo/Desktop/shift_jis_notes.txt"].map((p) => ({
                    path: p,
                    encoding: "UTF-8",
                    backup: null,
                    cursor: 0,
                    title: p.split("/").pop(),
                    withBom: false,
                    lineEnding: "LF",
                    userReadOnly: false,
                  }))
                : []),
            ],
            active: 0,
          }
        : null,
    save_session: () => null,
    open_document: (a) => {
      const doc = Object.values(SAMPLES).find((d) => d && d.path === a.path) ?? {
        path: a.path,
        content: `Contents of ${a.path}\n`,
      };
      return opened(doc);
    },
    load_recent_files: () => [
      "/Users/demo/Projects/notes/README.md",
      "/Users/demo/Projects/app/src/main.ts",
      "/Users/demo/Desktop/shift_jis_notes.txt",
    ],
    add_recent_file: (a) => [a.path],
    clear_recent_files: () => [],
    list_backups: () => [],
    take_pending_files: () => [],
    palette_commands: () => [
      ["new_tab", "New Tab", "CmdOrCtrl+T"],
      ["open", "Open…", "CmdOrCtrl+O"],
      ["save", "Save", "CmdOrCtrl+S"],
      ["save_as", "Save As…", "CmdOrCtrl+Shift+S"],
      ["find", "Find…", "CmdOrCtrl+F"],
      ["find_in_files", "Find in Files…", "CmdOrCtrl+Shift+F"],
      ["goto_line", "Go to Line…", "CmdOrCtrl+L"],
      ["preferences", "Settings…", "CmdOrCtrl+,"],
      ["word_wrap", "Word Wrap", "Alt+Z"],
      ["sort_lines", "Sort Lines", null],
      ["unique_lines", "Remove Duplicate Lines", null],
      ["reverse_lines", "Reverse Lines", null],
      ["uppercase", "UPPERCASE", null],
      ["lowercase", "lowercase", null],
      ["duplicate_line", "Duplicate Line", null],
      ["delete_line", "Delete Line", null],
      ["join_lines", "Join Lines", null],
      ["document_info", "Document Info…", null],
    ].map(([id, label, accelerator]) => ({ id, label, accelerator })),
    document_fingerprint: () => fingerprint(),
    document_metadata: () => ({
      size: sample ? sample.content.length : 0,
      modifiedMs: Date.UTC(2026, 9, 1, 9, 30),
    }),
    line_ending_distribution: () => {
      const size = sample ? sample.content.length : 0;
      const lf = sample ? sample.content.split("\n").length - 1 : 0;
      return { lf, crlf: 0, cr: 0, scannedBytes: size, totalSize: size };
    },
    sync_theme_menu: () => null,
    sync_read_only_menu: () => null,
    sync_reopen_closed_tab_menu: () => null,
    sync_clear_recent_menu: () => null,
    retitle_menu: () => null,
    save_backup: () => null,
    delete_backup: () => null,
    watch_file: () => null,
    unwatch_file: () => null,
    build_line_index: () => null,
    report_startup_ready: () => null,
    report_openfile_ready: () => null,
    explain_detection: () => ({
      bom: null,
      detectorVerdict: "UTF-8",
      sampledBytes: sample ? sample.content.length : 0,
      totalSize: sample ? sample.content.length : 0,
      wouldChoose: "UTF-8 (detector)",
      largeFilePreview: false,
    }),
    "plugin:event|listen": (a) => {
      if (!listeners.has(a.event)) listeners.set(a.event, new Set());
      listeners.get(a.event).add(a.handler);
      return a.handler;
    },
    "plugin:event|unlisten": (a) => {
      for (const set of listeners.values()) set.delete(a.eventId);
      return null;
    },
    "plugin:dialog|ask": () => true,
    "plugin:dialog|confirm": () => true,
    "plugin:dialog|message": () => "Ok",
    "plugin:dialog|open": () => null,
    "plugin:dialog|save": () => null,
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      listeners.get(event)?.delete(id);
    },
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        return cb && cb(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path) {
      return path;
    },
    async invoke(cmd, args = {}) {
      calls.push([cmd, args]);
      const h = handlers[cmd];
      if (h) return h(args);
      // Window/webview plugin calls (setTitle, onCloseRequested, …) are
      // fire-and-forget here. Any other unmodelled app command rejects, so
      // the frontend's real error path runs instead of treating `null` as
      // valid data (add a canned handler above to screenshot that surface).
      if (cmd.startsWith("plugin:")) return null;
      throw new Error(`ui-harness: no mock for "${cmd}"`);
    },
  };

  window.__mock = {
    calls,
    handlers,
    emit(event, payload) {
      for (const id of listeners.get(event) ?? []) {
        callbacks.get(id)?.({ event, id, payload });
      }
    },
    menu(command) {
      this.emit("mojidori://menu", command);
    },
  };
})();
