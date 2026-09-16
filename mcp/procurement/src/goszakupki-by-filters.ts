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
 * Live `/tenders/posted` Select2 values (2026-09-16). Numeric 1–7 are not
 * accepted: the site answers HTTP 500.
 */
export const FALLBACK_STATUS_OPTIONS: readonly GoszakupkiStatusOption[] = [
  { value: "Submission", label: "Подача предложений" },
  { value: "SubmissionEss", label: "Подача документов/сведений" },
  { value: "Examination", label: "Рассмотрение предложений" },
  { value: "WaitingForBargain", label: "Ожидание торгов" },
  { value: "Bargain", label: "Проводятся торги" },
  { value: "Quantification", label: "Определение победителя" },
  { value: "Signing", label: "Подписание договора" },
  { value: "Closed", label: "Завершен" },
  { value: "Canceled", label: "Отменен" },
  { value: "Manque", label: "Признан несостоявшимся" },
  { value: "Paused", label: "Приостановлен" },
  { value: "Preselection", label: "Предварительный отбор" },
  { value: "DocsApproval", label: "Утверждение конкурсных документов" },
  { value: "Different", label: "Различен по лотам" },
  { value: "ProviderSelected", label: "Выбран продавец (поставщик)" },
  { value: "ExaminationEss", label: "Рассмотрение документов/сведений" },
  { value: "ManqueEss", label: "Завершен без выбора" },
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
