// Three-way close confirmation (the native dialog plugin only offers two
// buttons). Modal: clicking outside does nothing; Esc cancels, Enter saves.
import { installModal } from "./modal";
import { t } from "./i18n";

export type CloseChoice = "save" | "discard" | "cancel";

export function showCloseConfirm(title: string): Promise<CloseChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const dialog = document.createElement("div");
    dialog.className = "confirm-dialog";

    const message = document.createElement("p");
    message.textContent = t("confirm.unsavedChanges", title);
    dialog.appendChild(message);

    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";

    const finish = (choice: CloseChoice): void => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(choice);
    };

    const make = (label: string, choice: CloseChoice): HTMLButtonElement => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => finish(choice));
      buttons.appendChild(button);
      return button;
    };

    make(t("confirm.dontSave"), "discard");
    make(t("confirm.cancel"), "cancel");
    const save = make(t("confirm.save"), "save");
    save.className = "confirm-primary";

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish("cancel");
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finish("save");
      }
    };
    document.addEventListener("keydown", onKey, true);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    installModal(overlay, dialog, { role: "alertdialog", labelledBy: message });
    save.focus();
  });
}
