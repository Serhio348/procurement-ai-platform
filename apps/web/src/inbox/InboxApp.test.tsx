import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import fixture from "../../../../tests/fixtures/specialist/inbox.json";
import { InboxApp } from "./InboxApp.js";

afterEach(() => {
  cleanup();
});

describe("InboxApp", () => {
  it("opens a procurement change without accept or ignore actions", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InboxApp entries={SpecialistCatalog.parse(fixture).urgentInbox()} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Срочно")).toHaveLength(2);
    expect(screen.queryByText("Бытовой щиток")).toBeNull();
    expect(screen.getByRole("link", { name: "https://goszakupki.by/auction/view/001" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /принять|игнорировать/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: "Закупки" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /НКУ и щитовое оборудование/ }));

    expect(screen.getByRole("heading", { level: 2, name: "НКУ и щитовое оборудование" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://goszakupki.by/auction/view/002" })).toBeTruthy();
    expect(screen.getByText("приём предложений")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Изменение" }).closest("section")?.textContent).toContain(
      "Обновлён документ",
    );
  });

  it("shows a quiet empty state and keeps the tasks section disabled", () => {
    render(
      <MemoryRouter>
        <InboxApp entries={[]} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Новых изменений нет").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Профили" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Задачи/ })).toHaveProperty("disabled", true);
  });
});
