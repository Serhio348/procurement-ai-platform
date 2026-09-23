import { useEffect, useRef, type ReactElement } from "react";

export const TRASH_PURGE_PROMPT =
  "Удалить закупку из корзины безвозвратно? Вернуть её уже будет нельзя.";
export const TRASH_EMPTY_PROMPT =
  "Очистить корзину безвозвратно? Вернуть закупки уже будет нельзя.";
export const TRASH_MOVE_PROMPT =
  "Убрать закупку в корзину? Потом её можно вернуть или удалить.";

const FOCUSABLE =
  "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

export function ConfirmToast({
  title = "Подтвердите действие",
  message,
  confirmLabel = "ОК",
  cancelLabel = "Отмена",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const toastRef = useRef<HTMLDivElement>(null);
  // autoFocus lands before mount effects run, so the opener is captured
  // during the first render — while the dialog cannot hold focus yet.
  const previousFocusRef = useRef<HTMLElement | null | "unset">("unset");
  if (previousFocusRef.current === "unset") {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  // Focus returns to whatever the specialist was doing before the dialog.
  useEffect(() => {
    const previous = previousFocusRef.current;
    return () => {
      if (previous !== "unset") previous?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const root = toastRef.current;
      if (root === null) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  // Unmounting the overlay in the same click lets the event hit «Удалить» again
  // and reopen the toast while the DELETE request is still in flight.
  const afterClick =
    (action: () => void) =>
    (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      event.preventDefault();
      event.stopPropagation();
      window.setTimeout(action, 0);
    };

  return (
    <div className="confirm-toast-backdrop" onClick={afterClick(onCancel)}>
      <div
        ref={toastRef}
        className="confirm-toast"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-toast-title"
        aria-describedby="confirm-toast-message"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <p id="confirm-toast-title" className="confirm-toast-title">
          {title}
        </p>
        <p id="confirm-toast-message">{message}</p>
        <div className="confirm-toast-actions">
          <button
            type="button"
            className={danger ? "confirm-toast-ok is-danger" : "confirm-toast-ok"}
            onClick={afterClick(onConfirm)}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="confirm-toast-cancel"
            autoFocus
            onClick={afterClick(onCancel)}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
