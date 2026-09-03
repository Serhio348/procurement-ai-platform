import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistCatalog } from "@procurement/domain";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fixture from "../../../../tests/fixtures/specialist/inbox.json";
import { ProcurementsApp } from "./ProcurementsApp.js";

afterEach(() => {
  cleanup();
});

describe("ProcurementsApp", () => {
  it("opens the household case from the list without treating it as an urgent inbox row", async () => {
    const user = userEvent.setup();
    const items = SpecialistCatalog.parse(fixture).procurements();
    render(
      <MemoryRouter initialEntries={["/procurements"]}>
        <Routes>
          <Route path="/procurements" element={<ProcurementsApp items={items} />} />
          <Route path="/procurements/:id" element={<ProcurementsApp items={items} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /Бытовой щиток/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Бытовой щиток/ }));

    expect(screen.getByRole("heading", { level: 2, name: "Бытовой щиток" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://goszakupki.by/auction/view/003" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Бытовой щиток" }).closest("section")?.textContent,
    ).toContain("объявлена");
    expect(screen.getByRole("heading", { level: 3, name: "Последнее изменение" }).closest("section")?.textContent).toContain(
      "10000 → 9000",
    );
  });
});
