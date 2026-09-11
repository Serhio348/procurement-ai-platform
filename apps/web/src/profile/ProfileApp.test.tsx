import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistWorkingProfile } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProfileApp } from "./ProfileApp.js";
import { ProfileList } from "./ProfileList.js";

afterEach(() => {
  cleanup();
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
  setWatch: (watch: boolean) => Promise<ReturnType<typeof profile>> = vi.fn(
    async () => current,
  ),
) {
  return render(
    <MemoryRouter initialEntries={[`/profiles/${current.id}`]}>
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
    </MemoryRouter>,
  );
}

describe("ProfileApp", () => {
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
    const setWatch = vi.fn(async (watchNewProcurements: boolean) =>
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
    const setWatch = vi.fn(async (watchNewProcurements: boolean) =>
      profile({ name: "Щиты", keywords: ["НКУ"], watchNewProcurements }),
    );

    renderProfile(profile({ name: "", keywords: [] }), save, setWatch);

    await user.type(screen.getByLabelText("Название"), "Щиты");
    await user.type(screen.getByLabelText("Добавить слово"), "НКУ{enter}");
    expect(screen.getByText(/несохранённые изменения/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Щиты", keywords: ["НКУ"] }));
    expect(setWatch).toHaveBeenCalledWith(true);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(setWatch.mock.invocationCallOrder[0] ?? 0);
    expect(await screen.findByRole("button", { name: "Слежение включено" })).toBeTruthy();
    expect(screen.queryByText(/несохранённые изменения/)).toBeNull();
  });

  it("does not resave an untouched form when only watch is toggled", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());
    const setWatch = vi.fn(async (watchNewProcurements: boolean) => profile({ watchNewProcurements }));

    renderProfile(profile(), save, setWatch);
    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));

    expect(save).not.toHaveBeenCalled();
    expect(setWatch).toHaveBeenCalledWith(true);
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

    await user.click(screen.getByLabelText("Завершена"));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["accepting_bids", "completed"],
      }),
    );
  });

  it("saves the single-source exclusions and can exclude failed procedures by status", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile());

    renderProfile(profile({ statuses: [] }), save);

    await user.click(
      screen.getByLabelText(/Не показывать закупки из одного источника по итогам несостоявшейся/),
    );
    await user.click(screen.getByLabelText("Не состоялась"));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeSingleSource: false,
        excludeSingleSourceAfterFailed: true,
        statuses: ["failed"],
      }),
    );
  });
});
