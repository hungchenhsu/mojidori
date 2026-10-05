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
      ["new_tab", "New Tab"],
      ["open", "Open…"],
      ["save", "Save"],
      ["save_as", "Save As…"],
      ["find", "Find…"],
      ["find_in_files", "Find in Files…"],
      ["goto_line", "Go to Line…"],
      ["preferences", "Settings…"],
      ["word_wrap", "Word Wrap"],
      ["sort_lines", "Sort Lines"],
    ].map(([id, label]) => ({ id, label })),
    document_fingerprint: () => fingerprint(),
    document_metadata: () => ({ readOnly: false, fingerprint: fingerprint() }),
    watch_file: () => null,
    unwatch_file: () => null,
    build_line_index: () => null,
    report_startup_ready: () => null,
    report_openfile_ready: () => null,
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
      // Window/webview plugin calls (setTitle, onCloseRequested, …) and any
      // command not modelled above resolve to null.
      return null;
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
