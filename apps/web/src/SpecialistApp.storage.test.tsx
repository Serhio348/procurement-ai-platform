import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import { inboxItemFromFoundCard, SpecialistCatalog } from "@procurement/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecialistApp } from "./SpecialistApp.js";

const profile = SpecialistWorkingProfile.parse({
  id: "00000000-0000-4000-8000-000000000901",
  name: "Подстанции",
});

const stale = SpecialistProcurementCard.parse({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Старая из базы",
  status: "unknown",
  statusLabel: "Завершён",
  url: "https://goszakupki.by/request/view/1",
  sourceProcurementId: "request/1",
  profileIds: [profile.id],
});

const found = SpecialistProcurementCard.parse({
  id: "00000000-0000-4000-8000-000000000002",
  title: "Найденная поиском",
  status: "unknown",
  statusLabel: "Приём предложений",
  url: "https://goszakupki.by/request/view/2",
  sourceProcurementId: "request/2",
  profileIds: [profile.id],
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, "", "/procurements");
});

afterEach(() => {
  cleanup();
});

describe("SpecialistApp search list", () => {
  it("starts empty, then keeps only this search after remount", async () => {
    const user = userEvent.setup();
    const searchProps = {
      inbox: [],
      procurements: [] as SpecialistProcurementCard[],
      profiles: [profile],
      activeProfileId: profile.id,
      search: async () => ({
        profileName: profile.name,
        relevantCount: 1,
        discardedCount: 0,
        items: [found],
      }),
    };

    const first = render(<SpecialistApp {...searchProps} />);
    expect(screen.queryByRole("button", { name: /Старая из базы/ })).toBeNull();
    expect(screen.getAllByText("Нет закупок в работе").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Искать по профилю" }));
    expect(screen.getByRole("button", { name: /Найденная поиском/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Старая из базы/ })).toBeNull();
    first.unmount();

    render(<SpecialistApp {...searchProps} procurements={[found]} />);
    expect(screen.getByRole("button", { name: /Найденная поиском/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Старая из базы/ })).toBeNull();
  });

  it("keeps a watched case out of Закупки", () => {
    const watching = SpecialistProcurementCard.parse({
      ...stale,
      triage: "monitor",
      title: "Отслеживаемая из кабинета",
    });
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[watching, found]}
        profiles={[profile]}
        activeProfileId={profile.id}
      />,
    );
    expect(screen.queryByRole("button", { name: /Отслеживаемая из кабинета/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Найденная поиском/ })).toBeTruthy();
  });

  it("moves an inbox case into Закупки and opens it for triage", async () => {
    window.history.pushState({}, "", "/");
    const user = userEvent.setup();
    const opened = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "КТПБ из входящих",
      status: "announced",
      statusLabel: "объявлена",
      url: "https://goszakupki.by/auction/view/401",
      sourceProcurementId: "auction/401",
      foundAs: "match",
      profileIds: [profile.id],
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(opened);
    catalog.record(inboxItemFromFoundCard(opened, "2026-09-06T12:00:00.000Z"));

    render(
      <SpecialistApp
        inbox={catalog.urgentInbox()}
        procurements={[found]}
        profiles={[profile]}
        activeProfileId={profile.id}
        resolveInbox={async () => ({ items: [], card: opened, documents: [] })}
        decide={async () => [opened]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Открыть карточку" }));
    expect(await screen.findByRole("button", { name: "Отслеживать" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "КТПБ из входящих" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Закупки" }).className).toContain("nav-current");
  });
});
