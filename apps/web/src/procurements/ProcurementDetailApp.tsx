import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  ProcedureCard,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistTriageKind,
} from "@procurement/contracts";
import {
  bidsDeadlinePassed,
  isSingleSourceAfterFailedProcedure,
  procedureBuyerFields,
  procedureDetailFields,
  procedurePublicId,
} from "@procurement/domain";
import { fetchProcurementCard } from "../api/specialist.js";
import { ConfirmToast, TRASH_PURGE_PROMPT } from "../shell/ConfirmToast.js";
import { Shell } from "../shell/Shell.js";
import { DocumentNameLink, ingestProgressCaption, officeDownloadFrame, triageActionClass } from "./ProcurementsApp.js";
import { RelevanceNote } from "./RelevanceNote.js";
import { TermsEvidenceList } from "./TermsEvidenceList.js";

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

export function ProcurementDetailApp({
  procurements,
  onCardLoaded,
  fetchCase,
  decide,
  restore,
  purge,
  ingestProgress,
}: {
  procurements: readonly SpecialistProcurementCard[];
  onCardLoaded?: (card: SpecialistProcurementCard) => void;
  fetchCase?: (id: string) => Promise<SpecialistProcurementCard>;
  decide?: (id: string, kind: SpecialistTriageKind) => Promise<readonly SpecialistProcurementCard[]>;
  restore?: (id: string) => Promise<readonly SpecialistProcurementCard[]>;
  purge?: (id: string) => Promise<void>;
  ingestProgress?: (id: string) => Promise<SpecialistIngestProgress>;
}): ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const fromList = procurements.find((item) => item.id === id);
  const [fetched, setFetched] = useState<SpecialistProcurementCard | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const stored = fromList ?? fetched;
  const [live, setLive] = useState<ProcedureCard | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyKind, setBusyKind] = useState<SpecialistTriageKind | undefined>();
  const [trashBusy, setTrashBusy] = useState<"restore" | "purge" | undefined>();
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const [progress, setProgress] = useState<SpecialistIngestProgress | undefined>();
  const ingestGeneration = useRef(0);

  useEffect(() => {
    setMissing(false);
    if (id === undefined || fromList !== undefined || fetchCase === undefined) {
      if (fromList !== undefined) setFetched(undefined);
      return undefined;
    }
    let cancelled = false;
    setFetched(undefined);
    void fetchCase(id)
      .then((card) => {
        if (cancelled) return;
        setFetched(card);
        onCardLoaded?.(card);
      })
      .catch(() => {
        if (!cancelled) {
          setFetched(undefined);
          setMissing(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, fromList, fetchCase, onCardLoaded]);

  useEffect(() => {
    setLive(undefined);
    setError(undefined);
    if (id === undefined || stored === undefined) return;
    if (stored.sourceCard !== undefined) return;
    if (stored.triage !== "monitor" && stored.triage !== "participate" && stored.triage !== "reject") {
      return;
    }
    void loadPlatformCard(id);
  }, [id, stored?.id, stored?.sourceCard, stored?.triage]);

  async function loadPlatformCard(procurementId: string): Promise<void> {
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

  async function runDecide(kind: SpecialistTriageKind): Promise<void> {
    if (decide === undefined || stored === undefined || busyKind !== undefined) return;
    if (stored.triage === kind) return;
    setBusyKind(kind);
    const procurementId = stored.id;
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
      const next = await decide(stored.id, kind);
      const updated = next.find((item) => item.id === stored.id);
      if (updated !== undefined) onCardLoaded?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить решение");
    } finally {
      ingestGeneration.current += 1;
      if (timer !== undefined) window.clearInterval(timer);
      setProgress(undefined);
      setBusyKind(undefined);
    }
  }

  async function runRestore(): Promise<void> {
    if (restore === undefined || stored === undefined || trashBusy !== undefined) return;
    setTrashBusy("restore");
    try {
      const next = await restore(stored.id);
      const updated = next.find((item) => item.id === stored.id);
      if (updated !== undefined) onCardLoaded?.(updated);
      navigate(`/my-procurements/${stored.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось вернуть закупку");
    } finally {
      setTrashBusy(undefined);
    }
  }

  async function runPurge(): Promise<void> {
    if (purge === undefined || stored === undefined || trashBusy !== undefined) return;
    setTrashBusy("purge");
    try {
      await purge(stored.id);
      navigate("/trash");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить закупку");
      setTrashBusy(undefined);
    }
  }

  if (stored === undefined) {
    const waiting = fetchCase !== undefined && id !== undefined && !missing;
    return (
      <Shell>
        <main className="procurement-detail">
          <p>{waiting ? "Загрузка…" : "Закупка не найдена."}</p>
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
      {purgeConfirm ? (
        <ConfirmToast
          message={TRASH_PURGE_PROMPT}
          danger
          onConfirm={() => {
            setPurgeConfirm(false);
            void runPurge();
          }}
          onCancel={() => {
            setPurgeConfirm(false);
          }}
        />
      ) : null}
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
              {stored.triage === "monitor"
                ? "Слежу"
                : stored.triage === "participate"
                  ? "Участвую"
                  : stored.triage === "reject"
                    ? "Корзина"
                    : "Решение"}
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

        {stored.triage === "reject" ? (
          restore === undefined && purge === undefined ? null : (
            <div className="triage-actions procurement-detail-triage-actions">
              {restore === undefined ? null : (
                <button
                  type="button"
                  className="search-profile"
                  disabled={trashBusy !== undefined}
                  onClick={() => {
                    void runRestore();
                  }}
                >
                  {trashBusy === "restore" ? "Возвращаем…" : "Вернуть в «Мои закупки»"}
                </button>
              )}
              {purge === undefined ? null : (
                <button
                  type="button"
                  className="search-profile is-pressed-reject"
                  disabled={trashBusy !== undefined}
                  onClick={() => {
                    setPurgeConfirm(true);
                  }}
                >
                  {trashBusy === "purge" ? "Удаляем…" : "Удалить из корзины"}
                </button>
              )}
            </div>
          )
        ) : decide === undefined ? null : (
          <div className="triage-actions procurement-detail-triage-actions">
            <button
              type="button"
              className={triageActionClass("monitor", stored.triage)}
              aria-pressed={stored.triage === "monitor"}
              disabled={busyKind !== undefined}
              onClick={() => {
                void runDecide("monitor");
              }}
            >
              Отслеживать
            </button>
            <button
              type="button"
              className={triageActionClass("participate", stored.triage)}
              aria-pressed={stored.triage === "participate"}
              disabled={busyKind !== undefined}
              onClick={() => {
                void runDecide("participate");
              }}
            >
              {busyKind === "participate"
                ? (progress === undefined
                  ? "Скачиваем документы…"
                  : ingestProgressCaption(progress))
                : "Участвовать"}
            </button>
          </div>
        )}

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
                if (id !== undefined) void loadPlatformCard(id);
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

        <RelevanceNote card={stored} />

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
              <TermsEvidenceList items={stored.termsEvidence} />
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
            <>
              <iframe name={officeDownloadFrame} title="Загрузка документа" hidden />
              <ul className="procurement-detail-documents">
                {stored.documents.map((doc) => (
                  <li key={doc.sourceUrl} className="procurement-detail-document">
                    <DocumentNameLink document={doc} />
                  </li>
                ))}
              </ul>
            </>
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
