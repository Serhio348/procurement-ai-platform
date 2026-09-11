import { useEffect, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import {
  bidsDeadlinePassed,
  isSingleSourceAfterFailedProcedure,
  procedureBuyerFields,
  procedureDetailFields,
  procedurePublicId,
} from "@procurement/domain";
import { fetchProcurementCard } from "../api/specialist.js";
import { Shell } from "../shell/Shell.js";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function ProcurementDetailApp({
  procurements,
  onCardLoaded,
}: {
  procurements: readonly SpecialistProcurementCard[];
  onCardLoaded?: (card: SpecialistProcurementCard) => void;
}): ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const stored = procurements.find((item) => item.id === id);
  const [live, setLive] = useState<ProcedureCard | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLive(undefined);
    setError(undefined);
    if (id === undefined || stored === undefined) return;
    if (stored.sourceCard !== undefined) return;
    if (stored.triage !== "monitor" && stored.triage !== "participate") return;
    void loadCard(id);
  }, [id, stored?.id, stored?.sourceCard, stored?.triage]);

  async function loadCard(procurementId: string): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchProcurementCard(procurementId);
      setLive(next);
      if (stored !== undefined && onCardLoaded !== undefined) {
        onCardLoaded({ ...stored, sourceCard: next });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить карточку");
    } finally {
      setLoading(false);
    }
  }

  if (stored === undefined) {
    return (
      <Shell>
        <main className="procurement-detail">
          <p>Закупка не найдена.</p>
        </main>
      </Shell>
    );
  }

  const source = live ?? stored.sourceCard;
  const buyerRows = source === undefined ? [] : procedureBuyerFields(source);
  const detailRows = source === undefined ? [] : procedureDetailFields(source);
  const publicId = source === undefined ? undefined : procedurePublicId(source);
  const lots = source?.lots ?? [];

  return (
    <Shell>
      <main className="procurement-detail">
        <p className="procurement-detail-back">
          <button type="button" className="procurement-detail-back-link" onClick={() => navigate(-1)}>
            ← Назад
          </button>
        </p>
        <header className="procurement-detail-header">
          <h1 className="procurement-detail-title">
            {publicId ?? shortId(stored.id)} — {stored.title}
          </h1>
          <div className="procurement-detail-badges">
            <span className={`procurement-detail-triage triage-${stored.triage ?? ""}`}>
              {stored.triage === "monitor" ? "Слежу" : "Участвую"}
            </span>
            <span className="procurement-detail-status">{stored.statusLabel}</span>
            {bidsDeadlinePassed(
              source === undefined ? stored : { ...stored, sourceCard: source },
              new Date(),
            ) ? (
              <span className="procurement-detail-expired">срок подачи истёк</span>
            ) : null}
            {source !== undefined && isSingleSourceAfterFailedProcedure(source) ? (
              <span className="procurement-detail-after-failed">
                из одного источника после несостоявшейся процедуры
              </span>
            ) : null}
          </div>
        </header>

        <div className="procurement-detail-toolbar">
          <a
            href={stored.url}
            target="_blank"
            rel="noopener noreferrer"
            className="procurement-detail-link"
          >
            Открыть на goszakupki.by
          </a>
          {loading ? <span className="procurement-detail-loading">Загрузка с площадки…</span> : null}
          {!loading ? (
            <button
              type="button"
              className="procurement-detail-retry"
              onClick={() => {
                if (id !== undefined) void loadCard(id);
              }}
            >
              Обновить
            </button>
          ) : null}
        </div>

        {source === undefined ? (
          <p className="procurement-detail-warning">
            Карточка площадки ещё не сохранена. Показаны данные из поиска. Нажмите «Обновить», чтобы
            загрузить страницу источника.
          </p>
        ) : null}

        {error ? <p className="procurement-detail-error">{error}</p> : null}

        <section className="procurement-detail-section">
          <h2 className="procurement-detail-section-title">Заказчик</h2>
          {buyerRows.length === 0 && stored.buyerName === undefined ? (
            <p>Нет данных о заказчике.</p>
          ) : (
            <dl className="procurement-detail-list">
              {buyerRows.length === 0 ? (
                <>
                  <dt>Наименование</dt>
                  <dd>{stored.buyerName}</dd>
                </>
              ) : (
                buyerRows.map((row) => (
                  <div key={row.label} className="procurement-detail-row">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))
              )}
            </dl>
          )}
        </section>

        <section className="procurement-detail-section">
          <h2 className="procurement-detail-section-title">Основная информация</h2>
          {detailRows.length === 0 && stored.amountLabel === undefined ? (
            <p>Нет данных с карточки площадки.</p>
          ) : (
            <dl className="procurement-detail-list">
              {detailRows.length === 0 ? (
                <>
                  <dt>Общая стоимость</dt>
                  <dd>{stored.amountLabel}</dd>
                </>
              ) : (
                detailRows.map((row) => (
                  <div key={row.label} className="procurement-detail-row">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))
              )}
            </dl>
          )}
          {stored.termsDetail ? (
            <details className="procurement-detail-raw" open>
              <summary>Условия из документов</summary>
              <pre className="procurement-detail-terms">{stored.termsDetail}</pre>
            </details>
          ) : null}
          {stored.paymentQuote ? (
            <p className="procurement-detail-quote">
              <strong>Расчёт:</strong> {stored.paymentQuote}
            </p>
          ) : null}
        </section>

        <details className="procurement-detail-collapse">
          <summary>Документы ({stored.documents.length})</summary>
          {stored.documents.length === 0 ? (
            <p className="procurement-detail-empty">Документы ещё не скачаны.</p>
          ) : (
            <ul className="procurement-detail-documents">
              {stored.documents.map((doc) => (
                <li key={doc.sourceUrl} className="procurement-detail-document">
                  <a
                    href={doc.hash === undefined ? doc.downloadUrl ?? doc.sourceUrl : `/api/documents/${doc.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {doc.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </details>

        <details className="procurement-detail-collapse">
          <summary>Лоты ({lots.length})</summary>
          {lots.length === 0 ? (
            <p className="procurement-detail-empty">Нет данных о лотах.</p>
          ) : (
            <ul className="procurement-detail-lots">
              {lots.map((lot) => (
                <li key={lot.number} className="procurement-detail-lot">
                  <p className="procurement-detail-lot-title">
                    Лот {lot.number}: {lot.title}
                  </p>
                  {lot.quantity !== undefined ? (
                    <p className="procurement-detail-lot-quantity">
                      {lot.quantity} {lot.unit ?? ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </details>
      </main>
    </Shell>
  );
}
