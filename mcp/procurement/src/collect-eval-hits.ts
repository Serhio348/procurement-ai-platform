import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SearchQuery } from "@procurement/contracts";
import { inferSearchIntentPlan, platformSearchTerms } from "@procurement/domain";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";

/**
 * Dumps raw goszakupki.by listing rows for the NCU pump eval set.
 * Does not score, filter, or change SearchIntentPlan.
 *
 * Extra coverage terms are only for the dataset mix (монтаж, ремонт, …).
 * Production console search still uses platformSearchTerms(plan, keywords).
 */
const PROFILE = {
  name: "НКУ для управления насосами",
  keywords: ["НКУ", "шкаф управления"],
  excludeKeywords: [] as string[],
};

const COVERAGE_TERMS = [
  "монтаж НКУ",
  "ремонт НКУ",
  "обслуживание НКУ",
  "пусконаладка НКУ",
  "проектирование НКУ",
  "шкаф автоматики",
  "насос шкаф",
];

const LIMIT_PER_TERM = 40;

interface DumpedHit {
  id: string;
  title: string;
  url: string;
  buyerName?: string;
  sourceStatus?: string;
  terms: string[];
}

await loadRepoEnv();

const plan = inferSearchIntentPlan(PROFILE);
const profileTerms = platformSearchTerms(plan, PROFILE.keywords);
const terms = unique([...profileTerms, ...COVERAGE_TERMS]);
const source = new GoszakupkiBySource({
  client: new GoszakupkiHttpClient({ requestsPerMinute: 20, timeoutMs: 45_000 }),
});
const seen = new Map<string, DumpedHit>();
const termCounts: Record<string, number> = {};

for (const term of terms) {
  const response = await source.search(
    SearchQuery.parse({
      sourceId: "goszakupki_by",
      keywords: [term],
      limit: LIMIT_PER_TERM,
    }),
  );
  termCounts[term] = response.hits.length;
  process.stderr.write(`term «${term}»: ${String(response.hits.length)} rows\n`);
  for (const hit of response.hits) {
    const existing = seen.get(hit.sourceProcurementId);
    if (existing !== undefined) {
      if (!existing.terms.includes(term)) existing.terms.push(term);
      continue;
    }
    seen.set(hit.sourceProcurementId, {
      id: hit.sourceProcurementId,
      title: hit.title,
      url: hit.url,
      ...(hit.buyerName === undefined ? {} : { buyerName: hit.buyerName }),
      ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
      terms: [term],
    });
  }
}

const hits = [...seen.values()];
process.stdout.write(
  `${JSON.stringify(
    {
      profile: PROFILE,
      platformTerms: profileTerms,
      coverageTerms: COVERAGE_TERMS,
      termCounts,
      unique: hits.length,
      hits,
    },
    null,
    2,
  )}\n`,
);
process.stderr.write(`unique ${String(hits.length)}\n`);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function loadRepoEnv(): Promise<void> {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/u)) {
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
