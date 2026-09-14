import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AdminApp } from "./AdminApp.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminApp", () => {
  it("approves a pending request with the selected role", async () => {
    const user = userEvent.setup();
    const approvals: unknown[] = [];
    stubAdminFetch(approvals);
    renderAdmin("/admin/access");

    expect(await screen.findByText("Иван")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Одобрить" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("Площадка goszakupki.by недоступна")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Одобрить" }));
    expect(approvals).toEqual([{ role: "specialist" }]);
  });

  it("opens watch without mixing it with access requests", async () => {
    const user = userEvent.setup();
    stubAdminFetch([]);
    renderAdmin("/admin/access");

    expect(await screen.findByText("Иван")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Слежение" }));
    expect(await screen.findAllByText(/Фоновый поиск выполнен/)).not.toHaveLength(0);
    expect(screen.getAllByText("Кабель").length).toBeGreaterThan(0);
    expect(screen.queryByText("Иван")).toBeNull();
    expect(screen.queryByRole("button", { name: "Одобрить" })).toBeNull();
  });

  it("opens errors without mixing them with access requests", async () => {
    const user = userEvent.setup();
    stubAdminFetch([]);
    renderAdmin("/admin/access");

    expect(await screen.findByText("Иван")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: /Ошибки/ }));
    expect(await screen.findByText("Площадка goszakupki.by недоступна")).toBeTruthy();
    expect(screen.queryByText("Иван")).toBeNull();
    expect(screen.queryByRole("button", { name: "Одобрить" })).toBeNull();
  });

  it("clears active errors and keeps them in the log as taken off", async () => {
    const user = userEvent.setup();
    stubAdminFetch([]);
    renderAdmin("/admin/errors");

    expect(await screen.findByText("Площадка goszakupki.by недоступна")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Снять ошибки (1)" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "Снять ошибки (1)" }));

    expect(await screen.findByRole("button", { name: "Активных ошибок нет" })).toBeTruthy();
    expect(screen.getByText(/снято/)).toBeTruthy();
    expect(screen.getByText("Площадка goszakupki.by недоступна")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ошибки" })).toBeTruthy();
  });

  it("opens another specialist cabinet as a read-only list", async () => {
    const user = userEvent.setup();
    stubAdminFetch([]);
    renderAdmin("/admin/access");

    expect(await screen.findByText("Иван")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Кабинеты" }));
    expect(await screen.findByText(/Мои закупки 1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Одобрить" })).toBeNull();
    await user.click(screen.getByRole("link", { name: "Открыть" }));
    expect(await screen.findByRole("link", { name: "Кабель для кабинета" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Участвовать" })).toBeNull();
    expect(screen.getByRole("link", { name: /Все кабинеты/ })).toBeTruthy();
  });
});

function renderAdmin(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/:pane?/:userId?" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubAdminFetch(approvals: unknown[]) {
  const pending = {
    id: "user-2",
    email: "ivan@example.com",
    name: "Иван",
    role: null,
    accessStatus: "pending",
    createdAt: "2026-09-06T12:00:00.000Z",
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/auth/session") {
      return json({
        user: {
          id: "admin-1",
          email: "admin@example.com",
          name: "Администратор",
          role: "admin",
          accessStatus: "active",
          pendingUserCount: 1,
        },
      });
    }
    if (String(url).includes("/approve")) {
      approvals.push(JSON.parse(String(init?.body)));
      return json({
        items: [{ ...pending, role: "specialist", accessStatus: "active" }],
        pendingCount: 0,
      });
    }
    if (String(url) === "/api/admin/users") {
      return json({ items: [pending], pendingCount: 1 });
    }
    if (String(url) === "/api/admin/cabinets") {
      return json({
        items: [
          {
            userId: "user-2",
            email: "ivan@example.com",
            name: "Иван",
            role: "specialist",
            accessStatus: "active",
            workspaceId: "00000000-0000-4000-8000-000000000501",
            profileCount: 1,
            mineCount: 1,
            archiveCount: 0,
            trashCount: 0,
          },
        ],
      });
    }
    if (String(url).startsWith("/api/admin/users/user-2/procurements")) {
      return json({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000502",
            title: "Кабель для кабинета",
            status: "accepting_bids",
            statusLabel: "приём предложений",
            url: "https://goszakupki.by/auction/view/admin-view-1",
            sourceProcurementId: "auction/admin-view-1",
            triage: "participate",
          },
        ],
        total: 1,
        tab: "all",
        hasMore: false,
      });
    }
    if (String(url) === "/api/admin/journal/errors/ack") {
      return json({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000301",
            at: "2026-09-06T12:00:00.000Z",
            kind: "search",
            level: "error",
            message: "Площадка goszakupki.by недоступна",
            acknowledgedAt: "2026-09-07T09:00:00.000Z",
          },
        ],
        errorCount: 0,
      });
    }
    if (String(url) === "/api/admin/journal") {
      return json({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000302",
            at: "2026-09-06T12:00:00.000Z",
            kind: "discovery",
            level: "info",
            message: "Фоновый поиск выполнен (Кабель). Добавлено 2, уже решённых пропущено 1.",
          },
          {
            id: "00000000-0000-4000-8000-000000000301",
            at: "2026-09-06T12:00:00.000Z",
            kind: "search",
            level: "error",
            message: "Площадка goszakupki.by недоступна",
          },
        ],
        errorCount: 1,
      });
    }
    if (String(url) === "/api/profiles") {
      return json({
        items: [
          {
            id: "00000000-0000-4000-8000-000000000401",
            name: "Кабель",
            purpose: "",
            description: "",
            instructions: "",
            keywords: ["кабель"],
            excludeKeywords: [],
            watchNewProcurements: true,
          },
        ],
        activeProfileId: "00000000-0000-4000-8000-000000000401",
      });
    }
    return new Response("missing", { status: 404 });
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
