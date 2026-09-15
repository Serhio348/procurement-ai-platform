import { SearchQuery, SourceProcurementId } from "@procurement/contracts";
import {
  inferSearchIntentPlan,
  listingKeepsPlatformHit,
  platformSearchTerms,
  procedureIntentText,
  scoreSearchIntent,
  scoreSearchIntentFromProcedure,
  selectRelevantSearchCards,
} from "@procurement/domain";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import type { GoszakupkiPageResponse } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";

/**
 * Live diagnostic for STAGE-61 + /limited/view/3669746.
 * Does not change production scoring, contracts, or adapters.
 *
 * Run from repo root, VPN off:
 *   npx tsx mcp/procurement/src/live-limited-pipeline.ts
 */

const TARGET_ID = "limited/3669746";
const CARD_PATH = "/limited/view/3669746";

const worksProfile = {
  name: "Монтаж и пусконаладка электросилового оборудования",
  keywords: ["электрооборудование", "монтаж", "пусконаладка"],
  excludeKeywords: [] as string[],
};

const nkuProfile = {
  name: "НКУ для управления насосами",
  keywords: ["НКУ", "шкаф управления"],
  excludeKeywords: [] as string[],
};

const designProfile = {
  name: "Проектирование электроснабжения и электрооборудования",
  keywords: ["проектирование", "электроснабжение", "электрооборудование"],
  excludeKeywords: [] as string[],
};

const httpGets: string[] = [];

await loadRepoEnv();

const inner = new GoszakupkiHttpClient({
  requestsPerMinute: 20,
  timeoutMs: 45_000,
});
const source = new GoszakupkiBySource({
  client: {
    get: async (path: string): Promise<GoszakupkiPageResponse> => {
      httpGets.push(path);
      process.stderr.write(`HTTP GET ${path}\n`);
      return inner.get(path);
    },
  },
});

const worksPlan = inferSearchIntentPlan(worksProfile);
const nkuPlan = inferSearchIntentPlan(nkuProfile);
const designPlan = inferSearchIntentPlan(designProfile);
const pipelineTerms = platformSearchTerms(worksPlan, worksProfile.keywords);

type SearchAttempt = {
  term: string;
  pipeline: boolean;
  hitCount: number;
  found: boolean;
};

const attempts: SearchAttempt[] = [];
let foundHit: Awaited<ReturnType<typeof source.search>>["hits"][number] | undefined;
let foundTerm: string | undefined;
let foundViaPipeline = false;

process.stderr.write("Searching goszakupki.by…\n");
for (const term of pipelineTerms) {
  const result = await source.search(
    SearchQuery.parse({ sourceId: "goszakupki_by", keywords: [term], limit: 100 }),
  );
  const hit = result.hits.find((item) => item.sourceProcurementId === TARGET_ID);
  attempts.push({
    term,
    pipeline: true,
    hitCount: result.hits.length,
    found: hit !== undefined,
  });
  process.stderr.write(
    `pipeline term «${term}»: ${String(result.hits.length)} hits, target ${hit === undefined ? "absent" : "found"}\n`,
  );
  if (hit !== undefined) {
    foundHit = hit;
    foundTerm = term;
    foundViaPipeline = true;
    break;
  }
}

if (foundHit === undefined) {
  const extraTerm = "АСКУЭ";
  const result = await source.search(
    SearchQuery.parse({ sourceId: "goszakupki_by", keywords: [extraTerm], limit: 50 }),
  );
  const hit = result.hits.find((item) => item.sourceProcurementId === TARGET_ID);
  attempts.push({
    term: extraTerm,
    pipeline: false,
    hitCount: result.hits.length,
    found: hit !== undefined,
  });
  process.stderr.write(
    `extra term «${extraTerm}»: ${String(result.hits.length)} hits, target ${hit === undefined ? "absent" : "found"}\n`,
  );
  if (hit !== undefined) {
    foundHit = hit;
    foundTerm = extraTerm;
  }
}

const haystack =
  foundHit === undefined
    ? undefined
    : [foundHit.title, foundHit.buyerName, foundHit.sourceStatus]
        .filter((part): part is string => part !== undefined)
        .join(" ");
const queried = worksPlan.objects.length > 0 ? worksPlan.objects : worksProfile.keywords;
const listingKeep =
  haystack === undefined ? undefined : listingKeepsPlatformHit(haystack, queried);
const listingScore =
  foundHit === undefined ? undefined : scoreSearchIntent({ title: foundHit.title }, worksPlan);
const ranked =
  foundHit === undefined
    ? undefined
    : selectRelevantSearchCards([foundHit], { ...worksProfile, intent: worksPlan }, 50);

process.stderr.write(`GET ${TARGET_ID}\n`);
const card = await source.get(SourceProcurementId.parse(TARGET_ID));
const cardGetsAfterFirst = countCardGets();
await source.get(SourceProcurementId.parse(TARGET_ID));
const cardGetsAfterSecond = countCardGets();

const intentText = procedureIntentText(card);
const worksScore = scoreSearchIntentFromProcedure(card, worksPlan);
const nkuScore = scoreSearchIntentFromProcedure(card, nkuPlan);
const designScore = scoreSearchIntentFromProcedure(card, designPlan);

const rankedKind =
  ranked === undefined
    ? "n/a"
    : ranked.cards.length > 0
      ? "match"
      : ranked.ambiguousCards.length > 0
        ? "review"
        : "discarded";
const rankedCard = ranked?.cards[0] ?? ranked?.ambiguousCards[0];

