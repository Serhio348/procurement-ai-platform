import { useEffect, type ReactElement } from "react";

export const TRASH_PURGE_PROMPT =
  "Удалить закупку из корзины безвозвратно? Вернуть её уже будет нельзя.";
export const TRASH_EMPTY_PROMPT =
  "Очистить корзину безвозвратно? Вернуть закупки уже будет нельзя.";
export const TRASH_MOVE_PROMPT =
  "Убрать закупку в корзину? Потом её можно вернуть или удалить.";

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
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
