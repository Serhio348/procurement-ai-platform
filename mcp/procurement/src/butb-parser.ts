import {
  ProcedureCard,
  SearchHit,
  type IsoDateTime,
  type PlatformAmount,
  type PlatformInstant,
  type ProcedureKind,
  type ProcedureStatus,
  type SourceDocument,
  type SourceLot,
} from "@procurement/contracts";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

const TIME_ZONE = "Europe/Minsk";

/**
 * zakupki.butb.by is a JSF/ICEfaces application: the public registry is
 * server-session state, not a set of linked pages. The adapter therefore
 * speaks the postback protocol (see butb-http.ts) and this module only
 * knows the markup shapes.
 *
 * Verified live shapes (October 2026):
 *  - Full page GET renders `#fra\\:reestrAu` rows with 11 cells and an
 *    `mojarra.jsfcljs` name link per row.
 *  - ACE dataTable pageChange answers a JSF partial-response XML whose
 *    `<update id="fra:reestrAu"><![CDATA[…]]>` carries the same table.
 *  - The row name link posts back `{linkId: linkId}` and the site 302s to
 *    `/auctions/viewinvitation.html`; the opened card lives in the session.
 *  - Expanding the registry's search panel degrades the table to a single
 *    «Вид закупки» column for the rest of the session — so the adapter
 *    scans the registry and filters locally instead of using that form.
 */

export interface ButbRegistryRow {
  /** Row index used in `fra:reestrAu:{index}:…` component ids. */
  rowIndex: number;
  /** JSF component id of the name link — the card postback trigger. */
  cardLinkId: string;
  /** Registry number, e.g. AU20261015396707 — the stable public id. */
  registryNumber: string;
  /** «Номер на icetrade.by / ГИАС» second line of the number cell. */
  icetradeNumber?: string;
  title: string;
  kindLabel: string;
  publishedAt?: PlatformInstant;
  amount?: PlatformAmount;
  buyerName?: string;
  financing?: string;
  bidsDeadline?: PlatformInstant;
  auctionAt?: PlatformInstant;
  sourceStatus?: string;
  completedAt?: PlatformInstant;
}

export interface ParsedButbCard {
  card: ProcedureCard;
  documents: SourceDocument[];
}

/** Hidden JSF tokens every postback must echo. */
export interface ButbViewState {
  viewState: string;
  iceWindow?: string;
  iceView?: string;
  /** Action URL of the `fra` form (usually /auctions/reestrauctions.html). */
  formAction?: string;
}

const REGISTRY_ROW_ID = /^fra:reestrAu:(\d+):_t\d+$/;
const REGISTRY_NUMBER = /^[A-Z]{2}\d{10,}$/;

export function parseButbViewState(html: string): ButbViewState | undefined {
  // Partial-response XML keeps the token inside an update block.
  const update = html.match(
    /<update id="javax\.faces\.ViewState"><!\[CDATA\[([^\]]+)\]\]>/,
  );
  const inline = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  const viewState = update?.[1] ?? inline?.[1];
  if (viewState === undefined) return undefined;
  return {
    viewState,
    ...(html.match(/name="ice\.window"[^>]*value="([^"]+)"/)?.[1] === undefined
      ? {}
      : { iceWindow: html.match(/name="ice\.window"[^>]*value="([^"]+)"/)![1] }),
    ...(html.match(/name="ice\.view"[^>]*value="([^"]+)"/)?.[1] === undefined
      ? {}
      : { iceView: html.match(/name="ice\.view"[^>]*value="([^"]+)"/)![1] }),
    ...(html.match(/<form action="([^"]+)"[^>]*id="fra"/)?.[1] === undefined
      ? {}
      : { formAction: html.match(/<form action="([^"]+)"[^>]*id="fra"/)![1] }),
  };
}

/**
 * Pulls one updated component out of a JSF partial-response document.
 * Returns the CDATA payload (rendered HTML) or undefined.
 */
export function butbPartialUpdate(xml: string, componentId: string): string | undefined {
  const escaped = componentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<update id="${escaped}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></update>`),
  );
  return match?.[1];
}