const searchFound = foundHit !== undefined;
const listingPass = listingKeep === true;
const expectedReview = rankedKind === "review" || rankedKind === "match";
const getOk = card.sourceProcurementId === TARGET_ID && card.lots.length > 0;
const subjectOk = /монтаж.*электрооборудован/i.test(card.lots[0]?.title ?? "");
const intentOk =
  /монтаж/i.test(intentText) &&
  /электрооборудован/i.test(intentText) &&
  /пусконаладочн/i.test(intentText);
const worksMatch = worksScore.decision === "match";
const independenceOk = nkuScore.decision !== "match";
const verdict =
  searchFound &&
  foundViaPipeline &&
  listingPass &&
  expectedReview &&
  getOk &&
  subjectOk &&
  intentOk &&
  worksMatch &&
  independenceOk
    ? "PASS — реальная закупка проходит весь pipeline"
    : failReason();

process.stdout.write(`${report()}\n`);

function failReason(): string {
  if (!searchFound) {
    return "FAIL — 3669746 не появилась в live procurement.search";
  }
  if (!foundViaPipeline) {
    return "FAIL — карточка нашлась не pipeline-термином, а только extra-термином";
  }
  if (listingKeep !== true) {
    return "FAIL — listingKeepsPlatformHit отбросил строку списка";
  }
  if (!expectedReview) {
    return "FAIL — rankHitByIntent не отправил карточку в review/match";
  }
  if (!getOk) {
    return "FAIL — procurement.get не вернул ProcedureCard с lots[]";
  }
  if (!subjectOk) {
    return "FAIL — lots[].title не содержит предмет монтажа электрооборудования";
  }
  if (!intentOk) {
    return "FAIL — procedureIntentText без монтажа / электрооборудования / пусконаладки";
  }
  if (!worksMatch) {
    return `FAIL — scoreSearchIntentFromProcedure = ${worksScore.decision}, ожидался match`;
  }
  if (!independenceOk) {
    return `FAIL — профиль НКУ тоже дал ${nkuScore.decision}, профили не независимы`;
  }
  return "FAIL — неизвестная причина";
}

function countCardGets(): number {
  return httpGets.filter((path) => path.split("?")[0] === CARD_PATH).length;
}

function yamlBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function report(): string {
  return [
    "## 1. SearchIntentPlan",
    "",
    yamlBlock(worksPlan),
    "",
    "## 2. Platform search",
    "",
    searchFound ? "Найден" : "Не найден",
    "",
    `Термин: ${foundTerm ?? pipelineTerms.join(", ")}`,
    foundViaPipeline ? "Источник термина: pipeline (`platformSearchTerms`)" : foundHit !== undefined ? "Источник термина: extra (не pipeline)" : "Источник термина: n/a",
    "",
    yamlBlock({ pipelineTerms, attempts }),
    "",
    "## 3. SearchHit",
    "",
    foundHit === undefined
      ? "нет"
      : yamlBlock({
          sourceProcurementId: foundHit.sourceProcurementId,
          url: foundHit.url,
          title: foundHit.title,
          buyerName: foundHit.buyerName,
          sourceStatus: foundHit.sourceStatus,
          pageFamily: foundHit.pageFamily,
        }),
    "",
    "## 4. Listing filter",
    "",
    listingKeep === true ? "PASS" : listingKeep === false ? "FAIL" : "n/a — нет SearchHit",
    "",
    yamlBlock({ haystack, queried, listingKeepsPlatformHit: listingKeep }),
    "",
    "## 5. rankHitByIntent",
    "",
    yamlBlock({
      listingScore,
      outcome: rankedKind,
      foundAs: rankedCard?.foundAs,
      score: rankedCard?.relevanceScore,
      reason: rankedCard?.relevanceReason,
      discardedCount: ranked?.discardedCount,
    }),
    "",
    "## 6. procurement.get",
    "",
    yamlBlock({
      sourceProcurementId: card.sourceProcurementId,
      url: card.url,
      kind: card.kind,
      pageFamily: card.pageFamily,
      title: card.title,
    }),
    "",
    "## 7. ProcedureCard / Subject",
    "",
    yamlBlock({
      title: card.title,
      lots: card.lots.map((lot) => ({
        title: lot.title,
        description: lot.description,
        positions: lot.positions.map((position) => position.title),
      })),
    }),
    "",
    "## 8. Full scoring",
    "",
    yamlBlock({
      procedureIntentText: intentText,
      intentTextHas: {
        монтаж: /монтаж/i.test(intentText),
        электрооборудование: /электрооборудован/i.test(intentText),
        пусконаладочные: /пусконаладочн/i.test(intentText),
      },
      worksScore,
    }),
    "",
    "## 9. Profile independence",
    "",
    "| Profile | Result | Score |",
    "|---|---|---|",
    `| ${worksProfile.name} | ${worksScore.decision} | ${String(worksScore.score)} |`,
    `| ${nkuProfile.name} | ${nkuScore.decision} | ${String(nkuScore.score)} |`,
    `| ${designProfile.name} | ${designScore.decision} | ${String(designScore.score)} |`,
    "",
    yamlBlock({ nkuScore, designScore }),
    "",
    "## 10. Hardcode",
    "",
    "Скрипт не добавляет if (3669746) / АСКУЭ / Жлобин. Проверьте production grep отдельно: в адаптере limited только в общем regex семейства.",
    "",
    "## 11. HTTP requests",
    "",
    yamlBlock({
      cardPath: CARD_PATH,
      cardGetsAfterFirstGet: cardGetsAfterFirst,
      cardGetsAfterSecondGet: cardGetsAfterSecond,
      cacheHitOnSecondGet: cardGetsAfterFirst === cardGetsAfterSecond,
      allGets: httpGets,
    }),
    "",
    "## 12. Final verdict",
    "",
    verdict,
  ].join("\n");
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
