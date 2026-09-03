import { describe, expect, it, vi } from "vitest";
import { createSupervisor } from "../supervisor/factory.js";
import { OpenAiCompatibleSupervisorModel } from "./openai-compatible-supervisor-model.js";

describe("OpenAiCompatibleSupervisorModel", () => {
  it("posts JSON-mode chat completions without putting the API key in the prompt", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
        response_format: { type: string };
      };
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(body.messages)).not.toContain("secret-key");
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ intentSummary: "ok" }) } }],
      });
    });

    const model = new OpenAiCompatibleSupervisorModel({
      apiKey: "secret-key",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    await expect(model.createPlan(minimalInput())).resolves.toEqual({ intentSummary: "ok" });
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer secret-key",
    );
  });

  it("fails closed on HTTP errors and truncated JSON", async () => {
    const httpError = new OpenAiCompatibleSupervisorModel({
      apiKey: "secret-key",
      fetchImplementation: (async () =>
        jsonResponse({ error: "busy" }, 503)) as unknown as typeof fetch,
    });
    await expect(httpError.createPlan(minimalInput())).rejects.toThrow(/HTTP 503/);

    const invalidJson = new OpenAiCompatibleSupervisorModel({
      apiKey: "secret-key",
      fetchImplementation: (async () =>
        jsonResponse({
          choices: [{ message: { content: "{not-json" } }],
        })) as unknown as typeof fetch,
    });
    await expect(invalidJson.createPlan(minimalInput())).rejects.toThrow();
  });
});

describe("createSupervisor", () => {
  it("refuses to start without an API key", () => {
    expect(() => createSupervisor({ environment: {} })).toThrow(/LLM_API_KEY/);
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
  return {
    requestId: "req-1",
    intents: [],
    domainProfiles: [],
    effectiveRules: [],
    availableCapabilities: [],
  };
}
