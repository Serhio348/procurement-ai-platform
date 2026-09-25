import { useEffect, useState } from "react";
import type { SpecialistTelegramStatus } from "@procurement/contracts";

export interface TelegramApi {
  status(): Promise<SpecialistTelegramStatus>;
  link(): Promise<{ code: string; url?: string | undefined; expiresInSec: number }>;
  setMode(mode: "all" | "urgent"): Promise<SpecialistTelegramStatus>;
  unlink(): Promise<SpecialistTelegramStatus>;
}

/**
 * «Уведомления в Telegram» on the profiles page: link a chat once, then new
 * procurements and watch changes arrive as bot messages with buttons.
 */
export function TelegramConnect({ api }: { api: TelegramApi }) {
  const [state, setState] = useState<SpecialistTelegramStatus | "loading">("loading");
  const [linkUrl, setLinkUrl] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(cause instanceof Error ? cause.message : "Telegram недоступен");
          setState({ available: false, linked: false });
        }
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback);
  };

  if (state === "loading") return null;
  if (!state.available) {
    return (
      <section className="telegram-connect">
        <h2>Уведомления в Telegram</h2>
        <p className="profile-hint">
          Бот не настроен на сервере — уведомления приходят только во входящие консоли.
        </p>
        {error === undefined ? null : (
          <p className="toast toast-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="telegram-connect">
      <h2>Уведомления в Telegram</h2>
      {error === undefined ? null : (
        <p className="toast toast-error" role="alert">
          {error}
        </p>
      )}
      {state.linked ? (
        <>
          <p className="profile-hint">
            Подключён чат{state.username === undefined ? "" : ` @${state.username}`}. Новые закупки и
            изменения по отслеживаемым приходят сообщениями.
          </p>
          <div className="profile-actions">
            <button
              type="button"
              className="search-profile"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void api
                  .setMode(state.mode === "urgent" ? "all" : "urgent")
                  .then(setState)
                  .catch((cause: unknown) => fail(cause, "Не удалось сменить режим"))
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {state.mode === "urgent" ? "Присылать все события" : "Только срочные"}
            </button>
            <button
              type="button"
              className="profile-list-remove telegram-disconnect"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void api
                  .unlink()
                  .then(setState)
                  .catch((cause: unknown) => fail(cause, "Не удалось отключить Telegram"))
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Отключить
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="profile-hint">
            Получайте новые закупки и изменения сообщениями в Telegram. Нажмите «Подключить» и
            перейдите по ссылке — бот привяжет чат к вашему кабинету.
          </p>
          <div className="profile-actions">
            <button
              type="button"
              className="search-profile"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void api
                  .link()
                  .then((created) => {
                    setLinkUrl(created.url);
                    if (created.url !== undefined) window.open(created.url, "_blank", "noopener");
                  })
                  .catch((cause: unknown) => fail(cause, "Не удалось создать ссылку"))
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {busy ? "Создаю ссылку…" : "Подключить Telegram"}
            </button>
          </div>
          {linkUrl === undefined ? null : (
            <p className="profile-hint">
              Ссылка действует 10 минут:{" "}
              <a href={linkUrl} target="_blank" rel="noreferrer">
                открыть бота
              </a>
              . После «Start» вернитесь сюда — статус обновится при следующем заходе.
            </p>
          )}
        </>
      )}
    </section>
  );
}
