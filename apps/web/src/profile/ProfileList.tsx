import { Link } from "react-router-dom";
import type { SpecialistWorkingProfile } from "@procurement/contracts";
import { profileDisplayName } from "@procurement/domain";
import { Shell } from "../shell/Shell.js";

export function ProfileList({
  profiles,
  create,
  remove,
}: {
  profiles: readonly SpecialistWorkingProfile[];
  create: () => Promise<void>;
  remove?: (id: string) => Promise<void>;
}) {
  const canRemove = profiles.length > 1;
  return (
    <Shell>
      <main className="profile-page">
        <h1>Профили</h1>
        <p className="profile-lead">
          Каждое направление — свой профиль и своё слежение. На вкладке
          «Закупки» выберите профиль и нажмите «Искать по профилю».
        </p>
        <ul className="profile-list">
          {profiles.map((profile) => (
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
                  title={canRemove ? "Удалить профиль" : "Нельзя удалить единственный профиль"}
                  disabled={!canRemove}
                  onClick={() => {
                    void remove(profile.id);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="profile-actions">
          <button
            type="button"
            className="search-profile"
            onClick={() => {
              void create();
            }}
          >
            Новый профиль
          </button>
        </div>
      </main>
    </Shell>
  );
}
