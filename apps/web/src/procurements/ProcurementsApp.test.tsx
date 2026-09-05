import { cleanup, render, screen } from "@testing-library/react";
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
  ingestFileProgressLabel,
  ingestProgressCaption,
  ProcurementsApp,
} from "./ProcurementsApp.js";

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
      <MemoryRouter initialEntries={[`/procurements/${items[0]!.id}`]}>
        <Routes>
          <Route path="/procurements/:id" element={<ProcurementsApp items={items} />} />
        </Routes>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "zapros-filtra.doc" });
    expect(link.getAttribute("href")).toBe(`/api/documents/${"a".repeat(64)}`);
    expect(link.getAttribute("download")).toBe("zapros-filtra.doc");
    expect(screen.queryByRole("heading", { name: "Текст документа" })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Коммерческие условия" })).toBeTruthy();
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

  it("records a specialist choice and hides a rejected case from the list", async () => {
    const user = userEvent.setup();
    const found = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "Комплектная трансформаторная подстанция",
      status: "unknown",
      statusLabel: "Прием предложений",
      url: "https://example.test/auction/001",
      sourceProcurementId: "auction-001",
    });

    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route
            path="/procurements"
            element={
              <ProcurementsApp
                items={[found]}
                decide={async (_id, kind) =>
                  kind === "reject"
                    ? []
                    : [
                        {
                          ...found,
                          triage: kind,
                          ...(kind === "participate"
                            ? {
                                documents: [
                                  {
                                    name: "ТЗ.pdf",
                                    sourceUrl: "https://example.test/files/tz.pdf",
                                    hash: "a".repeat(64),
                                    sizeBytes: 12,
                                    status: "hashed" as const,
                                  },
                                ],
                              }
                            : {}),
                        },
                      ]
                }
              />
            }
          />
          <Route
            path="/procurements/:id"
            element={
              <ProcurementsApp
                items={[found]}
                decide={async (_id, kind) =>
                  kind === "reject"
                    ? []
                    : [
                        {
                          ...found,
                          triage: kind,
                          ...(kind === "participate"
                            ? {
                                documents: [
                                  {
                                    name: "ТЗ.pdf",
                                    sourceUrl: "https://example.test/files/tz.pdf",
                                    hash: "a".repeat(64),
                                    sizeBytes: 12,
                                    status: "hashed" as const,
                                  },
                                ],
                              }
                            : {}),
                        },
                      ]
                }
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Отслеживать" }));
    expect(screen.getByText("отслеживаем")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отслеживать" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Участвовать" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      screen.getByRole("button", { name: /Комплектная трансформаторная подстанция/ }).className,
    ).toContain("is-triage-monitor");
    await user.click(screen.getByRole("button", { name: "Участвовать" }));
    expect(screen.getByText("участвуем")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Участвовать" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: /Комплектная трансформаторная подстанция/ }).className,
    ).toContain("is-triage-participate");
    expect(screen.getByText(/Прочитано агентом: 0 из 1/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "ТЗ.pdf" }).getAttribute("href")).toBe(
      `/api/documents/${"a".repeat(64)}`,
    );
    await user.click(screen.getByRole("button", { name: "Не нужно" }));
    expect(screen.getByText("Закупка скрыта и больше не будет предлагаться.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Комплектная трансформаторная подстанция/ })).toBeNull();
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
    expect(await screen.findByText("прочитано агентом")).toBeTruthy();
    expect(screen.getByText(/Прочитано агентом: 1 из 1/)).toBeTruthy();
  });
});
