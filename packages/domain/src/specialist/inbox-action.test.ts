import { ChangeEvent, SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  applyInboxChangeToCard,
  inboxItemFromFoundCard,
  inboxTopic,
  inboxTopicLabel,
} from "./inbox-action.js";

describe("inbox actions", () => {
  it("routes a found procedure to the card, documents to download, status to a card refresh", () => {
    expect(inboxTopic("procedure_found")).toBe("new_found");
    expect(inboxTopicLabel("new_found")).toBe("Новая закупка");
    expect(inboxTopic("document_updated")).toBe("documents");
    expect(inboxTopic("status_changed")).toBe("card_update");
    expect(inboxTopic("price_changed")).toBe("card_update");
  });

  it("builds a durable found event so rediscovery does not duplicate the inbox row", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000401",
      title: "КТПБ",
      status: "announced",
      statusLabel: "объявлена",
      url: "https://goszakupki.by/auction/view/001",
      sourceProcurementId: "auction/001",
    });
    const first = inboxItemFromFoundCard(card, "2026-09-06T12:00:00.000Z");
    const second = inboxItemFromFoundCard(card, "2026-09-06T13:00:00.000Z");
    expect(first.change.kind).toBe("procedure_found");
    expect(first.change.id).toBe(second.change.id);
    expect(first.change.urgent).toBe(true);
  });

  it("labels a review hit as a candidate, not an urgent new procurement", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000402",
      title: "Пусконаладка котла",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/auction/view/002",
      sourceProcurementId: "auction/002",
      foundAs: "review",
    });
    const item = inboxItemFromFoundCard(card, "2026-09-06T12:00:00.000Z");
    expect(item.change.kind).toBe("procedure_candidate");
    expect(item.change.urgent).toBe(false);
    expect(inboxTopic(item.change.kind)).toBe("review");
    expect(inboxTopicLabel("review")).toBe("На проверку");
  });

  it("copies the detected status and price onto the card and does not invent an advance", () => {
    const card = SpecialistProcurementCard.parse({
      id: "00000000-0000-4000-8000-000000000020",
      title: "Поставка КТПБ",
      status: "accepting_bids",
      statusLabel: "приём предложений",
      url: "https://goszakupki.by/auction/view/001",
      sourceProcurementId: "auction/001",
    });
    const change = ChangeEvent.parse({
      id: "00000000-0000-4000-8000-000000000101",
      procurementId: card.id,
      kind: "status_changed",
      previous: "accepting_bids",
      current: "cancelled",
      detectedAt: "2026-09-03T08:15:00.000Z",
      urgent: true,
    });
    const updated = applyInboxChangeToCard(card, change);
    expect(updated.status).toBe("cancelled");
    expect(updated.statusLabel).toBe("отменена");
    expect(JSON.stringify(updated)).not.toMatch(/аванс/i);

    const priced = applyInboxChangeToCard(
      card,
      ChangeEvent.parse({
        ...change,
        id: "00000000-0000-4000-8000-000000000199",
        kind: "price_changed",
        previous: "10000",
        current: "9000",
      }),
    );
    expect(priced.amountLabel).toBe("9000");
    expect(priced.status).toBe("accepting_bids");
  });
});
