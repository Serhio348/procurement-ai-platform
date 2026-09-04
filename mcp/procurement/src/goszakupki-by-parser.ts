import {
  ProcedureCard,
  SearchHit,
  SourceDocument,
  type IsoDateTime,
  type PageFamily,
  type PlatformAmount,
  type PlatformInstant,
  type ProcurementGetDocumentsResponse,
  type ProcurementGetHistoryResponse,
  type ProcedureKind,
  type ProcedureStatus,
  type SourceLot,
} from "@procurement/contracts";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

const TIME_ZONE = "Europe/Minsk";

export interface ParseGoszakupkiCardInput {
  html: string;
  url: string;
  fetchedAt: IsoDateTime;
}

export interface ParsedGoszakupkiCard {
  card: ProcedureCard;
  documents: ProcurementGetDocumentsResponse["documents"];
  history: ProcurementGetHistoryResponse["clarifications"];
}

export interface ParsedGoszakupkiSearchRow {
  hit: SearchHit;
  kind: ProcedureKind;
}

export interface ParsedGoszakupkiSearchPage {
  rows: ParsedGoszakupkiSearchRow[];
  hasNextPage: boolean;
}

export function parseGoszakupkiSearchPage(
  html: string,
  pageUrl: string,
): ParsedGoszakupkiSearchPage {
  const $ = cheerio.load(html);
  const rows = $("tr[data-key]")
    .toArray()
    .map((row) => {
      const cells = $(row).children("td");
      const link = cells.eq(1).find('a[href*="/view/"]').first();
      const href = link.attr("href");
      if (cells.length < 6 || href === undefined) return undefined;
      const targetUrl = new URL(href, pageUrl);
      const identity = targetUrl.pathname.match(
        /^\/(auction|marketing|request|etrade|single-source)\/view\/(\d+)\/?$/,
      );
      if (identity?.[1] === undefined || identity[2] === undefined) return undefined;
      const family = identity[1];
      const title = text(link);
      if (title.length === 0) return undefined;
      const buyerCell = cells.eq(1).clone();
      buyerCell.find("a").remove();
      const buyerName = text(buyerCell);
      const sourceStatus = text(cells.eq(3));
      const amount = parsePlatformAmount(text(cells.eq(5)));
      const bidsDeadline = parsePlatformInstant(text(cells.eq(4)));
      return {
        hit: SearchHit.parse({
          sourceId: "goszakupki_by",
          sourceProcurementId: `${family}/${identity[2]}`,
          url: targetUrl.href,
          title,
          pageFamily: pageFamilyFromSegment(family),
          ...(sourceStatus.length === 0 ? {} : { sourceStatus }),
          ...(buyerName.length === 0 ? {} : { buyerName }),
          ...(amount?.amount === null || amount?.currency === undefined
            ? {}
            : { startingPrice: { amount: amount.amount, currency: amount.currency } }),
          ...(amount === undefined ? {} : { amount }),
          ...(bidsDeadline === undefined ? {} : { bidsDeadline }),
        }),
        kind: procedureKind(text(cells.eq(2))),
      };
    })
    .filter((row) => row !== undefined);
  const hasNextPage = $(".pagination li.next:not(.disabled) a[href]").length > 0;
  return { rows, hasNextPage };
}

