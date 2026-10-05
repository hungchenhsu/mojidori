// Read-only hex/bytes preview overlay, entered from the decode-warning
// status chip for files that failed to decode as text. This view is
// strictly read-only: no editing, no save path — it only ever displays the
// plain-text hex dump the Rust core already formatted (raw bytes never
// cross IPC).
import { installModal } from "./modal";
import { t } from "./i18n";
import { readHexDump } from "./ipc";
import { formatSize } from "./statusbar";

/** Requested read size; the Rust core independently caps this at 64 KB. */
const MAX_HEX_BYTES = 64 * 1024;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Pure helper: human-readable "showing first N of M" caption. */
export function hexPreviewCaption(
  shownBytes: number,
  totalSize: number,
): string {
  if (shownBytes >= totalSize) {
    return t("hexview.showingAll", formatSize(totalSize));
  }
  return t("hexview.showingPartial", formatSize(shownBytes), formatSize(totalSize));
}

export function showHexView(path: string, title: string): void {
  if (document.querySelector(".hexview-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "hexview-overlay";
  const panel = document.createElement("div");
  panel.className = "hexview-panel";

  const header = document.createElement("div");
  header.className = "hexview-header";
  const titleEl = document.createElement("span");
  titleEl.className = "hexview-title";
  titleEl.textContent = title || basename(path);
  const captionEl = document.createElement("span");
  captionEl.className = "hexview-caption";
  captionEl.textContent = t("common.loading");
  header.appendChild(titleEl);
  header.appendChild(captionEl);
  panel.appendChild(header);

  const content = document.createElement("pre");
  content.className = "hexview-content";
  content.tabIndex = 0;
  panel.appendChild(content);

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { labelledBy: titleEl });
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);
  content.focus();

  void readHexDump(path, MAX_HEX_BYTES)
    .then((result) => {
      captionEl.textContent = hexPreviewCaption(
        result.shownBytes,
        result.totalSize,
      );
      content.textContent = result.text;
    })
    .catch((error) => {
      captionEl.textContent = String(error);
    });
}
