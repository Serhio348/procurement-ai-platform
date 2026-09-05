import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistWorkingProfile } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProfileApp } from "./ProfileApp.js";

afterEach(() => {
  cleanup();
});

function profile(extra: Record<string, unknown> = {}) {
  return SpecialistWorkingProfile.parse({
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

    render(
      <MemoryRouter>
        <ProfileApp
          profile={profile({ description: "", keywords: [] })}
          save={save}
          setWatch={setWatch}
        />
      </MemoryRouter>,
    );

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
    expect(screen.getByText(/Поиск и слежение сами не запустились/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));
    expect(setWatch).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Слежение за новыми закупками включено" })).toBeTruthy();
  });

  it("can drop a looking-for word without rewriting the text", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => profile({ keywords: ["КТПБ"] }));

    render(
      <MemoryRouter>
        <ProfileApp
          profile={profile({ description: "КТПБ, НКУ", keywords: ["КТПБ", "НКУ"] })}
          save={save}
          setWatch={vi.fn(async () => profile())}
        />
      </MemoryRouter>,
    );

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
});
