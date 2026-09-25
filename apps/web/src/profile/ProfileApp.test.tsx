import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistWorkingProfile } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Link, Route, Routes } from "react-router-dom";
import { ProfileApp } from "./ProfileApp.js";
import { ProfileList } from "./ProfileList.js";
import { UnsavedGuardProvider } from "../shell/UnsavedGuard.js";
import { ProfileEditorRoute } from "../SpecialistApp.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const profileId = "00000000-0000-4000-8000-000000000901";

function profile(extra: Record<string, unknown> = {}) {
  return SpecialistWorkingProfile.parse({
    id: profileId,
    name: "Электротехническое оборудование",
    keywords: ["КТПБ"],
    excludeKeywords: [],
    watchNewProcurements: false,
    ...extra,
  });
}

function renderProfile(
  current: ReturnType<typeof profile>,
  save: () => Promise<ReturnType<typeof profile>>,
  setWatch: (id: string, watch: boolean) => Promise<ReturnType<typeof profile>> = vi.fn(
    async () => current,
  ),
) {
  return render(
    <MemoryRouter initialEntries={[`/profiles/${current.id}`]}>
      <UnsavedGuardProvider>
      <Routes>
        <Route
          path="/profiles"
          element={<ProfileList profiles={[current]} create={async () => undefined} />}
        />
        <Route
          path="/profiles/:id"
          element={<ProfileApp profile={current} save={save} setWatch={setWatch} />}
        />
      </Routes>
      </UnsavedGuardProvider>
    </MemoryRouter>,
  );
}

