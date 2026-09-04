import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistProcurementCard } from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fixture from "../../../../tests/fixtures/specialist/inbox.json";
import { documentHref, documentStatusLabel, ProcurementsApp } from "./ProcurementsApp.js";

afterEach(() => {
  cleanup();
});

describe("ProcurementsApp", () => {
  it("labels a skipped project album without implying OCR", () => {
    const label = documentStatusLabel({
      name: "23-301-50-100-jekn.pdf",
      sourceUrl: "https://goszakupki.by/files/1",
      hash: "a".repeat(64),
      sizeBytes: 100,
      status: "hashed",
      extraction: {
        status: "skipped_project",
        kind: "skipped_project",
        pageCount: 27,
        letterCount: 0,
        confidence: 1,
        ocrApplied: false,
        textPreview: "",
        pages: [],
        notes: ["Файл похож на альбом проекта."],
      },
    });
    expect(label).toContain("не распознавали");
  });

  it("opens the household case from the list without treating it as an urgent inbox row", async () => {
    const user = userEvent.setup();
    const items = SpecialistCatalog.parse(fixture).procurements();
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route path="/procurements" element={<ProcurementsApp items={items} />} />
          <Route path="/procurements/:id" element={<ProcurementsApp items={items} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /Бытовой щиток/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Бытовой щиток/ }));

    expect(screen.getByRole("heading", { level: 2, name: "Бытовой щиток" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://goszakupki.by/auction/view/003" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Бытовой щиток" }).closest("section")?.textContent,
    ).toContain("объявлена");
    expect(screen.getByRole("heading", { level: 3, name: "Последнее изменение" }).closest("section")?.textContent).toContain(
      "10000 → 9000",
    );
  });

  it("opens a hashed PDF from the local API copy instead of goszakupki.by", async () => {
    const user = userEvent.setup();
    const hash = "a".repeat(64);
    const document = {
      name: "Документация.pdf",
      sourceUrl: "https://goszakupki.by/files/1",
      downloadUrl: "https://goszakupki.by/files/download/1",
      hash,
      sizeBytes: 1024,
      status: "hashed" as const,
    };
    const items = [
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000301",
        title: "Живой КТПБ",
        status: "accepting_bids",
        statusLabel: "приём заявок",
        url: "https://goszakupki.by/auction/view/3629820",
        sourceProcurementId: "auction/3629820",
        live: true,
        documents: [document],
        termsDetail: "Срок поставки: 60 дн.\nГарантия: 60 мес.",
        extractPreview: "УТВЕРЖДАЮ Г лавный инженер каша OCR",
        extractNotes: ["Текст взят из Word, без OCR."],
        reportMarkdown: "# 2БКТПБ\n\nСрок поставки: 60 дн.\nГарантия: 60 мес.",
      }),
    ];

    expect(documentHref(document)).toBe(`/api/documents/${hash}`);

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route path="/procurements" element={<ProcurementsApp items={items} />} />
          <Route path="/procurements/:id" element={<ProcurementsApp items={items} />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /Живой КТПБ/ }));
    expect(screen.getByRole("link", { name: "Документация.pdf" }).getAttribute("href")).toBe(
      `/api/documents/${hash}`,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Коммерческие условия" })).toBeTruthy();
    expect(screen.getByText(/Срок поставки: 60 дн/)).toBeTruthy();
    expect(screen.getByText(/Гарантия: 60 мес/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Текст документов" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Отчёт" })).toBeNull();
    expect(screen.queryByText(/Г лавный инженер/)).toBeNull();
  });

  it("adds profile matches from search without a keyword text field", async () => {
    const user = userEvent.setup();
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
      amountLabel: "125 000,00 BYN",
      actions: [
        {
          step: 1,
          actor: "DomainSearchAgent",
          status: "done",
          detail:
            "procurement.search: найдена «Комплектная трансформаторная подстанция». Документы ещё не брали.",
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[]}
                search={async () => ({
                  profileName: "Электротехническое оборудование",
                  relevantCount: 1,
                  discardedCount: 3,
                  items: [found],
                })}
              />
            }
          />
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[]}
                search={async () => ({
                  profileName: "Электротехническое оборудование",
                  relevantCount: 1,
                  discardedCount: 3,
                  items: [found],
                })}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Искать по профилю" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Искать по профилю" }));

    expect(screen.getByRole("button", { name: /Комплектная трансформаторная подстанция/ })).toBeTruthy();
    expect(screen.getByText(/найдено 1, отброшено 3/)).toBeTruthy();
    expect(screen.getByText(/Документы ещё не брали/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
