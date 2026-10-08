import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { buildSpecialistApi } from "./app.js";
import { createMemoryAuthDirectory } from "./auth/memory-directory.js";
import { createMemoryCabinetRegistry } from "./cabinets.js";
import {
  assistantPilotFromEnv,
  createMemoryAssistantSuggestions,
  createMemoryDecisionMemory,
  type DecisionMemoryPort,
} from "./decision-memory.js";
import type { TelegramNotifier } from "./telegram.js";

type Api = Awaited<ReturnType<typeof buildSpecialistApi>>;

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" ? (first.split(";")[0] ?? "") : "";
}

let sequence = 0;
function card(title: string, profileId: string) {
  sequence += 1;
  return SpecialistProcurementCard.parse({
    id: `00000000-0000-4000-8000-${String(100000000000 + sequence)}`,
    sourceProcurementId: `request/memory-${sequence}`,
    url: `https://goszakupki.by/request/view/memory-${sequence}`,
    title,
    status: "accepting_bids",
    statusLabel: "Приём предложений",
    foundAs: "match",
    live: true,
    profileIds: [profileId],
  });
}

interface Member {
  cookie: string;
  workspaceId: string;
  profileId: string;
}

/**
 * Admin and one approved specialist in separate cabinets. Only the cabinets
 * put into `pilot` after sign-in are in the assistant pilot.
 */
function telegramStub(): TelegramNotifier & { suggestions: string[] } {
  const suggestions: string[] = [];
  return {
    suggestions,
    botUsername: () => undefined,
    status: async () => ({ linked: false }),
    createLinkCode: async () => ({ code: "x", expiresInSec: 600 }),
    unlink: async () => undefined,
    setMode: async () => undefined,
    notifyInbox: async () => undefined,
    notifySuggestion: async (_workspaceId, suggestion) => {
      suggestions.push(suggestion.label);
    },
    handleUpdate: async () => undefined,
    pollOnce: async (offset) => offset,
  };
}

