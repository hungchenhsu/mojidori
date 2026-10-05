// Quick-open panel: type-to-filter over recently opened files.
import { installModal } from "./modal";
import { t } from "./i18n";

const MAX_VISIBLE = 12;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Case-insensitive substring filter over full paths, capped at `max`. */
export function filterRecent(
  recent: string[],
  query: string,
  max: number = MAX_VISIBLE,
): string[] {
  const needle = query.toLowerCase();
  return recent
    .filter((path) => path.toLowerCase().includes(needle))
    .slice(0, max);
}

export function showQuickOpen(
  recent: string[],
  onPick: (path: string) => void,
): void {
  if (document.querySelector(".quickopen-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "quickopen-overlay";
  const panel = document.createElement("div");
  panel.className = "quickopen-panel";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t("quickOpen.searchPlaceholder");
  panel.appendChild(input);

  const list = document.createElement("ul");
  list.className = "quickopen-list";
  panel.appendChild(list);

  let filtered: string[] = [];
  let selected = 0;

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    overlay.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };

  const render = (): void => {
    filtered = filterRecent(recent, input.value);
    selected = Math.min(selected, Math.max(filtered.length - 1, 0));
    list.replaceChildren();
    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "quickopen-empty";
      empty.textContent =
        recent.length === 0 ? t("quickOpen.noRecent") : t("quickOpen.noMatches");
      list.appendChild(empty);
      return;
    }
    filtered.forEach((path, index) => {
      const item = document.createElement("li");
      item.className =
        index === selected ? "quickopen-item selected" : "quickopen-item";
      const name = document.createElement("span");
      name.className = "quickopen-name";
      name.textContent = basename(path);
      const dir = document.createElement("span");
      dir.className = "quickopen-dir";
      dir.textContent = path;
      item.appendChild(name);
      item.appendChild(dir);
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => {
        close();
        onPick(path);
      });
      list.appendChild(item);
    });
  };

  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
      render();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = filtered[selected];
      if (pick) {
        close();
        onPick(pick);
      }
    }
  });

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  installModal(overlay, panel, { label: t("modal.quickOpen") });
  render();
  input.focus();
  setTimeout(() => document.addEventListener("mousedown", onAway), 0);
}
