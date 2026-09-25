import { cleanup, render, screen, within } from "@testing-library/react";
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

    expect(
      screen.getByText("Тревога: есть срочные изменения в отслеживаемых закупках"),
    ).toBeTruthy();
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

  it("splits new procurements from changes on watched cards", async () => {
    const catalog = SpecialistCatalog.parse(fixture);
    catalog.upsertCase({
      id: "00000000-0000-4000-8000-000000000402",
      title: "КТПБ 630 для котельной",
      status: "announced",
      statusLabel: "объявлена",
      url: "https://goszakupki.by/auction/view/402",
      sourceProcurementId: "auction/402",
    });
    const { inboxItemFromFoundCard } = await import("@procurement/domain");
    catalog.record(
      inboxItemFromFoundCard(catalog.procurements()[0]!, "2026-09-06T12:00:00.000Z"),
    );

    render(
      <MemoryRouter>
        <InboxApp entries={catalog.urgentInbox()} />
      </MemoryRouter>,
    );

    const newGroup = screen.getByRole("region", { name: /Новые закупки/ });
    const watchedGroup = screen.getByRole("region", { name: /Изменения в моих закупках/ });
    expect(within(newGroup).getByRole("button", { name: /КТПБ 630/ })).toBeTruthy();
    expect(within(newGroup).queryByRole("button", { name: /Поставка КТПБ/ })).toBeNull();
    expect(within(watchedGroup).getByRole("button", { name: /Поставка КТПБ/ })).toBeTruthy();
    expect(within(watchedGroup).getByRole("button", { name: /НКУ и щитовое оборудование/ })).toBeTruthy();
    expect(within(watchedGroup).queryByRole("button", { name: /КТПБ 630/ })).toBeNull();
  });

  it("marks review candidates as needs-attention without raising the alarm", async () => {
    const catalog = SpecialistCatalog.parse({ items: [] });
    catalog.upsertCase({
      id: "00000000-0000-4000-8000-000000000501",
      title: "БКТПВ 1000 для микрорайона",
      status: "accepting_bids",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/501",
      sourceProcurementId: "auction/501",
      foundAs: "review",
    });
    const { inboxItemFromFoundCard } = await import("@procurement/domain");
    catalog.record(
      inboxItemFromFoundCard(catalog.procurements()[0]!, "2026-09-06T12:00:00.000Z"),
    );
    const entries = catalog.urgentInbox().map((entry) => ({
      ...entry,
      profileNames: ["КТП и сети"],
      reviewReason: "Термин «КТП» совпал частично; тип объекта не подтверждён",
    }));

    render(
      <MemoryRouter>
        <InboxApp entries={entries} />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Тревога:/)).toBeNull();
    expect(screen.getByText(/На проверку: система не уверена/)).toBeTruthy();
    expect(screen.getByText("На проверку")).toBeTruthy();
    expect(screen.getByText("Почему на проверку")).toBeTruthy();
    expect(
      screen.getByText("Термин «КТП» совпал частично; тип объекта не подтверждён"),
    ).toBeTruthy();
    expect(screen.getByText("КТП и сети")).toBeTruthy();
  });

  it("keeps the alarm when urgent changes sit next to review candidates", async () => {
    const catalog = SpecialistCatalog.parse({ items: [] });
    catalog.upsertCase({
      id: "00000000-0000-4000-8000-000000000502",
      title: "БКТПВ 1000 для микрорайона",
      status: "accepting_bids",
      statusLabel: "приём заявок",
      url: "https://goszakupki.by/auction/view/502",
      sourceProcurementId: "auction/502",
      foundAs: "review",
    });
    const { inboxItemFromFoundCard } = await import("@procurement/domain");
    catalog.record(
      inboxItemFromFoundCard(catalog.procurements()[0]!, "2026-09-06T12:00:00.000Z"),
    );
    catalog.record({
      procurement: {
        title: "Поставка КТПБ",
        status: "cancelled",
        url: "https://goszakupki.by/auction/view/503",
        sourceProcurementId: "auction/503",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000503",
        procurementId: "00000000-0000-4000-8000-000000000503",
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        detectedAt: "2026-09-06T13:00:00.000Z",
        urgent: true,
      },
    });

    render(
      <MemoryRouter>
        <InboxApp entries={catalog.urgentInbox()} />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("Тревога: есть срочные изменения в отслеживаемых закупках"),
    ).toBeTruthy();
    expect(screen.getByText("На проверку")).toBeTruthy();
  });

  it("shows a quiet empty state and keeps the tasks section disabled", () => {
    render(
      <MemoryRouter>
        <InboxApp entries={[]} />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Тревога:/)).toBeNull();
    expect(screen.getAllByText("Новых изменений нет").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("link", { name: "Профили" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("link", { name: "Корзина" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Задачи/ })).toHaveProperty("disabled", true);
  });

  it("clears every inbox row only after the specialist confirms", async () => {
    const user = userEvent.setup();
    let dismissed = 0;
    render(
      <MemoryRouter>
        <InboxAlertProvider count={2}>
          <InboxApp
            entries={SpecialistCatalog.parse(fixture).urgentInbox()}
            onDismissAll={async () => {
              dismissed += 1;
            }}
          />
        </InboxAlertProvider>
      </MemoryRouter>,
    );

    // The button exists only with rows and a wired handler; the confirm
    // explains that read events cannot come back but new changes still can.
    const clear = screen.getByRole("button", { name: "Очистить всё" });
    await user.click(clear);
    expect(screen.getByText(/будет отмечено как разобранные/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(dismissed).toBe(0);

    await user.click(screen.getByRole("button", { name: "Очистить всё" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Очистить" }),
    );
    expect(dismissed).toBe(1);
  });

  it("does not offer the clear-all button without a handler or rows", () => {
    render(
      <MemoryRouter>
        <InboxApp entries={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "Очистить всё" })).toBeNull();
  });
});
