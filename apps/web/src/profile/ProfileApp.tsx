import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type {
  SpecialistProfileWrite,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import {
  addPlatformKeyword,
  mergePlatformKeywords,
  platformKeywordEdits,
  removePlatformKeyword,
} from "@procurement/domain";
import { Shell } from "../shell/Shell.js";

export function ProfileApp({
  profile: initial,
  activate,
  save,
  setWatch,
}: {
  profile: SpecialistWorkingProfile;
  activate?: (id: string) => Promise<SpecialistWorkingProfile>;
  save: (next: SpecialistProfileWrite) => Promise<SpecialistWorkingProfile>;
  setWatch: (watchNewProcurements: boolean) => Promise<SpecialistWorkingProfile>;
}): ReactElement {
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const initialEdits = platformKeywordEdits(initial.description, initial.keywords);
  const [extras, setExtras] = useState(initialEdits.extras);
  const [removed, setRemoved] = useState(initialEdits.removed);
  const [addWord, setAddWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const platformQueries = mergePlatformKeywords(description, extras, removed);
  const activateRef = useRef(activate);
  activateRef.current = activate;

  useEffect(() => {
    const select = activateRef.current;
    if (select === undefined) return;
    void select(initial.id);
  }, [initial.id]);

  function applyEdits(next: { extras: string[]; removed: string[] }): void {
    setExtras(next.extras);
    setRemoved(next.removed);
  }

  function addQuery(): void {
    applyEdits(addPlatformKeyword(description, extras, removed, addWord));
    setAddWord("");
  }

  async function saveProfile(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const descriptionText = description.trim();
      const next = await save({
        name: name.trim(),
        purpose: descriptionText,
        description: descriptionText,
        instructions: instructions.trim(),
        keywords: platformQueries,
        excludeKeywords: [],
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
        <p className="profile-back">
          <Link to="/profiles">Все профили</Link>
        </p>
        <h1>Профиль направления</h1>
        <p className="profile-lead">
          Одно поле «Что ищем» задаёт поиск. Слова на площадку можно убрать или
          дописать, не повторяя тот же текст. Сохранение только записывает данные.
        </p>
        {notice === undefined ? null : <p className="search-notice">{notice}</p>}
        <form
          className="profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <section className="profile-section" aria-labelledby="profile-direction">
            <h2 id="profile-direction">Направление</h2>
            <label htmlFor="profile-name">Название</label>
            <input
              id="profile-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <label htmlFor="profile-description">Что ищем</label>
            <p className="profile-hint">
              Своими словами. Запятая или новая строка — отдельное слово на
              goszakupki.by.
            </p>
            <textarea
              id="profile-description"
              rows={4}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
            <p className="profile-hint" id="profile-queries-label">
              На площадку уйдёт
            </p>
            {platformQueries.length === 0 ? (
              <p className="profile-empty-queries">Пока пусто — напишите, что ищем, или добавьте слово.</p>
            ) : (
              <ul className="profile-chips" aria-labelledby="profile-queries-label">
                {platformQueries.map((phrase) => (
                  <li key={phrase.toLowerCase()}>
                    <span className="profile-chip">
                      {phrase}
                      <button
                        type="button"
                        className="profile-chip-remove"
                        aria-label={`Убрать ${phrase}`}
                        onClick={() => {
                          applyEdits(removePlatformKeyword(description, extras, removed, phrase));
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <label htmlFor="profile-add-word">Добавить слово</label>
            <div className="profile-add-row">
              <input
                id="profile-add-word"
                value={addWord}
                onChange={(event) => {
                  setAddWord(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addQuery();
                }}
              />
              <button type="button" className="profile-fill" disabled={busy} onClick={addQuery}>
                Добавить
              </button>
            </div>
            <label htmlFor="profile-instructions">Указания</label>
            <p className="profile-hint">
              Пометки, какие закупки вам нужны, а какие пропускать.
            </p>
            <textarea
              id="profile-instructions"
              rows={4}
              value={instructions}
              onChange={(event) => {
                setInstructions(event.target.value);
              }}
            />
          </section>

          <div className="profile-actions">
            <button type="submit" className="search-profile" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить профиль"}
            </button>
          </div>
        </form>

        <section className="profile-section" aria-labelledby="profile-watch">
          <h2 id="profile-watch">Новые закупки</h2>
          <p className="profile-hint">
            Если кнопка не нажата, площадка сама не проверяется. Найденное появится во
            вкладке «Закупки», не во входящих.
          </p>
          <div className="profile-actions">
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
        </section>
      </main>
    </Shell>
  );
}
