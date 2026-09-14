import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import fixture from "../../../../tests/fixtures/specialist/inbox.json";
import { InboxAlertProvider } from "./InboxAlert.js";
import { InboxApp } from "./InboxApp.js";

afterEach(() => {
  cleanup();
});

describe("InboxApp", () => {
  it("offers refresh, download or delete instead of leaving the change as unread mail", async () => {
    const user = userEvent.setup();
    const resolved: Array<{ id: string; action: string }> = [];
    render(
      <MemoryRouter>
        <InboxAlertProvider count={2}>
          <InboxApp
            entries={SpecialistCatalog.parse(fixture).urgentInbox()}
            onResolve={async (id, action) => {
              resolved.push({ id, action });
            }}
          />
        </InboxAlertProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Тревога: есть сообщения, которые нужно разобрать")).toBeTruthy();
    expect(document.querySelector(".nav-badge")?.textContent).toBe("2");
    expect(screen.getByText("Карточка")).toBeTruthy();
    expect(screen.getByText("Документы")).toBeTruthy();
    expect(screen.queryByText("Бытовой щиток")).toBeNull();
    expect(screen.getByRole("button", { name: "Обновить карточку" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: /НКУ и щитовое оборудование/ }));
    expect(screen.getByRole("heading", { level: 2, name: "НКУ и щитовое оборудование" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Скачать документы" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Скачать документы" }));
    expect(resolved).toEqual([
      { id: "00000000-0000-4000-8000-000000000102", action: "documents" },
    ]);
  });

  it("opens a newly found procurement from the card button and dismisses it through resolve", async () => {
    const user = userEvent.setup();
    const resolved: string[] = [];
    const catalog = SpecialistCatalog.parse({ items: [] });
    catalog.upsertCase({
      id: "00000000-0000-4000-8000-000000000401",
      title: "КТПБ 400",
      status: "announced",
      statusLabel: "объявлена",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
    });
    const { inboxItemFromFoundCard } = await import("@procurement/domain");
    catalog.record(
      inboxItemFromFoundCard(catalog.procurements()[0]!, "2026-09-06T12:00:00.000Z"),
    );

    render(
      <MemoryRouter>
        <InboxApp
          entries={catalog.urgentInbox()}
          onResolve={async (id, action) => {
            resolved.push(`${action}:${id}`);
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Открыть карточку" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "Открыть карточку" }));
    expect(resolved[0]?.startsWith("open:")).toBe(true);
  });

  it("shows a quiet empty state and keeps the tasks section disabled", () => {
    render(
      <MemoryRouter>
        <InboxApp entries={[]} />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Тревога: есть сообщения, которые нужно разобрать")).toBeNull();
    expect(screen.getAllByText("Новых изменений нет").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Профили" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Корзина" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Задачи/ })).toHaveProperty("disabled", true);
  });
});
