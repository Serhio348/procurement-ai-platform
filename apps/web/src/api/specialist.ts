import {
  ProcedureCard,
  SpecialistInboxDismissAllResponse,
  SpecialistInboxListResponse,
  SpecialistInboxResolveResponse,
  SpecialistIngestProgress,
  SpecialistProcurementCard,
  SpecialistProcurementListResponse,
  SpecialistProfileListResponse,
  SpecialistProfileSuggestResponse,
  SpecialistSearchResponse,
  SpecialistSearchRun,
  SpecialistServiceHealth,
  SpecialistTelegramLinkResponse,
  SpecialistTelegramStatus,
  SpecialistWorkingProfile,
  type SpecialistInboxAction,
  type SpecialistInboxDismissAllResponse as SpecialistInboxDismissAllResponseValue,
  type SpecialistInboxEntry,
  type SpecialistInboxResolveResponse as SpecialistInboxResolveResponseValue,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistProfileSuggestResponse as SpecialistProfileSuggestResponseValue,
  type SpecialistProfileWrite,
  type SpecialistSearchResponse as SpecialistSearchResponseValue,
  type SpecialistSearchRun as SpecialistSearchRunValue,
  type SpecialistServiceHealth as SpecialistServiceHealthValue,
  type SpecialistTelegramLinkResponse as SpecialistTelegramLinkResponseValue,
  type SpecialistTelegramStatus as SpecialistTelegramStatusValue,
  type SpecialistTriageKind,
  type SpecialistProfileListResponse as SpecialistProfileListResponseValue,
  type SpecialistIngestProgress as SpecialistIngestProgressValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
} from "@procurement/contracts";
import { ApiError, throwApiError, withCredentials } from "./http.js";

export async function fetchInbox(fetcher: typeof fetch = fetch): Promise<readonly SpecialistInboxEntry[]> {
  const response = await fetcher("/api/inbox", withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось загрузить входящие");
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
    await throwApiError(response, "Не удалось обработать сообщение");
  }
  return SpecialistInboxResolveResponse.parse(await response.json());
}

