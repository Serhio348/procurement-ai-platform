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
  { value: "accepting_bids", label: "Подача предложений" },
  { value: "bidding_closed", label: "Приём завершён, идёт подписание" },
  { value: "auction_in_progress", label: "Торги идут" },
  { value: "under_review", label: "На рассмотрении" },
  { value: "completed", label: "Завершена" },
  { value: "cancelled", label: "Отменена" },
  { value: "failed", label: "Не состоялась" },
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
  const [excludeSingleSource, setExcludeSingleSource] = useState(initial.excludeSingleSource);
  const [filters, setFilters] = useState(initial.filters);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [tab, setTab] = useState<"profile" | "search">("profile");
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
    if (raw.trim().length === 0) {
      setFilters((current) => ({ ...current, [key]: undefined } as typeof current));
      return;
    }
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value) || value < 0) return;
    setFilters((current) => ({ ...current, [key]: value } as typeof current));
  }

  function currentWrite(): SpecialistProfileWrite {
    return {
      name: name.trim(),
      purpose: name.trim(),
      description: "",
      keywords,
      excludeKeywords: splitExcludeLines(excluded),
      statuses: [...statuses],
      excludeSingleSource,
      filters,
    };
  }

  const dirty = !sameWrite(currentWrite(), profile);

  useEffect(() => {
    if (!dirty) return undefined;
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function saveProfile(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const next = await save(currentWrite());
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
      // Watch without saved keywords runs a search that finds nothing, so the
      // form is written first and only then the switch is flipped.
      const saved = dirty ? await save(currentWrite()) : profile;
      const next = await setWatch(!saved.watchNewProcurements);
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
          <Link
            to="/profiles"
            onClick={(event) => {
              if (dirty && !window.confirm(UNSAVED_PROMPT)) event.preventDefault();
            }}
          >
            Все профили
          </Link>
        </p>
        <h1>Профиль направления</h1>
        {dirty ? <p className="profile-unsaved">Есть несохранённые изменения — нажмите «Сохранить профиль».</p> : null}
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

          <div className="profile-tabs" role="tablist" aria-label="Разделы профиля">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "profile"}
              className={tab === "profile" ? "profile-tab profile-tab-active" : "profile-tab"}
              onClick={() => {
                setTab("profile");
              }}
            >
              Профиль
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "search"}
              className={tab === "search" ? "profile-tab profile-tab-active" : "profile-tab"}
              onClick={() => {
                setTab("search");
              }}
            >
              Расширенный поиск
            </button>
          </div>

          {tab === "profile" ? (
            <div className="profile-tab-body">
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

              <section className="profile-section" aria-labelledby="profile-single-source">
                <h2 id="profile-single-source">Закупки из одного источника</h2>
                <p className="profile-hint">
                  Такие закупки часто объявляют после несостоявшейся процедуры: срок подачи по
                  первой процедуре уже прошёл, а в списке она выглядит живой.
                </p>
                <fieldset className="profile-statuses">
                  <legend className="sr-only">Закупки из одного источника</legend>
                  <label className="profile-status-option">
                    <input
                      type="checkbox"
                      checked={excludeSingleSource}
                      onChange={(event) => {
                        setExcludeSingleSource(event.target.checked);
                      }}
                    />
                    Не показывать закупки из одного источника
                  </label>
                </fieldset>
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
            </div>
          ) : (
            <section className="profile-section profile-filters-section" aria-labelledby="profile-filters">
              <h2 id="profile-filters">Уточнить поиск на площадке</h2>
              <p className="profile-hint">
                Эти поля отправляются прямо на goszakupki.by вместе со словами поиска — чем точнее, тем меньше лишних страниц.
              </p>
              <div className="profile-filters-form">
                <div className="profile-filter-group">
                  <label htmlFor="profile-unp">УНП заказчика</label>
                  <input
                    id="profile-unp"
                    value={filters.buyerUnp ?? ""}
                    onChange={(event) => setFilter("buyerUnp", event.target.value)}
                  />
                </div>

                <div className="profile-filter-group">
                  <label htmlFor="profile-customer">Заказчик / организатор</label>
                  <input
                    id="profile-customer"
                    value={filters.buyerText ?? ""}
                    onChange={(event) => setFilter("buyerText", event.target.value)}
                  />
                </div>

                <div className="profile-filter-group">
                  <label htmlFor="profile-number">Номер закупки</label>
                  <input
                    id="profile-number"
                    value={filters.procurementNumber ?? ""}
                    onChange={(event) => setFilter("procurementNumber", event.target.value)}
                  />
                </div>

                <div className="profile-filter-group profile-filter-range">
                  <span className="profile-filter-label">Цена (BYN)</span>
                  <div className="profile-filter-range-row">
                    <div>
                      <label htmlFor="profile-price-from" className="profile-sublabel">с</label>
                      <input
                        id="profile-price-from"
                        type="number"
                        value={filters.priceFrom ?? ""}
                        onChange={(event) => setPrice("priceFrom", event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-price-to" className="profile-sublabel">по</label>
                      <input
                        id="profile-price-to"
                        type="number"
                        value={filters.priceTo ?? ""}
                        onChange={(event) => setPrice("priceTo", event.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="profile-filter-group profile-filter-range">
                  <span className="profile-filter-label">Дата размещения приглашения</span>
                  <div className="profile-filter-range-row">
                    <div>
                      <label htmlFor="profile-published-from" className="profile-sublabel">с</label>
                      <input
                        id="profile-published-from"
                        type="date"
                        value={filters.publishedFrom ?? ""}
                        onChange={(event) => setDate("publishedFrom", event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-published-to" className="profile-sublabel">по</label>
                      <input
                        id="profile-published-to"
                        type="date"
                        value={filters.publishedTo ?? ""}
                        onChange={(event) => setDate("publishedTo", event.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="profile-filter-group profile-filter-range">
                  <span className="profile-filter-label">Дата окончания приёма</span>
                  <div className="profile-filter-range-row">
                    <div>
                      <label htmlFor="profile-request-from" className="profile-sublabel">с</label>
                      <input
                        id="profile-request-from"
                        type="date"
                        value={filters.requestEndFrom ?? ""}
                        onChange={(event) => setDate("requestEndFrom", event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-request-to" className="profile-sublabel">по</label>
                      <input
                        id="profile-request-to"
                        type="date"
                        value={filters.requestEndTo ?? ""}
                        onChange={(event) => setDate("requestEndTo", event.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="profile-filter-group profile-filter-range">
                  <span className="profile-filter-label">Дата торгов</span>
                  <div className="profile-filter-range-row">
                    <div>
                      <label htmlFor="profile-auction-from" className="profile-sublabel">с</label>
                      <input
                        id="profile-auction-from"
                        type="date"
                        value={filters.auctionFrom ?? ""}
                        onChange={(event) => setDate("auctionFrom", event.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="profile-auction-to" className="profile-sublabel">по</label>
                      <input
                        id="profile-auction-to"
                        type="date"
                        value={filters.auctionTo ?? ""}
                        onChange={(event) => setDate("auctionTo", event.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="profile-filter-group">
                  <label htmlFor="profile-types">Вид процедуры</label>
                  <MultiSelectDropdown
                    id="profile-types"
                    options={TYPE_OPTIONS}
                    selected={filters.typeIds ?? []}
                    onChange={(next) => {
                      setFilter("typeIds", next);
                    }}
                    placeholder="Выберите виды процедур"
                  />
                </div>

                <div className="profile-filter-group">
                  <span className="profile-filter-label" id="profile-statuses">Статус</span>
                  <p className="profile-hint">Отмеченные статусы уходят на площадку. Ничего не отмечено — площадка отдаёт все.</p>
                  <fieldset className="profile-statuses" aria-labelledby="profile-statuses">
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
                </div>

                <div className="profile-filter-group">
                  <label htmlFor="profile-regions">Область заказчика</label>
                  <MultiSelectDropdown
                    id="profile-regions"
                    options={REGION_OPTIONS}
                    selected={filters.regionIds ?? []}
                    onChange={(next) => {
                      setFilter("regionIds", next);
                    }}
                    placeholder="Выберите области"
                  />
                </div>
              </div>
            </section>
          )}

          <div className="profile-actions">
            <button type="submit" className="search-profile" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить профиль"}
            </button>
          </div>
        </form>
      </main>
    </Shell>
  );
}

function MultiSelectDropdown({
  id,
  options,
  selected,
  onChange,
  placeholder,
}: {
  id: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  const label =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? options.find((option) => option.value === selected[0])?.label ?? placeholder
        : `Выбрано ${selected.length}`;

  return (
    <div className="profile-filter-dropdown" ref={ref}>
      <button
        id={id}
        type="button"
        className="profile-filter-dropdown-toggle"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {label}
      </button>
      {open ? (
        <div className="profile-filter-dropdown-menu">
          {options.map((option) => (
            <label key={option.value} className="profile-filter-dropdown-option">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value);
                  onChange(next);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const UNSAVED_PROMPT = "Изменения профиля не сохранены. Уйти без сохранения?";

function sameWrite(
  write: SpecialistProfileWrite,
  saved: SpecialistWorkingProfile,
): boolean {
  const list = (items: readonly string[]) => items.map((item) => item.trim().toLowerCase()).join("\n");
  return (
    write.name === saved.name.trim() &&
    list(write.keywords) === list(saved.keywords) &&
    list(write.excludeKeywords) === list(saved.excludeKeywords) &&
    [...write.statuses].sort().join(",") === [...saved.statuses].sort().join(",") &&
    write.excludeSingleSource === saved.excludeSingleSource &&
    JSON.stringify(write.filters) === JSON.stringify(saved.filters)
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
