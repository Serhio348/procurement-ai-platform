import {
  SpecialistInboxListResponse,
  SpecialistProcurementListResponse,
  type SpecialistInboxEntry,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
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
