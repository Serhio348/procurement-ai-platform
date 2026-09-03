import { z } from "zod";
import type { SearchClassifierInput } from "@procurement/contracts";
import type { SearchClassifierPort } from "../agents/domain-search/model-port.js";

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

export interface OpenAiCompatibleSearchClassifierOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export class OpenAiCompatibleSearchClassifier implements SearchClassifierPort {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleSearchClassifierOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
    this.#endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "deepseek-chat";
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async classify(input: SearchClassifierInput): Promise<unknown> {
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
    if (content === undefined) throw new Error("LLM API response has no classification");
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
  "Ты классификатор закупок DomainSearchAgent.",
  "Верни только один JSON-объект без markdown.",
  "JSON должен содержать: verdict (relevant|irrelevant|needs_human), confidence (0..1), reason на русском, needDeeper, matchedTerms.",
  "Не ставь оценку от 0 до 100 и не вычисляй score.",
  "Используй только переданный профиль, заголовок и карточку. Не выдумывай факты.",
  "Если по заголовку нельзя решить, верни needs_human.",
  "needDeeper=true, если нужны документы или лоты, чтобы подтвердить решение.",
].join("\n");
