import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcedureCard, SpecialistIngestProgress, SpecialistProcurementCard } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProcurementDetailApp } from "./ProcurementDetailApp.js";

afterEach(() => {
  cleanup();
});

const source = ProcedureCard.parse({
  sourceId: "goszakupki_by",
  sourceProcurementId: "request/3545600",
  url: "https://goszakupki.by/request/view/3545600",
  title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
  fetchedAt: "2026-09-11T00:00:00.000Z",
  status: "accepting_bids",
  externalIds: [{ kind: "auc", value: "auc0003545600" }],
  buyer: {
    name: "Брестэнерго",
    registrationNumber: "200050653",
    address: "г. Брест, ул. Воровского, 13/1",
    contact: "Головко Роман Геннадьевич, +375333869267",
  },
  amount: { kind: "indicative", amount: 160651.42, currency: "BYN", raw: "160 651.42 BYN" },
  rawFields: {
    "Дата размещения приглашения": "03.09.2026",
    "Дата окончания приема предложений": "09.09.2026",
    "Общая ориентировочная стоимость закупки": "160 651.42 BYN",
    "Иные сведения": "Согласно заданию на закупку",
  },
});

describe("ProcurementDetailApp", () => {
  it("renders the stored platform card without fetching again", () => {
    const card = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000401",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "participate",
      buyerName: "Брестэнерго",
      amountLabel: "160 651.42 BYN",
      sourceCard: source,
      documents: [
        {
          name: "ТЗ.docx",
          sourceUrl: "https://goszakupki.by/files/1",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${card.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={<ProcurementDetailApp procurements={[card]} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/auc0003545600/)).toBeTruthy();
    expect(screen.getByText("200050653")).toBeTruthy();
    expect(screen.getByText("г. Брест, ул. Воровского, 13/1")).toBeTruthy();
    expect(screen.getByText("Головко Роман Геннадьевич, +375333869267")).toBeTruthy();
    expect(screen.getByText("160 651.42 BYN")).toBeTruthy();
    expect(screen.getByText("Согласно заданию на закупку")).toBeTruthy();
    expect(screen.queryByText("Загрузка с площадки…")).toBeNull();
  });

  it("reindexes downloaded files when the specialist refreshes a participate card", async () => {
    const user = userEvent.setup();
    const card = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000401",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "participate",
      sourceCard: source,
      documents: [
        {
          name: "ТЗ.docx",
          sourceUrl: "https://goszakupki.by/files/1",
          hash: "a".repeat(64),
          status: "hashed",
        },
      ],
    });
    const reindex = vi.fn(async () => [card]);

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${card.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={<ProcurementDetailApp procurements={[card]} reindex={reindex} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => {
      expect(reindex).toHaveBeenCalledWith(card.id);
    });
  });

  it("loads a case by id when the local list is empty", async () => {
    const card = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000402",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "participate",
      sourceCard: source,
    });
    let resolveCard!: (value: SpecialistProcurementCard) => void;
    const fetchCase = vi.fn(
      () =>
        new Promise<SpecialistProcurementCard>((resolve) => {
          resolveCard = resolve;
        }),
    );

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${card.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={<ProcurementDetailApp procurements={[]} fetchCase={fetchCase} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Загрузка…")).toBeTruthy();
    resolveCard(card);
    await waitFor(() => {
      expect(screen.getByText(/auc0003545600/)).toBeTruthy();
    });
  });

  it("lets the specialist switch from watching to participating", async () => {
    const user = userEvent.setup();
    const watching = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000403",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "monitor",
      sourceCard: source,
    });
    const decide = vi.fn(async () => [{ ...watching, triage: "participate" as const }]);

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${watching.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={
              <ProcurementDetailApp
                procurements={[watching]}
                decide={decide}
                onCardLoaded={() => undefined}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Отслеживать" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Участвовать" }));
    expect(decide).toHaveBeenCalledWith(watching.id, "participate");
  });

  it("restores a trashed card back into Мои закупки", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000404",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "reject",
      sourceCard: source,
    });
    const restore = vi.fn(async () => [{ ...trashed, triage: "monitor" as const }]);
    const onCardLoaded = vi.fn();

    render(
      <MemoryRouter initialEntries={[`/trash/${trashed.id}`]}>
        <Routes>
          <Route
            path="/trash/:id"
            element={
              <ProcurementDetailApp
                procurements={[trashed]}
                restore={restore}
                purge={async () => undefined}
                onCardLoaded={onCardLoaded}
              />
            }
          />
          <Route path="/my-procurements/:id" element={<p>Мои закупки</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Корзина" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отслеживать" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Вернуть в «Мои закупки»" }));
    expect(restore).toHaveBeenCalledWith(trashed.id);
    expect(onCardLoaded).toHaveBeenCalledWith(expect.objectContaining({ triage: "monitor" }));
    await waitFor(() => {
      expect(screen.getByText("Мои закупки")).toBeTruthy();
    });
  });

  it("purges a trashed card only after the in-app confirmation", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000405",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "reject",
      sourceCard: source,
    });
    const purge = vi.fn(async () => undefined);

    render(
      <MemoryRouter initialEntries={[`/trash/${trashed.id}`]}>
        <Routes>
          <Route
            path="/trash/:id"
            element={<ProcurementDetailApp procurements={[trashed]} purge={purge} />}
          />
          <Route path="/trash" element={<p>Список корзины</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Удалить из корзины" }));
    expect(purge).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(purge).toHaveBeenCalledWith(trashed.id);
    });
    await waitFor(() => {
      expect(screen.getByText("Список корзины")).toBeTruthy();
    });
  });

  it("keeps ingest progress on the card after the specialist opens it", async () => {
    const participating = SpecialistProcurementCard.parse({
      id: "92b439f2-0000-4000-8000-000000000405",
      title: "Реконструкция ВЛ-0,4 кВ от КТП-129",
      status: "accepting_bids",
      statusLabel: "Рассмотрение документов/сведений",
      url: "https://goszakupki.by/request/view/3545600",
      sourceProcurementId: "request/3545600",
      triage: "participate",
      sourceCard: source,
    });

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${participating.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={
              <ProcurementDetailApp
                procurements={[participating]}
                ingestProgress={async () =>
                  SpecialistIngestProgress.parse({
                    procurementId: participating.id,
                    phase: "downloading",
                    total: 1,
                    downloaded: 0,
                    indexed: 0,
                    readCount: 0,
                    percent: 15,
                    currentName: "ТЗ.pdf",
                    files: [
                      {
                        name: "ТЗ.pdf",
                        sourceUrl: "https://goszakupki.by/files/1",
                        state: "downloading",
                        percent: 15,
                      },
                    ],
                  })
                }
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getByText(/Скачивание «ТЗ.pdf» — 15%/)).toBeTruthy();
  });
});