export async function deleteInbox(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistInboxEntry[]> {
  const response = await fetcher(`/api/inbox/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    await throwApiError(response, "Не удалось удалить сообщение");
  }
  return SpecialistInboxListResponse.parse(await response.json()).items;
}

export async function dismissAllInbox(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistInboxDismissAllResponseValue> {
  const response = await fetcher(
    "/api/inbox/dismiss-all",
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось очистить входящие");
  }
  return SpecialistInboxDismissAllResponse.parse(await response.json());
}

export async function fetchProcurements(
  query: { tab?: string; profileId?: string; limit?: number; offset?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProcurementListResponse> {
  const params = new URLSearchParams();
  if (query.tab !== undefined) params.set("tab", query.tab);
  if (query.profileId !== undefined) params.set("profileId", query.profileId);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await fetcher(`/api/procurements${suffix}`, withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось загрузить закупки");
  }
  return SpecialistProcurementListResponse.parse(await response.json());
}

export async function fetchProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProcurementCardValue> {
  const response = await fetcher(`/api/procurements/${id}`, withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось открыть закупку");
  }
  return SpecialistProcurementCard.parse(await response.json());
}

export async function searchProcurements(
  profileId: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistSearchResponseValue> {
  const response = await fetcher(
    "/api/procurements/search",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 400, offset, profileId }),
    }),
  );
  if (!response.ok) {
    throw new ApiError(await searchFailureMessage(response), { status: response.status });
  }
  return SpecialistSearchResponse.parse(await response.json());
}

export async function cancelSearch(
  profileId: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistSearchRunValue> {
  const response = await fetcher(
    "/api/procurements/search/cancel",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось остановить поиск");
  }
  return SpecialistSearchRun.parse(await response.json());
}

export async function fetchSearchProgress(
  profileId: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistSearchRunValue> {
  const response = await fetcher(
    `/api/procurements/search/progress?profileId=${encodeURIComponent(profileId)}`,
    withCredentials(),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось получить прогресс поиска");
  }
  return SpecialistSearchRun.parse(await response.json());
}

export async function fetchProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profile", withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось загрузить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchProfiles(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher("/api/profiles", withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось загрузить профили");
  }
  return SpecialistProfileListResponse.parse(await response.json());
}

export async function createProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profiles", withCredentials({ method: "POST" }));
  if (!response.ok) {
    await throwApiError(response, "Не удалось создать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function deleteProfile(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher(`/api/profiles/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    await throwApiError(response, 
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
    await throwApiError(response, "Не удалось выбрать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function suggestProfile(
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileSuggestResponseValue> {
  const response = await fetcher(
    "/api/profiles/suggest",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
  if (!response.ok) {
    await throwApiError(
      response,
      response.status === 503
        ? "Подсказка недоступна: модель не настроена"
        : "Не удалось подобрать профиль",
    );
  }
  return SpecialistProfileSuggestResponse.parse(await response.json());
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
    await throwApiError(response, "Не удалось сохранить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function setProfileWatch(
  id: string,
  watchNewProcurements: boolean,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher(
    `/api/profiles/${id}/watch`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchNewProcurements }),
    }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось изменить слежение за новыми закупками");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchProcurementCard(
  id: string,
  fetcher: typeof fetch = fetch,
  fresh = false,
): Promise<ProcedureCard> {
  const response = await fetcher(
    `/api/procurements/${id}/card${fresh ? "?fresh=1" : ""}`,
    withCredentials(),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось открыть карточку закупки");
  }
  return ProcedureCard.parse(await response.json());
}

export async function fetchIngestProgress(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistIngestProgressValue> {
  const response = await fetcher(`/api/procurements/${id}/ingest-progress`, withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось получить прогресс индексации");
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
    await throwApiError(response, "Не удалось сохранить решение по закупке");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function reindexProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly SpecialistProcurementCardValue[]> {
  const response = await fetcher(
    `/api/procurements/${id}/reindex`,
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось обновить документы закупки");
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
    await throwApiError(response, "Не удалось вернуть закупку из корзины");
  }
  return SpecialistProcurementListResponse.parse(await response.json()).items;
}

export async function emptyTrash(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/api/procurements/trash", withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    await throwApiError(response, "Не удалось очистить корзину");
  }
}

export async function purgeProcurement(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`/api/procurements/${id}`, withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    await throwApiError(response, "Не удалось удалить закупку из корзины");
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
    await throwApiError(response, "Не удалось обновить архив");
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

/**
 * Readiness report (R42). A 503 still carries the parsed body — degraded
 * components are data, not a request failure. Only a network/JSON failure
 * throws; that case is already covered by the poll-stale banner.
 */
export async function fetchTelegramStatus(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistTelegramStatusValue> {
  const response = await fetcher("/api/telegram", withCredentials());
  if (!response.ok) {
    await throwApiError(response, "Не удалось проверить Telegram");
  }
  return SpecialistTelegramStatus.parse(await response.json());
}

export async function createTelegramLink(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistTelegramLinkResponseValue> {
  const response = await fetcher(
    "/api/telegram/link",
    withCredentials({ method: "POST" }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось создать ссылку Telegram");
  }
  return SpecialistTelegramLinkResponse.parse(await response.json());
}

export async function setTelegramMode(
  mode: "all" | "urgent",
  fetcher: typeof fetch = fetch,
): Promise<SpecialistTelegramStatusValue> {
  const response = await fetcher(
    "/api/telegram/mode",
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );
  if (!response.ok) {
    await throwApiError(response, "Не удалось сменить режим Telegram");
  }
  return SpecialistTelegramStatus.parse(await response.json());
}

export async function unlinkTelegram(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistTelegramStatusValue> {
  const response = await fetcher("/api/telegram", withCredentials({ method: "DELETE" }));
  if (!response.ok) {
    await throwApiError(response, "Не удалось отключить Telegram");
  }
  return SpecialistTelegramStatus.parse(await response.json());
}

export async function fetchServiceHealth(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistServiceHealthValue> {
  const response = await fetcher("/api/health", withCredentials());
  return SpecialistServiceHealth.parse(await response.json());
}