/** `totalRecords` advertised by the YAHOO paginator widget config. */
export function butbTotalRecords(html: string): number | undefined {
  const match = html.match(/"totalRecords":(\d+)/);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Registry rows of `fra:reestrAu`. Works on the full page render and on the
 * HTML embedded in a pageChange `<update>` block alike — the table markup is
 * identical. Rows whose name link is missing are skipped: without its JSF id
 * the card cannot be opened, so the row is unusable.
 */
export function parseButbRegistryRows(html: string): ButbRegistryRow[] {
  const $ = cheerio.load(html);
  const rows: ButbRegistryRow[] = [];
  $("tr[id^='fra:reestrAu_row_']").each((_index, row) => {
    const parsed = registryRow($, $(row));
    if (parsed !== undefined) rows.push(parsed);
  });
  return rows;
}

function registryRow(
  $: cheerio.CheerioAPI,
  $row: Cheerio<AnyNode>,
): ButbRegistryRow | undefined {
  const link = $row.find("a[onclick*='jsfcljs'], a[onclick*='iceSubmit']").first();
  const linkId = link.attr("id");
  if (linkId === undefined) return undefined;
  const linkMatch = linkId.match(REGISTRY_ROW_ID);
  if (linkMatch?.[1] === undefined) return undefined;
  const title = link.text().trim();
  if (title.length === 0) return undefined;

  const cells = $row
    .children("td")
    .toArray()
    .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
  const numberCell = cells[0] ?? "";
  const registryNumber = numberCell.match(/[A-Z]{2}\d{10,}/)?.[0];
  if (registryNumber === undefined || !REGISTRY_NUMBER.test(registryNumber)) {
    return undefined;
  }
  // The second number line is «icetrade / ГИАС» — «- / 4828385» or «- / -».
  const secondary = numberCell
    .replace(registryNumber, "")
    .replace(/[-/]/g, " ")
    .trim();
  const publishedAt = parseInstant(cells[3]);
  const amount = parseAmount(cells[4]);
  const buyerName = emptyToUndefined(cells[5]);
  const financing = emptyToUndefined(cells[6]);
  const bidsDeadline = parseInstant(cells[7]);
  const auctionAt = parseInstant(cells[8]);
  const sourceStatus = emptyToUndefined(cells[9]);
  const completedAt = parseInstant(cells[10]);
  return {
    rowIndex: Number(linkMatch[1]),
    cardLinkId: linkId,
    registryNumber,
    ...(secondary.length === 0 ? {} : { icetradeNumber: secondary }),
    title,
    kindLabel: cells[2] ?? "",
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(amount === undefined ? {} : { amount }),
    ...(buyerName === undefined ? {} : { buyerName }),
    ...(financing === undefined ? {} : { financing }),
    ...(bidsDeadline === undefined ? {} : { bidsDeadline }),
    ...(auctionAt === undefined ? {} : { auctionAt }),
    ...(sourceStatus === undefined ? {} : { sourceStatus }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function butbRegistryHit(row: ButbRegistryRow, baseUrl: string): SearchHit {
  return SearchHit.parse({
    sourceId: "butb",
    sourceProcurementId: `butb/${row.registryNumber}`,
    url: `${baseUrl}/auctions/reestrauctions.html`,
    title: row.title,
    pageFamily: "other",
    kind: butbKind(row.kindLabel),
    ...(row.kindLabel.length === 0 ? {} : { kindLabel: row.kindLabel }),
    ...(row.sourceStatus === undefined
      ? {}
      : { sourceStatus: row.sourceStatus, status: butbStatus(row.sourceStatus) }),
    ...(row.buyerName === undefined ? {} : { buyerName: row.buyerName }),
    ...(row.amount?.amount === null || row.amount?.currency === undefined
      ? {}
      : { startingPrice: { amount: row.amount.amount, currency: row.amount.currency } }),
    ...(row.amount === undefined ? {} : { amount: row.amount }),
    ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
    ...(row.bidsDeadline === undefined ? {} : { bidsDeadline: row.bidsDeadline }),
  });
}

export function parseButbCard(input: {
  html: string;
  url: string;
  fetchedAt: IsoDateTime;
  registryNumber?: string;
}): ParsedButbCard {
  const $ = cheerio.load(input.html);
  const fields = cardFields($);
  // The card's own field wins over the requested number: when the postback
  // opened the wrong row, the card says so and the caller's identity check
  // catches the mismatch instead of relabelling a stranger's card.
  const registryNumber =
    fields.get("регистрационный номер")?.match(/[A-Z]{2}\d{10,}/)?.[0] ??
    input.registryNumber ??
    "unknown";
  const gias = fields.get("номер закупки в гиас");
  const title =
    emptyToUndefined(fields.get("наименование закупки")) ??
    fields.get("предмет закупки") ??
    registryNumber;
  const sourceStatus = fields.get("состояние");
  const customer = fields.get("полное наименование");
  const price = parseAmount(
    [fields.get("начальная цена"), fields.get("начальная (максимальная) цена")]
      .filter((v): v is string => v !== undefined)
      .join(" "),
  );

  const lots = parseLots($);
  const documents = parseDocuments($, input.url, input.fetchedAt);

  const rawFields: Record<string, string> = {};
  for (const [key, value] of fields) rawFields[key] = value;

  return {
    card: ProcedureCard.parse({
      listedDocuments: documents.map((document) => ({
        name: document.name,
        sourceUrl: document.sourceUrl,
        ...(document.downloadUrl === undefined
          ? {}
          : { downloadUrl: document.downloadUrl }),
      })),
      sourceId: "butb",
      sourceProcurementId: `butb/${registryNumber}`,
      externalIds: [
        ...(gias === undefined || gias.trim().length === 0
          ? []
          : [{ kind: "gias" as const, value: gias.trim() }]),
        { kind: "other" as const, value: registryNumber },
      ],
      url: input.url,
      title,
      pageFamily: "other",
      kind: butbKind(fields.get("вид процедуры закупки") ?? fields.get("вид закупки")),
      ...(sourceStatus === undefined
        ? {}
        : { sourceStatus, status: butbStatus(sourceStatus) }),
      parties: [
        ...(customer === undefined
          ? []
          : [
              {
                role: "buyer" as const,
                name: customer,
                ...(fields.get("унп") === undefined
                  ? {}
                  : { registrationNumber: fields.get("унп") }),
                contacts: [
                  {
                    raw: [
                      fields.get("телефон"),
                      fields.get("адрес электронной почты") ?? fields.get("e-mail"),
                      fields.get("место нахождения"),
                    ]
                      .filter((part): part is string => part !== undefined && part.length > 0)
                      .join(", "),
                  },
                ].filter((contact) => contact.raw.length > 0),
              },
            ]),
      ],
      ...(customer === undefined
        ? {}
        : {
            buyer: {
              name: customer,
              ...(fields.get("унп") === undefined
                ? {}
                : { registrationNumber: fields.get("унп") }),
              ...(fields.get("место нахождения") === undefined
                ? {}
                : { address: fields.get("место нахождения") }),
            },
          }),
      ...(price?.amount === null || price?.currency === undefined
        ? {}
        : { startingPrice: { amount: price.amount, currency: price.currency } }),
      ...(price === undefined ? {} : { amount: price }),
      ...(parseInstant(fields.get("дата размещения приглашения")) === undefined
        ? {}
        : { publishedAt: parseInstant(fields.get("дата размещения приглашения")) }),
      ...(parseInstant(fieldByPrefix(fields, "конечная дата")) === undefined
        ? {}
        : { bidsDeadline: parseInstant(fieldByPrefix(fields, "конечная дата")) }),
      lots,
      history: [],
      rawFields,
      fetchedAt: input.fetchedAt,
    }),
    documents,
  };
}

/** Label→value pairs of the card — consecutive `<span>` siblings. */
function cardFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  const spans = $("span[id]")
    .toArray()
    .map((element) => $(element).text().replace(/\s+/g, " ").trim());
  for (let index = 0; index + 1 < spans.length; index += 1) {
    const label = normalizeLabel(spans[index] ?? "");
    const value = spans[index + 1] ?? "";
    if (label.length < 3 || label.length > 80) continue;
    if (fields.has(label)) continue;
    fields.set(label, value);
  }
  return fields;
}

function parseLots($: CheerioAPI): SourceLot[] {
  const table = $("table[id$='lotsList']").first();
  if (table.length === 0) return [];
  const lots: SourceLot[] = [];
  table.find("tbody tr").each((index, row) => {
    const cells = $(row)
      .children("td")
      .toArray()
      .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
    if (cells.length < 3) return;
    const price = parseAmount(cells[7]);
    lots.push({
      number: cells[0] ?? String(index + 1),
      title: cells[2] ?? cells[0] ?? `Лот ${index + 1}`,
      positions: [],
      ...(emptyToUndefined(cells[1]) === undefined ? {} : { okrbCode: cells[1] }),
      ...(quantityUnit(cells[3]) === undefined ? {} : quantityUnit(cells[3])),
      ...(emptyToUndefined(cells[4]) === undefined ? {} : { deliveryPlace: cells[4] }),
      ...(emptyToUndefined(cells[5]) === undefined ? {} : { deliveryTerm: cells[5] }),
      ...(emptyToUndefined(cells[6]) === undefined ? {} : { funding: cells[6] }),
      ...(price?.amount === null || price?.currency === undefined
        ? {}
        : { startingPrice: { amount: price.amount, currency: price.currency } }),
      ...(price === undefined ? {} : { amount: price }),
      ...(emptyToUndefined(cells[8]) === undefined ? {} : { status: cells[8] }),
    });
  });
  return lots;
}

function parseDocuments($: CheerioAPI, pageUrl: string, discoveredAt: IsoDateTime): SourceDocument[] {
  const documents: SourceDocument[] = [];
  const seen = new Set<string>();
  $("a[href*='/auctions/download']").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const absolute = new URL(href, pageUrl).href;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const name =
      $(element).text().replace(/\s+/g, " ").trim() ||
      decodeURIComponent(absolute.split("/").pop() ?? "document");
    documents.push({
      name,
      sourceUrl: absolute,
      downloadUrl: absolute,
      mimeType: "application/octet-stream",
      lifecycle: "active",
      discoveredAt,
    });
  });
  return documents;
}

/** BUTB «Вид закупки» labels → normalized kind. */
export function butbKind(label: string | undefined): ProcedureKind {
  const normalized = (label ?? "").toLocaleLowerCase("ru-BY").trim();
  if (normalized.includes("аукцион")) return "electronic_auction";
  if (normalized.includes("конкурс")) return "open_tender";
  if (
    normalized.includes("запрос ценовых предложений") ||
    normalized === "зцп" ||
    normalized.includes("заявка о ценах")
  ) {
    return "request_for_quotations";
  }
  if (normalized.includes("одного источника") || normalized.includes("один источник")) {
    return "single_source";
  }
  if (normalized.includes("переговор")) return "competitive_negotiation";
  return "other";
}

/** BUTB «Состояние» labels → normalized status. */
export function butbStatus(label: string | undefined): ProcedureStatus {
  const normalized = (label ?? "").toLocaleLowerCase("ru-BY").trim();
  if (normalized.length === 0) return "unknown";
  if (normalized.includes("несостоя")) return "failed";
  if (normalized.includes("отмен") || normalized.includes("приостанов")) return "cancelled";
  if (normalized.includes("подача предложений") || normalized.includes("подача документ")) {
    return "accepting_bids";
  }
  if (normalized.includes("заверш")) return "completed";
  if (normalized.includes("рассмотрени") || normalized.includes("оценк")) return "under_review";
  if (normalized.includes("торг") || normalized.includes("аукцион")) return "auction_in_progress";
  return "unknown";
}

/** Registry number embeds the publish date: AU**2026-10-15**396707. */
export function butbRegistryPublishDate(registryNumber: string): string | undefined {
  const match = registryNumber.match(/^[A-Z]{2}(\d{4})(\d{2})(\d{2})\d+$/);
  if (match === null) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseInstant(raw: string | undefined): PlatformInstant | undefined {
  if (raw === undefined) return undefined;
  const match = raw.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
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

// NBSP (\u00A0) appears inside «1 710 704,01 BYN» prices — write it escaped
// or eslint's no-irregular-whitespace rejects the literal.
const DIGIT_GROUP = /([\d][\d\s.,]*)(?:\s|\u00A0)*(?:бел\.\s*руб\w*|([A-Z]{3}))?/i;
const THOUSANDS_SEP = /[\s\u00A0]/g;

function parseAmount(raw: string | undefined): PlatformAmount | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const match = raw.match(DIGIT_GROUP);
  if (match === null || match[1] === undefined) return undefined;
  const compact = match[1].replace(THOUSANDS_SEP, "");
  const normalized =
    compact.includes(",") && compact.includes(".")
      ? compact.replace(/,/g, "")
      : compact.replace(",", ".");
  const amount = Number(normalized);
  const currency = match[2] ?? (raw.includes("BYN") || raw.includes("бел") ? "BYN" : undefined);
  return {
    kind: "limit",
    amount: Number.isFinite(amount) ? amount : null,
    ...(currency === undefined ? {} : { currency }),
    raw,
  };
}

function quantityUnit(raw: string | undefined): { quantity?: number; unit?: string } | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const match = raw.trim().match(/^([\d.,]+)\s*(.*)$/);
  if (match === null) return { unit: raw.trim() };
  const quantity = Number(match[1]?.replace(",", "."));
  return {
    ...(Number.isFinite(quantity) ? { quantity } : {}),
    ...(match[2] !== undefined && match[2].trim().length > 0 ? { unit: match[2].trim() } : {}),
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === "-" ? undefined : trimmed;
}

function normalizeLabel(raw: string): string {
  return raw.toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}

/** First field whose normalized label starts with the prefix. */
function fieldByPrefix(fields: Map<string, string>, prefix: string): string | undefined {
  for (const [key, value] of fields) {
    if (key.startsWith(prefix)) return value;
  }
  return undefined;
}
