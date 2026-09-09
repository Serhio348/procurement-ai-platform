import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  ProcedureStatus,
  SpecialistProfileWrite,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { profileDisplayName } from "@procurement/domain";
import { Shell } from "../shell/Shell.js";
import { profileCreatedToast } from "./ProfileList.js";

const TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Auction", label: "Электронный аукцион" },
  { value: "Request", label: "Запрос ценовых предложений" },
  { value: "eTrade", label: "Открытый конкурс / конкурс" },
  { value: "twoStageFirst", label: "Двухэтапный конкурс (1 этап)" },
  { value: "twoStageSecond", label: "Двухэтапный конкурс (2 этап)" },
  { value: "Marketing", label: "Запрос предложений о сведениях" },
  { value: "costLimit", label: "Заявка о ценах (тарифах) на ТРУ" },
  { value: "Limited", label: "Конкурс с ограниченным участием" },
  { value: "singleSource", label: "Закупка из одного источника (в электронном виде)" },
  { value: "eSingleSource", label: "Закупка из одного источника на ЭТП" },
  { value: "Other", label: "Иной вид" },
];

const REGION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "1", label: "Брестская область" },
  { value: "2", label: "Витебская область" },
  { value: "3", label: "Гомельская область" },
  { value: "4", label: "Гродненская область" },
  { value: "5", label: "Минская область" },
  { value: "6", label: "Могилевская область" },
  { value: "7", label: "г. Минск" },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: ProcedureStatus; label: string }> = [
  { value: "announced", label: "Объявлена" },
  { value: "accepting_bids", label: "Приём предложений" },
  { value: "bidding_closed", label: "Приём завершён, идёт подписание" },
  { value: "auction_in_progress", label: "Торги идут" },
  { value: "under_review", label: "На рассмотрении" },
  { value: "completed", label: "Завершена" },
  { value: "cancelled", label: "Отменена" },
  { value: "unknown", label: "Прочие" },
];

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
  const [keywords, setKeywords] = useState(initial.keywords);
  const [addWord, setAddWord] = useState("");
  const [excluded, setExcluded] = useState(initial.excludeKeywords.join("\n"));
  const [statuses, setStatuses] = useState<readonly ProcedureStatus[]>(initial.statuses);
  const [filters, setFilters] = useState(initial.filters);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const navigate = useNavigate();
  const untitled = initial.name.trim().length === 0;
  const activateRef = useRef(activate);
  activateRef.current = activate;

  useEffect(() => {
    const select = activateRef.current;
    if (select === undefined) return;
    void select(initial.id);
  }, [initial.id]);

  function addQueries(): void {
    const phrases = addWord
      .split(/[\n,;]/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (phrases.length === 0) return;
    const seen = new Set(keywords.map((item) => item.toLowerCase()));
    const next = [...keywords];
    for (const phrase of phrases) {
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(phrase);
    }
    setKeywords(next);
    setAddWord("");
  }

  function removeKeyword(value: string): void {
    const key = value.toLowerCase();
    setKeywords(keywords.filter((item) => item.toLowerCase() !== key));
  }

  function setFilter<K extends keyof typeof filters>(key: K, value: (typeof filters)[K]): void {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function setDate(key: keyof typeof filters, raw: string): void {
    const value = raw === "" ? undefined : raw;
    setFilters((current) => ({ ...current, [key]: value } as typeof current));
  }

  function setPrice(key: keyof typeof filters, raw: string): void {
    const value = raw === "" ? undefined : Number(raw);
    setFilters((current) => ({ ...current, [key]: value } as typeof current));
  }

  function toggleArrayValue(current: readonly string[], value: string, selected: boolean): string[] {
    return selected ? [...current, value] : current.filter((item) => item !== value);
  }

  async function saveProfile(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await save({
        name: name.trim(),
        purpose: name.trim(),
        description: "",
        keywords,
        excludeKeywords: splitExcludeLines(excluded),
        statuses: [...statuses],
        filters,
      });
      setProfile(next);
      const title = profileDisplayName(next);
      await navigate("/profiles", {
        state: {
          toast: untitled ? profileCreatedToast(title) : `Профиль «${title}» сохранён.`,
        },
      });
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
        {notice === undefined ? null : <p className="search-notice">{notice}</p>}
        <form
          className="profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <section className="profile-section" aria-labelledby="profile-name">
            <label htmlFor="profile-name">Название</label>
            <input
              id="profile-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </section>

          <section className="profile-section" aria-labelledby="profile-words">
            <h2 id="profile-words">Ключевые слова и фразы для поиска</h2>
            <p className="profile-hint">Каждое слово или фраза — отдельный запрос на goszakupki.by.</p>
            <div className="profile-add-row">
              <input
                aria-label="Добавить слово"
                value={addWord}
                onChange={(event) => {
                  setAddWord(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addQueries();
                }}
                placeholder="Впишите слово и нажмите Enter; можно несколько через запятую"
              />
              <button type="button" className="profile-fill" onClick={addQueries}>
                Добавить
              </button>
            </div>
            {keywords.length === 0 ? (
              <p className="profile-empty-queries">Пока пусто — добавьте слова для поиска.</p>
            ) : (
              <ul className="profile-chips">
                {keywords.map((phrase) => (
                  <li key={phrase.toLowerCase()}>
                    <span className="profile-chip">
                      {phrase}
                      <button
                        type="button"
                        className="profile-chip-remove"
                        aria-label={`Убрать ${phrase}`}
                        onClick={() => {
                          removeKeyword(phrase);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="profile-section">
            <h2>Исключать</h2>
            <p className="profile-hint">
              Запятая или новая строка — отдельное слово. Закупка с таким словом в названии,
              заказчике или статусе в выдачу не попадёт.
            </p>
            <label htmlFor="profile-exclude">Исключать</label>
            <textarea
              id="profile-exclude"
              rows={2}
              value={excluded}
              onChange={(event) => {
                setExcluded(event.target.value);
              }}
            />
          </section>

          <section className="profile-section" aria-labelledby="profile-statuses">
            <h2 id="profile-statuses">Статусы закупок</h2>
            <p className="profile-hint">Отбираются только отмеченные статусы. Ничего не отмечено — показываем все.</p>
            <fieldset className="profile-statuses">
              <legend className="sr-only">Статусы</legend>
              {STATUS_OPTIONS.map((option) => (
                <label key={option.value} className="profile-status-option">
                  <input
                    type="checkbox"
                    checked={statuses.includes(option.value)}
                    onChange={(event) => {
                      setStatuses(
                        event.target.checked
                          ? [...statuses, option.value]
                          : statuses.filter((item) => item !== option.value),
                      );
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </section>

          <section className="profile-section" aria-labelledby="profile-filters">
            <h2 id="profile-filters">Уточнить поиск на площадке</h2>
            <p className="profile-hint">Эти поля отправляются прямо на goszakupki.by — чем точнее, тем меньше лишних страниц.</p>
            <div className="profile-filters-grid">
              <label htmlFor="profile-unp">УНП заказчика</label>
              <input
                id="profile-unp"
                value={filters.buyerUnp}
                onChange={(event) => setFilter("buyerUnp", event.target.value)}
              />

              <label htmlFor="profile-customer">Заказчик / организатор</label>
              <input
                id="profile-customer"
                value={filters.buyerText}
                onChange={(event) => setFilter("buyerText", event.target.value)}
              />

              <label htmlFor="profile-number">Номер закупки</label>
              <input
                id="profile-number"
                value={filters.procurementNumber}
                onChange={(event) => setFilter("procurementNumber", event.target.value)}
              />

              <label htmlFor="profile-price-from">Цена с (BYN)</label>
              <input
                id="profile-price-from"
                type="number"
                value={filters.priceFrom ?? ""}
                onChange={(event) => setPrice("priceFrom", event.target.value)}
              />

              <label htmlFor="profile-price-to">Цена по (BYN)</label>
              <input
                id="profile-price-to"
                type="number"
                value={filters.priceTo ?? ""}
                onChange={(event) => setPrice("priceTo", event.target.value)}
              />

              <label htmlFor="profile-published-from">Дата размещения с</label>
              <input
                id="profile-published-from"
                type="date"
                value={filters.publishedFrom ?? ""}
                onChange={(event) => setDate("publishedFrom", event.target.value)}
              />

              <label htmlFor="profile-published-to">Дата размещения по</label>
              <input
                id="profile-published-to"
                type="date"
                value={filters.publishedTo ?? ""}
                onChange={(event) => setDate("publishedTo", event.target.value)}
              />

              <label htmlFor="profile-request-from">Дата окончания приёма с</label>
              <input
                id="profile-request-from"
                type="date"
                value={filters.requestEndFrom ?? ""}
                onChange={(event) => setDate("requestEndFrom", event.target.value)}
              />

              <label htmlFor="profile-request-to">Дата окончания приёма по</label>
              <input
                id="profile-request-to"
                type="date"
                value={filters.requestEndTo ?? ""}
                onChange={(event) => setDate("requestEndTo", event.target.value)}
              />

              <label htmlFor="profile-auction-from">Дата торгов с</label>
              <input
                id="profile-auction-from"
                type="date"
                value={filters.auctionFrom ?? ""}
                onChange={(event) => setDate("auctionFrom", event.target.value)}
              />

              <label htmlFor="profile-auction-to">Дата торгов по</label>
              <input
                id="profile-auction-to"
                type="date"
                value={filters.auctionTo ?? ""}
                onChange={(event) => setDate("auctionTo", event.target.value)}
              />
            </div>

            <div className="profile-filters-lists">
              <div>
                <h3>Вид процедуры</h3>
                <fieldset className="profile-statuses">
                  <legend className="sr-only">Вид процедуры</legend>
                  {TYPE_OPTIONS.map((option) => (
                    <label key={option.value} className="profile-status-option">
                      <input
                        type="checkbox"
                        checked={(filters.typeIds ?? []).includes(option.value)}
                        onChange={(event) =>
                          setFilter("typeIds", toggleArrayValue(filters.typeIds ?? [], option.value, event.target.checked))
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
              </div>
              <div>
                <h3>Область заказчика</h3>
                <fieldset className="profile-statuses">
                  <legend className="sr-only">Область</legend>
                  {REGION_OPTIONS.map((option) => (
                    <label key={option.value} className="profile-status-option">
                      <input
                        type="checkbox"
                        checked={(filters.regionIds ?? []).includes(option.value)}
                        onChange={(event) =>
                          setFilter("regionIds", toggleArrayValue(filters.regionIds ?? [], option.value, event.target.checked))
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
              </div>
            </div>
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
            Если кнопка не нажата, площадка сама не проверяется. Найденное появится во вкладке
            «Закупки», не во входящих.
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
              {profile.watchNewProcurements ? "Слежение включено" : "Следить за новыми закупками"}
            </button>
          </div>
        </section>
      </main>
    </Shell>
  );
}

function splitExcludeLines(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of text.split(/[\n,;]/u)) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (item.length === 0 || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}
