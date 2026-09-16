import * as cheerio from "cheerio";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseGoszakupkiSearchFilters } from "./goszakupki-by-filters.js";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { parseGoszakupkiSearchPage } from "./goszakupki-by-parser.js";

/**
 * Same GET as the site advanced search. No adapter scoring.
 *
 *   npm run diagnose:posted-search -- --text КТПБ --status Submission
 */

await loadRepoEnv();

const text = arg("--text") ?? "КТПБ";
const statusIds = all("--status");
const client = new GoszakupkiHttpClient({
  requestsPerMinute: 20,
  timeoutMs: 45_000,
});

const form = await client.get("/tenders/posted");
const options = parseGoszakupkiSearchFilters(form.body).statuses;
out(`FORM ${String(form.status)} ${form.url}`);
out(`status fields in HTML: ${options.length === 0 ? "none" : options.map((item) => `${item.value}=${item.label}`).join("; ")}`);

const allowed = new Set(options.map((item) => item.value));
let ids = statusIds;
if (ids.length === 0) {
  ids = options.filter((item) => item.label === "Подача предложений").map((item) => item.value);
}
const unknown = ids.filter((id) => allowed.size > 0 && !allowed.has(id));
if (unknown.length > 0) {
  const submission = options.find((item) => item.label === "Подача предложений")?.value;
  out(`status codes not on the form: ${unknown.join(", ")}`);
  if (submission !== undefined) {
    out(`using ${submission} for Подача предложений`);
    ids = [submission];
  }
}

const parameters = new URLSearchParams();
parameters.set("TendersSearch[text]", text);
for (const id of ids) parameters.append("TendersSearch[status][]", id);
const path = `/tenders/posted?${parameters.toString()}`;
out(`GET ${path}`);
out(`decoded ${decodeURIComponent(path)}`);

const listing = await client.get(path);
const $ = cheerio.load(listing.body);
const raw = $("tr[data-key]").toArray();
const parsed = parseGoszakupkiSearchPage(listing.body, listing.url);
out(`HTTP ${String(listing.status)} tableRows=${String(raw.length)} parsed=${String(parsed.rows.length)}`);
for (const [index, row] of raw.entries()) {
  const hrefs = $(row)
    .find("a[href]")
    .toArray()
    .map((element) => $(element).attr("href") ?? "")
    .filter(Boolean);
  out(`RAW ${String(index + 1)} ${$(row).text().replace(/\s+/gu, " ").trim().slice(0, 220)}`);
  out(`    hrefs ${hrefs.join(" | ")}`);
}
for (const { hit } of parsed.rows) {
  out(`PARSED ${hit.sourceProcurementId}  ${hit.sourceStatus ?? "—"}  ${hit.title}`);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function all(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) {
      values.push(process.argv[index + 1] ?? "");
      index += 1;
    }
  }
  return values;
}

function out(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function loadRepoEnv(): Promise<void> {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  let file: string;
  try {
    file = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of file.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
