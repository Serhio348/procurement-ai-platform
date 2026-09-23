import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inferSearchIntentPlan, scoreSearchIntentFromProcedure } from "@procurement/domain";
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
        kindLabel: "Закупка из одного источника на ЭТП",
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
    expect(parsed.rows[1]?.hit.kindLabel).toBe("Запрос ценовых предложений");
    expect(parsed.rows[2]?.hit.kindLabel).toBe("Заявка о ценах (тарифах) на ТРУ");
    expect(parsed.rows[3]?.kind).toBe("electronic_auction");
    expect(parsed.rows[3]?.hit.kindLabel).toBe("Электронный аукцион");
    expect(parsed.rows[1]?.hit.status).toBe("accepting_bids");
    expect(parsed.rows[3]?.hit.status).toBe("accepting_bids");
    expect(parsed.rows[3]?.hit.sourceStatus).toBe("Подача предложений");
  });

  it("reads listing status by column header and maps приём/подача to accepting bids", () => {
    const html = `<!doctype html><table>
      <thead><tr>
        <th></th>
        <th>Номер закупки</th>
        <th>Организация / Предмет закупки</th>
        <th>Вид процедуры закупки</th>
        <th>Статус</th>
        <th>Предложения, документы до</th>
        <th>Ориентировочная/предельная стоимость</th>
      </tr></thead>
      <tbody>
        <tr data-key="0">
          <td><input type="checkbox"></td>
          <td>auc0003664806</td>
          <td>Заказчик<br><a href="/auction/view/3664806">Выбор поставщика блочной комплектной подстанции (БКТПБ №3)</a></td>
          <td>Электронный аукцион</td>
          <td><span class="badge">Подача предложений</span></td>
          <td>27.09.2026</td>
          <td>526 056.26 BYN</td>
        </tr>
        <tr data-key="1">
          <td></td>
          <td>auc0001</td>
          <td><a href="/request/view/1">НКУ 0,4 кВ</a></td>
          <td>Запрос ценовых предложений</td>
          <td>Приём предложений</td>
          <td>01.10.2026</td>
          <td>1 BYN</td>
        </tr>
      </tbody>
    </table>`;
    const parsed = parseGoszakupkiSearchPage(html, "https://goszakupki.by/tenders/posted");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.hit).toMatchObject({
      sourceProcurementId: "auction/3664806",
      status: "accepting_bids",
      sourceStatus: "Подача предложений",
      kind: "electronic_auction",
    });
    expect(parsed.rows[1]?.hit.status).toBe("accepting_bids");
  });

  it("keeps the procedure card when a GIAS /view/ link sits before the title", () => {
    const html = `<!doctype html><table>
      <thead><tr>
        <th></th>
        <th>Номер закупки</th>
        <th>Организация / Предмет закупки</th>
        <th>Вид процедуры закупки</th>
        <th>Статус</th>
        <th>Предложения, документы до</th>
        <th>Ориентировочная/предельная стоимость</th>
      </tr></thead>
      <tbody>
        <tr data-key="0">
          <td><input type="checkbox"></td>
          <td><a href="https://gias.by/gias/#/purchase/current/view/4761844">4761844</a></td>
          <td>Гродноэнерго<br><a href="/auction/view/3664806">Выбор поставщика блочной комплектной подстанции (БКТПБ №3)</a></td>
          <td>Электронный аукцион</td>
          <td><span class="badge">Подача предложений</span></td>
          <td>27.09.2026</td>
          <td>526 056.26 BYN</td>
        </tr>
      </tbody>
    </table>`;
    const parsed = parseGoszakupkiSearchPage(html, "https://goszakupki.by/tenders/posted");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.hit).toMatchObject({
      sourceProcurementId: "auction/3664806",
      title: "Выбор поставщика блочной комплектной подстанции (БКТПБ №3)",
      sourceStatus: "Подача предложений",
    });
  });

  it("uses the subject cell when the procedure link text is only a number", () => {
    const html = `<!doctype html><table>
      <thead><tr>
        <th></th>
        <th>Номер закупки</th>
        <th>Организация / Предмет закупки</th>
        <th>Вид процедуры закупки</th>
        <th>Статус</th>
        <th>Предложения, документы до</th>
        <th>Ориентировочная/предельная стоимость</th>
      </tr></thead>
      <tbody>
        <tr data-key="0">
          <td><input type="checkbox"></td>
          <td>3664806</td>
          <td>Гродноэнерго<br><a href="https://goszakupki.by/auction/view/3664806?lang=ru">3664806</a> Поставка БКТПБ №3</td>
          <td>Электронный аукцион</td>
          <td><span class="badge">Подача предложений</span></td>
          <td>27.09.2026</td>
          <td>526 056.26 BYN</td>
        </tr>
      </tbody>
    </table>`;
    const parsed = parseGoszakupkiSearchPage(html, "https://goszakupki.by/tenders/posted");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.hit.sourceProcurementId).toBe("auction/3664806");
    expect(parsed.rows[0]?.hit.title).toContain("БКТПБ №3");
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
      expect(parsed.card.listedDocuments[0]?.sourceUrl).toBe(parsed.documents[0]?.sourceUrl);
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

  it("reads the single-source basis and the failed procedure it replaces, and names a failed lot", async () => {
    const html = (
      await readFile(fileURLToPath(new URL("single-source.html", fixtureDirectory)), "utf8")
    )
      .replace(
        "<tr><th>Отрасль</th>",
        '<tr><th>Основание выбора процедуры закупки из одного источника</th><td>7. Признание процедуры государственной закупки несостоявшейся.</td></tr>' +
          '<tr><th>Номер процедуры государственной закупки на ЭТП, признанной несостоявшейся</th><td><a href="/auction/view/3541262">auc0003541262</a></td></tr>' +
          "<tr><th>Отрасль</th>",
      )
      .replace(
        '<span class="badge">Подача документов/сведений</span>',
        '<span class="badge">Рассмотрение документов/сведений. Процедура признана несостоявшейся</span>',
      );
    const parsed = parseGoszakupkiCard({
      html,
      url: "https://goszakupki.by/single-source/view/9000005",
      fetchedAt,
    });

    expect(parsed.card.kind).toBe("single_source");
    expect(parsed.card.singleSourceBasis).toContain("несостоявшейся");
    expect(parsed.card.precedingProcedureNumber).toBe("auc0003541262");
    expect(parsed.card.status).toBe("failed");
    expect(parsed.card.rawFields["Основание выбора процедуры закупки из одного источника"]).toBeDefined();
  });

  it("carries the procedure kind on listing rows so a profile can drop single-source purchases", async () => {
    const html = await readFile(fileURLToPath(new URL("search.html", fixtureDirectory)), "utf8");
    const parsed = parseGoszakupkiSearchPage(html, "https://goszakupki.by/tenders/posted");
    expect(parsed.rows[0]?.hit.kind).toBe("single_source");
    expect(parsed.rows[3]?.hit.kind).toBe("electronic_auction");
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

  it("lists a documentation storage link from the documents panel", () => {
    const parsed = parseGoszakupkiCard({
      html: `
        <div id="print-area">
          <div class="page-header"><h1>Карточка auc0009000098</h1></div>
          <div class="panel">
            <div class="panel-heading">Общая информация</div>
            <table><tr><th>Название</th><td>Поставка щита</td></tr></table>
          </div>
          <div class="panel panel-default">
            <div class="panel-heading"><b>Документы</b></div>
            <table class="table">
              <tr><td><a href="https://disk.yandex.ru/d/ContestPack">Документация закупки</a></td></tr>
            </table>
          </div>
        </div>`,
      url: "https://goszakupki.by/request/view/9000098",
      fetchedAt,
    });

    expect(parsed.documents).toEqual([
      expect.objectContaining({
        name: "Документация закупки",
        sourceUrl: "https://disk.yandex.ru/d/ContestPack",
        downloadUrl: "https://disk.yandex.ru/d/ContestPack",
      }),
    ]);
  });

  it("picks up a «download all» archive link from the documents panel", () => {
    const parsed = parseGoszakupkiCard({
      html: `
        <div id="print-area">
          <div class="page-header"><h1>Карточка auc0009000097</h1></div>
          <div class="panel">
            <div class="panel-heading">Общая информация</div>
            <table><tr><th>Название</th><td>Поставка щита</td></tr></table>
          </div>
          <div class="panel panel-default">
            <div class="panel-heading"><b>Документы</b></div>
            <table class="table">
              <tr><td><a class="modal-link" href="/auction/get-file/97?c=detail&amp;f=0">ТЗ.pdf</a></td></tr>
              <tr><td><a data-url="/auction/get-archive/97">Скачать документы одним архивом</a></td></tr>
              <tr><td><a onclick="location.href='/auction/get-archive-zip/97'">Архив ZIP</a></td></tr>
            </table>
          </div>
        </div>`,
      url: "https://goszakupki.by/auction/view/9000097",
      fetchedAt,
    });

    const urls = parsed.documents.map((item) => item.sourceUrl);
    expect(urls).toContain("https://goszakupki.by/auction/get-archive/97");
    expect(urls).toContain("https://goszakupki.by/auction/get-archive-zip/97");
    const pack = parsed.documents.find((item) => item.sourceUrl.includes("get-archive"));
    expect(pack?.downloadUrl).toContain("download=1");
  });

  it("maps buying-organisation labels and an indicative amount", async () => {
    const html = await readFile(
      fileURLToPath(new URL("request-buying-org.html", fixtureDirectory)),
      "utf8",
    );
    const parsed = parseGoszakupkiCard({
      html,
      url: "https://goszakupki.by/request/view/3545600",
      fetchedAt,
    });

    expect(parsed.card.buyer).toMatchObject({
      name: 'Брестское республиканское унитарное предприятие электроэнергетики "Брестэнерго"',
      registrationNumber: "200050653",
      address: "Республика Беларусь, Брестская область, 224030, г. Брест, ул. Воровского, 13/1",
      contact: "Головко Роман Геннадьевич, +375333869267",
    });
    expect(parsed.card.amount).toMatchObject({
      kind: "indicative",
      amount: 160651.42,
      currency: "BYN",
      raw: "160 651.42 BYN",
    });
    expect(parsed.card.rawFields["Иные сведения"]).toBe("Согласно заданию на закупку");
    expect(
      parsed.card.rawFields[
        "Дата и время окончания приема запросов о разъяснении документации о закупке"
      ],
    ).toContain("08.09.2026 16:00");
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

  it("keeps a limited contest listing row and parses its lot subject", async () => {
    const listingHtml = await readFile(
      fileURLToPath(new URL("search-limited.html", fixtureDirectory)),
      "utf8",
    );
    const listing = parseGoszakupkiSearchPage(
      listingHtml,
      "https://goszakupki.by/tenders/posted",
    );
    expect(listing.rows).toHaveLength(1);
    expect(listing.rows[0]?.hit).toMatchObject({
      sourceProcurementId: "limited/3669746",
      url: "https://goszakupki.by/limited/view/3669746",
      pageFamily: "other",
      kind: "open_tender",
      kindLabel: "Конкурс с ограниченным участием",
      title:
        "Выбор субподрядной организации по объекту: «Проект застройки микрорайона №21 в г.Жлобине. Генплан и инженерные сети» 1 очередь строительства.",
    });

    const html = await readFile(
      fileURLToPath(new URL("limited.html", fixtureDirectory)),
      "utf8",
    );
    const parsed = parseGoszakupkiCard({
      html,
      url: "https://goszakupki.by/limited/view/3669746",
      fetchedAt,
    });
    expect(parsed.card.sourceProcurementId).toBe("limited/3669746");
    expect(parsed.card.pageFamily).toBe("other");
    expect(parsed.card.kind).toBe("open_tender");
    expect(parsed.card.rawFields["Вид процедуры закупки"]).toBe(
      "Конкурс с ограниченным участием",
    );
    expect(parsed.card.title).toContain("Жлобине");
    expect(parsed.card.lots[0]?.title).toMatch(/монтаж.*электрооборудования/i);
    expect(parsed.card.lots[0]?.title).toMatch(/АСКУЭ/);
    expect(parsed.card.lots[0]?.positions[0]?.title).toMatch(/электрооборудования/i);

    const scored = scoreSearchIntentFromProcedure(
      parsed.card,
      inferSearchIntentPlan({
        name: "Монтаж и пусконаладка электросилового оборудования",
        keywords: ["электрооборудование", "монтаж", "пусконаладка"],
        excludeKeywords: [],
      }),
    );
    expect(scored.decision).toBe("match");
    expect(scored.matchedObjects).toContain("электрооборудование");
    expect(scored.matchedDesired).toEqual(expect.arrayContaining(["монтаж", "пусконаладка"]));
  });
});
