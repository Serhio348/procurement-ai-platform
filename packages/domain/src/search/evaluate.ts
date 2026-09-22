import {
  ProcedureCard,
  SearchHit,
  type ProcedureCard as ProcedureCardValue,
  type SearchHit as SearchHitValue,
} from "@procurement/contracts";
import { inferSearchIntentPlan, type IntentProfileSlice } from "./intent-plan.js";
import { scoreIntentCard } from "./review.js";
import { selectRelevantSearchCards } from "./search-cards.js";

export type SearchEvalGold = "relevant" | "irrelevant" | "uncertain";
export type SearchEvalDecision = "match" | "review" | "discard";
/** Pipeline stage that settled the row: listing filter, platform card, or model/human. */
export type SearchEvalStage = "listing" | "card" | "model";

/** A lot the harness can attach to the synthetic card to exercise lot-level scoring. */
export interface SearchEvalLot {
  title: string;
  description?: string;
  positions?: readonly string[];
}

export interface SearchEvalCase {
  id: string;
  title: string;
  extraText?: string;
  gold: SearchEvalGold;
  /** Public listing URL for reuse. Ignored by scoring. */
  url?: string;
  /** Listing buyer, same field old cheapClassify already reads. */
  buyerName?: string;
  sourceStatus?: string;
  /** Platform-card lots; absent means the fetch returned none. */
  lots?: readonly SearchEvalLot[];
}

export type SearchEvalProfile = IntentProfileSlice;

export interface SearchEvalRow {
  id: string;
  title: string;
  extraText?: string;
  gold: SearchEvalGold;
  oldDecision: SearchEvalDecision;
  newDecision: SearchEvalDecision;
  /** Retrieval-stage verdict; the card stage never sees listing discards. */
  listingDecision?: SearchEvalDecision;
  /** Where the final decision was made; "model" means review would leave code scoring. */
  stage?: SearchEvalStage;
  relevanceScore?: number;
  relevanceReason?: string;
}

export interface SearchEvalCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export interface SearchEvalMetrics extends SearchEvalCounts {
  precision: number | undefined;
  recall: number | undefined;
  f1: number | undefined;
}

export interface SearchEvalGoldCounts {
  relevant: number;
  irrelevant: number;
  uncertain: number;
}

/** Listing-stage outcome: how much signal and noise survived the retrieval filter. */
export interface SearchEvalRetrieval {
  relevantKept: number;
  relevantDropped: number;
  irrelevantKept: number;
  irrelevantDropped: number;
  /** Share of gold-relevant cases that reached the card stage at all. */
  recall: number | undefined;
}

/** How many rows each pipeline stage settled; "model" rows go to model/human review. */
export interface SearchEvalStages {
  listing: number;
  card: number;
  model: number;
}

export interface SearchEvalReport {
  profileName: string;
  rows: SearchEvalRow[];
  gold: SearchEvalGoldCounts;
  retrieval: SearchEvalRetrieval;
  stages: SearchEvalStages;
  old: SearchEvalMetrics;
  next: SearchEvalMetrics;
}

/**
 * The model/human step the runtime calls when the card cannot settle a case.
 * The default marks every unsettled row as needing a human, so offline runs
 * stay honest: a «review» decision means the pipeline did not decide.
 */
export type SearchEvalReviewer = (
  card: ProcedureCardValue,
  item: SearchEvalCase,
) => "relevant" | "irrelevant" | "needs_human";

export interface SearchEvalOptions {
  review?: SearchEvalReviewer;
}

