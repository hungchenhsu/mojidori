// Mojibake repair wizard: detect common mis-decode round-trips (e.g. Big5
// bytes once decoded as Windows-1252 and re-saved) and offer a previewed,
// reversible repair. Entered from the status-bar encoding menu and the
// decode-warning menu (see main.ts) — never applied silently: the user
// always picks a specific candidate from a preview before anything changes,
// and the result only ever lands in the editor buffer as an unsaved,
// undoable change (never written to disk by this module).
import { installModal } from "./modal";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";
import { applyMojibakeRepair, detectMojibake, type RepairCandidate } from "./ipc";

/**
 * First `maxChars` Unicode code points of `text`. Pure helper: uses
 * `Array.from` (iterates by code point) rather than slicing the UTF-16
 * string directly, so a surrogate pair straddling the cut point is never
 * split — the client-side mirror of the char-boundary-safe truncation the
 * Rust core does for `RepairCandidate.preview`.
 */
export function truncatePreview(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
}

/** Pure helper: the one-line description shown above each candidate. */
export function describeCandidate(candidate: RepairCandidate): string {
  return t(
    "mojibake.candidateDescription",
    candidate.original,
    candidate.intermediate,
  );
}

/**
 * Whether the live editor content has drifted from `snapshot` — the content
 * captured once when the wizard opened and used, unchanged, for both
 * `detectMojibake` and `applyMojibakeRepair` below. Detection and the
 * user's candidate pick are both async round trips, so the *same* tab's
 * content can keep changing while the wizard sits open (typing, a line
 * operation, a reload); if it has, the repair in hand was computed from a
 * version of the document the user can no longer see on screen, and the
 * caller must reject applying it rather than silently overwrite whatever
 * they've since typed (see issue #93).
 *
 * A plain string comparison, not a hash or a CM6 changeset/generation
 * counter: the whole content already round-trips through IPC as a string
 * for detection and repair, so comparing the same string again costs
 * nothing extra and needs no new state to create or keep in sync.
 *
 * This only catches drift within the same document. Whether the user
 * switched to a *different* tab entirely is a separate, pre-existing check
 * (`tabs.activeId !== docId` in main.ts's `showMojibakeRepairWizard`) that
 * this function knows nothing about — the two guards are independent and
 * both must pass before a repair is applied.
 */
export function isMojibakeSnapshotStale(snapshot: string, liveContent: string): boolean {
  return snapshot !== liveContent;
}

const BEFORE_PREVIEW_CHARS = 200;

function renderCandidates(
  list: HTMLElement,
  candidates: RepairCandidate[],
  content: string,
  onPick: (candidate: RepairCandidate) => void,
): void {
  list.replaceChildren();
  for (const candidate of candidates) {
    const item = document.createElement("button");
    item.className = "mojibake-item";

    const desc = document.createElement("div");
    desc.className = "mojibake-item-desc";
    desc.textContent = describeCandidate(candidate);
    item.appendChild(desc);

    const count = document.createElement("div");
    count.className = "mojibake-item-count";
    count.textContent = t("mojibake.replacementCount", candidate.replacementCount);
    item.appendChild(count);

    const compare = document.createElement("div");
    compare.className = "mojibake-compare";

    const beforeCol = document.createElement("div");
    beforeCol.className = "mojibake-col";
    const beforeLabel = document.createElement("div");
    beforeLabel.className = "mojibake-col-label";
    beforeLabel.textContent = t("mojibake.before");
    const before = document.createElement("pre");
    before.textContent = truncatePreview(content, BEFORE_PREVIEW_CHARS);
    beforeCol.appendChild(beforeLabel);
    beforeCol.appendChild(before);

    const afterCol = document.createElement("div");
    afterCol.className = "mojibake-col";
    const afterLabel = document.createElement("div");
    afterLabel.className = "mojibake-col-label";
    afterLabel.textContent = t("mojibake.after");
    const after = document.createElement("pre");
    after.textContent = candidate.preview;
    afterCol.appendChild(afterLabel);
    afterCol.appendChild(after);

    compare.appendChild(beforeCol);
    compare.appendChild(afterCol);
    item.appendChild(compare);

    item.addEventListener("click", () => onPick(candidate));
    list.appendChild(item);
  }
}

/**
 * Show the mojibake repair wizard for `content` (the active document's full
 * text). On success — after the user picks a candidate and the full-text
 * repair round-trips cleanly — `onApply` is called with the repaired text;
 * the caller is responsible for putting it in the editor (and for
 * verifying it is still applying to the right document, since detection
 * runs asynchronously). Nothing is written to disk here.
 */
export function showMojibakeWizard(
  content: string,
  onApply: (repaired: string) => void,
): void {
  if (document.querySelector(".mojibake-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "mojibake-overlay";
  const panel = document.createElement("div");
  panel.className = "mojibake-panel";

  const header = document.createElement("div");
  header.className = "mojibake-header";
  header.textContent = t("mojibake.title");
  panel.appendChild(header);

  const status = document.createElement("div");
  status.className = "mojibake-status";
  status.textContent = t("common.loading");
  panel.appendChild(status);

  const list = document.createElement("div");
  list.className = "mojibake-list";
  panel.appendChild(list);

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
  installModal(overlay, panel, { labelledBy: header });
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);

  const applyCandidate = async (candidate: RepairCandidate): Promise<void> => {
    try {
      const repaired = await applyMojibakeRepair(
        content,
        candidate.intermediate,
        candidate.original,
      );
      close();
      onApply(repaired);
      await messageDialog(t("mojibake.appliedMessage"), {
        title: t("mojibake.appliedTitle"),
        kind: "info",
      });
    } catch (error) {
      status.textContent = String(error);
    }
  };

  void detectMojibake(content)
    .then((candidates) => {
      if (candidates.length === 0) {
        status.textContent = t("mojibake.noCandidates");
        return;
      }
      status.textContent = t("mojibake.pickCandidate");
      renderCandidates(list, candidates, content, (candidate) =>
        void applyCandidate(candidate),
      );
    })
    .catch((error) => {
      status.textContent = String(error);
    });
}
