import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistWorkingProfile } from "@procurement/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProfileList, profileCreatedToast } from "./ProfileList.js";

afterEach(() => {
  cleanup();
});

describe("ProfileList", () => {
  it("lists empty directions without stock industry words and can add another", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => undefined);

    render(
      <MemoryRouter>
        <ProfileList
          profiles={[
            SpecialistWorkingProfile.parse({
              id: "00000000-0000-4000-8000-000000000901",
              name: "",
              keywords: [],
            }),
          ]}
          create={create}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: /Без названия/ })).toBeTruthy();
    expect(screen.queryByText(/КТПБ/)).toBeNull();
    expect(screen.queryByText(/электротехническ/i)).toBeNull();
    expect(screen.queryByText(/водоподготов/i)).toBeNull();
    expect(screen.getByText(/Единственный профиль удалить нельзя/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Новый профиль" }));
    expect(create).toHaveBeenCalled();
  });

  it("shows a created-profile toast from navigation state", () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: "/profiles", state: { toast: profileCreatedToast("Водоподготовка") } },
        ]}
      >
        <ProfileList
          profiles={[
            SpecialistWorkingProfile.parse({
              id: "00000000-0000-4000-8000-000000000902",
              name: "Водоподготовка",
            }),
          ]}
          create={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toContain("Профиль «Водоподготовка» создан.");
  });

  it("deletes a direction with the row cross and keeps the last profile", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => undefined);
    const water = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Водоподготовка",
    });
    const substations = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000901",
      name: "Подстанции",
    });

    const { rerender } = render(
      <MemoryRouter>
        <ProfileList profiles={[substations, water]} create={async () => undefined} remove={remove} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Удалить профиль «Водоподготовка»" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(water.id));

    rerender(
      <MemoryRouter>
        <ProfileList profiles={[substations]} create={async () => undefined} remove={remove} />
      </MemoryRouter>,
    );

    expect(
      (screen.getByRole("button", { name: "Удалить профиль «Подстанции»" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("surfaces a delete failure instead of swallowing it", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => {
      throw new Error("Не удалось удалить профиль");
    });
    const water = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Водоподготовка",
    });
    const substations = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000901",
      name: "Подстанции",
    });

    render(
      <MemoryRouter>
        <ProfileList profiles={[substations, water]} create={async () => undefined} remove={remove} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Удалить профиль «Водоподготовка»" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось удалить профиль",
    );
  });
});
