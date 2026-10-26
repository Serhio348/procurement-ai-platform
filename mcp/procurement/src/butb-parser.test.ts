import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  butbKind,
  butbPartialUpdate,
  butbRegistryHit,
  butbRegistryPublishDate,
  butbSearchApplied,
  butbSearchToggleId,
  butbStatus,
  butbTableUsable,
  butbTotalRecords,
  parseButbCard,
  parseButbRegistryRows,
  parseButbSearchForm,
  parseButbViewState,
} from "./butb-parser.js";

const registry = readFileSync(
  fileURLToPath(new URL("../test/fixtures/butb/registry.html", import.meta.url)),
  "utf8",
);
const page2 = readFileSync(
  fileURLToPath(new URL("../test/fixtures/butb/page2.xml", import.meta.url)),
  "utf8",
);
const card = readFileSync(
  fileURLToPath(new URL("../test/fixtures/butb/card.html", import.meta.url)),
  "utf8",
);

describe("parseButbViewState", () => {
  it("reads the JSF tokens from a full page", () => {
    const state = parseButbViewState(registry);
    expect(state?.viewState).toMatch(/^\d+:[-\d]+$/);
    expect(state?.iceWindow).toBeTruthy();
    expect(state?.iceView).toBeTruthy();
    expect(state?.formAction).toContain("reestrauctions");
  });

  it("reads the ViewState from a partial-response update", () => {
    const state = parseButbViewState(page2);
    expect(state?.viewState).toMatch(/[-\d]+:[-\d]+/);
  });
});

describe("butbPartialUpdate", () => {
  it("extracts the rendered table from a pageChange answer", () => {
    const table = butbPartialUpdate(page2, "fra:reestrAu");
    expect(table).toBeDefined();
    expect(table).toContain("reestrAu_row_20");
  });
});

describe("parseButbRegistryRows", () => {
  it("parses the full page render with card link ids", () => {
    const rows = parseButbRegistryRows(registry);
    expect(rows.length).toBe(20);
    const first = rows[0]!;
    expect(first.registryNumber).toMatch(/^[A-Z]{2}\d{10,}$/);
    expect(first.cardLinkId).toMatch(/^fra:reestrAu:0:_t\d+$/);
    expect(first.title.length).toBeGreaterThan(3);
    expect(first.kindLabel.length).toBeGreaterThan(0);
    expect(first.publishedAt?.precision).toBe("date");
    expect(first.bidsDeadline?.precision).toBe("date");
    expect(first.sourceStatus).toContain("Подача");
  });

  it("parses rows from a paginator update (absolute row indexes)", () => {
    const table = butbPartialUpdate(page2, "fra:reestrAu")!;
    const rows = parseButbRegistryRows(table);
    expect(rows.length).toBe(20);
    expect(rows[0]!.rowIndex).toBe(20);
    expect(rows[0]!.cardLinkId).toBe("fra:reestrAu:20:_t344");
    expect(rows.map((row) => row.registryNumber)).toContain("AU20261015396676");
  });

  it("keeps the icetrade number when present and drops a dash placeholder", () => {
    const rows = parseButbRegistryRows(registry);
    const withNumber = rows.find((row) => row.icetradeNumber !== undefined);
    const without = rows.find((row) => row.icetradeNumber === undefined);
    expect(withNumber?.icetradeNumber).toMatch(/^\d+$/);
    expect(without).toBeDefined();
  });
});

describe("butbRegistryHit", () => {
  it("maps a registry row to a SearchHit", () => {
    const row = parseButbRegistryRows(registry)[0]!;
    const hit = butbRegistryHit(row, "https://zakupki.butb.by");
    expect(hit.sourceId).toBe("butb");
    expect(hit.sourceProcurementId).toBe(`butb/${row.registryNumber}`);
    expect(hit.title).toBe(row.title);
    expect(hit.status).not.toBe("unknown");
  });
});

