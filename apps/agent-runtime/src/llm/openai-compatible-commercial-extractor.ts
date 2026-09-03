import { z } from "zod";
import type { CommercialExtractorInput } from "@procurement/contracts";
import type { CommercialExtractorPort } from "../agents/commercial-terms/model-port.js";

const ChatCompletionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().min(1),
        }),
      }),
    )
    .min(1),
});

export interface OpenAiCompatibleCommercialExtractorOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export class OpenAiCompatibleCommercialExtractor implements CommercialExtractorPort {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleCommercialExtractorOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
    this.#endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "deepseek-chat";
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async extract(input: CommercialExtractorInput): Promise<unknown> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM API returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
      throw new Error("LLM API response exceeds configured size limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxResponseBytes) {
      throw new Error("LLM API response exceeds configured size limit");
    }
    const envelope = ChatCompletionResponse.parse(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
    const content = envelope.choices[0]?.message.content;
    if (content === undefined) throw new Error("LLM API response has no commercial claims");
    return JSON.parse(content) as unknown;
  }
}

function completionEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

const systemPrompt = [
  "Ты извлекаешь коммерческие условия CommercialTermsAgent.",
  "Верни только один JSON-объект без markdown: { \"claims\": [...] }.",
  "Каждый claim: key, value, unit при необходимости, confidence (0..1), hash, page, quote.",
  "key только из: commercial.advance_percent, commercial.payment_kind, commercial.final_payment_percent, commercial.payment_deadline_days, commercial.delivery_period_days, commercial.warranty_months, commercial.price, commercial.bid_security, commercial.contract_security, commercial.penalties.",
  "quote — дословный фрагмент со страницы, не пересказ.",
  "Не выдумывай условия, которых нет в тексте.",
  "Не ставь оценку от 0 до 100 и не вычисляй score.",
].join("\n");
