// Three-way stale-file confirmation for the regular Save path (issue #113):
// shown when save_document's commit-time fingerprint check finds the file
// changed on disk since it was opened, so writing the in-editor content
// would silently clobber whatever produced that change. Mirrors confirm.ts's
// showCloseConfirm — the native dialog plugin only offers two buttons, and
// this needs three.
//
// Unlike showCloseConfirm, Enter is deliberately not bound to any single
// button: both non-cancel choices are destructive in opposite directions —
// Overwrite clobbers content written by someone else, Reload discards the
// user's own unsaved edits in this tab — so there is no single "safe to
// default to" action worth a global Enter shortcut. Escape still cancels,
// and initial focus lands on Cancel — the one button that is always
// non-destructive.
import { installModal } from "./modal";
import { t } from "./i18n";

export type StaleFileChoice = "reload" | "overwrite" | "cancel";

export function showStaleFileConfirm(title: string): Promise<StaleFileChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog";

    const message = document.createElement("p");
    message.textContent = t("dialog.staleFileMessage", title);
    dialog.appendChild(message);

    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";

    const finish = (choice: StaleFileChoice): void => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(choice);
    };

    const make = (label: string, choice: StaleFileChoice): HTMLButtonElement => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => finish(choice));
      buttons.appendChild(button);
      return button;
    };

    make(t("dialog.reload"), "reload");
    const cancel = make(t("confirm.cancel"), "cancel");
    make(t("dialog.overwrite"), "overwrite");

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish("cancel");
      }
    };
    document.addEventListener("keydown", onKey, true);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    installModal(overlay, dialog, { role: "alertdialog", labelledBy: message });
    cancel.focus();
  });
}
