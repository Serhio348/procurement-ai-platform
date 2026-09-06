import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "./LoginPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("keeps a business login form and sends email plus password", async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/auth/sign-in") {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            user: {
              id: "user-1",
              email: "admin@example.com",
              name: "Администратор",
              role: "admin",
              accessStatus: "active",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("missing", { status: 404 });
    });

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Вход" })).toBeTruthy();
    expect(screen.getByText("Консоль специалиста")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /сообщение|чат/i })).toBeNull();

    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Пароль"), "admin-password");
    await user.click(screen.getByRole("button", { name: "Войти" }));

    expect(posts).toEqual([{ email: "admin@example.com", password: "admin-password" }]);
  });
});
