import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import { inboxItemFromFoundCard, SpecialistCatalog } from "@procurement/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  foundAs: "match",
  relevanceReason: "В лотах есть комплектная трансформаторная подстанция.",
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

  it("opening a foreign profile's inbox case does not claim it for the active profile", async () => {
    window.history.pushState({}, "", "/");
    const user = userEvent.setup();
    const other = SpecialistWorkingProfile.parse({
      id: "00000000-0000-4000-8000-000000000902",
      name: "Кабели",
    });
    const opened = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Чужая закупка из входящих",
      status: "announced",
      statusLabel: "объявлена",
      url: "https://goszakupki.by/auction/view/402",
      sourceProcurementId: "auction/402",
      foundAs: "review",
      profileIds: [other.id],
    });
    const catalog = new SpecialistCatalog();
    catalog.upsertCase(opened);
    catalog.record(inboxItemFromFoundCard(opened, "2026-09-06T12:00:00.000Z"));

    render(
      <SpecialistApp
        inbox={catalog.urgentInbox()}
        procurements={[found]}
        profiles={[profile, other]}
        activeProfileId={profile.id}
        resolveInbox={async () => ({ items: [], card: opened, documents: [] })}
        decide={async () => [opened]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Открыть карточку" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Чужая закупка из входящих" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Закупки" }));
    // The active profile's queue shows only its own cards; the foreign
    // candidate keeps its origin profile instead of being claimed.
    expect(screen.queryByRole("button", { name: /Чужая закупка из входящих/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Найденная поиском/ })).toBeTruthy();
  });

  it("restores the stored search queue on mount without running a search", async () => {
    const queued = SpecialistProcurementCard.parse({
      ...found,
      id: "00000000-0000-4000-8000-000000000777",
      title: "Из сохранённой очереди",
      sourceProcurementId: "request/777",
    });
    const search = vi.fn();
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[]}
        profiles={[profile]}
        activeProfileId={profile.id}
        search={search}
        listMine={async () => [queued]}
      />,
    );

    expect(await screen.findByRole("button", { name: /Из сохранённой очереди/ })).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it("resumes polling a still-running search after a page reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const run = {
        profileId: profile.id,
        profileName: profile.name,
        status: "scoring" as const,
        retrievedCount: 5,
        scoredCount: 2,
        matchCount: 1,
        discardedCount: 0,
        reviewCount: 0,
        listingDiscardedCount: 0,
        skipped: [],
      };
      const searchProgress = vi.fn().mockResolvedValue(run);
      render(
        <SpecialistApp
          inbox={[]}
          procurements={[]}
          profiles={[profile]}
          activeProfileId={profile.id}
          listMine={async () => []}
          searchProgress={searchProgress}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(searchProgress).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(searchProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
