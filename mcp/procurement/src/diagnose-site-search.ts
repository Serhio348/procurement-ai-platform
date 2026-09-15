import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { parseGoszakupkiSearchPage } from "./goszakupki-by-parser.js";

const DEFAULT_TERMS = [
  "монтаж электрооборудования",
  "монтаж электросилового оборудования",
  "пусконаладочные работы",
  "пуско-наладочные работы",
  "наладка электрооборудования",
  "электромонтажные работы",
];

const terms = unique(process.argv.slice(2).map((term) => term.trim()).filter(Boolean));
const searchTerms = terms.length > 0 ? terms : DEFAULT_TERMS;
const pagesPerTerm = positiveInteger(process.env["SEARCH_PAGES"], 5);
const client = new GoszakupkiHttpClient({
  requestsPerMinute: 30,
  timeoutMs: 45_000,
});

const searches = [];
const occurrences = new Map<
  string,
  {
    sourceProcurementId: string;
    title: string;
    url: string;
    buyerName?: string;
    sourceStatus?: string;
    foundBy: string[];
  }
>();

for (const term of searchTerms) {
  const rows = [];
  let fetchedPages = 0;
  for (let page = 1; page <= pagesPerTerm; page += 1) {
    const path = searchPath(term, page);
    process.stderr.write(`SITE GET term=${JSON.stringify(term)} page=${String(page)} path=${path}\n`);
    const response = await client.get(path);
    const parsed = parseGoszakupkiSearchPage(response.body, response.url);
    fetchedPages += 1;
    for (const { hit } of parsed.rows) {
      const row = {
        sourceProcurementId: hit.sourceProcurementId,
        title: hit.title,
        url: hit.url,
        ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
        ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
      };
      rows.push(row);
      const known = occurrences.get(hit.sourceProcurementId);
      if (known === undefined) {
        occurrences.set(hit.sourceProcurementId, { ...row, foundBy: [term] });
      } else if (!known.foundBy.includes(term)) {
        known.foundBy.push(term);
      }
    }
    process.stderr.write(
      `SITE PAGE term=${JSON.stringify(term)} page=${String(page)} rows=${String(parsed.rows.length)} hasNext=${String(parsed.hasNextPage)}\n`,
    );
    if (!parsed.hasNextPage) break;
  }
  searches.push({ term, fetchedPages, rowCount: rows.length, rows });
}

const allRows = [...occurrences.values()];
process.stdout.write(
  `${JSON.stringify(
    {
      mode: "raw_goszakupki_listing",
      generatedAt: new Date().toISOString(),
      pagesPerTerm,
      searchTerms,
      searches,
      uniqueCount: allRows.length,
      occurrences: allRows,
    },
    null,
    2,
  )}\n`,
);
process.stderr.write(
  `SITE DONE terms=${String(searchTerms.length)} unique=${String(allRows.length)}\n`,
);

function searchPath(term: string, page: number): string {
  const parameters = new URLSearchParams();
  parameters.set("TendersSearch[text]", term);
  if (page > 1) parameters.set("page", String(page));
  return `/tenders/posted?${parameters.toString()}`;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase("ru-BY");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
