import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("asks the API for the active tab instead of filtering a full dump", async () => {
    const load = vi.fn(async (tab: "all" | "monitor" | "participate" | "archive" | "trash") => {
      if (tab === "all") return [card];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[]}
          load={load}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    expect(load).toHaveBeenCalledWith("all");
  });

  it("reloads the list when the specialist switches Все / Слежу / Архив", async () => {
    const user = userEvent.setup();
    const watching = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000011",
      title: "Кабель под наблюдением",
      triage: "monitor",
    });
    const archived = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000012",
      title: "Завершённая в архиве",
      archived: true,
    });
    const load = vi.fn(async (tab: "all" | "monitor" | "participate" | "archive" | "trash") => {
      if (tab === "all") return [card, watching];
      if (tab === "monitor") return [watching];
      if (tab === "archive") return [archived];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[]}
          load={load}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    expect(screen.getByText("Кабель под наблюдением")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Слежу" }));
    await waitFor(() => {
      expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
    });
    expect(screen.getByText("Кабель под наблюдением")).toBeTruthy();
    expect(load).toHaveBeenCalledWith("monitor");

    await user.click(screen.getByRole("tab", { name: "Архив" }));
    await waitFor(() => {
      expect(screen.getByText("Завершённая в архиве")).toBeTruthy();
    });
    expect(screen.queryByText("Кабель под наблюдением")).toBeNull();
    expect(load).toHaveBeenCalledWith("archive");
  });

  it("does not keep Корзина among Мои закупки tabs", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[SpecialistProcurementCard.parse({ ...card, triage: "reject" })]}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Мои закупки" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Корзина" })).toBeNull();
    expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
  });

  it("keeps rejected cards out of Мои закупки even if the loaded page is mixed", async () => {
    const trashed = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000099",
      title: "Убранная закупка",
      triage: "reject",
    });
    const load = vi.fn(async () => [card, trashed]);
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[card, trashed]}
          load={load}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    expect(screen.queryByText("Убранная закупка")).toBeNull();
  });

  it("lists a rejected card on the Корзина page and restores it", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    const onRestore = vi.fn(async () => undefined);
    const onPurge = vi.fn(async () => undefined);
    render(
      <MemoryRouter initialEntries={["/trash"]}>
        <MyProcurementsApp
          section="trash"
          procurements={[trashed]}
          onRestore={onRestore}
          onPurge={onPurge}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Корзина" })).toBeTruthy();
    expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Вернуть" }));
    expect(onRestore).toHaveBeenCalledWith(trashed.id);
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("loads the trash list from the API when opened as a section", async () => {
    const trashed = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    const load = vi.fn(async (tab: "all" | "monitor" | "participate" | "archive" | "trash") => {
      if (tab === "trash") return [trashed];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/trash"]}>
        <MyProcurementsApp
          section="trash"
          procurements={[]}
          load={load}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    expect(load).toHaveBeenCalledWith("trash");
  });

  it("purges a trash card only after confirmation", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    const onPurge = vi.fn(async () => undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/trash"]}>
        <MyProcurementsApp
          section="trash"
          procurements={[trashed]}
          onPurge={onPurge}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Удалить" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onPurge).toHaveBeenCalledWith(trashed.id);
  });
});
