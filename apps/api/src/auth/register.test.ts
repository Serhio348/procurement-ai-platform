import { McpToolCallError } from "@procurement/mcp-client";
import { describe, expect, it } from "vitest";
import { buildSpecialistApi } from "../app.js";
import { createMemoryAuthDirectory } from "./memory-directory.js";
import { SESSION_COOKIE } from "./cookie.js";

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" ? (first.split(";")[0] ?? "") : "";
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

    const journal = await app.inject({
      method: "GET",
      url: "/api/admin/journal",
      headers: { cookie: cookieHeader(adminIn) },
    });
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: cookieHeader(adminIn) },
    });
    const log = JSON.parse(journal.body) as {
      errorCount: number;
      items: Array<{ kind: string; message: string }>;
    };
    expect(journal.statusCode).toBe(200);
    expect(log.items.some((item) => item.kind === "access" && item.message.includes("одобрил"))).toBe(
      true,
    );
    expect(JSON.parse(session.body).user.errorEventCount).toBe(0);

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

  it("lists a pending signup when createdAt is a PostgreSQL timestamptz", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const pending = await directory.signUp({
      email: "ivan@example.com",
      name: "Иван",
      password: "secret-password",
    });
    directory.listUsers = async () => [
      { ...pending, createdAt: "2026-09-06 12:00:00+00" },
    ];
    const app = await buildSpecialistApi({ authDirectory: directory });
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
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).items[0]?.email).toBe("ivan@example.com");
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

  it("shows a search outage on the admin journal and the error counter", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const app = await buildSpecialistApi({
      authDirectory: directory,
      searchHits: {
        search: async () => {
          throw new McpToolCallError("source_unavailable", "procurement.search", "blocked");
        },
      },
    });
    const adminIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const cookie = cookieHeader(adminIn);
    await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers: { cookie },
      payload: { name: "Кабель", keywords: ["кабель"], purpose: "", description: "", excludeKeywords: [], statuses: ["accepting_bids"], filters: {} },
    });
    const searched = await app.inject({
      method: "POST",
      url: "/api/procurements/search",
      headers: { cookie },
      payload: {},
    });
    const journal = await app.inject({
      method: "GET",
      url: "/api/admin/journal",
      headers: { cookie },
    });
    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie },
    });

    expect(searched.statusCode).toBe(503);
    expect(journal.statusCode).toBe(200);
    expect(JSON.parse(journal.body).errorCount).toBe(1);
    expect(JSON.parse(journal.body).items[0]?.message).toContain("goszakupki.by");
    expect(JSON.parse(session.body).user.errorEventCount).toBe(1);
    await app.close();
  });

  it("journals who signed in and how long they stayed", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const app = await buildSpecialistApi({ authDirectory: directory });

    const firstIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    expect(firstIn.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { cookie: cookieHeader(firstIn) },
    });

    const secondIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const journal = await app.inject({
      method: "GET",
      url: "/api/admin/journal",
      headers: { cookie: cookieHeader(secondIn) },
    });
    const messages = (JSON.parse(journal.body) as { items: Array<{ message: string }> }).items.map(
      (item) => item.message,
    );

    expect(journal.statusCode).toBe(200);
    expect(messages.some((message) => message.includes("вошёл в консоль"))).toBe(true);
    expect(messages.some((message) => message.includes("вышел") && message.includes("В системе"))).toBe(
      true,
    );
    await app.close();
  });

  it("keeps the first session alive when the same account signs in elsewhere", async () => {
    const directory = createMemoryAuthDirectory();
    await directory.bootstrapAdmin("admin@example.com", "admin-password", "Администратор");
    const app = await buildSpecialistApi({ authDirectory: directory });

    const firstIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const secondIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      payload: { email: "admin@example.com", password: "admin-password" },
    });
    const stillFirst = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: cookieHeader(firstIn) },
    });

    expect(secondIn.statusCode).toBe(200);
    expect(JSON.parse(stillFirst.body).user?.email).toBe("admin@example.com");
    await app.close();
  });
});