export function parseGoszakupkiCard(input: ParseGoszakupkiCardInput): ParsedGoszakupkiCard {
  const $ = cheerio.load(input.html);
  const heading = text($("#print-area .page-header h1").first());
  const aucId = heading.match(/\bauc\d+\b/i)?.[0]?.toLowerCase();
  if (aucId === undefined) {
    throw new Error("Goszakupki card does not contain an auc identifier");
  }

  const pageFamily = pageFamilyFromUrl(input.url);
  const pathId = new URL(input.url).pathname.match(
    /^\/(auction|marketing|request|etrade|single-source)\/view\/(\d+)\/?$/,
  );
  if (pathId?.[1] === undefined || pathId[2] === undefined) {
    throw new Error("Goszakupki card URL does not contain a supported source identifier");
  }
  const sourceProcurementId = `${pathId[1]}/${pathId[2]}`;
  const fields = collectFields($);
  const procedureLabel = firstField(fields, ["Вид процедуры закупки"]);
  const title = firstField(fields, [
    "Название процедуры закупки",
    "Название запроса ценовых предложений",
    "Название открытого конкурса/конкурса",
    "Название процедуры закупки из одного источника на ЭТП",
    "Название",
  ]);
  if (title === undefined) throw new Error("Goszakupki card does not contain a title");

  const lots = parseLots($);
  const sourceStatus = aggregateSourceStatus(lots);
  const amount = parsePlatformAmount(
    firstField(fields, ["Общая предельная стоимость закупки"]),
  );
  const buyer = parseBuyer(fields);
  const contact = firstField(fields, [
    "Фамилии, имена и отчества, номера телефонов работников заказчика",
    "Контактные данные",
  ]);
  const giasId = findGiasId($);
  const externalIds = [
    { kind: "auc" as const, value: aucId },
    ...(giasId === undefined ? [] : [{ kind: "gias" as const, value: giasId }]),
  ];

  const card = ProcedureCard.parse({
    sourceId: "goszakupki_by",
    sourceProcurementId,
    externalIds,
    url: input.url,
    title,
    pageFamily,
    kind: procedureKind(procedureLabel),
    status: procedureStatus(sourceStatus),
    ...(sourceStatus === undefined ? {} : { sourceStatus }),
    ...(buyer === undefined
      ? {}
      : {
          buyer,
          parties: [
            {
              role: "buyer",
              name: buyer.name,
              ...(buyer.registrationNumber === undefined
                ? {}
                : { registrationNumber: buyer.registrationNumber }),
              ...(buyer.address === undefined ? {} : { address: buyer.address }),
              ...(contact === undefined ? {} : { contacts: [{ raw: contact }] }),
            },
          ],
        }),
    ...(amount?.amount === null || amount?.currency === undefined
      ? {}
      : { startingPrice: { amount: amount.amount, currency: amount.currency } }),
    ...(amount === undefined ? {} : { amount }),
    ...(parsePlatformInstant(
      firstField(fields, ["Дата размещения приглашения", "Дата размещения заявки на покупку"]),
    ) === undefined
      ? {}
      : {
          publishedAt: parsePlatformInstant(
            firstField(fields, [
              "Дата размещения приглашения",
              "Дата размещения заявки на покупку",
            ]),
          ),
        }),
    ...(parsePlatformInstant(
      firstField(fields, [
        "Дата окончания приема предложений",
        "Дата окончания приема сведений",
        "Дата окончания приема документов и (или) сведений",
      ]),
    ) === undefined
      ? {}
      : {
          bidsDeadline: parsePlatformInstant(
            firstField(fields, [
              "Дата окончания приема предложений",
              "Дата окончания приема сведений",
              "Дата окончания приема документов и (или) сведений",
            ]),
          ),
        }),
    ...(parsePlatformInstant(
      firstField(fields, ["Дата и время проведения электронного аукциона"]),
    ) === undefined
      ? {}
      : {
          auctionAt: parsePlatformInstant(
            firstField(fields, ["Дата и время проведения электронного аукциона"]),
          ),
        }),
    lots,
    rawFields: Object.fromEntries(fields),
    fetchedAt: input.fetchedAt,
  });

  return {
    card,
    documents: parseDocuments($, input.url, input.fetchedAt),
    history: parseHistory($, input.url),
  };
}

function collectFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  $("#print-area .panel table tr").each((_index, row) => {
    const key = text($(row).children("th").first());
    const value = text($(row).children("td").first());
    if (key.length > 0 && value.length > 0 && !fields.has(key)) fields.set(key, value);
  });
  return fields;
}

