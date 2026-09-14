import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type {
  SpecialistCaseDocument,
  SpecialistIngestFileProgress,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistSearchResponse,
  SpecialistTriageKind,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import {
  ingestFileWeight,
  isRejectedTriage,
  isWatchedTriage,
  procurementsForProfile,
  profileDisplayName,
  specialistDocumentWasRead,
} from "@procurement/domain";
import { ConfirmToast, TRASH_MOVE_PROMPT } from "../shell/ConfirmToast.js";
import { Shell } from "../shell/Shell.js";
import { RelevanceNote } from "./RelevanceNote.js";
import { TermsEvidenceList } from "./TermsEvidenceList.js";

export function documentHref(document: SpecialistCaseDocument): string {
  return document.hash === undefined
    ? (document.downloadUrl ?? document.sourceUrl)
    : `/api/documents/${document.hash}`;
}

export function documentOpensInline(document: SpecialistCaseDocument): boolean {
  return document.name.toLowerCase().endsWith(".pdf");
}

export function ingestFileAsDocument(
  file: SpecialistIngestFileProgress,
  documents: readonly SpecialistCaseDocument[],
): SpecialistCaseDocument | undefined {
  const known = documents.find((item) => item.sourceUrl === file.sourceUrl);
  if (known !== undefined && (known.hash !== undefined || known.downloadUrl !== undefined)) {
    return known;
  }
  if (file.hash === undefined) return undefined;
  return {
    name: file.name,
    sourceUrl: file.sourceUrl,
    hash: file.hash,
    status: "hashed",
  };
}

export const officeDownloadFrame = "procurement-office-download";

export function documentStatusLabel(document: SpecialistCaseDocument): string {
  const extraction = document.extraction;
  if (extraction === undefined) {
    return document.status === "hashed"
      ? `· ${String(document.sizeBytes ?? 0)} байт`
      : (document.note ?? document.status);
  }
  const confidence = Math.round(extraction.confidence * 100);
  switch (extraction.kind) {
    case "digital_text":
      return `цифровой текст, ${String(extraction.pageCount)} стр.`;
    case "office_text":
      return `Word/Excel/PowerPoint, ${String(extraction.pageCount)} ч.`;
    case "ocr_scan":
      return `распознавание скана, ${String(extraction.pageCount)} стр., уверенность ${String(confidence)}%`;
    case "skipped_project":
      return "проект/чертёж, не распознавали";
    case "sparse_drawing":
      return `чертёж/скан, мало букв, ${String(extraction.pageCount)} стр.`;
    case "empty":
      return "пустой файл";
    case "non_pdf":
      return "формат не прочитан";
  }
}

export function ingestFileProgressLabel(file: SpecialistIngestFileProgress): string {
  switch (file.state) {
    case "pending":
      return "ожидает";
    case "downloading":
      return "скачивание";
    case "indexing":
      return `индексация ${String(ingestFileWeight(file.state, file.percent))}%`;
    case "read":
      return "Прочитано агентом";
    case "skipped":
      return "агент не разбирал";
    case "failed":
      return "ошибка";
  }
}

export function ingestProgressCaption(progress: SpecialistIngestProgress): string {
  if (progress.phase === "listing") return "Список документов…";
  if (progress.phase === "downloading") {
    return progress.currentName === undefined
      ? `Скачивание ${String(progress.percent)}%`
      : `Скачивание «${progress.currentName}» — ${String(progress.percent)}%`;
  }
  if (progress.phase === "failed") return "Индексация не удалась";
  const current = progress.files.find((item) => item.name === progress.currentName);
  if (progress.phase === "indexing" && current !== undefined) {
    return `Индексация «${current.name}» — ${String(ingestFileWeight(current.state, current.percent))}%`;
  }
  return `Индексация ${String(progress.percent)}%`;
}

function DocumentReadMark() {
  return (
    <span className="doc-read-mark" title="Прочитано агентом" aria-label="Прочитано агентом">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3.2 8.2 6.1 11l6.7-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function DocumentNameLink({ document }: { document: SpecialistCaseDocument }) {
  if (documentOpensInline(document)) {
    return (
      <a href={documentHref(document)} target="_blank" rel="noreferrer">
        {document.name}
      </a>
    );
  }
  return (
    <a href={documentHref(document)} target={officeDownloadFrame}>
      {document.name}
    </a>
  );
}

export function triageLabel(kind: SpecialistTriageKind): string {
  switch (kind) {
    case "monitor":
      return "отслеживаем";
    case "participate":
      return "участвуем";
    case "reject":
      return "не нужно";
  }
}

export function procurementRowClass(
  selected: boolean,
  triage: SpecialistTriageKind | undefined,
): string {
  return [
    "inbox-row",
    selected ? "is-selected" : undefined,
    triage === undefined ? undefined : `is-triage-${triage}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

export function triageActionClass(
  kind: SpecialistTriageKind,
  current: SpecialistTriageKind | undefined,
): string {
  return current === kind ? `search-profile is-pressed is-pressed-${kind}` : "search-profile";
}

export function ProcurementsApp({
  items: catalog,
  profiles = [],
  activeProfileId,
  search,
  selectProfile,
  decide,
  ingestProgress,
}: {
  items: readonly SpecialistProcurementCard[];
  profiles?: readonly SpecialistWorkingProfile[];
  activeProfileId?: string;
  search?: (offset?: number) => Promise<SpecialistSearchResponse>;
  selectProfile?: (id: string) => Promise<void>;
  decide?: (id: string, kind: SpecialistTriageKind) => Promise<readonly SpecialistProcurementCard[]>;
  ingestProgress?: (id: string) => Promise<SpecialistIngestProgress>;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const [catalogItems, setCatalogItems] = useState(catalog);
  const [chosenProfileId, setChosenProfileId] = useState(activeProfileId ?? profiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<SpecialistTriageKind | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [searchPct, setSearchPct] = useState(0);
  const searching = busy && busyKind === undefined;
  useEffect(() => {
    if (!searching) {
      setSearchPct(0);
      return undefined;
    }
    // Simulated progress: the request is a single call, so the percent eases
    // toward 90 and the overlay closes when the response arrives.
    const timer = setInterval(() => {
      setSearchPct((pct) =>
        pct >= 90 ? pct : pct + Math.max(1, Math.round((90 - pct) * 0.08)),
      );
    }, 300);
    return () => clearInterval(timer);
  }, [searching]);
  const [progress, setProgress] = useState<SpecialistIngestProgress | undefined>();
  const ingestGeneration = useRef(0);
  const showingSearch = useRef(false);
  const catalogRef = useRef(catalog);
  if (catalogRef.current !== catalog) {
    catalogRef.current = catalog;
    // Parent refreshed a card (decide / inbox). Update rows already on screen
    // without swapping a search hit list for the whole database catalog.
    setCatalogItems((current) => {
      const incoming = catalog.filter(isSearchQueueCard);
      if (!showingSearch.current) return incoming;
      const byId = new Map(incoming.map((item) => [item.id, item] as const));
      return current
        .map((item) => byId.get(item.id) ?? item)
        .filter(isSearchQueueCard);
    });
  }
  const chosenProfile = profiles.find((item) => item.id === chosenProfileId);
  const items = procurementsForProfile(
    catalogItems.filter(isSearchQueueCard),
    chosenProfile,
  );
  const selected = items.find((item) => item.id === params["id"]) ?? items[0];
  const ingestForSelected =
    selected !== undefined &&
    progress !== undefined &&
    progress.procurementId === selected.id
      ? progress
      : undefined;
  const showCommercial =
    selected !== undefined &&
    (selected.termsDetail !== undefined ||
      selected.paymentQuote !== undefined ||
      (selected.triage === "participate" && selected.documents.length > 0));

  async function runSearch(offset = 0): Promise<void> {
    if (search === undefined || busy) return;
    setBusy(true);
    try {
      if (selectProfile !== undefined && chosenProfileId.length > 0) {
        await selectProfile(chosenProfileId);
      }
      const result = await search(offset);
      showingSearch.current = true;
      setCatalogItems(result.items);
      setHasMore(result.hasMore);
      setNextOffset(offset + 100);
      setNotice(
        `По профилю «${result.profileName}»: найдено ${String(result.relevantCount)}, отброшено ${String(result.discardedCount)}, сомнительных во входящих ${String(result.ambiguousCount)}.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Не удалось выполнить поиск по профилю.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function runDecide(kind: SpecialistTriageKind): Promise<void> {
    if (decide === undefined || selected === undefined || busy) return;
    setBusy(true);
    setBusyKind(kind);
    const procurementId = selected.id;
    const generation = ++ingestGeneration.current;
    const pullProgress = (): void => {
      if (ingestProgress === undefined) return;
      void ingestProgress(procurementId)
        .then((next) => {
          if (ingestGeneration.current !== generation) return;
          setProgress(next);
        })
        .catch(() => undefined);
    };
    const timer =
      kind === "participate" && ingestProgress !== undefined
        ? window.setInterval(pullProgress, 400)
        : undefined;
    if (kind === "participate") pullProgress();
    try {
      const next = await decide(procurementId, kind);
      const updated = next.find((item) => item.id === procurementId);
      if (kind === "reject" || kind === "monitor" || kind === "participate") {
        const without = catalogItems.filter((item) => item.id !== procurementId);
        setCatalogItems(without);
        if (kind === "reject") {
          setNotice("Перемещено в корзину. Вернуть можно в разделе «Корзина».");
        } else if (kind === "participate" && updated !== undefined) {
          setNotice(
            "Участвуем. Карточка в «Мои закупки». Документы скачиваются — можно открыть другой раздел.",
          );
        } else {
          setNotice("Отслеживаем. Карточка в «Мои закупки».");
        }
        const remaining = procurementsForProfile(
          without.filter(isSearchQueueCard),
          chosenProfile,
        )[0];
        await navigate(remaining === undefined ? "/procurements" : `/procurements/${remaining.id}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить решение.");
    } finally {
      ingestGeneration.current += 1;
      if (timer !== undefined) window.clearInterval(timer);
      setProgress(undefined);
      setBusy(false);
      setBusyKind(undefined);
    }
  }

  return (
    <Shell>
      {rejectConfirm ? (
        <ConfirmToast
          message={TRASH_MOVE_PROMPT}
          onConfirm={() => {
            setRejectConfirm(false);
            void runDecide("reject");
          }}
          onCancel={() => {
            setRejectConfirm(false);
          }}
        />
      ) : null}
      <main className="workspace">
        <section className="inbox" aria-labelledby="procurements-heading">
          <div className="inbox-toolbar">
            <h1 id="procurements-heading">Закупки</h1>
            <div className="inbox-search">
              {profiles.length === 0 ? null : (
                <>
                  <label htmlFor="search-profile-select">Профиль</label>
                  <select
                    id="search-profile-select"
                    value={chosenProfileId}
                    disabled={busy}
                    onChange={(event) => {
                      const id = event.target.value;
                      setChosenProfileId(id);
                      const profile = profiles.find((item) => item.id === id);
                      const next = procurementsForProfile(catalogItems, profile);
                      const keep = next.find((item) => item.id === selected?.id) ?? next[0];
                      void (async () => {
                        if (selectProfile !== undefined) await selectProfile(id);
                        await navigate(
                          keep === undefined ? "/procurements" : `/procurements/${keep.id}`,
                        );
                      })();
                    }}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profileDisplayName(profile)}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <button
                type="button"
                className="search-profile"
                disabled={search === undefined || busy}
                onClick={() => {
                  void runSearch();
                }}
              >
                {searching ? "Ищем…" : "Искать по профилю"}
              </button>
              {hasMore && search !== undefined ? (
                <button
                  type="button"
                  className="search-profile"
                  disabled={busy}
                  onClick={() => {
                    void runSearch(nextOffset);
                  }}
                >
                  Загрузить ещё
                </button>
              ) : null}
            </div>
          </div>
          {notice === undefined ? null : <p className="search-notice">{notice}</p>}
          {searching ? (
            <div className="search-overlay" role="status" aria-live="polite">
              <div className="search-spinner">
                <span className="search-spinner-pct">{searchPct}%</span>
              </div>
              <p className="search-overlay-text">Ищем закупки на площадке…</p>
            </div>
          ) : null}
          {items.length === 0 ? (
            <p className="empty">Нет закупок в работе</p>
          ) : (
            <ul className="inbox-list">
              {items.map((item) => {
                const isSelected = selected?.id === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={procurementRowClass(isSelected, item.triage)}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        void navigate(`/procurements/${item.id}`);
                      }}
                    >
                      <span className="inbox-row-top">
                        <span className="inbox-title">{item.title}</span>
                        <span className="inbox-marks">
                          {item.live ? (
                            <span className="live-mark" title="Карточка с площадки">
                              live
                            </span>
                          ) : null}
                          {item.triage === undefined ? null : (
                            <span className={`triage-mark is-${item.triage}`}>
                              {triageLabel(item.triage)}
                            </span>
                          )}
                          {item.latestChange?.urgent === true ? (
                            <span className="urgent-mark">Срочно</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="inbox-summary">{item.statusLabel}</span>
                      <span className="inbox-date">{item.sourceProcurementId}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section
          className={
            selected?.triage === undefined ? "detail" : `detail is-triage-${selected.triage}`
          }
          aria-labelledby="case-heading"
        >
          {selected === undefined ? (
            <>
              <h2 id="case-heading">Закупка</h2>
              <p className="empty">Нет закупок в работе</p>
            </>
          ) : (
            <>
              <h2 id="case-heading">{selected.title}</h2>
              <dl className="detail-meta">
                <div>
                  <dt>Номер</dt>
                  <dd>{selected.sourceProcurementId}</dd>
                </div>
                <div>
                  <dt>Статус</dt>
                  <dd>{selected.statusLabel}</dd>
                </div>
                <div>
                  <dt>Площадка</dt>
                  <dd>
                    <a href={selected.url} target="_blank" rel="noreferrer">
                      {selected.url}
                    </a>
                  </dd>
                </div>
                {selected.kindLabel === undefined ? null : (
                  <div>
                    <dt>Вид</dt>
                    <dd>{selected.kindLabel}</dd>
                  </div>
                )}
                {selected.buyerName === undefined ? null : (
                  <div>
                    <dt>Заказчик</dt>
                    <dd>{selected.buyerName}</dd>
                  </div>
                )}
                {selected.amountLabel === undefined ? null : (
                  <div>
                    <dt>Сумма</dt>
                    <dd>{selected.amountLabel}</dd>
                  </div>
                )}
              </dl>
              <RelevanceNote card={selected} />
              {decide === undefined ? null : (
                <div className="triage-actions">
                  <button
                    type="button"
                    className={triageActionClass("monitor", selected.triage)}
                    aria-pressed={selected.triage === "monitor"}
                    disabled={busy}
                    onClick={() => {
                      void runDecide("monitor");
                    }}
                  >
                    Отслеживать
                  </button>
                  <button
                    type="button"
                    className={triageActionClass("participate", selected.triage)}
                    aria-pressed={selected.triage === "participate"}
                    disabled={busy}
                    onClick={() => {
                      void runDecide("participate");
                    }}
                  >
                    {busyKind === "participate"
                      ? (ingestForSelected === undefined
                        ? "Скачиваем документы…"
                        : ingestProgressCaption(ingestForSelected))
                      : "Участвовать"}
                  </button>
                  <button
                    type="button"
                    className={triageActionClass("reject", selected.triage)}
                    aria-pressed={selected.triage === "reject"}
                    disabled={busy}
                    onClick={() => {
                      setRejectConfirm(true);
                    }}
                  >
                    Не нужно
                  </button>
                </div>
              )}
              {selected.actions.length === 0 ? null : (
                <>
                  <h3>Что сделано</h3>
                  <ul className="missing-list">
                    {selected.actions.map((action) => (
                      <li key={`${String(action.step)}-${action.actor}`}>{action.detail}</li>
                    ))}
                  </ul>
                </>
              )}
              {ingestForSelected === undefined ? null : (
                <div className="ingest-progress" aria-live="polite">
                  <div className="ingest-progress-label">{ingestProgressCaption(ingestForSelected)}</div>
                  <div
                    className="ingest-progress-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={ingestForSelected.percent}
                  >
                    <span style={{ width: `${String(ingestForSelected.percent)}%` }} />
                  </div>
                </div>
              )}
              {ingestForSelected !== undefined &&
              ingestForSelected.files.length > 0 &&
              selected.documents.length === 0 ? (
                <>
                  <h3>Документы</h3>
                  <iframe
                    name={officeDownloadFrame}
                    title="Загрузка документа"
                    hidden
                  />
                  <ul className="doc-list">
                    {ingestForSelected.files.map((file) => {
                      const document = ingestFileAsDocument(file, selected.documents);
                      return (
                        <li key={file.sourceUrl}>
                          {document === undefined ? (
                            <span className="doc-file-name">{file.name}</span>
                          ) : (
                            <DocumentNameLink document={document} />
                          )}
                          {file.state === "read" ? (
                            <DocumentReadMark />
                          ) : (
                            <span className="doc-file-meta">{ingestFileProgressLabel(file)}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : selected.documents.length === 0 && !showCommercial ? null : (
                <div className="case-columns">
                  {selected.documents.length === 0 ? null : (
                    <div>
                      <h3>Документы</h3>
                      <iframe
                        name={officeDownloadFrame}
                        title="Загрузка документа"
                        hidden
                      />
                      <ul className="doc-list">
                        {selected.documents.map((document) => (
                          <li key={document.sourceUrl}>
                            <DocumentNameLink document={document} />
                            {specialistDocumentWasRead(document) ? <DocumentReadMark /> : null}
                            <span className="doc-file-meta">{documentStatusLabel(document)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {showCommercial ? (
                    <div>
                      <h3>Коммерческие условия</h3>
                      <pre className="change-body">
                        {selected.termsDetail ??
                          "В разобранном тексте нет аванса, срока в днях и гарантии. Смотрите цитаты в тексте документа."}
                      </pre>
                      <TermsEvidenceList items={selected.termsEvidence} />
                      {selected.paymentQuote === undefined ? null : (
                        <>
                          <h3>Оплата на площадке</h3>
                          <pre className="change-body">{selected.paymentQuote}</pre>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
              {selected.missing.length === 0 ? null : (
                <>
                  <h3>Не хватает</h3>
                  <ul className="missing-list">
                    {selected.missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {selected.latestChange === undefined ? null : (
                <>
                  <h3>Последнее изменение</h3>
                  <pre className="change-body">{selected.latestChange.detail}</pre>
                </>
              )}
            </>
          )}
        </section>
      </main>
    </Shell>
  );
}

function isSearchQueueCard(item: SpecialistProcurementCard): boolean {
  return !isWatchedTriage(item) && !isRejectedTriage(item.triage);
}