async function twoCabinets(memory: DecisionMemoryPort = createMemoryDecisionMemory()) {
  const directory = createMemoryAuthDirectory();
  await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
  const cabinets = createMemoryCabinetRegistry();
  const pilot = new Set<string>();
  const telegram = telegramStub();
  const app = await buildSpecialistApi({
    authDirectory: directory,
    cabinets,
    telegram,
    assistant: {
      memory,
      suggestions: createMemoryAssistantSuggestions(),
      enabledFor: (workspaceId) => pilot.has(workspaceId),
    },
  });
  const adminIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in",
    payload: { email: "admin@example.com", password: "admin-password" },
  });
  const adminCookie = cookieHeader(adminIn);
  const signed = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up",
    payload: { email: "spec@example.com", name: "Иван", password: "secret-password" },
  });
  const users = JSON.parse(
    (await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adminCookie } }))
      .body,
  ) as { items: Array<{ id: string; email: string }> };
  const specialistId = users.items.find((item) => item.email === "spec@example.com")?.id ?? "";
  const adminId = users.items.find((item) => item.email === "admin@example.com")?.id ?? "";
  await app.inject({
    method: "POST",
    url: `/api/admin/users/${specialistId}/approve`,
    headers: { cookie: adminCookie },
    payload: { role: "specialist" },
  });
  const member = async (userId: string, cookie: string): Promise<Member> => {
    const workspaceId = await cabinets.workspaceIdFor(userId);
    const profile = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/profile", headers: { cookie } })).body,
    ) as { id: string };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${profile.id}`,
      headers: { cookie },
      payload: { name: "Сети", keywords: ["сети 0,4 кВ"] },
    });
    return { cookie, workspaceId, profileId: profile.id };
  };
  const admin = await member(adminId, adminCookie);
  const specialist = await member(specialistId, cookieHeader(signed));
  pilot.add(admin.workspaceId);

  const decide = async (who: Member, title: string, kind: "monitor" | "reject") => {
    const item = card(title, who.profileId);
    (await cabinets.open(who.workspaceId)).catalog.upsertCase(item);
    const response = await app.inject({
      method: "POST",
      url: `/api/procurements/${item.id}/decision`,
      headers: { cookie: who.cookie },
      payload: { kind },
    });
    expect(response.statusCode).toBe(200);
    return item;
  };
  const terms = (who: Member) =>
    app.inject({
      method: "GET",
      url: `/api/admin/assistant/terms?profileId=${who.profileId}`,
      headers: { cookie: who.cookie },
    });
  const suggestions = async (who: Member) =>
    (
      JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/assistant/suggestions",
            headers: { cookie: who.cookie },
          })
        ).body,
      ) as { items: Array<{ id: string; label: string; profileName: string; rejectCount: number }> }
    ).items;
  const answer = (who: Member, id: string, action: "accept" | "dismiss") =>
    app.inject({
      method: "POST",
      url: `/api/assistant/suggestions/${id}`,
      headers: { cookie: who.cookie },
      payload: { action },
    });
  const profileOf = async (who: Member) =>
    JSON.parse(
      (await app.inject({ method: "GET", url: "/api/profile", headers: { cookie: who.cookie } })).body,
    ) as { excludeKeywords: string[] };
  return {
    app,
    memory,
    telegram,
    admin,
    specialist,
    decide,
    terms,
    suggestions,
    answer,
    profileOf,
  };
}

const TAKEN = [
  "Монтаж сетей 0,4 кВ в д. Озерцо",
  "Выполнение работ по устройству сетей 0,4кВ",
  "Реконструкция сетей 0,4 кВ подстанции",
];
const LIGHTING = [
  "Капитальный ремонт наружного освещения ул. Ленина",
  "Текущий ремонт сетей наружного освещения в г. Пинске",
  "Монтаж наружного освещения парка",
  "Устройство наружного освещения дворовой территории",
  "Модернизация наружного освещения стадиона",
];

async function closing(app: Api, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } finally {
    await app.close();
  }
}

describe("cabinet assistant decision memory", () => {
  it("remembers decisions past the emptied trash and forgets a returned one", async () => {
    const { app, memory, admin, decide, terms } = await twoCabinets();
    await closing(app, async () => {
      for (const title of [
        "Монтаж сетей 0,4 кВ в д. Озерцо",
        "Выполнение работ по устройству сетей 0,4кВ",
        "Реконструкция сетей 0,4 кВ подстанции",
      ]) {
        await decide(admin, title, "monitor");
      }
      for (const title of [
        "Капитальный ремонт наружного освещения ул. Ленина",
        "Текущий ремонт сетей наружного освещения в г. Пинске",
        "Монтаж наружного освещения парка",
        "Устройство наружного освещения дворовой территории",
        "Модернизация наружного освещения стадиона",
      ]) {
        await decide(admin, title, "reject");
      }
      const returned = await decide(admin, "Ремонт кровли здания", "reject");
      const restored = await app.inject({
        method: "POST",
        url: `/api/procurements/${returned.id}/restore`,
        headers: { cookie: admin.cookie },
      });
      expect(restored.statusCode).toBe(200);
      const emptied = await app.inject({
        method: "DELETE",
        url: "/api/procurements/trash",
        headers: { cookie: admin.cookie },
      });
      expect(emptied.statusCode).toBe(204);

      const remembered = await memory.list(admin.workspaceId);
      expect(remembered).toHaveLength(8);
      expect(remembered.some((entry) => entry.title === returned.title)).toBe(false);
      expect(remembered.every((entry) => entry.profileIds.includes(admin.profileId))).toBe(true);

      const view = await terms(admin);
      expect(view.statusCode).toBe(200);
      const body = JSON.parse(view.body) as {
        rejectCount: number;
        acceptCount: number;
        signals: Array<{ label: string; rejectCount: number; acceptCount: number }>;
      };
      expect(body.rejectCount).toBe(5);
      expect(body.acceptCount).toBe(3);
      expect(body.signals).toEqual([
        expect.objectContaining({ label: "наружного освещения", rejectCount: 5, acceptCount: 0 }),
      ]);
    });
  });

  it("keeps another cabinet's decisions out of the pilot cabinet's memory", async () => {
    const { app, memory, admin, specialist, decide, terms } = await twoCabinets();
    await closing(app, async () => {
      await decide(specialist, "Ремонт наружного освещения", "reject");
      await decide(admin, "Монтаж сетей 0,4 кВ", "monitor");

      expect(await memory.list(specialist.workspaceId)).toEqual([]);
      expect((await memory.list(admin.workspaceId)).map((entry) => entry.title)).toEqual([
        "Монтаж сетей 0,4 кВ",
      ]);
      expect((await terms(specialist)).statusCode).toBe(403);
    });
  });

  it("keeps the decision when the memory write fails", async () => {
    const broken: DecisionMemoryPort = {
      record: async () => {
        throw new Error("database down");
      },
      forget: async () => undefined,
      list: async () => [],
    };
    const { app, admin, decide } = await twoCabinets(broken);
    await closing(app, async () => {
      const item = await decide(admin, "Ремонт наружного освещения", "reject");
      const trash = await app.inject({
        method: "GET",
        url: "/api/procurements?tab=trash",
        headers: { cookie: admin.cookie },
      });
      expect(JSON.parse(trash.body).items).toEqual([
        expect.objectContaining({ id: item.id, triage: "reject" }),
      ]);
    });
  });
});

describe("assistant rule suggestions", () => {
  it("offers one rule after repeated rejects and «Принять» adds it to the profile's exclusions", async () => {
    const { app, telegram, admin, decide, suggestions, answer, profileOf } = await twoCabinets();
    await closing(app, async () => {
      for (const title of TAKEN) await decide(admin, title, "monitor");
      for (const title of LIGHTING.slice(0, 4)) await decide(admin, title, "reject");
      expect(await suggestions(admin)).toEqual([]);

      await decide(admin, LIGHTING[4]!, "reject");
      await decide(admin, "Ремонт наружного освещения сквера", "reject");
      const offered = await suggestions(admin);
      expect(offered).toEqual([
        expect.objectContaining({ label: "наружного освещения", profileName: "Сети", rejectCount: 5 }),
      ]);
      expect(telegram.suggestions).toEqual(["наружного освещения"]);
      expect((await profileOf(admin)).excludeKeywords).toEqual([]);

      const accepted = await answer(admin, offered[0]!.id, "accept");
      expect(accepted.statusCode).toBe(200);
      expect(
        (JSON.parse(accepted.body) as { profile?: { excludeKeywords: string[] } }).profile
          ?.excludeKeywords,
      ).toEqual(["наружного освещения"]);
      expect((await profileOf(admin)).excludeKeywords).toEqual(["наружного освещения"]);
      expect(await suggestions(admin)).toEqual([]);
      expect((await answer(admin, offered[0]!.id, "accept")).statusCode).toBe(404);
    });
  });

  it("never offers a dismissed rule again, however many rejects follow", async () => {
    const { app, telegram, admin, decide, suggestions, answer, profileOf } = await twoCabinets();
    await closing(app, async () => {
      for (const title of TAKEN) await decide(admin, title, "monitor");
      for (const title of LIGHTING) await decide(admin, title, "reject");
      const offered = await suggestions(admin);
      expect((await answer(admin, offered[0]!.id, "dismiss")).statusCode).toBe(200);

      for (let index = 0; index < 4; index += 1) {
        await decide(admin, `Обслуживание наружного освещения, участок ${index + 1}`, "reject");
      }
      expect(await suggestions(admin)).toEqual([]);
      expect(telegram.suggestions).toEqual(["наружного освещения"]);
      expect((await profileOf(admin)).excludeKeywords).toEqual([]);
    });
  });

  it("does not show or resolve the pilot cabinet's rule from another cabinet", async () => {
    const { app, admin, specialist, decide, suggestions, answer } = await twoCabinets();
    await closing(app, async () => {
      for (const title of TAKEN) await decide(admin, title, "monitor");
      for (const title of LIGHTING) await decide(admin, title, "reject");
      for (const title of TAKEN) await decide(specialist, title, "monitor");
      for (const title of LIGHTING) await decide(specialist, title, "reject");
      const offered = await suggestions(admin);
      expect(offered).toHaveLength(1);
      expect(await suggestions(specialist)).toEqual([]);
      expect((await answer(specialist, offered[0]!.id, "accept")).statusCode).toBe(404);
      expect(await suggestions(admin)).toHaveLength(1);
    });
  });
});

describe("assistant pilot gate", () => {
  it("is off unless a cabinet is listed", () => {
    expect(assistantPilotFromEnv(undefined)("a")).toBe(false);
    expect(assistantPilotFromEnv(" ")("a")).toBe(false);
    const listed = assistantPilotFromEnv("a, b");
    expect(listed("b")).toBe(true);
    expect(listed("c")).toBe(false);
    expect(assistantPilotFromEnv("*")("c")).toBe(true);
  });
});
