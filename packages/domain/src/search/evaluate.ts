import { SearchHit, type SearchHit as SearchHitValue } from "@procurement/contracts";
import { inferSearchIntentPlan, type IntentProfileSlice } from "./intent-plan.js";
import { scoreSearchIntent } from "./intent-score.js";
import { selectRelevantSearchCards } from "./search-cards.js";

export type SearchEvalGold = "relevant" | "irrelevant" | "uncertain";
export type SearchEvalDecision = "match" | "review" | "discard";

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
}

export type SearchEvalProfile = IntentProfileSlice;

export interface SearchEvalRow {
  id: string;
  title: string;
  extraText?: string;
  gold: SearchEvalGold;
  oldDecision: SearchEvalDecision;
  newDecision: SearchEvalDecision;
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

export interface SearchEvalReport {
  profileName: string;
  rows: SearchEvalRow[];
  gold: SearchEvalGoldCounts;
  old: SearchEvalMetrics;
  next: SearchEvalMetrics;
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
  const rows = cases.map((item) => {
    const oldDecision = decisionFromSelection(item.id, oldSelected);
    const newCard =
      newSelected.cards.find((card) => card.sourceProcurementId === item.id) ??
      newSelected.ambiguousCards.find((card) => card.sourceProcurementId === item.id);
    const newDecision = decisionFromSelection(item.id, newSelected);
    const scored = scoreSearchIntent(
      {
        title: item.title,
        ...(item.extraText === undefined ? {} : { extraText: item.extraText }),
      },
      intent,
    );
    const row: SearchEvalRow = {
      id: item.id,
      title: item.title,
      gold: item.gold,
      oldDecision,
      newDecision,
      relevanceScore: newCard?.relevanceScore ?? scored.score,
      relevanceReason: newCard?.relevanceReason ?? scored.reason,
      ...(item.extraText === undefined ? {} : { extraText: item.extraText }),
    };
    return row;
  });
  return {
    profileName: profile.name,
    rows,
    gold: goldCountsFromRows(rows),
    old: metricsFromRows(rows, "oldDecision"),
    next: metricsFromRows(rows, "newDecision"),
  };
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
    `Cases: ${String(report.rows.length)} (uncertain gold labels are skipped in Precision/Recall/F1)`,
    `Gold: relevant=${String(report.gold.relevant)} irrelevant=${String(report.gold.irrelevant)} uncertain=${String(report.gold.uncertain)}`,
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
  return `- ${row.id}: «${row.title}»${extra}\n  gold=${row.gold} old=${row.oldDecision} new=${row.newDecision} score=${score}\n  reason: ${reason}`;
}
