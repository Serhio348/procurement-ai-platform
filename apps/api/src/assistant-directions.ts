import { z } from "zod";
import {
  ASSISTANT_DIRECTION_PROMPT,
  parseAssistantDirections,
  type AssistantDirection,
} from "@procurement/domain";

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

/**
 * The model looks at what the specialist rejected and groups it into
 * directions («тепловые пункты», «пожарная сигнализация»). It only names
 * candidates: every phrase is validated against the same decision memory
 * before the cabinet hears about it.
 */
export interface AssistantDirectionPort {
  analyze: (input: {
    profileName: string;
    keywords: readonly string[];
    excludeKeywords: readonly string[];
    rejected: readonly { title: string; subject: string }[];
    accepted: readonly { title: string; subject: string }[];
  }) => Promise<AssistantDirection[]>;
}

export interface OpenAiCompatibleAssistantDirectionOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export function createOpenAiCompatibleAssistantDirection(
  options: OpenAiCompatibleAssistantDirectionOptions,
): AssistantDirectionPort {
  if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
  const endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
  const model = options.model ?? "deepseek-chat";
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async analyze(input) {
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
            { role: "system", content: ASSISTANT_DIRECTION_PROMPT },
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
      if (content === undefined) return [];
      return parseAssistantDirections(JSON.parse(content) as unknown);
    },
  };
}

export function createAssistantDirectionFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): AssistantDirectionPort | undefined {
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) return undefined;
  if (environment["ASSISTANT_DIRECTIONS"] === "off") return undefined;
  const timeoutRaw = environment["ASSISTANT_DIRECTION_TIMEOUT_MS"] ?? environment["LLM_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
  return createOpenAiCompatibleAssistantDirection({
    apiKey,
    ...(environment["LLM_BASE_URL"] === undefined ? {} : { baseUrl: environment["LLM_BASE_URL"] }),
    ...(environment["ASSISTANT_DIRECTION_MODEL"] === undefined
      ? environment["LLM_MODEL"] === undefined
        ? {}
        : { model: environment["LLM_MODEL"] }
      : { model: environment["ASSISTANT_DIRECTION_MODEL"] }),
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
