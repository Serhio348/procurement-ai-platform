import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseGoszakupkiCard,
  parseGoszakupkiSearchPage,
} from "./goszakupki-by-parser.js";

const fixtureDirectory = new URL("../../../tests/fixtures/goszakupki-by/", import.meta.url);
const fetchedAt = "2026-09-02T06:00:00+03:00";

describe("parseGoszakupkiCard", () => {
  it("parses the anonymous tender listing without opening card pages", async () => {
    const html = await readFile(
      fileURLToPath(new URL("search.html", fixtureDirectory)),
      "utf8",
    );
    const parsed = parseGoszakupkiSearchPage(
      html,
      "https://goszakupki.by/tenders/posted",
    );

    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0]).toMatchObject({
      hit: {
        sourceProcurementId: "single-source/9000104",
        pageFamily: "other",
        title: "Поставка автоматического выключателя",
        buyerName: "ОАО «Тестовый заказчик 4»",
        sourceStatus: "Подача документов/сведений",
        startingPrice: { amount: 4200, currency: "BYN" },
        bidsDeadline: {
          precision: "date",
          date: "2026-09-03",
          timeZone: "Europe/Minsk",
        },
      },
      kind: "single_source",
    });
    expect(parsed.rows[1]?.kind).toBe("request_for_quotations");
    expect(parsed.rows[3]?.kind).toBe("electronic_auction");
  });

  it.each([
    ["auction", "9000001", "auction", "electronic_auction", "Поставка комплектной", "2026-09-01"],
    ["marketing", "9000002", "marketing", "other", "Поверка измерительных", "2026-09-01"],
    ["request", "9000003", "request", "request_for_quotations", "Трансформатор силовой", "2026-09-01"],
    ["etrade", "9000004", "etrade", "open_tender", "Монтаж распределительного", "2026-09-01"],
    ["single-source", "9000005", "other", "single_source", "Поставка автоматических", "2026-09-02"],
  ] as const)(
    "parses the sanitized %s card structure",
    async (family, id, expectedPageFamily, expectedKind, expectedTitle, expectedDate) => {
      const html = await readFile(
        fileURLToPath(new URL(`${family}.html`, fixtureDirectory)),
        "utf8",
      );
      const parsed = parseGoszakupkiCard({
        html,
        url: `https://goszakupki.by/${family}/view/${id}`,
        fetchedAt,
      });

      expect(parsed.card.sourceId).toBe("goszakupki_by");
      expect(parsed.card.sourceProcurementId).toBe(`${family}/${id}`);
      expect(parsed.card.externalIds).toContainEqual({
        kind: "auc",
        value: `auc000${id}`,
      });
      expect(parsed.card.pageFamily).toBe(expectedPageFamily);
      expect(parsed.card.kind).toBe(expectedKind);
      expect(parsed.card.status).toBe("accepting_bids");
      expect(parsed.card.title).toContain(expectedTitle);
      expect(parsed.card.buyer?.name).toBeTruthy();
      expect(parsed.card.publishedAt).toEqual({
        precision: "date",
        date: expectedDate,
        timeZone: "Europe/Minsk",
      });
      expect(parsed.card.lots).toHaveLength(1);
      expect(parsed.card.lots[0]?.number).toBe("1");
      expect(parsed.documents.length).toBeGreaterThan(0);
      expect(parsed.documents[0]?.sourceUrl).toContain(
        `/${family}/get-file/${id}?c=detail&f=0`,
      );
      expect(parsed.documents[0]?.downloadUrl).toContain("download=1");
    },
  );

  it("keeps a sparse external card valid without inventing optional values", () => {
    const parsed = parseGoszakupkiCard({
      html: `
        <div id="print-area">
          <div class="page-header"><h1>Карточка auc0009000099</h1></div>
          <div class="panel">
            <div class="panel-heading">Общая информация</div>
            <table><tr><th>Название</th><td>Минимальная карточка</td></tr></table>
          </div>
        </div>`,
      url: "https://goszakupki.by/marketing/view/9000099",
      fetchedAt,
    });

    expect(parsed.card).toMatchObject({
      sourceProcurementId: "marketing/9000099",
      title: "Минимальная карточка",
      status: "unknown",
      lots: [],
    });
    expect(parsed.card.publishedAt).toBeUndefined();
    expect(parsed.card.buyer).toBeUndefined();
  });

  it("extracts document metadata and public chronology without downloading files", async () => {
    const html = await readFile(
      fileURLToPath(new URL("auction.html", fixtureDirectory)),
      "utf8",
    );
    const parsed = parseGoszakupkiCard({
      html,
      url: "https://goszakupki.by/auction/view/9000001",
      fetchedAt,
    });

    expect(parsed.documents[0]).toMatchObject({
      name: "technical-specification.pdf",
      mimeType: "application/pdf",
      sourceFileKey: "0",
      discoveredAt: fetchedAt,
    });
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history[0]?.sourceUrl).toBe("https://goszakupki.by/questions/9001");
  });

  it("rejects a page whose card identity is absent", () => {
    expect(() =>
      parseGoszakupkiCard({
        html: "<div id='print-area'><h1>Ошибка</h1></div>",
        url: "https://goszakupki.by/auction/view/9000001",
        fetchedAt,
      }),
    ).toThrow(/auc identifier/);
  });
});
