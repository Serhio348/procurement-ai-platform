import { act, cleanup, render, screen } from "@testing-library/react";
import {
  SpecialistProcurementCard,
  SpecialistServiceHealth,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpecialistApp } from "./SpecialistApp.js";

const profile = SpecialistWorkingProfile.parse({
  id: "00000000-0000-4000-8000-000000000901",
  name: "Подстанции",
});

const card = SpecialistProcurementCard.parse({
  id: "00000000-0000-4000-8000-000000000501",
  title: "Поставка КТП",
  status: "accepting_bids",
  statusLabel: "приём заявок",
  url: "https://goszakupki.by/auction/view/501",
  sourceProcurementId: "auction/501",
  triage: "participate",
  profileIds: [profile.id],
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SpecialistApp poll health (R28)", () => {
  it("stays silent about one or two poll failures and flags three in a row", async () => {
    const refreshInbox = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[card]}
        profiles={[profile]}
        activeProfileId={profile.id}
        refreshInbox={refreshInbox}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refreshInbox).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/Нет связи с сервером/)).toBeTruthy();
    // Displayed data is not wiped while the connection note is on.
    expect(screen.getByRole("heading", { name: "Входящие" })).toBeTruthy();
  });

  it("clears the connection note once a poll succeeds again", async () => {
    const refreshInbox = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[card]}
        profiles={[profile]}
        activeProfileId={profile.id}
        refreshInbox={refreshInbox}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screen.getByText(/Нет связи с сервером/)).toBeTruthy();

    refreshInbox.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull();
  });
});

describe("SpecialistApp service health banner (R42)", () => {
  const degradedHealth = SpecialistServiceHealth.parse({
    ok: true,
    ready: false,
    mode: "live",
    uptimeSec: 12,
    components: {
      postgres: "failed",
      source: "live",
      objectStore: "minio",
      models: { searchIntent: true, classifier: true, commercialReader: true },
      mail: true,
    },
    degraded: ["PostgreSQL"],
  });

  it("names degraded capabilities while readiness is false and clears when ready", async () => {
    const serviceHealth = vi.fn().mockResolvedValue(degradedHealth);
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[card]}
        profiles={[profile]}
        activeProfileId={profile.id}
        serviceHealth={serviceHealth}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(serviceHealth).toHaveBeenCalled();
    expect(screen.getByText(/Сервис работает не полностью: PostgreSQL/)).toBeTruthy();

    serviceHealth.mockResolvedValue(
      SpecialistServiceHealth.parse({ ...degradedHealth, ready: true, degraded: [] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByText(/Сервис работает не полностью/)).toBeNull();
  });
});
