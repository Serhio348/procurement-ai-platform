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
    purpose: "Находить КТПБ.",
    description: "Промышленные подстанции.",
    instructions: "Бытовые щитки не брать.",
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
          profile={profile({ name: "", description: "", instructions: "", keywords: [] })}
          save={vi.fn(async () => profile())}
          setWatch={vi.fn(async () => profile())}
        />
      </MemoryRouter>,
    );

    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Что ищем") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Указания") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /Убрать / })).toBeNull();
    expect(screen.queryByText(/КТПБ/)).toBeNull();
    expect(screen.queryByText(/водоподготов/i)).toBeNull();
  });

  it("shows looking-for words as chips, keeps extras, and does not turn watch on", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () =>
      profile({
        name: "Щиты",
        purpose: "кабель",
        description: "кабель",
        keywords: ["кабель", "ВРУ"],
      }),
    );
    const setWatch = vi.fn(async (watchNewProcurements: boolean) =>
      profile({ name: "Щиты", keywords: ["кабель", "ВРУ"], watchNewProcurements }),
    );

    renderProfile(profile({ description: "", keywords: [] }), save, setWatch);

    await user.clear(screen.getByLabelText("Название"));
    await user.type(screen.getByLabelText("Название"), "Щиты");
    await user.type(screen.getByLabelText("Что ищем"), "нужны КТПБ, НКУ и подстанция");
    expect(screen.getByRole("button", { name: "Убрать КТПБ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать НКУ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать подстанция" })).toBeTruthy();
    expect(screen.queryByLabelText("Строки поиска")).toBeNull();
    expect(screen.queryByLabelText("Не предлагать, если в заголовке есть")).toBeNull();

    await user.type(screen.getByLabelText("Добавить слово"), "ВРУ");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByRole("button", { name: "Убрать ВРУ" })).toBeTruthy();

    await user.clear(screen.getByLabelText("Что ищем"));
    await user.type(screen.getByLabelText("Что ищем"), "кабель");
    expect(screen.getByRole("button", { name: "Убрать кабель" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать ВРУ" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Убрать КТПБ" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith({
      name: "Щиты",
      purpose: "кабель",
      description: "кабель",
      instructions: "Бытовые щитки не брать.",
      keywords: ["кабель", "ВРУ"],
      excludeKeywords: [],
    });
    expect(screen.queryByLabelText("Зачем ищем")).toBeNull();
    expect(setWatch).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Профили" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Профиль «Щиты» сохранён.");
  });

  it("after creating a named profile shows a toast and returns to the list", async () => {
    const user = userEvent.setup();
    const current = profile({ name: "", description: "", instructions: "", keywords: [] });
    const save = vi.fn(async () => profile({ name: "Водоподготовка", keywords: [] }));

    renderProfile(current, save);

    await user.type(screen.getByLabelText("Название"), "Водоподготовка");
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Профили" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Профиль «Водоподготовка» создан.");
  });

  it("can drop a looking-for word without rewriting the text", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ keywords: ["КТПБ"] }));

    renderProfile(profile({ description: "КТПБ, НКУ", keywords: ["КТПБ", "НКУ"] }), save);

    await user.click(screen.getByRole("button", { name: "Убрать НКУ" }));
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "КТПБ, НКУ",
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
      "реставрация, ремонт зданий\nреставрация",
    );
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeKeywords: ["реставрация", "ремонт зданий"],
      }),
    );
  });
});
