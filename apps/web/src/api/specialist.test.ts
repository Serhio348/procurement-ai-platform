import { SpecialistInboxListResponse } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { fetchInbox } from "./specialist.js";

describe("fetchInbox", () => {
  it("parses the specialist inbox payload from the API", async () => {
    const items = [
      {
        id: "00000000-0000-4000-8000-000000000101",
        procurementId: "00000000-0000-4000-8000-000000000020",
        title: "Поставка КТПБ",
        status: "cancelled",
        statusLabel: "отменена",
        url: "https://goszakupki.by/auction/view/001",
        sourceProcurementId: "auction/001",
        summary: "Статус (срочно): accepting_bids → cancelled.",
        detail: "Номер: auction/001.",
        detectedOn: "2026-09-03",
        urgent: true as const,
      },
    ];
    const inbox = await fetchInbox(
      async () =>
        new Response(JSON.stringify(SpecialistInboxListResponse.parse({ items })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Поставка КТПБ");
  });
});