/** Synthetic platform card from a labelled case, same fields procurement.get would fill. */
export function procedureCardFromEvalCase(item: SearchEvalCase): ProcedureCardValue {
  const hit = hitFromEvalCase(item);
  return ProcedureCard.parse({
    sourceId: hit.sourceId,
    sourceProcurementId: hit.sourceProcurementId,
    url: hit.url,
    title: hit.title,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...(hit.kind === undefined ? {} : { kind: hit.kind }),
    ...(hit.pageFamily === undefined ? {} : { pageFamily: hit.pageFamily }),
    ...(hit.status === undefined ? {} : { status: hit.status }),
    ...(hit.sourceStatus === undefined ? {} : { sourceStatus: hit.sourceStatus }),
    ...(item.buyerName === undefined ? {} : { rawFields: { "Заказчик": item.buyerName } }),
    lots: (item.lots ?? []).map((lot, index) => ({
      number: String(index + 1),
      title: lot.title,
      ...(lot.description === undefined ? {} : { description: lot.description }),
      positions: (lot.positions ?? []).map((title) => ({ title })),
    })),
  });
}

/**
 * Extra listing text is attached as `buyerName` on the synthetic hit: that is
 * the field the old classifier already reads, while the new scorer only looks
 * at the title. No scoring code is copied here.
 */
export function hitFromEvalCase(item: SearchEvalCase): SearchHitValue {
  const listingExtra = item.extraText ?? item.buyerName;
  return SearchHit.parse({
    sourceId: item.url?.includes("goszakupki.by") === true ? "goszakupki_by" : "fixture",
    sourceProcurementId: item.id,
    url: item.url ?? `https://example.test/${encodeURIComponent(item.id)}`,
    title: item.title,
    ...(listingExtra === undefined ? {} : { buyerName: listingExtra }),
    ...(item.sourceStatus === undefined ? {} : { sourceStatus: item.sourceStatus }),
  });
}

export function goldCountsFromRows(
  rows: readonly { gold: SearchEvalGold }[],
): SearchEvalGoldCounts {
  const counts: SearchEvalGoldCounts = { relevant: 0, irrelevant: 0, uncertain: 0 };
  for (const row of rows) counts[row.gold] += 1;
  return counts;
}

export function evaluateSearch(
  cases: readonly SearchEvalCase[],
  profile: SearchEvalProfile,
  options?: SearchEvalOptions,
): SearchEvalReport {
  const hits = cases.map(hitFromEvalCase);
  const limit = Math.max(cases.length, 1);
  const oldSelected = selectRelevantSearchCards(
    hits,
    { keywords: profile.keywords, excludeKeywords: profile.excludeKeywords },
    limit,
  );
  const intent = inferSearchIntentPlan(profile);
  const newSelected = selectRelevantSearchCards(
    hits,
    {
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
      intent,
    },
    limit,
  );
  const reviewer: SearchEvalReviewer =
    options?.review ?? (() => "needs_human");
  const rows = cases.map((item) => {
    const oldDecision = decisionFromSelection(item.id, oldSelected);
    const listingDecision = decisionFromSelection(item.id, newSelected);
    // The card stage scores the same synthetic platform card the runtime
    // builds after procurement.get: title plus each lot, aggregated by
    // scoreIntentCard. A plain «no object found» is not a verdict — it goes
    // to the model/human step exactly like in scorePendingHits.
    const card = procedureCardFromEvalCase(item);
    const { scored, outcome } = scoreIntentCard(card, intent);
    let newDecision: SearchEvalDecision;
    let stage: SearchEvalStage;
    if (listingDecision === "discard") {
      newDecision = "discard";
      stage = "listing";
    } else if (outcome?.verdict === "relevant") {
      newDecision = "match";
      stage = "card";
    } else if (outcome?.verdict === "irrelevant") {
      newDecision = "discard";
      stage = "card";
    } else {
      const reviewed = reviewer(card, item);
      newDecision =
        reviewed === "relevant" ? "match" : reviewed === "irrelevant" ? "discard" : "review";
      stage = "model";
    }
    const row: SearchEvalRow = {
      id: item.id,
      title: item.title,
      gold: item.gold,
      oldDecision,
      newDecision,
      listingDecision,
      stage,
      relevanceScore: scored.score,
      relevanceReason: scored.reason,
      ...(item.extraText === undefined ? {} : { extraText: item.extraText }),
    };
    return row;
  });
  return {
    profileName: profile.name,
    rows,
    gold: goldCountsFromRows(rows),
    retrieval: retrievalFromRows(rows),
    stages: stageCounts(rows),
    old: metricsFromRows(rows, "oldDecision"),
    next: metricsFromRows(rows, "newDecision"),
  };
}

