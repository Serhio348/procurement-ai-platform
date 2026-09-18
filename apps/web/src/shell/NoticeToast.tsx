import { useEffect, type ReactElement } from "react";

export interface InboxNotice {
  id: string;
  title: string;
  message: string;
}

/**
 * Passive notification stack: no backdrop and no decision to make. Each
 * notice dismisses itself after a while; the durable copy stays in the inbox.
 */
export function NoticeStack({
  notices,
  onDismiss,
}: {
  notices: readonly InboxNotice[];
  onDismiss: (id: string) => void;
}): ReactElement | null {
  if (notices.length === 0) return null;
  return (
    <div className="notice-stack" role="region" aria-label="Уведомления">
      {notices.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function NoticeToast({
  notice,
  onDismiss,
}: {
  notice: InboxNotice;
  onDismiss: (id: string) => void;
}): ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(notice.id), 10_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice.id, onDismiss]);

  return (
    <div className="notice-toast" role="alert">
      <div className="notice-toast-body">
        <p className="notice-toast-title">{notice.title}</p>
        <p className="notice-toast-message">{notice.message}</p>
      </div>
      <button
        type="button"
        className="notice-toast-close"
        aria-label="Закрыть уведомление"
        onClick={() => onDismiss(notice.id)}
      >
        ×
      </button>
    </div>
  );
}
