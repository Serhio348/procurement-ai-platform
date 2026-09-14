import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpecialistProcurementCard, SpecialistWorkingProfile } from "@procurement/contracts";
import { inboxItemFromFoundCard, SpecialistCatalog } from "@procurement/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStoredSearchIds,
  SEARCH_IDS_STORAGE_KEY,
  SpecialistApp,
  writeStoredSearchIds,
} from "./SpecialistApp.js";

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

describe("stored search ids", () => {
  it("ignores corrupt storage instead of throwing", () => {
    window.localStorage.setItem(SEARCH_IDS_STORAGE_KEY, "{not json");
    expect(readStoredSearchIds()).toEqual({});
    window.localStorage.setItem(SEARCH_IDS_STORAGE_KEY, JSON.stringify({ a: [1, 2], b: ["x"] }));
    expect(readStoredSearchIds()).toEqual({ b: ["x"] });
  });

  it("round-trips per profile", () => {
    writeStoredSearchIds({ [profile.id]: [found.id] });
    expect(readStoredSearchIds()).toEqual({ [profile.id]: [found.id] });
  });

  it("keeps last-search ids in a per-user namespace", () => {
    writeStoredSearchIds({ [profile.id]: [found.id] }, "user-a");
    writeStoredSearchIds({ [profile.id]: [stale.id] }, "user-b");
    expect(readStoredSearchIds("user-a")).toEqual({ [profile.id]: [found.id] });
    expect(readStoredSearchIds("user-b")).toEqual({ [profile.id]: [stale.id] });
    expect(readStoredSearchIds()).toEqual({});
  });
});

describe("SpecialistApp search persistence", () => {
  it("shows only the last search result after a full remount (page reload)", async () => {
    const user = userEvent.setup();
    const props = {
      inbox: [],
      procurements: [stale, found],
      profiles: [profile],
      activeProfileId: profile.id,
      search: async () => ({
        profileName: profile.name,
        relevantCount: 1,
        discardedCount: 0,
        items: [found],
      }),
    };

    const first = render(<SpecialistApp {...props} />);
    expect(screen.getByRole("button", { name: /Старая из базы/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Искать по профилю" }));
    expect(screen.queryByRole("button", { name: /Старая из базы/ })).toBeNull();
    first.unmount();

    render(<SpecialistApp {...props} />);
    expect(screen.getByRole("button", { name: /Найденная поиском/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Старая из базы/ })).toBeNull();
  });

  it("keeps a watched case out of Закупки", () => {
    const watching = SpecialistProcurementCard.parse({ ...found, triage: "monitor" });
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[watching, stale]}
        profiles={[profile]}
        activeProfileId={profile.id}
      />,
    );
    expect(screen.queryByRole("button", { name: /Найденная поиском/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Старая из базы/ })).toBeTruthy();
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
    writeStoredSearchIds({ [profile.id]: [found.id] });

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