function retrievalFromRows(rows: readonly SearchEvalRow[]): SearchEvalRetrieval {
  const retrieval: SearchEvalRetrieval = {
    relevantKept: 0,
    relevantDropped: 0,
    irrelevantKept: 0,
    irrelevantDropped: 0,
    recall: undefined,
  };
  for (const row of rows) {
    const kept = row.listingDecision !== "discard";
    if (row.gold === "relevant") {
      if (kept) retrieval.relevantKept += 1;
      else retrieval.relevantDropped += 1;
    } else if (row.gold === "irrelevant") {
      if (kept) retrieval.irrelevantKept += 1;
      else retrieval.irrelevantDropped += 1;
    }
  }
  const relevant = retrieval.relevantKept + retrieval.relevantDropped;
  retrieval.recall = relevant === 0 ? undefined : retrieval.relevantKept / relevant;
  return retrieval;
}

function stageCounts(rows: readonly SearchEvalRow[]): SearchEvalStages {
  const stages: SearchEvalStages = { listing: 0, card: 0, model: 0 };
  for (const row of rows) {
    if (row.stage !== undefined) stages[row.stage] += 1;
  }
  return stages;
}

export function metricsFromRows(
  rows: readonly SearchEvalRow[],
  field: "oldDecision" | "newDecision",
): SearchEvalMetrics {
  const counts: SearchEvalCounts = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
  };
  for (const row of rows) {
    if (row.gold === "uncertain") continue;
    const predicted = row[field] === "match";
    const actual = row.gold === "relevant";
    if (predicted && actual) counts.truePositives += 1;
    else if (predicted && !actual) counts.falsePositives += 1;
    else if (!predicted && actual) counts.falseNegatives += 1;
    else counts.trueNegatives += 1;
  }
  return { ...counts, ...ratios(counts) };
}

export function formatSearchEvalReport(report: SearchEvalReport): string {
  const newFp = report.rows.filter((row) => mismatch(row, "newDecision", "positive"));
  const newFn = report.rows.filter((row) => mismatch(row, "newDecision", "negative"));
  const lines = [
    `Profile: ${report.profileName}`,
    `Cases: ${String(report.rows.length)} (uncertain gold labels are skipped in Precision/Recall/F1; review counts as not-match)`,
    `Gold: relevant=${String(report.gold.relevant)} irrelevant=${String(report.gold.irrelevant)} uncertain=${String(report.gold.uncertain)}`,
    "",
    "Retrieval (listing stage):",
    `Recall: ${formatRatio(report.retrieval.recall)} (relevant kept ${String(report.retrieval.relevantKept)}, dropped ${String(report.retrieval.relevantDropped)})`,
    `Noise reaching card stage: ${String(report.retrieval.irrelevantKept)} irrelevant kept, ${String(report.retrieval.irrelevantDropped)} discarded`,
    `Settled at stage: listing=${String(report.stages.listing)} card=${String(report.stages.card)} model/human=${String(report.stages.model)}`,
    "",
    "Old search:",
    `Precision: ${formatRatio(report.old.precision)}`,
    `Recall: ${formatRatio(report.old.recall)}`,
    `F1: ${formatRatio(report.old.f1)}`,
    `False positives: ${String(report.old.falsePositives)}`,
    `False negatives: ${String(report.old.falseNegatives)}`,
    "",
    "New search:",
    `Precision: ${formatRatio(report.next.precision)}`,
    `Recall: ${formatRatio(report.next.recall)}`,
    `F1: ${formatRatio(report.next.f1)}`,
    `False positives: ${String(report.next.falsePositives)}`,
    `False negatives: ${String(report.next.falseNegatives)}`,
    "",
    "False positives of new search (predicted match, gold irrelevant):",
    ...namedExampleLines(newFp),
    "",
    "False negatives of new search (predicted not match, gold relevant):",
    ...namedExampleLines(newFn),
    "",
    "Cases where the new search changed the decision:",
    ...namedExampleLines(report.rows.filter((row) => row.oldDecision !== row.newDecision), true),
    "",
    "Old one-word false positives (old match, gold irrelevant):",
    ...namedExampleLines(report.rows.filter((row) => mismatch(row, "oldDecision", "positive"))),
    "",
    "False positives (predicted match, gold irrelevant):",
    ...exampleLines(report.rows, "positive"),
    "",
    "False negatives (predicted not match, gold relevant):",
    ...exampleLines(report.rows, "negative"),
    "",
    "All cases:",
    ...report.rows.map(formatRow),
  ];
  return lines.join("\n");
}

