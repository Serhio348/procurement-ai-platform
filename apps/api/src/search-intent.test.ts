import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleSearchIntent,
  createSearchIntentFromEnv,
} from "./search-intent.js";

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const profile = {
  name: "НКУ для управления насосами",
  keywords: ["НКУ для управления насосами"],
  excludeKeywords: [] as string[],
};

describe("createOpenAiCompatibleSearchIntent", () => {
  it("asks in JSON mode and ignores a score the model tried to add", async () => {
    const fetchImplementation = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonReply({
        choices: [
          {
            message: {
              content: JSON.stringify({
                objects: ["НКУ", "шкаф управления"],
                required_context: ["насос", "насосное оборудование"],
                desired_actions: ["поставка", "изготовление"],
                excluded_actions: ["монтаж", "ремонт"],
                intent: "equipment_purchase",
                score: 88,
              }),
            },
          },
        ],
      }),
    );
    const parser = createOpenAiCompatibleSearchIntent({
      apiKey: "secret-key",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    const plan = await parser.plan(profile);

    expect(plan.objects).toEqual(["НКУ", "шкаф управления"]);
    expect(plan.required_context.some((item) => item.toLowerCase().includes("насос"))).toBe(true);
    expect(plan.desired_actions).toContain("поставка");
    expect(plan).not.toHaveProperty("score");
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.content).toContain("Не ставь score");
    expect(body.messages[0]?.content).toContain("excluded_context");
    expect(JSON.stringify(body.messages)).not.toContain("secret-key");
  });
});

describe("createSearchIntentFromEnv", () => {
  it("stays off without a key and can be switched off with a key present", () => {
    expect(createSearchIntentFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      createSearchIntentFromEnv({
        LLM_API_KEY: "secret-key",
        SEARCH_INTENT: "off",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      createSearchIntentFromEnv({ LLM_API_KEY: "secret-key" } as NodeJS.ProcessEnv),
    ).toBeDefined();
  });
});
