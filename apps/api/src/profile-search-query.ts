import type {
  SearchQuery,
  SpecialistWorkingProfile,
} from "@procurement/contracts";

const SINGLE_SOURCE_TYPE_IDS = new Set(["singleSource", "eSingleSource"]);

/**
 * Every window on the profile's «Расширенный поиск» tab, plus the status
 * checkboxes, becomes a source-native query. Empty windows are omitted so
 * the site does not receive dummy dates or types the specialist never set.
 */
export function profileToSiteSearchQuery(
  profile: SpecialistWorkingProfile,
  options: {
    limit: number;
    offset: number;
    publishedFrom?: string;
    searchKeywords?: readonly string[];
    toIsoDateTime: (isoDate: string) => string;
  },
): Omit<SearchQuery, "sourceId"> {
  const { filters } = profile;
  const fromDate = [filters.publishedFrom, options.publishedFrom]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .sort()
    .at(-1);
  return {
    keywords: [...(options.searchKeywords ?? profile.keywords)],
    excludeKeywords: [...profile.excludeKeywords],
    buyerUnp: filters.buyerUnp?.trim() ?? "",
    buyerText: filters.buyerText?.trim() ?? "",
    procurementNumber: filters.procurementNumber?.trim() ?? "",
    priceFrom: filters.priceFrom,
    priceTo: filters.priceTo,
    publishedFrom: fromDate === undefined ? undefined : options.toIsoDateTime(fromDate),
    publishedTo: dateField(filters.publishedTo, options.toIsoDateTime),
    requestEndFrom: dateField(filters.requestEndFrom, options.toIsoDateTime),
    requestEndTo: dateField(filters.requestEndTo, options.toIsoDateTime),
    auctionFrom: dateField(filters.auctionFrom, options.toIsoDateTime),
    auctionTo: dateField(filters.auctionTo, options.toIsoDateTime),
    typeIds: siteTypeIds(filters.typeIds, profile.excludeSingleSource),
    statusIds: [...(filters.statusIds ?? [])],
    statuses: [...profile.statuses],
    regionIds: [...(filters.regionIds ?? [])],
    kinds: [],
    limit: options.limit,
    offset: options.offset,
  };
}

function dateField(
  value: string | undefined,
  toIsoDateTime: (isoDate: string) => string,
): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? undefined : toIsoDateTime(trimmed);
}

function siteTypeIds(
  typeIds: readonly string[] | undefined,
  excludeSingleSource: boolean,
): string[] {
  const selected = [...(typeIds ?? [])].filter((id) => id.trim().length > 0);
  if (!excludeSingleSource) return selected;
  return selected.filter((id) => !SINGLE_SOURCE_TYPE_IDS.has(id));
}
