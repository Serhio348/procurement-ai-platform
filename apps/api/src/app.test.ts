import { SpecialistCatalog } from "@procurement/domain";
import { describe, expect, it } from "vitest";
import { buildSpecialistApi } from "./app.js";
import { loadFixtureCatalog } from "./load-fixture.js";

describe("specialist API", () => {
  it("lists seeded urgent inbox items without the non-urgent household panel", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const response = await app.inject({ method: "GET", url: "/api/inbox" });
    const body = JSON.parse(response.body) as { items: Array<{ title: string }> };

    expect(response.statusCode).toBe(200);
    expect(body.items.map((item) => item.title)).toEqual([
      "Поставка КТПБ",
      "НКУ и щитовое оборудование",
    ]);

    await app.close();
  });

  it("shows a newly posted urgent change on the next inbox read", async () => {
    const app = await buildSpecialistApi({ catalog: new SpecialistCatalog() });
    const event = {
      procurement: {
        title: "Поставка КТПБ",
        status: "cancelled",
        url: "https://goszakupki.by/auction/view/001",
        sourceProcurementId: "auction/001",
      },
      change: {
        id: "00000000-0000-4000-8000-000000000201",
        procurementId: "00000000-0000-4000-8000-000000000020",
        kind: "status_changed",
        previous: "accepting_bids",
        current: "cancelled",
        detectedAt: "2026-09-03T11:00:00.000Z",
        urgent: true,
      },
    };

    const created = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });
    const listed = await app.inject({ method: "GET", url: "/api/inbox" });
    const duplicate = await app.inject({ method: "POST", url: "/api/inbox/events", payload: event });

    expect(created.statusCode).toBe(201);
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).items).toHaveLength(1);
    expect(JSON.parse(listed.body).items[0]?.title).toBe("Поставка КТПБ");
    expect(duplicate.statusCode).toBe(200);

    await app.close();
  });

  it("lists procurement cases including a non-urgent latest change", async () => {
    const app = await buildSpecialistApi({ catalog: await loadFixtureCatalog() });

    const list = await app.inject({ method: "GET", url: "/api/procurements" });
    const card = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000022",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/procurements/00000000-0000-4000-8000-000000000099",
    });

    expect(JSON.parse(list.body).items).toHaveLength(3);
    expect(card.statusCode).toBe(200);
    expect(JSON.parse(card.body).title).toBe("Бытовой щиток");
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
