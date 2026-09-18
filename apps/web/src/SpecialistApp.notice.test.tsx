import { act, cleanup, render, screen } from "@testing-library/react";
import {
  SpecialistProcurementCard,
  SpecialistWorkingProfile,
} from "@procurement/contracts";
import { inboxItemFromWatchChange, SpecialistCatalog } from "@procurement/domain";
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

function deadlineEntry(current: string, cardId = card.id) {
  const catalog = new SpecialistCatalog();
  const item = SpecialistProcurementCard.parse({ ...card, id: cardId });
  catalog.upsertCase(item);
  catalog.record(
    inboxItemFromWatchChange(
      item,
      {
        kind: "deadline_changed",
        field: "bidsDeadline",
        previous: "2026-09-19",
        current,
      },
      "2026-09-18T08:00:00.000Z",
    ),
  );
  return catalog.urgentInbox();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SpecialistApp deadline notices", () => {
  it("stays silent about deadline rows that were already in the inbox", () => {
    render(
      <SpecialistApp
        inbox={deadlineEntry("срок подачи истёк")}
        procurements={[card]}
        profiles={[profile]}
        activeProfileId={profile.id}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("raises a toast when a deadline warning arrives through the inbox poll", async () => {
    const entries = deadlineEntry("срок подачи истекает завтра");
    const refreshInbox = vi.fn().mockResolvedValue(entries);
    render(
      <SpecialistApp
        inbox={[]}
        procurements={[card]}
        profiles={[profile]}
        activeProfileId={profile.id}
        refreshInbox={refreshInbox}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const toasts = screen.getAllByRole("alert");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toContain("Поставка КТП");
    expect(toasts[0]?.textContent).toContain("истекает завтра");
  });

  it("does not re-toast the same row on the next poll", async () => {
    const entries = deadlineEntry("срок подачи истёк");
    const refreshInbox = vi.fn().mockResolvedValue(entries);
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
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    // Second poll sees the same row: the notice is already dismissed by its
    // own timer and must not be raised again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an expired deadline distinctly from a day-ahead warning", async () => {
    const entries = [
      ...deadlineEntry("срок подачи истёк"),
      ...deadlineEntry(
        "срок подачи истекает завтра",
        "00000000-0000-4000-8000-000000000502",
      ),
    ];
    const refreshInbox = vi.fn().mockResolvedValue(entries);
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
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const toasts = screen.getAllByRole("alert");
    expect(toasts).toHaveLength(2);
    const text = toasts.map((toast) => toast.textContent ?? "").join("\n");
    expect(text).toContain("истёк");
    expect(text).toContain("истекает завтра");
  });
});
