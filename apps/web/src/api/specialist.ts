import {
  ProcedureCard,
  SpecialistInboxListResponse,
  SpecialistInboxResolveResponse,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistProcurementListResponse,
  SpecialistProfileListResponse,
  SpecialistSearchResponse,
  SpecialistWorkingProfile,
  type SpecialistInboxAction,
  type SpecialistInboxEntry,
  type SpecialistInboxResolveResponse as SpecialistInboxResolveResponseValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistProfileWrite,
  type SpecialistSearchResponse as SpecialistSearchResponseValue,
  type SpecialistTriageKind,
  type SpecialistProfileListResponse as SpecialistProfileListResponseValue,
  type SpecialistIngestProgress as SpecialistIngestProgressValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
} from "@procurement/contracts";
import { withCredentials } from "./http.js";

export async function fetchInbox(fetcher: typeof fetch = fetch): Promise<readonly SpecialistInboxEntry[]> {
  const response = await fetcher("/api/inbox", withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось загрузить входящие");
  }
  return SpecialistInboxListResponse.parse(await response.json()).items;
}

export async function resolveInbox(
  id: string,
  action: SpecialistInboxAction,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistInboxResolveResponseValue> {
  const response = await fetcher(
    `/api/inbox/${id}/resolve`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось обработать сообщение");
  }
  return SpecialistInboxResolveResponse.parse(await response.json());
}

export async function deleteInbox(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistInboxEntry[]> {
  const response = await fetcher(`/api/inbox/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    throw new Error("Не удалось удалить сообщение");
  }
  return SpecialistInboxListResponse.parse(await response.json()).items;
}

export async function fetchProcurements(
  query: { tab?: string; limit?: number; offset?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const params = new URLSearchParams();
  if (query.tab !== undefined) params.set("tab", query.tab);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await fetcher(`/api/procurements${suffix}`, withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось загрузить закупки");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function fetchProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProcurementCardValue> {
  const response = await fetcher(`/api/procurements/${id}`, withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось открыть закупку");
  }
  return SpecialistProcurementCard.parse(await response.json());
}

export async function searchProcurements(
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistSearchResponseValue> {
  const response = await fetcher(
    "/api/procurements/search",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100, offset }),
    }),
  );
  if (!response.ok) {
    throw new Error(await searchFailureMessage(response));
  }
  return SpecialistSearchResponse.parse(await response.json());
}

export async function fetchProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profile", withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось загрузить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchProfiles(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher("/api/profiles", withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось загрузить профили");
  }
  return SpecialistProfileListResponse.parse(await response.json());
}

export async function createProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profiles", withCredentials({ method: "POST" }));
  if (!response.ok) {
    throw new Error("Не удалось создать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function deleteProfile(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher(`/api/profiles/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "Нельзя удалить единственный профиль"
        : "Не удалось удалить профиль",
    );
  }
  return SpecialistProfileListResponse.parse(await response.json());
}

export async function activateProfile(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher(`/api/profiles/${id}/activate`, withCredentials({ method: "POST" }));
  if (!response.ok) {
    throw new Error("Не удалось выбрать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function saveProfile(
  id: string,
  input: SpecialistProfileWrite,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher(
    `/api/profiles/${id}`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось сохранить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function setProfileWatch(
  watchNewProcurements: boolean,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher(
    "/api/profile/watch",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchNewProcurements }),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось изменить слежение за новыми закупками");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchProcurementCard(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<ProcedureCard> {
  const response = await fetcher(`/api/procurements/${id}/card`, withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось открыть карточку закупки");
  }
  return ProcedureCard.parse(await response.json());
}

export async function fetchIngestProgress(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistIngestProgressValue> {
  const response = await fetcher(`/api/procurements/${id}/ingest-progress`, withCredentials());
  if (!response.ok) {
    throw new Error("Не удалось получить прогресс индексации");
  }
  return SpecialistIngestProgress.parse(await response.json());
}

export async function decideProcurement(
  id: string,
  kind: SpecialistTriageKind,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const response = await fetcher(
    `/api/procurements/${id}/decision`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось сохранить решение по закупке");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function restoreProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const response = await fetcher(
    `/api/procurements/${id}/restore`,
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    throw new Error("Не удалось вернуть закупку из корзины");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function purgeProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/procurements/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    throw new Error("Не удалось удалить закупку из корзины");
  }
}

export async function setProcurementArchived(
  id: string,
  archived: boolean,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const response = await fetcher(
    `/api/procurements/${id}/archive`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }),
  );
  if (!response.ok) {
    throw new Error("Не удалось обновить архив");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function searchFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (body.error === "source_unavailable") {
      return "Площадка goszakupki.by сейчас недоступна.";
    }
    if (body.error === "search_timeout") {
      return "Поиск на площадке занял слишком много времени.";
    }
    if (body.error === "no_keywords") {
      return "В профиле нет слов для поиска. Заполните «Что ищем».";
    }
  } catch {
    return "Не удалось выполнить поиск по профилю.";
  }
  return "Не удалось выполнить поиск по профилю.";
}
