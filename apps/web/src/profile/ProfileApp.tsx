import { useState, type ReactElement } from "react";
import type {
  SpecialistProfileWrite,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { Shell } from "../shell/Shell.js";

function linesOf(values: readonly string[]): string {
  return values.join("\n");
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ProfileApp({
  profile: initial,
  save,
  setWatch,
}: {
  profile: SpecialistWorkingProfile;
  save: (next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setWatch: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
}): ReactElement {
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [keywords, setKeywords] = useState(linesOf(initial.keywords));
  const [excludeKeywords, setExcludeKeywords] = useState(linesOf(initial.excludeKeywords));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  async function saveProfile(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await save({
        name: name.trim() || profile.name,
        keywords: parseLines(keywords),
        excludeKeywords: parseLines(excludeKeywords),
      });
      setProfile(next);
      setNotice("Профиль сохранён. Поиск и слежение сами не запустились.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить профиль.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleWatch(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await setWatch(!profile.watchNewProcurements);
      setProfile(next);
      setNotice(
        next.watchNewProcurements
          ? "Слежение включено: новые закупки по профилю будут предлагаться сами."
          : "Слежение выключено: без этой кнопки новые закупки не ищутся.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось изменить слежение.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <main className="profile-page">
        <h1>Профиль</h1>
        <p className="search-notice">
          Сохранение только записывает направление. Разовый поиск — кнопка на списке закупок.
          Постоянное слежение — отдельная кнопка ниже.
        </p>
        {notice === undefined ? null : <p className="search-notice">{notice}</p>}
        <form
          className="profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <label>
            Название
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>
          <label>
            Ключевые слова, по одному на строку
            <textarea
              rows={8}
              value={keywords}
              onChange={(event) => {
                setKeywords(event.target.value);
              }}
            />
          </label>
          <label>
            Исключения, по одному на строку
            <textarea
              rows={4}
              value={excludeKeywords}
              onChange={(event) => {
                setExcludeKeywords(event.target.value);
              }}
            />
          </label>
          <div className="profile-actions">
            <button type="submit" className="search-profile" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить профиль"}
            </button>
            <button
              type="button"
              className={profile.watchNewProcurements ? "search-profile is-watching" : "search-profile"}
              disabled={busy}
              onClick={() => {
                void toggleWatch();
              }}
            >
              {profile.watchNewProcurements
                ? "Слежение за новыми закупками включено"
                : "Следить за новыми закупками"}
            </button>
          </div>
        </form>
      </main>
    </Shell>
  );
}
