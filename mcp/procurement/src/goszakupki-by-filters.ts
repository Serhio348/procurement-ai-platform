import {
  type ProcedureStatus,
  type SearchQuery,
} from "@procurement/contracts";
import * as cheerio from "cheerio";
import { procedureStatus } from "./goszakupki-by-parser.js";

export interface GoszakupkiStatusOption {
  value: string;
  label: string;
}

/**
 * Yii class names used when the listing page arrives without the search
 * form (pjax fragment). Live `/tenders/posted` is parsed first; these
 * names match the same convention as the type filter (`Auction`, `Request`).
 */
export const FALLBACK_STATUS_OPTIONS: readonly GoszakupkiStatusOption[] = [
  { value: "Request", label: "Подача предложений" },
  { value: "RequestDocs", label: "Подача документов/сведений" },
  { value: "Consideration", label: "Рассмотрение предложений" },
  { value: "Auction", label: "Проведение аукциона" },
  { value: "Completed", label: "Завершена" },
  { value: "Canceled", label: "Отменена" },
  { value: "NotTookPlace", label: "Не состоялась" },
];

export function parseGoszakupkiSearchFilters(html: string): {
  statuses: GoszakupkiStatusOption[];
} {
  const $ = cheerio.load(html);
  const statuses: GoszakupkiStatusOption[] = [];
  const seen = new Set<string>();
  const push = (value: string, label: string): void => {
    const trimmedValue = value.trim();
    const trimmedLabel = label.replace(/\s+/gu, " ").trim();
    if (trimmedValue.length === 0 || trimmedLabel.length === 0) return;
    if (seen.has(trimmedValue)) return;
    seen.add(trimmedValue);
    statuses.push({ value: trimmedValue, label: trimmedLabel });
  };

  $('input[name="TendersSearch[status][]"]').each((_, element) => {
    const input = $(element);
    const value = input.attr("value") ?? "";
    const label = input.closest("label").text() || input.parent().text();
    push(value, label);
  });
  $('select[name="TendersSearch[status][]"] option, select[name="TendersSearch[status]"] option').each(
    (_, element) => {
      const option = $(element);
      push(option.attr("value") ?? "", option.text());
    },
  );
  return { statuses };
}

export function goszakupkiStatusIds(
  statuses: readonly ProcedureStatus[],
  options: readonly GoszakupkiStatusOption[] = FALLBACK_STATUS_OPTIONS,
): string[] {
  if (statuses.length === 0) return [];
  const wanted = new Set(statuses);
  const ids: string[] = [];
  for (const option of options) {
    const mapped = procedureStatus(option.label);
    if (mapped === "unknown" || !wanted.has(mapped)) continue;
    if (ids.includes(option.value)) continue;
    ids.push(option.value);
  }
  return ids;
}

export function searchQueryStatusIds(
  query: Pick<SearchQuery, "statusIds" | "statuses">,
  options: readonly GoszakupkiStatusOption[],
): string[] {
  const mapped = goszakupkiStatusIds(query.statuses, options);
  const ids: string[] = [];
  for (const value of [...query.statusIds, ...mapped]) {
    if (value.trim().length === 0 || ids.includes(value)) continue;
    ids.push(value);
  }
  return ids;
}
