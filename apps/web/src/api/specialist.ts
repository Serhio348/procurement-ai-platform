import {
  SpecialistInboxListResponse,
  SpecialistProcurementListResponse,
  SpecialistSearchResponse,
  type SpecialistInboxEntry,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistSearchResponse as SpecialistSearchResponseValue,
} from "@procurement/contracts";

export async function fetchInbox(fetcher: typeof fetch = fetch): Promise<readonly SpecialistInboxEntry[]> {
  const response = await fetcher("/api/inbox");
  if (!response.ok) {
    throw new Error("Не удалось загрузить входящие");
  }
  return SpecialistInboxListResponse.parse(await response.json()).items;
}

export async function fetchProcurements(
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const response = await fetcher("/api/procurements");
  if (!response.ok) {
    throw new Error("Не удалось загрузить закупки");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function searchProcurements(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistSearchResponseValue> {
  const response = await fetcher("/api/procurements/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error("Не удалось выполнить поиск по профилю");
  }
  return SpecialistSearchResponse.parse(await response.json());
}
