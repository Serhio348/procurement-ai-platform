import type { SpecialistProcurementCard } from "@procurement/contracts";

export const SPECIALIST_CASE_LIST_TABS = [
  "listed",
  "all",
  "monitor",
  "participate",
  "archive",
  "trash",
] as const;
export type SpecialistCaseListTab = (typeof SPECIALIST_CASE_LIST_TABS)[number];

export const DEFAULT_CASE_LIST_LIMIT = 100;

export interface SpecialistCaseListQuery {
  tab?: SpecialistCaseListTab;
  limit?: number;
  offset?: number;
  liveOnly?: boolean;
  rejectedSourceIds?: ReadonlySet<string>;
}

export interface SpecialistCaseListPage {
  items: SpecialistProcurementCard[];
  total: number;
}

/**
 * Rows the console may show outside the inbox: not rejected, not a pending
 * review case. Search hits and decided cases both pass.
 */
export function isConsoleListedCase(
  card: Pick<SpecialistProcurementCard, "sourceProcurementId" | "foundAs" | "triage" | "live">,
  options: Pick<SpecialistCaseListQuery, "liveOnly" | "rejectedSourceIds"> = {},
): boolean {
  if (options.rejectedSourceIds?.has(card.sourceProcurementId) === true) return false;
  if (options.liveOnly === true && card.live !== true) return false;
  if (card.foundAs === "review" && card.triage === undefined) return false;
  return true;
}

export function caseMatchesListTab(
  card: Pick<SpecialistProcurementCard, "triage" | "archived">,
  tab: SpecialistCaseListTab,
): boolean {
  switch (tab) {
    case "listed":
      return true;
    case "all":
      return (card.triage === "monitor" || card.triage === "participate") && card.archived !== true;
    case "monitor":
      return card.triage === "monitor" && card.archived !== true;
    case "participate":
      return card.triage === "participate" && card.archived !== true;
    case "archive":
      return card.archived === true && card.triage !== "reject";
    case "trash":
      return card.triage === "reject";
  }
}

export interface CabinetCaseCounts {
  mineCount: number;
  archiveCount: number;
  trashCount: number;
}

export function countCabinetCases(
  cards: readonly Pick<SpecialistProcurementCard, "triage" | "archived">[],
): CabinetCaseCounts {
  let mineCount = 0;
  let archiveCount = 0;
  let trashCount = 0;
  for (const card of cards) {
    if (caseMatchesListTab(card, "all")) mineCount += 1;
    if (caseMatchesListTab(card, "archive")) archiveCount += 1;
    if (caseMatchesListTab(card, "trash")) trashCount += 1;
  }
  return { mineCount, archiveCount, trashCount };
}

export function pageListedCases(
  cards: readonly SpecialistProcurementCard[],
  query: SpecialistCaseListQuery = {},
): SpecialistCaseListPage {
  const tab = query.tab ?? "listed";
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_CASE_LIST_LIMIT;
  const visible = cards.filter((card) => {
    if (tab === "trash") return card.triage === "reject";
    return isConsoleListedCase(card, query) && caseMatchesListTab(card, tab);
  });
  return {
    items: visible.slice(offset, offset + limit).map(slimListedCard),
    total: visible.length,
  };
}

/**
 * Tile lists do not need extracts, files or the raw platform dump. The detail
 * route loads the full row by id.
 */
export function slimListedCard(card: SpecialistProcurementCard): SpecialistProcurementCard {
  const listed: SpecialistProcurementCard = {
    ...card,
    documents: [],
    actions: [],
    missing: [],
    extractNotes: [],
    termsEvidence: [],
  };
  delete listed.extractPreview;
  delete listed.reportMarkdown;
  delete listed.termsDetail;
  delete listed.paymentQuote;
  if (listed.sourceCard !== undefined) {
    listed.sourceCard = {
      ...listed.sourceCard,
      parties: [],
      lots: [],
      rawFields: {},
      externalIds: [],
    };
  }
  return listed;
}
