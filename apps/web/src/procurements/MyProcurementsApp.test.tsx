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

  it("shows a clamped title and procedure kind on the mine row", () => {
    const longTitle =
      "Комплект панелей по типу ЩО-70 для комплектации объекта «Реконструкция здания главного корпуса и здания поликлиники»";
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[
            SpecialistProcurementCard.parse({
              ...card,
              title: longTitle,
              kindLabel: "закупка из одного источника",
            }),
          ]}
          now={() => new Date("2026-08-01T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 2, name: longTitle })).toBeTruthy();
    expect(screen.getByText("закупка из одного источника")).toBeTruthy();
  });

  it("derives procedure kind from the platform card when kindLabel is missing", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp procurements={[card]} now={() => new Date("2026-08-01T10:00:00+03:00")} />
      </MemoryRouter>,
    );
    expect(screen.getByText("закупка из одного источника")).toBeTruthy();
  });

  it("does not show coarse «иная» when the URL family names a limited contest", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[
            SpecialistProcurementCard.parse({
              ...card,
              url: "https://goszakupki.by/limited/view/2",
              sourceProcurementId: "limited/2",
              kindLabel: "иная процедура",
              sourceCard: {
                sourceId: "goszakupki_by",
                sourceProcurementId: "limited/2",
                url: "https://goszakupki.by/limited/view/2",
                title: card.title,
                kind: "other",
                fetchedAt: "2026-09-01T00:00:00.000Z",
              },
            }),
          ]}
          now={() => new Date("2026-08-01T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("конкурс с ограниченным участием")).toBeTruthy();
    expect(screen.queryByText("иная процедура")).toBeNull();
  });

  it("shows live ingest progress on a participate card", () => {
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[card]}
          now={() => new Date("2026-08-01T10:00:00+03:00")}
          activeIngest={{
            [card.id]: {
              procurementId: card.id,
              phase: "downloading",
              total: 2,
              downloaded: 1,
              indexed: 0,
              readCount: 0,
              percent: 40,
              currentName: "ТЗ.pdf",
              files: [],
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Скачивание «ТЗ.pdf» — 40%/)).toBeTruthy();
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
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledWith(card.id);
    });
  });

  it("does not remove a card when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => undefined);
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
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("does not paint the parent catalog while the tab page is loading", async () => {
    const archived = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000013",
      title: "Архивная из памяти",
      archived: true,
    });
    let resolveLoad: (items: readonly SpecialistProcurementCard[]) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<readonly SpecialistProcurementCard[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[card, archived]}
          load={load}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByText("Архивная из памяти")).toBeNull();
    expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
    resolveLoad([card]);
    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    expect(screen.queryByText("Архивная из памяти")).toBeNull();
    expect(screen.queryByText("Загрузка…")).toBeNull();
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
      expect(screen.getByText("Кабель под наблюдением")).toBeTruthy();
    });
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
    expect(onPurge).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(onPurge).toHaveBeenCalledWith(trashed.id);
    });
  });

  it("hides a purged card before the delete request finishes", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    let finish = () => undefined;
    const onPurge = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
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
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
    });
    finish();
  });

  it("does not refetch the trash page after a purge", async () => {
    const user = userEvent.setup();
    const trashed = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    const load = vi.fn(async () => [trashed]);
    const onPurge = vi.fn(async () => undefined);
    render(
      <MemoryRouter initialEntries={["/trash"]}>
        <MyProcurementsApp
          section="trash"
          procurements={[]}
          load={load}
          onPurge={onPurge}
          now={() => new Date("2026-09-11T10:00:00.000Z")}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Выбор генеральной подрядной организации")).toBeTruthy();
    });
    load.mockClear();
    await user.click(screen.getByRole("button", { name: "Удалить" }));
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(onPurge).toHaveBeenCalledWith(trashed.id);
    });
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
  });

  it("empties the trash after confirmation", async () => {
    const user = userEvent.setup();
    const first = SpecialistProcurementCard.parse({ ...card, triage: "reject" });
    const second = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000002",
      title: "Вторая в корзине",
      triage: "reject",
      sourceProcurementId: "single-source/2",
    });
    const onEmptyTrash = vi.fn(async () => undefined);
    const onPurge = vi.fn(async () => undefined);
    render(
      <MemoryRouter initialEntries={["/trash"]}>
        <MyProcurementsApp
          section="trash"
          procurements={[first, second]}
          onEmptyTrash={onEmptyTrash}
          onPurge={onPurge}
          now={() => new Date("2026-09-11T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Очистить корзину" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Очистить корзину" }));
    expect(onEmptyTrash).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "ОК" }));
    await waitFor(() => {
      expect(onEmptyTrash).toHaveBeenCalledTimes(1);
    });
    expect(onPurge).not.toHaveBeenCalled();
    expect(screen.queryByText("Выбор генеральной подрядной организации")).toBeNull();
    expect(screen.queryByText("Вторая в корзине")).toBeNull();
    expect(screen.getByText("Корзина пуста.")).toBeTruthy();
  });

  it("paginates the mine list and moves between pages", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 14 }, (_, index) =>
      SpecialistProcurementCard.parse({
        ...card,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: `Закупка номер ${String(index + 1)}`,
        sourceProcurementId: `single-source/${String(index + 1)}`,
        triage: index % 2 === 0 ? "participate" : "monitor",
      }),
    );
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={items}
          pageSize={5}
          now={() => new Date("2026-08-01T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("1–5 из 14")).toBeTruthy();
    expect(screen.getByText("Закупка номер 1")).toBeTruthy();
    expect(screen.queryByText("Закупка номер 6")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Вперёд" }));
    expect(screen.getByText("6–10 из 14")).toBeTruthy();
    expect(screen.getByText("Закупка номер 6")).toBeTruthy();
    expect(screen.queryByText("Закупка номер 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("6–10 из 14")).toBeTruthy();
  });

  it("filters mine rows by profile and keeps «Все закупки»", async () => {
    const user = userEvent.setup();
    const equipment = {
      id: "00000000-0000-4000-8000-000000000901",
      name: "Оборудование",
      purpose: "",
      description: "",
      keywords: ["нку"],
      excludeKeywords: [],
      statuses: ["accepting_bids" as const],
      excludeSingleSource: false,
      filters: {},
      watchNewProcurements: false,
    };
    const networks = {
      ...equipment,
      id: "00000000-0000-4000-8000-000000000902",
      name: "Сети",
      keywords: ["сети"],
    };
    const first = SpecialistProcurementCard.parse({
      ...card,
      title: "НКУ для насосов",
      profileIds: [equipment.id],
    });
    const second = SpecialistProcurementCard.parse({
      ...card,
      id: "00000000-0000-4000-8000-000000000002",
      title: "Сети электроснабжения",
      sourceProcurementId: "request/2",
      triage: "monitor",
      profileIds: [networks.id],
    });
    render(
      <MemoryRouter initialEntries={["/my-procurements"]}>
        <MyProcurementsApp
          procurements={[first, second]}
          profiles={[equipment, networks]}
          now={() => new Date("2026-08-01T10:00:00+03:00")}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("tab", { name: "Все закупки" })).toBeTruthy();
    expect(screen.getByText("НКУ для насосов")).toBeTruthy();
    expect(screen.getByText("Сети электроснабжения")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Оборудование" }));
    expect(screen.getByText("НКУ для насосов")).toBeTruthy();
    expect(screen.queryByText("Сети электроснабжения")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Все закупки" }));
    expect(screen.getByText("Сети электроснабжения")).toBeTruthy();
  });
});
