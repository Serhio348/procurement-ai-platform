import { CommercialExtractorInput } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createCommercialReaderFromEnv,
  createOpenAiCompatibleCommercialReader,
} from "./commercial-reader.js";

const HASH = "e".repeat(64);

const input = CommercialExtractorInput.parse({
  pages: [
    {
      hash: HASH,
      name: "ТЗ.pdf",
      page: 3,
      text: "Аванс 30% в течение 10 банковских дней после подписания договора.",
    },
  ],
});

function jsonReply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createOpenAiCompatibleCommercialReader", () => {
  it("asks in JSON mode without leaking the key into the prompt", async () => {
    const fetchImplementation = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonReply({ choices: [{ message: { content: '{"claims":[]}' } }] }),
    );
    const reader = createOpenAiCompatibleCommercialReader({
      apiKey: "secret-key",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
    });

    const answer = await reader.read(input);

    expect(answer).toEqual({ claims: [] });
    const body = JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)) as {
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_object");
    expect(body.messages[0]?.content).toContain("дословный фрагмент");
    expect(JSON.stringify(body.messages)).not.toContain("secret-key");
  });

  it("fails loudly on an HTTP error instead of returning empty claims", async () => {
    const reader = createOpenAiCompatibleCommercialReader({
      apiKey: "secret-key",
      fetchImplementation: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });

    await expect(reader.read(input)).rejects.toThrow(/HTTP 500/);
  });
});

describe("createCommercialReaderFromEnv", () => {
  it("stays off without a key and can be switched off with a key present", () => {
    expect(createCommercialReaderFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      createCommercialReaderFromEnv({
        LLM_API_KEY: "secret-key",
        COMMERCIAL_READER: "off",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      createCommercialReaderFromEnv({ LLM_API_KEY: "secret-key" } as NodeJS.ProcessEnv),
    ).toBeDefined();
  });
});
