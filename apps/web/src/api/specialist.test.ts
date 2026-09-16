import { SpecialistInboxListResponse, SpecialistSearchResponse, SpecialistWorkingProfile } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  fetchInbox,
  fetchProfile,
  saveProfile,
  searchFailureMessage,
  searchProcurements,
} from "./specialist.js";

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
        kind: "status_changed" as const,
        topic: "card_update" as const,
        topicLabel: "Карточка",
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

describe("fetchProfile", () => {
  it("loads the working profile without treating watch as already on", async () => {
    const profile = await fetchProfile(async () =>
      new Response(
        JSON.stringify(
          SpecialistWorkingProfile.parse({
            name: "Электротехническое оборудование",
            keywords: ["КТПБ"],
            excludeKeywords: [],
            watchNewProcurements: false,
          }),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(profile.watchNewProcurements).toBe(false);
    expect(profile.keywords).toEqual(["КТПБ"]);
  });
});

describe("searchProcurements", () => {
  it("posts an empty body so the server uses the domain profile, not a chat query", async () => {
    const payload = SpecialistSearchResponse.parse({
      profileName: "Электротехническое оборудование",
      relevantCount: 1,
      discardedCount: 3,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000401",
          title: "Комплектная трансформаторная подстанция",
          status: "unknown",
          statusLabel: "Прием предложений",
          url: "https://example.test/auction/001",
          sourceProcurementId: "auction-001",
        },
      ],
    });
    let method: string | undefined;
    let body: string | null | undefined;
    const result = await searchProcurements(0, async (input, init) => {
      method = typeof input === "string" ? init?.method : undefined;
      body = typeof init?.body === "string" ? init.body : null;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    expect(method).toBe("POST");
    expect(body).toBe('{"limit":200,"offset":0}');
    expect(result.relevantCount).toBe(1);
    expect(result.items[0]?.title).toBe("Комплектная трансформаторная подстанция");
  });

  it("explains a blocked live source in Russian instead of a generic failure", async () => {
    const message = await searchFailureMessage(
      new Response(JSON.stringify({ error: "source_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(message).toContain("goszakupki.by");
  });
});

describe("saveProfile", () => {
  it("writes the opened profile by id, not only the active one", async () => {
    const id = "00000000-0000-4000-8000-000000000901";
    let url: string | undefined;
    const saved = await saveProfile(
      id,
      {
        name: "Щиты",
        purpose: "",
        description: "",
        instructions: "",
        keywords: [],
        excludeKeywords: [],
      },
      async (input) => {
        url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
        return new Response(
          JSON.stringify(
            SpecialistWorkingProfile.parse({
              id,
              name: "Щиты",
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    expect(url).toBe(`/api/profiles/${id}`);
    expect(saved.name).toBe("Щиты");
  });
});
