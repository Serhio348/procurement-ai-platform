import { CommercialExtractorInput } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCommercialTermsAgent } from "../agents/commercial-terms/factory.js";
import { OpenAiCompatibleCommercialExtractor } from "./openai-compatible-commercial-extractor.js";

describe("OpenAiCompatibleCommercialExtractor", () => {
  it("posts JSON-mode chat completions without putting the API key in the prompt", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
        response_format: { type: string };
      };
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(body.messages)).not.toContain("secret-key");
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ claims: [] }) } }],
      });
    });

    const model = new OpenAiCompatibleCommercialExtractor({
      apiKey: "secret-key",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    await expect(model.extract(minimalInput())).resolves.toEqual({ claims: [] });
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });
});

describe("createCommercialTermsAgent", () => {
  it("refuses to start without an API key", () => {
    expect(() =>
      createCommercialTermsAgent({
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
  return CommercialExtractorInput.parse({
    pages: [
      {
        hash: "a".repeat(64),
        name: "spec.pdf",
        page: 1,
        text: "Оплата после поставки.",
      },
    ],
  });
}
