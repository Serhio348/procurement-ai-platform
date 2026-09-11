import { cleanup, render, screen } from "@testing-library/react";
import { ProcedureCard, SpecialistProcurementCard } from "@procurement/contracts";
import { afterEach, describe, expect, it } from "vitest";
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
});
