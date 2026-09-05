import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistWorkingProfile } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProfileApp } from "./ProfileApp.js";

afterEach(() => {
  cleanup();
});

describe("ProfileApp", () => {
  it("saves keywords without turning watch on, and watch is a separate button", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () =>
      SpecialistWorkingProfile.parse({
        name: "Щиты",
        keywords: ["НКУ"],
        excludeKeywords: [],
        watchNewProcurements: false,
      }),
    );
    const setWatch = vi.fn(async (watchNewProcurements: boolean) =>
      SpecialistWorkingProfile.parse({
        name: "Щиты",
        keywords: ["НКУ"],
        excludeKeywords: [],
        watchNewProcurements,
      }),
    );

    render(
      <MemoryRouter>
        <ProfileApp
          profile={SpecialistWorkingProfile.parse({
            name: "Электротехническое оборудование",
            keywords: ["КТПБ"],
            excludeKeywords: [],
            watchNewProcurements: false,
          })}
          save={save}
          setWatch={setWatch}
        />
      </MemoryRouter>,
    );

    await user.clear(screen.getByLabelText("Название"));
    await user.type(screen.getByLabelText("Название"), "Щиты");
    await user.clear(screen.getByLabelText(/Ключевые слова/));
    await user.type(screen.getByLabelText(/Ключевые слова/), "НКУ");
    await user.click(screen.getByRole("button", { name: "Сохранить профиль" }));

    expect(save).toHaveBeenCalledWith({
      name: "Щиты",
      keywords: ["НКУ"],
      excludeKeywords: [],
    });
    expect(setWatch).not.toHaveBeenCalled();
    expect(screen.getByText(/Поиск и слежение сами не запустились/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следить за новыми закупками" }));
    expect(setWatch).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Слежение за новыми закупками включено" })).toBeTruthy();
  });
});
