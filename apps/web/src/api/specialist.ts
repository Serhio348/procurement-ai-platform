import {
  SpecialistInboxListResponse,
  SpecialistIngestProgress,
  SpecialistProcurementListResponse,
  SpecialistProfileListResponse,
  SpecialistSearchResponse,
  SpecialistWorkingProfile,
  type SpecialistInboxEntry,
  type SpecialistProcurementCard as SpecialistProcurementCardValue,
  type SpecialistProfileWrite,
  type SpecialistSearchResponse as SpecialistSearchResponseValue,
  type SpecialistTriageKind,
  type SpecialistProfileListResponse as SpecialistProfileListResponseValue,
  type SpecialistIngestProgress as SpecialistIngestProgressValue,
  type SpecialistWorkingProfile as SpecialistWorkingProfileValue,
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
    throw new Error(await searchFailureMessage(response));
  }
  return SpecialistSearchResponse.parse(await response.json());
}

export async function fetchProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profile");
  if (!response.ok) {
    throw new Error("Не удалось загрузить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchProfiles(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher("/api/profiles");
  if (!response.ok) {
    throw new Error("Не удалось загрузить профили");
  }
  return SpecialistProfileListResponse.parse(await response.json());
}

export async function createProfile(
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profiles", { method: "POST" });
  if (!response.ok) {
    throw new Error("Не удалось создать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function deleteProfile(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistProfileListResponseValue> {
  const response = await fetcher(`/api/profiles/${id}`, { method: "DELETE" });
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
  const response = await fetcher(`/api/profiles/${id}/activate`, { method: "POST" });
  if (!response.ok) {
    throw new Error("Не удалось выбрать профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function saveProfile(
  input: SpecialistProfileWrite,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error("Не удалось сохранить профиль");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function setProfileWatch(
  watchNewProcurements: boolean,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistWorkingProfileValue> {
  const response = await fetcher("/api/profile/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watchNewProcurements }),
  });
  if (!response.ok) {
    throw new Error("Не удалось изменить слежение за новыми закупками");
  }
  return SpecialistWorkingProfile.parse(await response.json());
}

export async function fetchIngestProgress(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<SpecialistIngestProgressValue> {
  const response = await fetcher(`/api/procurements/${id}/ingest-progress`);
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
  const response = await fetcher(`/api/procurements/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (!response.ok) {
    throw new Error("Не удалось сохранить решение по закупке");
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
