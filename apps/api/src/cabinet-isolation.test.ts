import { SearchHit, type SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildSpecialistApi } from "./app.js";
import { createMemoryAuthDirectory } from "./auth/memory-directory.js";
import { createMemoryCabinetRegistry } from "./cabinets.js";

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" ? (first.split(";")[0] ?? "") : "";
}

describe("personal cabinets", () => {
  it("keeps inbox, profiles and cases isolated between two approved users", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const cabinets = createMemoryCabinetRegistry();
    const app = await buildSpecialistApi({
      authDirectory: directory,
      cabinets,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/iso-1",
            url: "https://goszakupki.by/auction/view/iso-1",
            title: "КТПБ для изоляции",
          }),
        ],
      },
    });

    const adminIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const users: Array<{ email: string; cookie: string }> = [];
    for (const email of ["a@example.com", "b@example.com"]) {
      const signed = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up",
        payload: { email, name: email, password: "secret-password" },
      });
      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: { cookie: cookieHeader(adminIn) },
      });
      const id = (
        JSON.parse(listed.body) as { items: Array<{ id: string; email: string }> }
      ).items.find((item) => item.email === email)?.id;
      await app.inject({
        method: "POST",
        url: `/api/admin/users/${id ?? ""}/approve`,
        headers: { cookie: cookieHeader(adminIn) },
        payload: { role: "specialist" },
      });
      users.push({ email, cookie: cookieHeader(signed) });
    }
    const [userA, userB] = users;
    if (userA === undefined || userB === undefined) throw new Error("users missing");

    const profileA = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/profile",
          headers: { cookie: userA.cookie },
        })
      ).body,
    ) as { id: string };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${profileA.id}`,
      headers: { cookie: userA.cookie },
      payload: {
        name: "Профиль A",
        purpose: "",
        description: "КТПБ",
        keywords: ["КТПБ"],
        excludeKeywords: [],
        statuses: ["accepting_bids"],
        excludeSingleSource: false,
        filters: {},
      },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      headers: { cookie: userA.cookie },
      payload: { limit: 10, offset: 0, profileId: profileA.id },
    });
    const found = JSON.parse(searched.body) as {
      items: Array<{ id: string; title: string }>;
    };
    const inboxA = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: userA.cookie },
    });
    const inboxB = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: userB.cookie },
    });
    const listB = await app.inject({
      method: "GET",
      url: "/api/procurements",
      headers: { cookie: userB.cookie },
    });
    const foreign = await app.inject({
      method: "GET",
      url: `/api/procurements/${found.items[0]?.id ?? "00000000-0000-4000-8000-000000000099"}`,
      headers: { cookie: userB.cookie },
    });
    const profilesB = await app.inject({
      method: "GET",
      url: "/api/profiles",
      headers: { cookie: userB.cookie },
    });

    expect(searched.statusCode).toBe(200);
    expect(found.items[0]?.title).toBe("КТПБ для изоляции");
    expect(JSON.parse(inboxB.body).items).toEqual([]);
    expect(JSON.parse(listB.body).items).toEqual([]);
    expect(foreign.statusCode).toBe(404);
    expect(
      (JSON.parse(profilesB.body) as { items: Array<{ name: string }> }).items.some(
        (item) => item.name === "Профиль A",
      ),
    ).toBe(false);
    expect(JSON.parse(inboxA.body).items.length).toBeGreaterThanOrEqual(0);

    const foundId = found.items[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${foundId}/decision`,
      headers: { cookie: userA.cookie },
      payload: { kind: "reject" },
    });
    const trashA = await app.inject({
      method: "GET",
      url: "/api/procurements?tab=trash",
      headers: { cookie: userA.cookie },
    });
    const trashB = await app.inject({
      method: "GET",
      url: "/api/procurements?tab=trash",
      headers: { cookie: userB.cookie },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      headers: { cookie: userB.cookie },
    });
    const trashAfterProfile = await app.inject({
      method: "GET",
      url: "/api/procurements?tab=trash",
      headers: { cookie: userB.cookie },
    });

    expect(JSON.parse(trashA.body).items).toEqual([
      expect.objectContaining({ id: foundId, triage: "reject" }),
    ]);
    expect(JSON.parse(trashB.body).items).toEqual([]);
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(trashAfterProfile.body).items).toEqual([]);

    await app.close();
  });

  it("lets an admin read another cabinet without mixing cases or allowing a specialist in", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const cabinets = createMemoryCabinetRegistry();
    const app = await buildSpecialistApi({
      authDirectory: directory,
      cabinets,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/admin-view-1",
            url: "https://goszakupki.by/auction/view/admin-view-1",
            title: "Кабель для админа",
          }),
        ],
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
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
    });
    const specialistId = (
      JSON.parse(listed.body) as { items: Array<{ id: string; email: string }> }
    ).items.find((item) => item.email === "spec@example.com")?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/admin/users/${specialistId}/approve`,
      headers: { cookie: adminCookie },
      payload: { role: "specialist" },
    });
    const specCookie = cookieHeader(signed);
    const specProfile = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: "/api/profile",
          headers: { cookie: specCookie },
        })
      ).body,
    ) as { id: string };
    await app.inject({
      method: "PUT",
      url: `/api/profiles/${specProfile.id}`,
      headers: { cookie: specCookie },
      payload: { name: "Кабель", keywords: ["кабель"] },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      headers: { cookie: specCookie },
      payload: { profileId: specProfile.id },
    });
    const foundId = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
    await app.inject({
      method: "POST",
      url: `/api/procurements/${foundId}/decision`,
      headers: { cookie: specCookie },
      payload: { kind: "participate" },
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/cabinets",
      headers: { cookie: specCookie },
    });
    const cabinetsList = await app.inject({
      method: "GET",
      url: "/api/admin/cabinets",
      headers: { cookie: adminCookie },
    });
    const mine = await app.inject({
      method: "GET",
      url: `/api/admin/users/${specialistId}/procurements`,
      headers: { cookie: adminCookie },
    });
    const journal = await app.inject({
      method: "GET",
      url: "/api/admin/journal",
      headers: { cookie: adminCookie },
    });

    expect(forbidden.statusCode).toBe(403);
    const summary = (
      JSON.parse(cabinetsList.body) as {
        items: Array<{ userId: string; name: string; mineCount: number; lastActiveAt?: string }>;
      }
    ).items.find((item) => item.userId === specialistId);
    expect(summary?.name).toBe("Иван");
    expect(summary?.mineCount).toBe(1);
    expect(summary?.lastActiveAt).toEqual(expect.any(String));
    expect(mine.statusCode).toBe(200);
    expect(JSON.parse(mine.body).items).toEqual([
      expect.objectContaining({ id: foundId, title: "Кабель для админа", triage: "participate" }),
    ]);
    expect(
      (JSON.parse(journal.body).items as Array<{ message: string }>).some((item) =>
        item.message.includes("просмотрел кабинет: Иван (spec@example.com)"),
      ),
    ).toBe(true);

    await app.close();
  });

  it("runs a document job per cabinet even when both hold the same card id", async () => {
    // Card ids derive from the source row, so two cabinets searching the same
    // phrase store the same card.id — the ingest dedup must still let each
    // cabinet's job run (R17).
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const cabinets = createMemoryCabinetRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ingest = vi.fn(async (card: SpecialistProcurementCard) => {
      await gate;
      return { ...card, documents: [] };
    });
    const app = await buildSpecialistApi({
      authDirectory: directory,
      cabinets,
      searchHits: {
        search: async () => [
          SearchHit.parse({
            sourceId: "goszakupki_by",
            sourceProcurementId: "auction/shared-ingest",
            url: "https://goszakupki.by/auction/view/shared-ingest",
            title: "КТПБ общая закупка",
          }),
        ],
      },
      documentIngest: { ingest },
    });

    const adminIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const cookies: string[] = [];
    for (const email of ["one@example.com", "two@example.com"]) {
      const signed = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up",
        payload: { email, name: email, password: "secret-password" },
      });
      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: { cookie: cookieHeader(adminIn) },
      });
      const id = (
        JSON.parse(listed.body) as { items: Array<{ id: string; email: string }> }
      ).items.find((item) => item.email === email)?.id;
      await app.inject({
        method: "POST",
        url: `/api/admin/users/${id ?? ""}/approve`,
        headers: { cookie: cookieHeader(adminIn) },
        payload: { role: "specialist" },
      });
      cookies.push(cookieHeader(signed));
    }

    for (const cookie of cookies) {
      const profile = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/profile",
            headers: { cookie },
          })
        ).body,
      ) as { id: string };
      await app.inject({
        method: "PUT",
        url: `/api/profiles/${profile.id}`,
        headers: { cookie },
        payload: { name: "КТПБ", keywords: ["КТПБ"] },
      });
      const searched = await app.inject({
        method: "POST",
        url: "/api/procurements/search",
        headers: { cookie },
        payload: { profileId: profile.id },
      });
      const cardId = (JSON.parse(searched.body).items as Array<{ id: string }>)[0]?.id ?? "";
      await app.inject({
        method: "POST",
        url: `/api/procurements/${cardId}/decision`,
        headers: { cookie },
        payload: { kind: "participate" },
      });
    }

    // Both cabinets' jobs start: a shared card id must not deduplicate the
    // second cabinet's download while the first is still in flight.
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    release();

    await app.close();
  });
});