describe("parseButbCard", () => {
  const parsed = parseButbCard({
    html: card,
    url: "https://zakupki.butb.by/auctions/viewinvitation.html",
    fetchedAt: "2026-10-15T12:00:00Z",
  });

  it("extracts identity and fields", () => {
    expect(parsed.card.sourceProcurementId).toBe("butb/AU20261015396707");
    expect(parsed.card.sourceId).toBe("butb");
    expect(parsed.card.title).toContain("Микрохирургический");
    expect(parsed.card.kind).toBe("electronic_auction");
    expect(parsed.card.status).toBe("accepting_bids");
    expect(parsed.card.bidsDeadline).toEqual({
      precision: "date",
      date: "2026-10-30",
      timeZone: "Europe/Minsk",
    });
    expect(parsed.card.publishedAt).toEqual({
      precision: "date",
      date: "2026-10-15",
      timeZone: "Europe/Minsk",
    });
  });

  it("exposes the ГИАС number as an external id for cross-source dedup", () => {
    const gias = parsed.card.externalIds.find((id) => id.kind === "gias");
    expect(gias?.value).toBe("4828385");
  });

  it("parses buyer party", () => {
    expect(parsed.card.buyer?.name).toContain("Белорусская универсальная товарная биржа");
    expect(parsed.card.buyer?.registrationNumber).toBe("190542056");
  });

  it("parses all lots with okrb, delivery and price", () => {
    expect(parsed.card.lots.length).toBe(6);
    const lot = parsed.card.lots[0]!;
    expect(lot.number).toBe("1");
    expect(lot.okrbCode).toBe("32.50.50.390");
    expect(lot.title).toContain("Микрохирургический инструментарий");
    expect(lot.funding).toContain("собственные средства");
    expect(lot.startingPrice?.currency).toBe("BYN");
  });

  it("lists session document links", () => {
    expect(parsed.documents.length).toBeGreaterThanOrEqual(8);
    expect(parsed.documents[0]!.sourceUrl).toContain("/auctions/download?id=");
    expect(parsed.card.listedDocuments.length).toBe(parsed.documents.length);
  });

  it("reads the MR title from «Наименование процедуры», not the lots header", () => {
    // MR cards have no «Наименование закупки» field; their only
    // «Предмет закупки» span is the lots-table column header, whose next
    // span is «Количество (объем)» — it must not become the title.
    const mrCard = `<html><body>
      <span id="f1">Регистрационный номер</span><span id="f2">MR20261022397617</span>
      <span id="f3">Состояние</span><span id="f4">Подача предложений / документов</span>
      <span id="f5">Наименование процедуры</span><span id="f6">Изучение конъюнктуры рынка при разработке проектной документации (дооснащение шкафа УУТЗ)</span>
      <table><thead><tr>
        <th><span id="h1">Предмет закупки</span></th>
        <th><span id="h2">Количество (объем)</span></th>
      </tr></thead></table>
    </body></html>`;
    const mr = parseButbCard({
      html: mrCard,
      url: "https://zakupki.butb.by/auctions/viewinvitation.html",
      fetchedAt: "2026-10-22T12:00:00Z",
    });
    expect(mr.card.title).toContain("Изучение конъюнктуры рынка");
    expect(mr.card.title).not.toBe("Количество (объем)");
  });

  it("has no history on a card without FAQ/protocol tables", () => {
    expect(parsed.card.history).toEqual([]);
  });

  it("parses «Запросы и разъяснения» and «Протоколы» into sorted history", () => {
    // Live markup (AU20261009395855): faqListByText columns are
    // № | Запрос | Файл запроса | Дата запроса | Ответ | Файл ответа | …
    // and findProtocolListByText is № | Наименование | Дата | Файл | …
    const withHistory = `<html><body>
      <span id="f1">Регистрационный номер</span><span id="f2">AU20261009395855</span>
      <span id="f3">Наименование закупки</span><span id="f4">Тестовая закупка</span>
      <table class="iceDatTbl" id="j:faqListByText"><tbody>
        <tr class="iceDatTblRow">
          <td><span>1</span></td>
          <td><span>  Добрый день. Просим увеличить сроки поставки.  </span></td>
          <td><a class="iceOutLnk" href="/auctions/download?id=6106402&amp;name=AAA/req.htm">req.htm</a></td>
          <td><span>13.10.2026 11:16</span></td>
          <td><a class="iceCmdLnk" href="javascript:;">Срок поставки товара изменен.</a></td>
          <td><a class="iceOutLnk" href="/auctions/download?id=6107170&amp;name=BBB/ans.htm">ans.htm</a></td>
          <td></td><td></td>
        </tr>
        <tr class="iceDatTblRow">
          <td><span>2</span></td>
          <td><span>Вопрос без ответа и файлов</span></td>
          <td></td>
          <td><span>14.10.2026 09:05</span></td>
          <td></td><td></td><td></td><td></td>
        </tr>
      </tbody></table>
      <table class="iceDatTbl" id="j:findProtocolListByText"><tbody>
        <tr class="iceDatTblRow">
          <td><span>1</span></td>
          <td><span>Протокол о признании лота несостоявшимся</span></td>
          <td><span>12.10.2026</span></td>
          <td><a class="iceOutLnk" href="/auctions/download?id=6131377&amp;name=CCC/protocol.xls">protocol.xls</a></td>
          <td></td>
        </tr>
      </tbody></table>
    </body></html>`;
    const result = parseButbCard({
      html: withHistory,
      url: "https://zakupki.butb.by/auctions/viewinvitation.html",
      fetchedAt: "2026-10-22T12:00:00Z",
    });
    expect(result.card.history).toHaveLength(3);
    // Chronological order across both tables: protocol (12.10) first.
    const [protocol, answered, unanswered] = result.card.history;
    expect(protocol!.question).toContain("Протокол");
    expect(protocol!.askedAt).toBeUndefined();
    expect(protocol!.sourceUrl).toBe(
      "https://zakupki.butb.by/auctions/download?id=6131377&name=CCC/protocol.xls",
    );
    expect(answered!.question).toContain("Добрый день");
    expect(answered!.answer).toContain("Срок поставки");
    expect(answered!.askedAt).toBe("2026-10-13T11:16:00+03:00");
    // The answer file is the more useful link for the row.
    expect(answered!.sourceUrl).toContain("download?id=6107170");
    expect(unanswered!.question).toContain("Вопрос без ответа");
    expect(unanswered!.answer).toBeUndefined();
    expect(unanswered!.sourceUrl).toBeUndefined();
  });
});

