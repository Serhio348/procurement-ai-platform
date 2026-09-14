import { z } from "zod";
import {
  SearchIntentParserInput,
  type SearchIntentPlan,
} from "@procurement/contracts";
import {
  inferSearchIntentPlan,
  parseSearchIntentPlan,
  SEARCH_INTENT_SYSTEM_PROMPT,
} from "@procurement/domain";

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

export interface SearchIntentPort {
  plan: (profile: {
    name: string;
    keywords: readonly string[];
    excludeKeywords: readonly string[];
  }) => Promise<SearchIntentPlan>;
}

export interface OpenAiCompatibleSearchIntentOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Profile phrase → SearchIntentPlan. Any score field in the JSON is dropped
 * before parse; ranking stays in packages/domain.
 */
export function createOpenAiCompatibleSearchIntent(
  options: OpenAiCompatibleSearchIntentOptions,
): SearchIntentPort {
  if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
  const endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
  const model = options.model ?? "deepseek-chat";
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cache = new Map<string, SearchIntentPlan>();

  return {
    async plan(profile) {
      const input = SearchIntentParserInput.parse({
        name: profile.name,
        keywords: [...profile.keywords],
        excludeKeywords: [...profile.excludeKeywords],
      });
      const cacheKey = JSON.stringify(input);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const fallback = inferSearchIntentPlan(input);
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
            { role: "system", content: SEARCH_INTENT_SYSTEM_PROMPT },
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
      if (content === undefined) throw new Error("LLM API response has no intent plan");
      const parsed = parseSearchIntentPlan(JSON.parse(content) as unknown);
      const plan = parsed ?? fallback;
      cache.set(cacheKey, plan);
      return plan;
    },
  };
}

export function createSearchIntentFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): SearchIntentPort | undefined {
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) return undefined;
  if (environment["SEARCH_INTENT"] === "off") return undefined;
  const timeoutRaw = environment["SEARCH_INTENT_TIMEOUT_MS"] ?? environment["LLM_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
  return createOpenAiCompatibleSearchIntent({
    apiKey,
    ...(environment["LLM_BASE_URL"] === undefined ? {} : { baseUrl: environment["LLM_BASE_URL"] }),
    ...(environment["SEARCH_INTENT_MODEL"] === undefined
      ? environment["LLM_MODEL"] === undefined
        ? {}
        : { model: environment["LLM_MODEL"] }
      : { model: environment["SEARCH_INTENT_MODEL"] }),
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
