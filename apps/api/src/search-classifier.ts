import { z } from "zod";
import type { SearchClassifierInput } from "@procurement/contracts";
import type { SearchClassifierPort } from "./search-review.js";

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

export interface OpenAiCompatibleSearchClassifierOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Console-side twin of the agent-runtime classifier. The API may not import
 * the runtime (layer rule), so the HTTP shell lives here; verdict handling is
 * shared through packages/domain.
 */
export function createOpenAiCompatibleSearchClassifier(
  options: OpenAiCompatibleSearchClassifierOptions,
): SearchClassifierPort {
  if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
  const endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
  const model = options.model ?? "deepseek-chat";
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async classify(input: SearchClassifierInput): Promise<unknown> {
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`LLM API returned HTTP ${String(response.status)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxResponseBytes) {
        throw new Error("LLM API response exceeds configured size limit");
      }
      const envelope = ChatCompletionResponse.parse(
        JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      );
      const content = envelope.choices[0]?.message.content;
      if (content === undefined) throw new Error("LLM API response has no classification");
      return JSON.parse(content) as unknown;
    },
  };
}

export function createSearchClassifierFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): SearchClassifierPort | undefined {
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) return undefined;
  const timeoutRaw = environment["LLM_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
  return createOpenAiCompatibleSearchClassifier({
    apiKey,
    ...(environment["LLM_BASE_URL"] === undefined ? {} : { baseUrl: environment["LLM_BASE_URL"] }),
    ...(environment["LLM_MODEL"] === undefined ? {} : { model: environment["LLM_MODEL"] }),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
}

function completionEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

const systemPrompt = [
  "Ты классификатор закупок для специалиста по снабжению.",
  "Профиль описывает, какие закупки ищет компания: назначение, ключевые слова, исключения.",
  "Решай, относится ли закупка к профилю по смыслу, а не по совпадению букв: аббревиатура внутри другого слова или кода — не совпадение.",
  "Верни только один JSON-объект без markdown.",
  "JSON должен содержать: verdict (relevant|irrelevant|needs_human), confidence (0..1), reason на русском одной фразой, needDeeper (boolean), matchedTerms (массив строк).",
  "Не ставь оценку от 0 до 100 и не вычисляй score.",
  "Используй только переданный профиль, заголовок и карточку. Не выдумывай факты.",
  "Если передано поле mixedActions — в предмете закупки одновременно есть и нужное действие, и исключённое (например, поставка и монтаж). Ответь на вопрос из mixedActions.question: relevant, если основной предмет — то, что ищет профиль; irrelevant, если основной предмет — исключённое действие; needs_human, если доли сопоставимы или закупка «под ключ».",
  "Если по заголовку и карточке нельзя решить, верни needs_human.",
  "Для профиля работ: relevant только если закупка по смыслу про объекты и назначение именно этого профиля (его keywords/objects), а не из-за общих слов вроде «СМР», «строительно-монтажные», «подряд», «пусконаладка».",
  "Если совпали только общие слова работ, а предмета профиля в закупке нет — irrelevant.",
  "Если предмет профиля намечен, но объём работ неясен — needs_human.",
].join("\n");
