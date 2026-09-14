import { SearchHit } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
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

    await app.inject({
      method: "PUT",
      url: "/api/profile",
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
      payload: { limit: 10, offset: 0 },
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
});