function firstField(fields: ReadonlyMap<string, string>, labels: readonly string[]) {
  for (const label of labels) {
    const value = fields.get(label);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseBuyer(fields: ReadonlyMap<string, string>) {
  const name = firstField(fields, [
    "Наименование организации",
    "Наименование заказчика(-ов) (ФИО - для ИП)",
  ]);
  if (name === undefined) return undefined;
  const registrationNumber = firstField(fields, ["УНП организации", "УНП заказчика(-ов)"]);
  const address = firstField(fields, [
    "Место нахождения организации",
    "Место нахождения (место жительства) заказчика(-ов)",
  ]);
  const contact = firstField(fields, [
    "Фамилии, имена и отчества, номера телефонов работников заказчика",
    "Контактные данные",
  ]);
  return {
    name,
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(address === undefined ? {} : { address }),
    ...(contact === undefined ? {} : { contact }),
  };
}

function parseLots($: CheerioAPI): SourceLot[] {
  return $("#lotsList tr.lot-row")
    .toArray()
    .map((row) => {
      const lotRow = $(row);
      const details = lotRow.next("tr.lot-inf");
      const number = text(lotRow.find(".lot-num").first());
      const title = text(lotRow.find(".lot-description").first());
      const countAndPrice = text(lotRow.find(".lot-count-price").first());
      const parsedCount = parseCountAndPrice(countAndPrice);
      const detailFields = collectDetailFields($, details);
      const status = text(lotRow.find(".lot-status").first());
      const positions = parsePositions($, details);
      return {
        number: number.length > 0 ? number : String(lotRow.index() + 1),
        title,
        ...(status.length === 0 ? {} : { status }),
        ...(parsedCount.money === undefined ? {} : { startingPrice: parsedCount.money }),
        ...(parsedCount.amount === undefined ? {} : { amount: parsedCount.amount }),
        ...(parsedCount.quantity === undefined ? {} : { quantity: parsedCount.quantity }),
        ...(parsedCount.unit === undefined ? {} : { unit: parsedCount.unit }),
        ...optionalDetail(detailFields, "Срок поставки", "deliveryTerm"),
        ...optionalDetail(
          detailFields,
          "Место поставки товара, выполнения работ, оказания услуг",
          "deliveryPlace",
        ),
        ...optionalDetail(detailFields, "Источник финансирования", "funding"),
        ...optionalDetail(detailFields, "Способ расчетов", "paymentTermsRaw"),
        ...optionalDetail(detailFields, "Размер аукционного обеспечения", "bidSecurity"),
        ...optionalDetail(detailFields, "Размер конкурсного обеспечения", "bidSecurity"),
        ...optionalDetail(
          detailFields,
          "Размер обеспечения исполнения обязательств по договору",
          "contractSecurity",
        ),
        ...optionalDetail(detailFields, "Код предмета закупки по ОКРБ", "okrbCode"),
        positions,
      };
    })
    .filter((lot) => lot.title.length > 0);
}

function collectDetailFields(
  $: CheerioAPI,
  details: Cheerio<AnyNode>,
): Map<string, string> {
  const fields = new Map<string, string>();
  details.find("li.list-group-item").each((_index, item) => {
    const keyElement = $(item).children("b").first();
    if (keyElement.length === 0) return;
    const key = text(keyElement).replace(/:$/, "");
    const value = text($(item).children("span").first());
    if (key.length > 0 && value.length > 0) fields.set(key, value);
  });
  return fields;
}

function optionalDetail(
  fields: ReadonlyMap<string, string>,
  label: string,
  property:
    | "deliveryTerm"
    | "deliveryPlace"
    | "funding"
    | "paymentTermsRaw"
    | "bidSecurity"
    | "contractSecurity"
    | "okrbCode",
) {
  const value = fields.get(label);
  return value === undefined ? {} : { [property]: value };
}

function parsePositions($: CheerioAPI, details: Cheerio<AnyNode>) {
  const heading = details.find("h4").filter((_index, element) =>
    text($(element)).includes("Позиции лота"),
  );
  const list = heading.next("ul");
  return list
    .children("li")
    .toArray()
    .map((item) => {
      const raw = text($(item));
      const externalNumber = raw.match(/Позиция №\s*([^:]+):/i)?.[1]?.trim();
      const title = raw
        .replace(/^Позиция №\s*[^:]+:\s*/i, "")
        .split(/,\s*Код ОКРБ:/i)[0]
        ?.trim();
      const quantity = parseLocalizedNumber(raw.match(/Объем:\s*([\d\s.,]+)/i)?.[1]);
      const unit = raw.match(/Объем:\s*[\d\s.,]+\s*([^,]+)/i)?.[1]?.trim();
      if (title === undefined || title.length === 0) return undefined;
      return {
        ...(externalNumber === undefined ? {} : { externalNumber }),
        title,
        ...(quantity === undefined ? {} : { quantity }),
        ...(unit === undefined ? {} : { unit }),
      };
    })
    .filter((position) => position !== undefined);
}

function parseCountAndPrice(raw: string): {
  quantity?: number;
  unit?: string;
  money?: { amount: number; currency: string };
  amount?: PlatformAmount;
} {
  const moneyMatch = raw.match(/([\d][\d\s.,]*)\s+([A-Z]{3})\s*$/);
  const moneyAmount = parseLocalizedNumber(moneyMatch?.[1]);
  const currency = moneyMatch?.[2];
  const quantityPart =
    moneyMatch?.index === undefined ? raw : raw.slice(0, moneyMatch.index).replace(/,\s*$/, "");
  const quantity = parseLocalizedNumber(quantityPart.match(/^[\s]*([\d\s.,]+)/)?.[1]);
  const unit = quantityPart.replace(/^[\s]*[\d\s.,]+/, "").trim() || undefined;
  return {
    ...(quantity === undefined ? {} : { quantity }),
    ...(unit === undefined ? {} : { unit }),
    ...(moneyAmount === undefined || currency === undefined
      ? {}
      : {
          money: { amount: moneyAmount, currency },
          amount: { kind: "limit", amount: moneyAmount, currency, raw },
        }),
  };
}

function parsePlatformAmount(raw: string | undefined): PlatformAmount | undefined {
  if (raw === undefined) return undefined;
  const match = raw.match(/([\d][\d\s.,]*)\s+([A-Z]{3})/);
  const amount = parseLocalizedNumber(match?.[1]) ?? null;
  return {
    kind: "limit",
    amount,
    ...(match?.[2] === undefined ? {} : { currency: match[2] }),
    raw,
  };
}

function parseLocalizedNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const compact = raw.replace(/\s/g, "");
  const normalized =
    compact.includes(",") && compact.includes(".")
      ? compact.replace(/,/g, "")
      : compact.replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function parsePlatformInstant(raw: string | undefined): PlatformInstant | undefined {
  if (raw === undefined) return undefined;
  const match = raw.match(
    /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match === null) return undefined;
  const [, day, month, year, hour, minute, second] = match;
  if (day === undefined || month === undefined || year === undefined) return undefined;
  if (hour === undefined || minute === undefined) {
    return { precision: "date", date: `${year}-${month}-${day}`, timeZone: TIME_ZONE };
  }
  return {
    precision: "date_time",
    at: `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}+03:00`,
  };
}

function parseDocuments(
  $: CheerioAPI,
  cardUrl: string,
  discoveredAt: IsoDateTime,
): SourceDocument[] {
  return $("a.modal-link")
    .toArray()
    .map((element) => {
      const link = $(element);
      const name = text(link);
      const href = link.attr("href");
      if (name.length === 0 || href === undefined) return undefined;
      const metadataUrl = new URL(href, cardUrl);
      const sourceFileKey = metadataUrl.searchParams.get("f") ?? undefined;
      const downloadUrl = new URL(metadataUrl);
      downloadUrl.searchParams.set("download", "1");
      return SourceDocument.parse({
        name,
        sourceUrl: metadataUrl.href,
        metadataUrl: metadataUrl.href,
        downloadUrl: downloadUrl.href,
        mimeType: mimeTypeFromName(name),
        ...(sourceFileKey === undefined ? {} : { sourceFileKey }),
        discoveredAt,
      });
    })
    .filter((document) => document !== undefined);
}

function parseHistory($: CheerioAPI, cardUrl: string) {
  return $("table.chronology-events-list tbody tr, table.chronology-events-list > tr")
    .toArray()
    .map((row) => {
      const rowElement = $(row);
      const href = rowElement.find("a[href]").last().attr("href");
      const question = text(rowElement);
      if (question.length === 0) return undefined;
      return {
        question,
        ...(href === undefined ? {} : { sourceUrl: new URL(href, cardUrl).href }),
      };
    })
    .filter((clarification) => clarification !== undefined);
}

function findGiasId($: CheerioAPI): string | undefined {
  const row = $("small.text-info")
    .filter((_index, element) => text($(element)).includes("№ закупки в ГИАС"))
    .first()
    .parent();
  return text(row).match(/№ закупки в ГИАС:\s*(\d+)/i)?.[1];
}

function aggregateSourceStatus(lots: readonly SourceLot[]): string | undefined {
  const statuses = [...new Set(lots.map((lot) => lot.status).filter((value) => value !== undefined))];
  return statuses.length === 0 ? undefined : statuses.join("; ");
}

function procedureStatus(sourceStatus: string | undefined): ProcedureStatus {
  if (sourceStatus === undefined) return "unknown";
  const normalized = normalise(sourceStatus);
  if (
    normalized.includes("подача предложений") ||
    normalized.includes("подача документов")
  ) {
    return "accepting_bids";
  }
  if (normalized.includes("отмен")) return "cancelled";
  if (normalized.includes("заверш") || normalized.includes("заключен")) return "completed";
  if (normalized.includes("рассмотр")) return "under_review";
  return "unknown";
}

function procedureKind(label: string | undefined): ProcedureKind {
  const normalized = normalise(label ?? "");
  if (normalized.includes("электронный аукцион")) return "electronic_auction";
  if (normalized.includes("запрос ценовых предложений")) return "request_for_quotations";
  if (normalized.includes("открытый конкурс")) return "open_tender";
  if (normalized.includes("из одного источника")) return "single_source";
  if (normalized.includes("переговор")) return "competitive_negotiation";
  return "other";
}

function pageFamilyFromUrl(url: string): PageFamily {
  const firstSegment = new URL(url).pathname.split("/").filter(Boolean)[0];
  return pageFamilyFromSegment(firstSegment);
}

function pageFamilyFromSegment(firstSegment: string | undefined): PageFamily {
  if (
    firstSegment === "auction" ||
    firstSegment === "marketing" ||
    firstSegment === "request" ||
    firstSegment === "etrade"
  ) {
    return firstSegment;
  }
  return "other";
}

function mimeTypeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  const known: Readonly<Record<string, string>> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    zip: "application/zip",
  };
  return extension === undefined ? "application/octet-stream" : (known[extension] ?? "application/octet-stream");
}

function text(element: Cheerio<AnyNode>): string {
  return element.text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}
