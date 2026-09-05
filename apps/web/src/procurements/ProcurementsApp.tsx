import { useNavigate, useParams } from "react-router-dom";
import { useRef, useState } from "react";
import type {
  SpecialistCaseDocument,
  SpecialistProcurementCard,
  SpecialistSearchResponse,
  SpecialistTriageKind,
} from "@procurement/contracts";
import { Shell } from "../shell/Shell.js";

export function documentHref(document: SpecialistCaseDocument): string {
  return document.hash === undefined
    ? (document.downloadUrl ?? document.sourceUrl)
    : `/api/documents/${document.hash}`;
}

export function documentStatusLabel(document: SpecialistCaseDocument): string {
  const extraction = document.extraction;
  if (extraction === undefined) {
    return document.status === "hashed"
      ? `sha256 ${document.hash?.slice(0, 12) ?? ""}…, ${String(document.sizeBytes ?? 0)} байт`
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

export function ProcurementsApp({
  items: catalog,
  search,
  decide,
}: {
  items: readonly SpecialistProcurementCard[];
  search?: () => Promise<SpecialistSearchResponse>;
  decide?: (id: string, kind: SpecialistTriageKind) => Promise<readonly SpecialistProcurementCard[]>;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const [items, setItems] = useState(catalog);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const catalogRef = useRef(catalog);
  if (catalogRef.current !== catalog) {
    catalogRef.current = catalog;
    setItems(catalog);
  }
  const selected = items.find((item) => item.id === params["id"]) ?? items[0];

  async function runSearch(): Promise<void> {
    if (search === undefined || busy) return;
    setBusy(true);
    try {
      const result = await search();
      setItems(result.items);
      setNotice(
        `По профилю «${result.profileName}»: найдено ${String(result.relevantCount)}, отброшено ${String(result.discardedCount)}.`,
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
    try {
      const next = await decide(selected.id, kind);
      setItems(next);
      if (kind === "reject") {
        setNotice("Закупка скрыта и больше не будет предлагаться.");
        const remaining = next[0];
        await navigate(remaining === undefined ? "/procurements" : `/procurements/${remaining.id}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить решение.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <main className="workspace">
        <section className="inbox" aria-labelledby="procurements-heading">
          <div className="inbox-toolbar">
            <h1 id="procurements-heading">Закупки</h1>
            <button
              type="button"
              className="search-profile"
              disabled={search === undefined || busy}
              onClick={() => {
                void runSearch();
              }}
            >
              {busy ? "Ищем…" : "Искать по профилю"}
            </button>
          </div>
          {notice === undefined ? null : <p className="search-notice">{notice}</p>}
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
                      className={isSelected ? "inbox-row is-selected" : "inbox-row"}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        void navigate(`/procurements/${item.id}`);
                      }}
                    >
                      <span className="inbox-row-top">
                        <span className="inbox-title">{item.title}</span>
                        <span className="inbox-marks">
                          {item.live ? <span className="live-mark">живая</span> : null}
                          {item.triage === undefined ? null : (
                            <span className="triage-mark">{triageLabel(item.triage)}</span>
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

        <section className="detail" aria-labelledby="case-heading">
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
              {decide === undefined ? null : (
                <div className="triage-actions">
                  <button
                    type="button"
                    className="search-profile"
                    disabled={busy}
                    onClick={() => {
                      void runDecide("monitor");
                    }}
                  >
                    Отслеживать
                  </button>
                  <button
                    type="button"
                    className="search-profile"
                    disabled={busy}
                    onClick={() => {
                      void runDecide("participate");
                    }}
                  >
                    Участвовать
                  </button>
                  <button
                    type="button"
                    className="search-profile"
                    disabled={busy}
                    onClick={() => {
                      void runDecide("reject");
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
              {selected.documents.length === 0 ? null : (
                <>
                  <h3>Документы</h3>
                  <ul className="doc-list">
                    {selected.documents.map((document) => (
                      <li key={document.sourceUrl}>
                        <a href={documentHref(document)} target="_blank" rel="noreferrer">
                          {document.name}
                        </a>
                        <span>{documentStatusLabel(document)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {selected.termsDetail === undefined ? null : (
                <>
                  <h3>Коммерческие условия</h3>
                  <pre className="change-body">{selected.termsDetail}</pre>
                </>
              )}
              {selected.paymentQuote === undefined ? null : (
                <>
                  <h3>Оплата на площадке</h3>
                  <pre className="change-body">{selected.paymentQuote}</pre>
                </>
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