function decisionFromSelection(
  sourceProcurementId: string,
  selected: ReturnType<typeof selectRelevantSearchCards>,
): SearchEvalDecision {
  if (selected.cards.some((card) => card.sourceProcurementId === sourceProcurementId)) {
    return "match";
  }
  if (selected.ambiguousCards.some((card) => card.sourceProcurementId === sourceProcurementId)) {
    return "review";
  }
  return "discard";
}

function ratios(counts: SearchEvalCounts): Pick<SearchEvalMetrics, "precision" | "recall" | "f1"> {
  const precision = ratio(counts.truePositives, counts.truePositives + counts.falsePositives);
  const recall = ratio(counts.truePositives, counts.truePositives + counts.falseNegatives);
  const f1 =
    precision === undefined || recall === undefined || precision + recall === 0
      ? undefined
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

function formatRatio(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function exampleLines(
  rows: readonly SearchEvalRow[],
  kind: "positive" | "negative",
): string[] {
  const oldHits = rows.filter((row) => mismatch(row, "oldDecision", kind));
  const newHits = rows.filter((row) => mismatch(row, "newDecision", kind));
  return [
    `  old: ${oldHits.length === 0 ? "none" : oldHits.map(formatExample).join("; ")}`,
    `  new: ${newHits.length === 0 ? "none" : newHits.map(formatExample).join("; ")}`,
  ];
}

function mismatch(
  row: SearchEvalRow,
  field: "oldDecision" | "newDecision",
  kind: "positive" | "negative",
): boolean {
  if (kind === "positive") return row.gold === "irrelevant" && row[field] === "match";
  return row.gold === "relevant" && row[field] !== "match";
}

function formatExample(row: SearchEvalRow): string {
  return `«${row.title}»`;
}

function namedExampleLines(rows: readonly SearchEvalRow[], withDecisions = false): string[] {
  if (rows.length === 0) return ["  none"];
  return rows.map((row) => {
    const score = row.relevanceScore === undefined ? "—" : String(row.relevanceScore);
    const extra = withDecisions
      ? ` old=${row.oldDecision} new=${row.newDecision} score=${score}`
      : ` score=${score}`;
    return `  - ${row.id}: «${row.title}»${extra}`;
  });
}

function formatRow(row: SearchEvalRow): string {
  const extra = row.extraText === undefined ? "" : ` | extra: ${row.extraText}`;
  const score = row.relevanceScore === undefined ? "—" : String(row.relevanceScore);
  const reason = row.relevanceReason === undefined ? "—" : row.relevanceReason;
  const stage = row.stage === undefined ? "" : ` stage=${row.stage}`;
  const listing = row.listingDecision === undefined ? "" : ` listing=${row.listingDecision}`;
  return `- ${row.id}: «${row.title}»${extra}\n  gold=${row.gold} old=${row.oldDecision} new=${row.newDecision}${listing}${stage} score=${score}\n  reason: ${reason}`;
}