describe("kind and status mapping", () => {
  it("maps BUTB procedure kinds", () => {
    expect(butbKind("электронный аукцион")).toBe("electronic_auction");
    expect(butbKind("аукцион")).toBe("electronic_auction");
    expect(butbKind("ЗЦП")).toBe("request_for_quotations");
    expect(butbKind("запрос ценовых предложений")).toBe("request_for_quotations");
    expect(butbKind("конкурс")).toBe("open_tender");
    expect(butbKind("ЗОИ на ЭТП")).toBe("other");
  });

  it("maps BUTB states", () => {
    expect(butbStatus("Подача предложений / документов")).toBe("accepting_bids");
    expect(butbStatus("Завершена")).toBe("completed");
    expect(butbStatus("Признана несостоявшейся")).toBe("failed");
    expect(butbStatus("Приостановлена")).toBe("cancelled");
  });
});

describe("butbRegistryPublishDate", () => {
  it("extracts the publish date embedded in the registry number", () => {
    expect(butbRegistryPublishDate("AU20261015396707")).toBe("2026-10-15");
    expect(butbRegistryPublishDate("EZ20251231999999")).toBe("2025-12-31");
    expect(butbRegistryPublishDate("garbage")).toBeUndefined();
  });
});

describe("butbTotalRecords", () => {
  it("reads the paginator total", () => {
    expect(butbTotalRecords(registry)).toBeGreaterThan(200_000);
    expect(butbTotalRecords(page2)).toBeGreaterThan(200_000);
  });
});

