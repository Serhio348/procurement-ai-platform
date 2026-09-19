import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fixture from "../../../../tests/fixtures/specialist/inbox.json";
import {
  documentHref,
  documentStatusLabel,
  ingestFileAsDocument,
  ingestFileProgressLabel,
  ingestProgressCaption,
  ProcurementsApp,
} from "./ProcurementsApp.js";
import { ProcurementDetailApp } from "./ProcurementDetailApp.js";

afterEach(() => {
  cleanup();
});

const searchProfile = SpecialistWorkingProfile.parse({
  id: "00000000-0000-4000-8000-000000000901",
  name: "КТП",
  keywords: ["КТП"],
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

  it("does not glue sha256 onto a hashed filename", () => {
    const label = documentStatusLabel({
      name: "zapros-filtra.doc",
      sourceUrl: "https://goszakupki.by/files/1",
      hash: "c".repeat(64),
      sizeBytes: 75_264,
      status: "hashed",
    });
    expect(label).toBe("· 75264 байт");
    expect(label).not.toContain("sha256");
  });

  it("turns a finished ingest file into a hashed document without a reload", () => {
    expect(
      ingestFileAsDocument(
        {
          name: "договор.doc",
          sourceUrl: "https://example.test/files/1",
          state: "read",
          percent: 100,
          hash: "a".repeat(64),
        },
        [],
      ),
    ).toMatchObject({
      name: "договор.doc",
      hash: "a".repeat(64),
    });
  });

  it("names indexing percent and a finished file as read by the agent", () => {
    expect(
      ingestFileProgressLabel({
        name: "договор.doc",
        sourceUrl: "https://example.test/files/1",
        state: "indexing",
        percent: 0,
      }),
    ).toBe("индексация 20%");
    expect(
      ingestProgressCaption(
        SpecialistIngestProgress.parse({
          procurementId: "00000000-0000-4000-8000-000000000401",
          phase: "indexing",
          total: 1,
          downloaded: 1,
          indexed: 0,
          readCount: 0,
          percent: 20,
          currentName: "договор.doc",
          files: [
            {
              name: "договор.doc",
              sourceUrl: "https://example.test/files/1",
              state: "indexing",
              percent: 0,
            },
          ],
        }),
      ),
    ).toBe("Индексация «договор.doc» — 20%");
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
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.queryByText("живая")).toBeNull();
    expect(screen.getByRole("link", { name: "Документация.pdf" }).getAttribute("href")).toBe(
      `/api/documents/${hash}`,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Коммерческие условия" })).toBeTruthy();
    expect(screen.getByText(/Срок поставки: 60 дн/)).toBeTruthy();
    expect(screen.getByText(/Гарантия: 60 мес/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Текст документов" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Текст документа" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Отчёт" })).toBeNull();
    expect(screen.queryByText(/Г лавный инженер/)).toBeNull();
  });

  it("hands a Word file to the editor and keeps commercial notes on the card", () => {
    const items = [
      SpecialistProcurementCard.parse({
        id: "00000000-0000-4000-8000-000000000401",
        title: "Комплект фильтров",
        status: "unknown",
        statusLabel: "Подача предложений",
        url: "https://example.test/marketing/1",
        sourceProcurementId: "marketing/1",
        triage: "participate",
        termsDetail: "Оплата: по факту поставки.\nсрок поставки: сентябрь 2026г.",
        documents: [
          {
            name: "zapros-filtra.doc",
            sourceUrl: "https://example.test/files/1",
            hash: "a".repeat(64),
            sizeBytes: 75_264,
            status: "hashed",
            extraction: {
              status: "extracted",
              kind: "office_text",
              pageCount: 1,
              letterCount: 80,
              confidence: 0.86,
              ocrApplied: false,
              textPreview: "срок поставки: сентябрь 2026г.",
              pages: [
                {
                  page: 1,
                  text: "Заявка. срок поставки: сентябрь 2026г.; условия оплаты: по факту поставки;",
                  ocrApplied: false,
                  confidence: 0.86,
                },
              ],
            },
          },
        ],
      }),
    ];

    render(
      <MemoryRouter initialEntries={[`/my-procurements/${items[0]!.id}`]}>
        <Routes>
          <Route
            path="/my-procurements/:id"
            element={<ProcurementDetailApp procurements={items} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "zapros-filtra.doc" });
    expect(link.getAttribute("href")).toBe(`/api/documents/${"a".repeat(64)}`);
    expect(link.getAttribute("target")).toBe("procurement-office-download");
    expect(link.getAttribute("download")).toBeNull();
    expect(screen.getByText(/Оплата: по факту поставки/)).toBeTruthy();
    expect(screen.getByText(/сентябрь 2026/)).toBeTruthy();
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
      profileIds: [searchProfile.id],
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
                profiles={[searchProfile]}
                activeProfileId={searchProfile.id}
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
                profiles={[searchProfile]}
                activeProfileId={searchProfile.id}
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

  it("shows card-reading percent while the search run is scoring", () => {
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[]}
                searchRun={{
                  profileId: "00000000-0000-4000-8000-000000000901",
                  profileName: "КТП",
                  status: "scoring",
                  retrievedCount: 80,
                  scoredCount: 16,
                  matchCount: 2,
                  discardedCount: 14,
                  reviewCount: 0,
                  listingDiscardedCount: 0,
                  skipped: [
                    {
                      sourceProcurementId: "auction/skip-1",
                      title: "Монтаж сетей",
                      reason: "услуга в голове заголовка",
                      stage: "card",
                    },
                  ],
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toMatch(/Читаем карточки 16 из 80/);
    expect(screen.getByRole("status").textContent).toMatch(/20%/);
    expect(screen.getByText(/Найдено 2, отброшено 14/)).toBeTruthy();
    expect(screen.getByText("Почему не взяли (1)")).toBeTruthy();
  });

  it("still lists listing skips when the run opened no cards", () => {
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[]}
                searchRun={{
                  profileId: "00000000-0000-4000-8000-000000000901",
                  profileName: "КТП",
                  status: "done",
                  retrievedCount: 0,
                  scoredCount: 0,
                  matchCount: 0,
                  discardedCount: 0,
                  reviewCount: 0,
                  listingDiscardedCount: 1,
                  skipped: [
                    {
                      sourceProcurementId: "marketing/1037877",
                      title: "шкаф АСКУЭ",
                      reason: "статус процедуры не входит в профиль",
                      stage: "listing",
                    },
                  ],
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/не открывали 1/)).toBeTruthy();
    expect(screen.getByText("Почему не взяли (1)")).toBeTruthy();
    expect(screen.getByText("статус процедуры не входит в профиль")).toBeTruthy();
    expect(screen.getByText("шкаф АСКУЭ")).toBeTruthy();
  });

  it("does not keep the previous search at 100% while a new listing runs", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[]}
                profiles={[searchProfile]}
                activeProfileId={searchProfile.id}
                search={async () => {
                  await gate;
                  return {
                    profileName: "КТП",
                    relevantCount: 0,
                    discardedCount: 0,
                    items: [],
                  };
                }}
                searchRun={{
                  profileId: "00000000-0000-4000-8000-000000000901",
                  profileName: "Кабель",
                  status: "done",
                  retrievedCount: 80,
                  scoredCount: 80,
                  matchCount: 7,
                  discardedCount: 73,
                  reviewCount: 0,
                  listingDiscardedCount: 0,
                  skipped: [],
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Искать по профилю" }));
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/Ищем закупки на площадке/);
    expect(status).not.toMatch(/100%/);
    release();
  });

  it("shows one row when the same procedure arrives under two ids", () => {
    const first = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000411",
      title: "Комплекс средств защиты и инструмента",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/marketing/view/3674081",
      sourceProcurementId: "marketing/3674081",
      foundAs: "match",
    });
    const second = SpecialistProcurementCard.parse({
      ...first,
      id: "00000000-0000-4000-8000-000000000412",
    });
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route path="/procurements" element={<ProcurementsApp items={[first, second]} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("button", { name: /Комплекс средств защиты/ })).toHaveLength(1);
  });

  it("does not show another profile's leftover search cards", () => {
    const equipment = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000901",
      name: "КТП",
    });
    const works = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Монтаж",
    });
    const leftover = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000421",
      title: "Поставка КТПБ",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/auction/view/ktp-1",
      sourceProcurementId: "auction/ktp-1",
      foundAs: "match",
      profileIds: [equipment.id],
    });
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[leftover]}
                profiles={[equipment, works]}
                activeProfileId={works.id}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: /Поставка КТПБ/ })).toBeNull();
  });

  it("opens a decided card aimed at by the inbox even though the queue hides it", () => {
    // Opening a review hit from the inbox must show that card, not the first
    // queue row — even when an earlier monitor/participate/reject decision
    // keeps it out of the search queue.
    const decided = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000431",
      title: "Поставка КТП 0,4 кВ",
      status: "accepting_bids",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/ktp-review",
      sourceProcurementId: "auction/ktp-review",
      foundAs: "match",
      triage: "monitor",
    });
    const other = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000432",
      title: "Прочая закупка",
      status: "accepting_bids",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/other",
      sourceProcurementId: "auction/other",
      foundAs: "match",
    });
    render(
      <MemoryRouter initialEntries={[`/procurements/${decided.id}`]}>
        <Routes>
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp items={[other, decided]} decide={async () => []} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Поставка КТП 0,4 кВ" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Прочая закупка" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отслеживать" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Участвовать" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Не нужно" })).toBeTruthy();
  });

  it("fetches the inbox-opened card by id when nothing in state carries it", async () => {
    const review = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000433",
      title: "На проверку: БКТПВ",
      status: "accepting_bids",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/bktpv",
      sourceProcurementId: "auction/bktpv",
      foundAs: "review",
    });
    const fetchCase = vi.fn(async () => review);
    const onCardLoaded = vi.fn();
    render(
      <MemoryRouter initialEntries={[`/procurements/${review.id}`]}>
        <Routes>
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[]}
                decide={async () => []}
                fetchCase={fetchCase}
                onCardLoaded={onCardLoaded}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "На проверку: БКТПВ" })).toBeTruthy();
    });
    expect(fetchCase).toHaveBeenCalledWith(review.id);
    expect(onCardLoaded).toHaveBeenCalledWith(review);
    expect(screen.getByRole("button", { name: "Отслеживать" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Участвовать" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Не нужно" })).toBeTruthy();
  });

  it("lets the specialist pick which profile to search", async () => {
    const user = userEvent.setup();
    const substations = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000901",
      name: "Подстанции",
    });
    const water = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Водоподготовка",
    });
    const selectProfile = vi.fn(async () => undefined);
    const search = vi.fn(async () => ({
      profileName: "Водоподготовка",
      relevantCount: 0,
      discardedCount: 0,
      items: [],
    }));

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[]}
                profiles={[substations, water]}
                activeProfileId={substations.id}
                selectProfile={selectProfile}
                search={search}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(substations.id);
    await user.selectOptions(screen.getByLabelText("Профиль"), water.id);
    await user.click(screen.getByRole("button", { name: "Искать по профилю" }));

    expect(selectProfile).toHaveBeenCalledWith(water.id);
    expect(search).toHaveBeenCalled();
  });

  it("shows only procurements that belong to the chosen profile", async () => {
    const user = userEvent.setup();
    const substations = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000901",
      name: "Подстанции",
      keywords: ["подстанция"],
    });
    const water = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Водоподготовка",
      keywords: ["вода"],
    });
    const station = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
      profileIds: [substations.id],
    });
    const filter = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Системы очистки воды",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/002",
      sourceProcurementId: "auction-002",
      profileIds: [water.id],
    });

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements/:id?"
            element={
              <ProcurementsApp
                items={[station, filter]}
                profiles={[substations, water]}
                activeProfileId={substations.id}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /Комплектная трансформаторная подстанция/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Системы очистки воды/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Профиль"), water.id);
    expect(screen.getByRole("button", { name: /Системы очистки воды/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Комплектная трансформаторная подстанция/ })).toBeNull();
  });

  it("records a specialist choice and moves the case out of Закупки", async () => {
    const user = userEvent.setup();
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
    });
    const other = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/002",
      sourceProcurementId: "auction-002",
    });

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[found, other]}
                decide={async (_id, kind) => [{ ...found, triage: kind }]}
              />
            }
          />
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[found, other]}
                decide={async (_id, kind) => [{ ...found, triage: kind }]}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Отслеживать" }));
    expect(screen.getByText("Отслеживаем. Карточка в «Мои закупки».")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Комплектная трансформаторная подстанция/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Кабель силовой/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Не нужно" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(screen.getByText("Перемещено в корзину. Вернуть можно в разделе «Корзина».")).toBeTruthy();
    });
  });

  it("shows file indexing percent then a read mark after the agent finishes", async () => {
    const user = userEvent.setup();
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплект фильтров",
      status: "unknown",
      statusLabel: "Подача предложений",
      url: "https://example.test/marketing/1",
      sourceProcurementId: "marketing/1",
    });
    let finish: ((items: SpecialistProcurementCard[]) => void) | undefined;
    const decide = (): Promise<SpecialistProcurementCard[]> =>
      new Promise((resolve) => {
        finish = resolve;
      });

    render(
      <MemoryRouter initialEntries={[`/procurements/${found.id}`]}>
        <Routes>
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[found]}
                decide={decide}
                ingestProgress={async () =>
                  SpecialistIngestProgress.parse({
                    procurementId: found.id,
                    phase: "indexing",
                    total: 1,
                    downloaded: 1,
                    indexed: 0,
                    readCount: 0,
                    percent: 20,
                    currentName: "договор.doc",
                    files: [
                      {
                        name: "договор.doc",
                        sourceUrl: "https://example.test/files/1",
                        state: "indexing",
                        percent: 0,
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

    await user.click(screen.getByRole("button", { name: "Участвовать" }));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
    expect(screen.getAllByText(/Индексация «договор.doc» — 20%/).length).toBeGreaterThan(0);
    finish?.([
      {
        ...found,
        triage: "participate",
        documents: [
          {
            name: "договор.doc",
            sourceUrl: "https://example.test/files/1",
            hash: "a".repeat(64),
            sizeBytes: 64_512,
            status: "hashed",
            extraction: {
              status: "extracted",
              kind: "office_text",
              pageCount: 1,
              letterCount: 40,
              confidence: 0.86,
              ocrApplied: false,
              textPreview: "аванс",
              pages: [],
              notes: [],
            },
          },
        ],
      },
    ]);
    expect(await screen.findByText(/Карточка в «Мои закупки»/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Комплект фильтров/ })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("opens a finished file as soon as the hash is known, without a reload", async () => {
    const user = userEvent.setup();
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплект фильтров",
      status: "unknown",
      statusLabel: "Подача предложений",
      url: "https://example.test/marketing/1",
      sourceProcurementId: "marketing/1",
    });
    const decide = (): Promise<SpecialistProcurementCard[]> => new Promise(() => undefined);

    render(
      <MemoryRouter initialEntries={[`/procurements/${found.id}`]}>
        <Routes>
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[found]}
                decide={decide}
                ingestProgress={async () =>
                  SpecialistIngestProgress.parse({
                    procurementId: found.id,
                    phase: "indexing",
                    total: 1,
                    downloaded: 1,
                    indexed: 1,
                    readCount: 1,
                    percent: 100,
                    currentName: "договор.doc",
                    files: [
                      {
                        name: "договор.doc",
                        sourceUrl: "https://example.test/files/1",
                        state: "read",
                        percent: 100,
                        hash: "a".repeat(64),
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

    await user.click(screen.getByRole("button", { name: "Участвовать" }));
    expect(await screen.findByRole("link", { name: "договор.doc" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "договор.doc" }).getAttribute("href")).toBe(
      `/api/documents/${"a".repeat(64)}`,
    );
  });

  it("does not keep the finished indexing bar when another procurement is selected", async () => {
    const user = userEvent.setup();
    const first = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Насос для системы очистки воды",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/request/1",
      sourceProcurementId: "request/1",
    });
    const second = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Кабель силовой",
      status: "unknown",
      statusLabel: "приём заявок",
      url: "https://example.test/auction/2",
      sourceProcurementId: "auction/2",
    });
    let finish: ((items: SpecialistProcurementCard[]) => void) | undefined;
    const decide = (): Promise<SpecialistProcurementCard[]> =>
      new Promise((resolve) => {
        finish = resolve;
      });

    render(
      <MemoryRouter initialEntries={[`/procurements/${first.id}`]}>
        <Routes>
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[first, second]}
                decide={decide}
                ingestProgress={async () =>
                  SpecialistIngestProgress.parse({
                    procurementId: first.id,
                    phase: "done",
                    total: 1,
                    downloaded: 1,
                    indexed: 1,
                    readCount: 1,
                    percent: 100,
                    currentName: "договор.doc",
                    files: [
                      {
                        name: "договор.doc",
                        sourceUrl: "https://example.test/files/1",
                        state: "read",
                        percent: 100,
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

    await user.click(screen.getByRole("button", { name: "Участвовать" }));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(screen.getAllByText(/Индексация 100%/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Кабель силовой/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Кабель силовой" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Индексация 100%/)).toBeNull();

    finish?.([
      { ...first, triage: "participate" },
      second,
    ]);
    expect(await screen.findByText(/Карточка в «Мои закупки»/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Насос для системы очистки воды/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Кабель силовой" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
