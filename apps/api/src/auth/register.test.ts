import { describe, expect, it } from "vitest";
import { buildSpecialistApi } from "../app.js";
import { createMemoryAuthDirectory } from "./memory-directory.js";
import { SESSION_COOKIE } from "./cookie.js";

function cookieHeader(response: { headers: { "set-cookie"?: string | string[] } }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(";")[0] ?? "";
}

describe("specialist auth API", () => {
  it("keeps inbox readable in tests without a directory via the default specialist session", async () => {
    const app = await buildSpecialistApi();
    const response = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an anonymous inbox read when a real directory is wired", async () => {
    const app = await buildSpecialistApi({ authDirectory: createMemoryAuthDirectory() });
    const response = await app.inject({ method: "GET", url: "/api/inbox" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("registers as pending and hides procurements until an admin approves", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const app = await buildSpecialistApi({ authDirectory: directory });

    const signedUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up",
      payload: {
        email: "user@example.com",
        name: "Иван",
        password: "secret-password",
        role: "admin",
      },
    });
    const body = JSON.parse(signedUp.body) as {
      user: { accessStatus: string; role: string | null };
    };
    expect(signedUp.statusCode).toBe(200);
    expect(body.user.accessStatus).toBe("pending");
    expect(body.user.role).toBeNull();

    const pendingInbox = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: cookieHeader(signedUp) },
    });
    expect(pendingInbox.statusCode).toBe(403);

    const adminIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: cookieHeader(adminIn) },
    });
    const users = JSON.parse(listed.body) as {
      pendingCount: number;
      items: Array<{ id: string; email: string }>;
    };
    expect(users.pendingCount).toBe(1);
    const pendingId = users.items.find((item) => item.email === "user@example.com")?.id;
    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/users/${pendingId ?? ""}/approve`,
      headers: { cookie: cookieHeader(adminIn) },
      payload: { role: "viewer" },
    });
    expect(approved.statusCode).toBe(200);

    const viewerInbox = await app.inject({
      method: "GET",
      url: "/api/inbox",
      headers: { cookie: cookieHeader(signedUp) },
    });
    const viewerSearch = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      headers: { cookie: cookieHeader(signedUp) },
      payload: {},
    });
    expect(viewerInbox.statusCode).toBe(200);
    expect(viewerSearch.statusCode).toBe(403);
    await app.close();
  });

  it("requires the internal token for inbox events when it is configured", async () => {
    const app = await buildSpecialistApi({
      authDirectory: createMemoryAuthDirectory(),
      internalApiToken: "secret-token",
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/inbox/events",
      payload: {
        procurement: {
          title: "Поставка КТПБ",
          status: "cancelled",
          url: "https://goszakupki.by/auction/view/001",
          sourceProcurementId: "auction/001",
        },
        change: {
          id: "00000000-0000-4000-8000-000000000201",
          procurementId: "00000000-0000-4000-8000-000000000020",
          kind: "status_changed",
          previous: "accepting_bids",
          current: "cancelled",
          detectedAt: "2026-09-03T11:00:00.000Z",
          urgent: true,
        },
      },
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/api/inbox/events",
      headers: { "x-internal-token": "secret-token" },
      payload: {
        procurement: {
          title: "Поставка КТПБ",
          status: "cancelled",
          url: "https://goszakupki.by/auction/view/001",
          sourceProcurementId: "auction/001",
        },
        change: {
          id: "00000000-0000-4000-8000-000000000201",
          procurementId: "00000000-0000-4000-8000-000000000020",
          kind: "status_changed",
          previous: "accepting_bids",
          current: "cancelled",
          detectedAt: "2026-09-03T11:00:00.000Z",
          urgent: true,
        },
      },
    });
    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(201);
    expect(cookieHeader(allowed).startsWith(SESSION_COOKIE)).toBe(false);
    await app.close();
  });
});
