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
    expect(screen.queryByText("Площадка goszakupki.by недоступна")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Одобрить" }));
    expect(approvals).toEqual([{ role: "specialist" }]);
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
});

function renderAdmin(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/:pane?" element={<AdminApp />} />
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
    if (String(url) === "/api/admin/journal") {
      return json({
        items: [
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
    return new Response("missing", { status: 404 });
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
