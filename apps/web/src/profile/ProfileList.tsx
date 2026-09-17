import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { SpecialistWorkingProfile } from "@procurement/contracts";
import { profileDisplayName } from "@procurement/domain";
import { Shell } from "../shell/Shell.js";

export function profileCreatedToast(name: string): string {
  return `Профиль «${name}» создан.`;
}

export function profileListToast(state: unknown): string | undefined {
  if (state === null || typeof state !== "object" || !("toast" in state)) return undefined;
  const value = (state as { toast: unknown }).toast;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ProfileList({
  profiles,
  create,
  remove,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  create: () => Promise<void>;
  remove?: (id: string) => Promise<void>;
}) {
  const location = useLocation();
  const incoming = profileListToast(location.state);
  const [toast, setToast] = useState(incoming);
  const [error, setError] = useState<string | undefined>();
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const canRemove = profiles.length > 1;

  useEffect(() => {
    setToast(incoming);
  }, [incoming]);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = window.setTimeout(() => {
      setToast(undefined);
    }, 8000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  useEffect(() => {
    if (error === undefined) return;
    const timer = window.setTimeout(() => {
      setError(undefined);
    }, 8000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [error]);

  return (
    <Shell>
      <main className="profile-page">
        {toast === undefined ? null : (
          <p className="toast" role="status">
            {toast}
          </p>
        )}
        {error === undefined ? null : (
          <p className="toast toast-error" role="alert">
            {error}
          </p>
        )}
        <h1>Профили</h1>
        <p className="profile-lead">
          Каждое направление — свой профиль и своё слежение. На вкладке
          «Закупки» выберите профиль и нажмите «Искать по профилю».
        </p>
        {!canRemove ? (
          <p className="profile-hint">
            Единственный профиль удалить нельзя — сначала создайте другой через
            «Новый профиль».
          </p>
        ) : null}
        <ul className="profile-list">
          {profiles.map((profile) => {
            const busy = pendingId === profile.id;
            return (
              <li key={profile.id} className="profile-list-item">
                <Link className="profile-list-link" to={`/profiles/${profile.id}`}>
                  <span>{profileDisplayName(profile)}</span>
                  <span className="profile-list-meta">
                    {profile.watchNewProcurements ? "слежение включено" : "без слежения"}
                  </span>
                </Link>
                {remove === undefined ? null : (
                  <button
                    type="button"
                    className="profile-list-remove"
                    aria-label={`Удалить профиль «${profileDisplayName(profile)}»`}
                    title={
                      busy
                        ? "Удаление…"
                        : canRemove
                          ? "Удалить профиль"
                          : "Нельзя удалить единственный профиль"
                    }
                    disabled={!canRemove || busy}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!canRemove || busy) return;
                      setError(undefined);
                      setPendingId(profile.id);
                      void remove(profile.id)
                        .catch((cause: unknown) => {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "Не удалось удалить профиль",
                          );
                        })
                        .finally(() => {
                          setPendingId(undefined);
                        });
                    }}
                  >
                    {busy ? "…" : "×"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="profile-actions">
          <button
            type="button"
            className="search-profile"
            disabled={creating}
            onClick={() => {
              setError(undefined);
              setCreating(true);
              void create()
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error ? cause.message : "Не удалось создать профиль",
                  );
                })
                .finally(() => {
                  setCreating(false);
                });
            }}
          >
            {creating ? "Создание…" : "Новый профиль"}
          </button>
        </div>
      </main>
    </Shell>
  );
}