describe("ProfileApp", () => {
  it("drafts the form from free text without saving it", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());
    const suggest = vi.fn(async () => ({
      draft: {
        name: "КТП и сети",
        purpose: "Поставка комплектных подстанций",
        keywords: ["КТП", "комплектная трансформаторная подстанция"],
        excludeKeywords: ["монтаж"],
        statuses: ["accepting_bids" as const],
        excludeSingleSource: false,
      },
      explanation: "Понял как поставку подстанций.",
      sampledTitles: ["КТП киоскового типа для района"],
      grounded: true,
    }));

    render(
      <MemoryRouter>
        <ProfileApp
          profile={profile({ name: "", keywords: [] })}
          save={save}
          setWatch={vi.fn(async () => profile())}
          suggest={suggest}
        />
      </MemoryRouter>,
    );

    await user.type(
      screen.getByLabelText("Опишите направление своими словами"),
      "Поставляем КТП, монтаж не делаем",
    );
    await user.click(screen.getByRole("button", { name: "Заполнить профиль" }));

    expect(suggest).toHaveBeenCalledWith("Поставляем КТП, монтаж не делаем");
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("КТП и сети");
    expect(
      screen.getByRole("button", { name: "Убрать комплектная трансформаторная подстанция" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать КТП" })).toBeTruthy();
    expect(screen.getByText(/Проверено по 1 реальным объявлениям/)).toBeTruthy();
    // The draft is reviewable, not auto-saved.
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/Есть несохранённые изменения/)).toBeTruthy();
  });

  it("shows the suggestion error instead of failing silently", async () => {
    const user = userEvent.setup();
    const suggest = vi.fn(async () => {
      throw new Error("Подсказка недоступна: модель не настроена");
    });

    render(
      <MemoryRouter>
        <ProfileApp
          profile={profile({ name: "", keywords: [] })}
          save={vi.fn(async () => profile())}
          setWatch={vi.fn(async () => profile())}
          suggest={suggest}
        />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Опишите направление своими словами"), "КТП");
    await user.click(screen.getByRole("button", { name: "Заполнить профиль" }));
    expect(screen.getByText("Подсказка недоступна: модель не настроена")).toBeTruthy();
  });

  it("opens empty fields without stock search words", () => {
    render(
      <MemoryRouter>
        <ProfileApp
          profile={profile({ name: "", keywords: [] })}
          save={vi.fn(async () => profile())}
          setWatch={vi.fn(async () => profile())}
        />
      </MemoryRouter>,
    );

    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Добавить слово") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("Указания")).toBeNull();
    expect(screen.queryByRole("button", { name: /Убрать / })).toBeNull();
    expect(screen.queryByText(/КТПБ/)).toBeNull();
    expect(screen.queryByText(/водоподготов/i)).toBeNull();
  });

  it("adds and removes keywords as chips and does not turn watch on", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ name: "Щиты", keywords: ["КТПБ", "ВРУ"] }));
    const setWatch = vi.fn(async (_id: string, watchNewProcurements: boolean) =>
      profile({ name: "Щиты", keywords: ["КТПБ", "ВРУ"], watchNewProcurements }),
    );

    renderProfile(profile({ name: "", keywords: [] }), save, setWatch);

    await user.type(screen.getByLabelText("Название"), "Щиты");
    await user.type(screen.getByLabelText("Добавить слово"), "КТПБ, НКУ, подстанция");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByRole("button", { name: "Убрать КТПБ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать НКУ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать подстанция" })).toBeTruthy();

    await user.clear(screen.getByLabelText("Добавить слово"));
    await user.type(screen.getByLabelText("Добавить слово"), "ВРУ");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByRole("button", { name: "Убрать ВРУ" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Убрать НКУ" }));
    expect(screen.queryByRole("button", { name: "Убрать НКУ" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Щиты",
        keywords: ["КТПБ", "подстанция", "ВРУ"],
      }),
    );
    expect(setWatch).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Профили" }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Профиль «Щиты» создан.");
  });

  it("saves typed keywords before turning watch on, so discovery has something to search", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ name: "Щиты", keywords: ["НКУ"] }));
    const setWatch = vi.fn(async (_id: string, watchNewProcurements: boolean) =>
      profile({ name: "Щиты", keywords: ["НКУ"], watchNewProcurements }),
    );

    renderProfile(profile({ name: "", keywords: [] }), save, setWatch);

    await user.type(screen.getByLabelText("Название"), "Щиты");
    await user.type(screen.getByLabelText("Добавить слово"), "НКУ{enter}");
    expect(screen.getByText(/несохранённые изменения/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Щиты", keywords: ["НКУ"] }));
    expect(setWatch).toHaveBeenCalledWith(profileId, true);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(setWatch.mock.invocationCallOrder[0] ?? 0);
    expect(await screen.findByRole("button", { name: "Слежение включено" })).toBeTruthy();
    expect(screen.queryByText(/несохранённые изменения/)).toBeNull();
  });

  it("does not resave an untouched form when only watch is toggled", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());
    const setWatch = vi.fn(async (_id: string, watchNewProcurements: boolean) => profile({ watchNewProcurements }));

    renderProfile(profile(), save, setWatch);
    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));

    expect(save).not.toHaveBeenCalled();
    expect(setWatch).toHaveBeenCalledWith(profileId, true);
  });

  // R29: a phrase typed but not committed with Enter is still saved.
  it("saves a keyword that was typed but never added with Enter", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ keywords: ["КТПБ", "сети электроснабжения"] }));

    renderProfile(profile(), save);

    await user.type(screen.getByLabelText("Добавить слово"), "сети электроснабжения");
    expect(screen.getByText(/несохранённые изменения/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        keywords: ["КТПБ", "сети электроснабжения"],
      }),
    );
  });

  it("does not mark the form dirty when the pending word only repeats a chip", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());

    renderProfile(profile(), save);

    await user.type(screen.getByLabelText("Добавить слово"), "ктпб");
    expect(screen.queryByText(/несохранённые изменения/)).toBeNull();
  });

  it("saves a pending word before turning watch on", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ keywords: ["КТПБ", "НКУ"] }));
    const setWatch = vi.fn(async (_id: string, watchNewProcurements: boolean) =>
      profile({ keywords: ["КТПБ", "НКУ"], watchNewProcurements }),
    );

    renderProfile(profile(), save, setWatch);

    await user.type(screen.getByLabelText("Добавить слово"), "НКУ");
    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ["КТПБ", "НКУ"] }),
    );
    expect(setWatch).toHaveBeenCalledWith(profileId, true);
    expect(await screen.findByRole("button", { name: "Слежение включено" })).toBeTruthy();
    // The saved phrase becomes a chip, the input is cleared.
    expect(screen.getByRole("button", { name: "Убрать НКУ" })).toBeTruthy();
    expect((screen.getByLabelText("Добавить слово") as HTMLInputElement).value).toBe("");
  });

  it("after creating a named profile shows a toast and returns to the list", async () => {
    const user = userEvent.setup();
    const current = profile({ name: "", keywords: [] });
    const save = vi.fn(async () => profile({ name: "Водоподготовка", keywords: [] }));

    renderProfile(current, save);

    await user.type(screen.getByLabelText("Название"), "Водоподготовка");
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Профили" }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Профиль «Водоподготовка» создан.");
  });

  it("can drop a keyword chip without rewriting the list", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ keywords: ["КТПБ"] }));

    renderProfile(profile({ keywords: ["КТПБ", "НКУ"] }), save);

    await user.click(screen.getByRole("button", { name: "Убрать НКУ" }));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        keywords: ["КТПБ"],
      }),
    );
    expect(screen.queryByRole("button", { name: "Убрать НКУ" })).toBeNull();
  });

  it("sends typed exclusions to the profile instead of dropping them", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () =>
      profile({ excludeKeywords: ["реставрация", "ремонт зданий"] }),
    );

    renderProfile(profile({ excludeKeywords: [] }), save);

    await user.type(
      screen.getByLabelText("Исключать"),
      "реставрация, ремонт зданий{enter}реставрация",
    );
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeKeywords: ["реставрация", "ремонт зданий"],
      }),
    );
  });

  it("lets the specialist watch finished procedures too", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());

    renderProfile(profile({ statuses: ["accepting_bids"] }), save);

    await user.click(screen.getByRole("tab", { name: "Расширенный поиск" }));
    await user.click(screen.getByLabelText("Завершена"));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["accepting_bids", "completed"],
      }),
    );
  });

  it("saves the single-source exclusion and can exclude failed procedures by status", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());

    renderProfile(profile({ statuses: [] }), save);

    await user.click(screen.getByLabelText("Не показывать закупки из одного источника"));
    await user.click(screen.getByRole("tab", { name: "Расширенный поиск" }));
    await user.click(screen.getByLabelText("Не состоялась"));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeSingleSource: true,
        statuses: ["failed"],
      }),
    );
  });

  it("saves every advanced-search window onto the profile filters", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());

    renderProfile(profile({ filters: {}, statuses: ["accepting_bids"] }), save);

    await user.click(screen.getByRole("tab", { name: "Расширенный поиск" }));
    await user.type(screen.getByLabelText("УНП заказчика"), "123456789");
    await user.type(screen.getByLabelText("Заказчик / организатор"), "Гродноэнерго");
    await user.type(screen.getByLabelText("Номер закупки"), "auc0003664806");
    fireEvent.change(document.getElementById("profile-price-from")!, { target: { value: "1000" } });
    fireEvent.change(document.getElementById("profile-price-to")!, { target: { value: "500000" } });
    fireEvent.change(document.getElementById("profile-published-from")!, {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(document.getElementById("profile-published-to")!, {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(document.getElementById("profile-request-from")!, {
      target: { value: "2026-09-16" },
    });
    fireEvent.change(document.getElementById("profile-request-to")!, {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(document.getElementById("profile-auction-from")!, {
      target: { value: "2026-09-20" },
    });
    fireEvent.change(document.getElementById("profile-auction-to")!, {
      target: { value: "2026-09-25" },
    });
    await user.click(document.getElementById("profile-types")!);
    await user.click(screen.getByLabelText("Электронный аукцион"));
    await user.click(document.getElementById("profile-types")!);
    await user.click(document.getElementById("profile-regions")!);
    await user.click(screen.getByLabelText("Гродненская область"));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["accepting_bids"],
        filters: expect.objectContaining({
          buyerUnp: "123456789",
          buyerText: "Гродноэнерго",
          procurementNumber: "auc0003664806",
          priceFrom: 1000,
          priceTo: 500000,
          publishedFrom: "2026-09-01",
          publishedTo: "2026-09-30",
          requestEndFrom: "2026-09-16",
          requestEndTo: "2026-10-01",
          auctionFrom: "2026-09-20",
          auctionTo: "2026-09-25",
          typeIds: ["Auction"],
          regionIds: ["4"],
        }),
      }),
    );
  });

  it("asks before leaving through the shell menu while the form is dirty", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderProfile(profile(), vi.fn(async () => profile()));

    await user.type(screen.getByLabelText("Название"), "Черновик");
    await user.click(within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("link", { name: "Входящие" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("не сохранены"));
    expect(screen.getByText("Профиль направления")).toBeTruthy();

    confirm.mockReturnValue(true);
    await user.click(within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("link", { name: "Входящие" }));
    expect(screen.queryByText("Профиль направления")).toBeNull();
  });

  it("leaves through the shell menu without asking when nothing changed", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");

    renderProfile(profile(), vi.fn(async () => profile()));

    await user.click(within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("link", { name: "Входящие" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByText("Профиль направления")).toBeNull();
  });

  it("shows the fields of the profile the route switched to", async () => {
    const user = userEvent.setup();
    const first = profile({ name: "Профиль A" });
    const second = profile({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Профиль B",
    });

    render(
      <MemoryRouter initialEntries={[`/profiles/${first.id}`]}>
        <UnsavedGuardProvider>
          <Link to={`/profiles/${second.id}`}>К профилю B</Link>
          <Routes>
            <Route
              path="/profiles/:id"
              element={
                <ProfileEditorRoute
                  profiles={[first, second]}
                  save={vi.fn(async () => second)}
                  setWatch={vi.fn(async () => second)}
                />
              }
            />
          </Routes>
        </UnsavedGuardProvider>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Название"), " — черновик A");
    await user.click(screen.getByRole("link", { name: "К профилю B" }));

    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Профиль B");
  });

  it("keeps purpose and description on save instead of wiping them", async () => {
    const user = userEvent.setup();
    const seeded = profile({
      purpose: "Комплектные трансформаторные подстанции",
      description: "seed-note",
    });
    const save = vi.fn(async () => seeded);

    renderProfile(seeded, save);

    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "Комплектные трансформаторные подстанции",
        description: "seed-note",
      }),
    );
  });

  it("sends an edited purpose and marks the form dirty", async () => {
    const user = userEvent.setup();
    const seeded = profile({ purpose: "КТП" });
    const save = vi.fn(async () => seeded);

    renderProfile(seeded, save);

    const field = screen.getByLabelText("Назначение") as HTMLTextAreaElement;
    expect(field.value).toBe("КТП");

    await user.clear(field);
    await user.type(field, "КТП и ВРУ для промышленных объектов");

    expect(screen.getByText(/несохранённые изменения/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "КТП и ВРУ для промышленных объектов" }),
    );
  });
});
