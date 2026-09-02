import { z } from "zod";
import type {
  SupervisorModelInput,
  SupervisorModelPort,
} from "../supervisor/model-port.js";

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

export interface OpenAiCompatibleSupervisorModelOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export class OpenAiCompatibleSupervisorModel implements SupervisorModelPort {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleSupervisorModelOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
    this.#endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "deepseek-chat";
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async createPlan(input: SupervisorModelInput): Promise<unknown> {
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
    if (content === undefined) throw new Error("LLM API response has no plan");
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
  "Ты Supervisor автономной платформы закупок.",
  "Верни только один JSON-объект без markdown.",
  "JSON должен содержать: intentSummary, selectedDomainProfileIds, steps, needsHuman, humanQuestion при needsHuman=true, confidence.",
  "Каждый steps item содержит capability, reason и при необходимости domainProfileId или procurementId.",
  "Используй только переданные идентификаторы, профили и capabilities.",
  "Supervisor только планирует: не ищет закупки, не читает документы, не вызывает инструменты и не вычисляет score.",
  "Все независимые intents должны сохраниться в плане.",
  "Если профиль или область задачи неоднозначны, верни needsHuman=true, пустые steps и вопрос на русском.",
  "Для domain_search, commercial_terms, risk_analysis и monitoring всегда указывай domainProfileId.",
  "Для действий над конкретной закупкой указывай procurementId.",
  "Причины и вопросы формулируй на русском языке.",
].join("\n");