describe("registry search form (live fixture)", () => {
  const expanded = readFileSync(
    fileURLToPath(new URL("../test/fixtures/butb/search-expanded.html", import.meta.url)),
    "utf8",
  );
  const filtered = readFileSync(
    fileURLToPath(new URL("../test/fixtures/butb/search-filtered.html", import.meta.url)),
    "utf8",
  );
  const degraded = readFileSync(
    fileURLToPath(new URL("../test/fixtures/butb/search-degraded.html", import.meta.url)),
    "utf8",
  );

  it("finds the search panel toggle id on the registry page", () => {
    // The component id is generated — the contract is the label, not j_idtNNN.
    expect(butbSearchToggleId(registry)).toMatch(/^fra:/);
  });

  it("discovers the form fields by their labels", () => {
    const form = parseButbSearchForm(expanded);
    expect(form).toBeDefined();
    expect(form!.subjectField).toMatch(/^fra:/);
    expect(form!.regNumberField).toMatch(/^fra:/);
    expect(form!.buyerNameField).toMatch(/^fra:/);
    expect(form!.buyerUnpField).toMatch(/^fra:/);
    expect(form!.submitId).toMatch(/^fra:/);
    expect(form!.submitValue).toBe("Искать");
    expect(form!.columnSaveId).toMatch(/^fra:/);
    // 11 optional columns + the status group.
    expect(form!.columnCheckboxes).toHaveLength(11);
    expect(form!.statusField).toBe("fra:selectStatus");
    // «подача предложений / документов» → "2" is the accepting-bids value.
    expect(form!.statusValues).toContainEqual({
      label: "подача предложений / документов",
      value: "2",
    });
    expect(
      form!.statusValues.every((entry) => /^fra:/.test(entry.label) === false),
    ).toBe(true);
  });

  it("reports an applied criteria banner on filtered pages only", () => {
    expect(butbSearchApplied(filtered)).toBe(true);
    expect(butbSearchApplied(degraded)).toBe(true);
    expect(butbSearchApplied(registry)).toBe(false);
    expect(butbSearchApplied(expanded)).toBe(false);
  });

  it("detects the degraded single-column table", () => {
    expect(butbTableUsable(registry)).toBe(true);
    expect(butbTableUsable(filtered)).toBe(true);
    // Degraded after expand and after submit: exactly one «Вид закупки» column.
    expect(butbTableUsable(expanded)).toBe(false);
    expect(butbTableUsable(degraded)).toBe(false);
  });

  it("parses the restored filtered table with the extra region column", () => {
    const rows = parseButbRegistryRows(filtered);
    expect(rows).toHaveLength(20);
    expect(butbTotalRecords(filtered)).toBe(413);
    const accepting = rows.find((row) => row.sourceStatus?.includes("Подача"));
    expect(accepting).toBeDefined();
    expect(accepting!.registryNumber).toMatch(/^[A-Z]{2}\d{10,}$/);
    expect(accepting!.cardLinkId).toMatch(/^fra:reestrAu:\d+:_t\d+$/);
    expect(accepting!.buyerRegion).toBe("Брестская область");
    // Column alignment after the inserted region cell: the status must sit
    // in its own cell, not leak into the auction date or financing fields.
    expect(accepting!.sourceStatus).toContain("Подача предложений");
    expect(accepting!.bidsDeadline).toBeDefined();
    expect(accepting!.financing).toBeDefined();
  });

  it("keeps the plain registry rows region-less", () => {
    const rows = parseButbRegistryRows(registry);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.buyerRegion === undefined)).toBe(true);
  });
});
