import { useEffect, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Money, PlatformAmount, PlatformInstant, ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import { fetchProcurementCard } from "../api/specialist.js";
import { Shell } from "../shell/Shell.js";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function formatInstant(value: PlatformInstant | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = value.precision === "date" ? value.date : value.at;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toLocaleDateString("ru-BY");
}

function formatMoney(amount: PlatformAmount | Money | undefined): string | undefined {
  if (amount === undefined) return undefined;
  if (("raw" in amount) && amount.raw.length > 0) return amount.raw;
  if (amount.amount === null || amount.amount === undefined) return undefined;
  const currency = "currency" in amount ? amount.currency : "BYN";
  return `${String(amount.amount)} ${currency}`;
}

export function ProcurementDetailApp({
  procurements,
}: {
  procurements: readonly SpecialistProcurementCard[];
}): ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const stored = procurements.find((item) => item.id === id);
  const [card, setCard] = useState<ProcedureCard | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined || stored?.triage !== "monitor") return;
    setLoading(true);
    setError(undefined);
    fetchProcurementCard(id)
      .then((next) => setCard(next))
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить карточку"))
      .finally(() => setLoading(false));
  }, [id, stored?.triage]);

  if (stored === undefined) {
    return (
      <Shell>
        <main className="procurement-detail">
          <p>Закупка не найдена.</p>
        </main>
      </Shell>
    );
  }

  const live = card;
  const buyer = live?.buyer;
  const amount = live?.amount ?? live?.startingPrice;

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
            {shortId(stored.id)} — {stored.title}
          </h1>
          <div className="procurement-detail-badges">
            <span className={`procurement-detail-triage triage-${stored.triage ?? ""}`}>
              {stored.triage === "monitor" ? "Слежу" : "Участвую"}
            </span>
            <span className="procurement-detail-status">{stored.statusLabel}</span>
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
          {!loading && stored.triage === "monitor" && live === undefined ? (
            <button
              type="button"
              className="procurement-detail-retry"
              onClick={() => {
                if (id === undefined) return;
                setLoading(true);
                setError(undefined);
                fetchProcurementCard(id)
                  .then((next) => setCard(next))
                  .catch((err) =>
                    setError(err instanceof Error ? err.message : "Не удалось загрузить карточку"),
                  )
                  .finally(() => setLoading(false));
              }}
            >
              Обновить
            </button>
          ) : null}
        </div>

        {stored.triage === "monitor" && live === undefined ? (
          <p className="procurement-detail-warning">
            Живая карточка с площадки не загрузилась. Показаны ранее сохранённые данные.
          </p>
        ) : null}

        {error ? <p className="procurement-detail-error">{error}</p> : null}

        <section className="procurement-detail-section">
          <h2 className="procurement-detail-section-title">Заказчик</h2>
          {buyer === undefined && stored.buyerName === undefined ? (
            <p>Нет данных о заказчике.</p>
          ) : (
            <dl className="procurement-detail-list">
              {buyer?.name !== undefined || stored.buyerName !== undefined ? (
                <>
                  <dt>Наименование</dt>
                  <dd>{buyer?.name ?? stored.buyerName}</dd>
                </>
              ) : null}
              {buyer?.registrationNumber ? (
                <>
                  <dt>УНП</dt>
                  <dd>{buyer.registrationNumber}</dd>
                </>
              ) : null}
              {buyer?.address ? (
                <>
                  <dt>Адрес</dt>
                  <dd>{buyer.address}</dd>
                </>
              ) : null}
              {buyer?.contact ? (
                <>
                  <dt>Контакты</dt>
                  <dd>{buyer.contact}</dd>
                </>
              ) : null}
            </dl>
          )}
        </section>

        <section className="procurement-detail-section">
          <h2 className="procurement-detail-section-title">Основная информация</h2>
          <dl className="procurement-detail-list">
            {live?.publishedAt ? (
              <>
                <dt>Дата размещения</dt>
                <dd>{formatInstant(live.publishedAt)}</dd>
              </>
            ) : null}
            {live?.bidsDeadline ? (
              <>
                <dt>Дата окончания приёма</dt>
                <dd>{formatInstant(live.bidsDeadline)}</dd>
              </>
            ) : null}
            {live?.auctionAt ? (
              <>
                <dt>Дата торгов</dt>
                <dd>{formatInstant(live.auctionAt)}</dd>
              </>
            ) : null}
            {formatMoney(amount) ?? stored.amountLabel ? (
              <>
                <dt>Общая предельная стоимость</dt>
                <dd>{formatMoney(amount) ?? stored.amountLabel}</dd>
              </>
            ) : null}
          </dl>
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
          {live?.rawFields !== undefined && Object.keys(live.rawFields).length > 0 ? (
            <details className="procurement-detail-raw">
              <summary>Дополнительные сведения с площадки</summary>
              <dl className="procurement-detail-list">
                {Object.entries(live.rawFields).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
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
          <summary>Лоты ({live?.lots.length ?? 0})</summary>
          {live === undefined || live.lots.length === 0 ? (
            <p className="procurement-detail-empty">Нет данных о лотах.</p>
          ) : (
            <ul className="procurement-detail-lots">
              {live.lots.map((lot) => (
                <li key={lot.number} className="procurement-detail-lot">
                  <p className="procurement-detail-lot-title">
                    Лот {lot.number}: {lot.title}
                  </p>
                  {lot.quantity !== undefined ? (
                    <p className="procurement-detail-lot-quantity">
                      {lot.quantity} {lot.unit ?? ""}
                    </p>
                  ) : null}
                  {formatMoney(lot.startingPrice) ? (
                    <p className="procurement-detail-lot-price">{formatMoney(lot.startingPrice)}</p>
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
