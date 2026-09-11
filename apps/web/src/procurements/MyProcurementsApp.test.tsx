import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistProcurementCard } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MyProcurementsApp } from "./MyProcurementsApp.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const card = SpecialistProcurementCard.parse({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Выбор генеральной подрядной организации",
  status: "under_review",
  statusLabel: "Рассмотрение предложений",
  url: "https://goszakupki.by/single-source/view/1",
  sourceProcurementId: "single-source/1",
  triage: "participate",
  watchSnapshot: {
    capturedAt: "2026-09-01T00:00:00.000Z",
    status: "under_review",
    bidsDeadline: "2026-08-08",
  },
  sourceCard: {
    sourceId: "goszakupki_by",
    sourceProcurementId: "single-source/1",
    url: "https://goszakupki.by/single-source/view/1",
    title: "Выбор генеральной подрядной организации",
    kind: "single_source",
    fetchedAt: "2026-09-01T00:00:00.000Z",
    bidsDeadline: { precision: "date", date: "2026-08-08", timeZone: "Europe/Minsk" },
    singleSourceBasis: "7. Признание процедуры государственной закупки несостоявшейся.",
  },
});

describe("MyProcurementsApp", () => {
  it("flags an expired deadline and a post-failure single-source purchase next to the source status", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp procurements={[card]} now={() => new Date("2026-09-11T10:00:00+03:00")} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Рассмотрение предложений")).toBeTruthy();
    expect(screen.getByText("срок подачи истёк")).toBeTruthy();
    expect(screen.getByText("после несостоявшейся")).toBeTruthy();
  });

  it("does not flag a deadline that is still ahead", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp procurements={[card]} now={() => new Date("2026-08-01T10:00:00+03:00")} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("срок подачи истёк")).toBeNull();
  });

  it("keeps an archived card out of the main tabs and lists it under «Архив»", async () => {
    const user = userEvent.setup();
    const stored = SpecialistProcurementCard.parse({ ...card, archived: true });
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp procurements={[stored]} now={() => new Date("2026-09-11T10:00:00+03:00")} />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Архив" }));
    expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
  });

  it("archives a card and removes it after a confirmation", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn(async () => undefined);
    const onRemove = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[card]}
          onArchive={onArchive}
          onRemove={onRemove}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "В архив" }));
    expect(onArchive).toHaveBeenCalledWith(card.id, true);

    await user.click(screen.getByRole("button", { name: "Убрать" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledWith(card.id);
  });

  it("does not remove a card when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[card]}
          onRemove={onRemove}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Убрать" }));
    expect(onRemove).not.toHaveBeenCalled();
  });
});
