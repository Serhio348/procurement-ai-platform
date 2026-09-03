import { SearchClassifierInput } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDomainSearchAgent } from "../agents/domain-search/factory.js";
import { OpenAiCompatibleSearchClassifier } from "./openai-compatible-search-classifier.js";

describe("OpenAiCompatibleSearchClassifier", () => {
  it("posts JSON-mode chat completions without putting the API key in the prompt", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
        response_format: { type: string };
      };
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(body.messages)).not.toContain("secret-key");
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "relevant",
                confidence: 0.8,
                reason: "ok",
              }),
            },
          },
        ],
      });
    });

    const model = new OpenAiCompatibleSearchClassifier({
      apiKey: "secret-key",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    await expect(model.classify(minimalInput())).resolves.toEqual({
      verdict: "relevant",
      confidence: 0.8,
      reason: "ok",
    });
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });
});

describe("createDomainSearchAgent", () => {
  it("refuses to start without an API key", () => {
    expect(() =>
      createDomainSearchAgent({
        environment: {},
        caller: { callTool: async () => ({ structuredContent: { hits: [] } }) },
      }),
    ).toThrow(/LLM_API_KEY/);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
  });
}

function minimalInput() {
  return SearchClassifierInput.parse({
    profile: {
      name: "Электротехническое оборудование",
      purpose: "Находить КТПБ",
      instructions: "",
      keywords: ["КТПБ"],
      excludeKeywords: [],
      semanticConcepts: [],
      positiveCriteria: [],
      negativeCriteria: [],
    },
    hit: {
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/1",
      url: "https://goszakupki.by/auction/view/1",
      title: "Поставка распределительного устройства",
    },
  });
}
