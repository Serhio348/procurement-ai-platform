import { z } from "zod";
import type { CommercialExtractorInput } from "@procurement/contracts";
import { COMMERCIAL_READER_SYSTEM_PROMPT } from "@procurement/domain";

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

/** Reads commercial conditions off already recognised pages. Verdicts stay in code. */
export interface CommercialReaderPort {
  read: (input: CommercialExtractorInput) => Promise<unknown>;
}

export interface OpenAiCompatibleCommercialReaderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Console-side twin of the agent-runtime commercial extractor. The API may not
 * import the runtime (layer rule), so only the HTTP shell lives here; every
 * claim it returns is verified against the page text in packages/domain.
 */
export function createOpenAiCompatibleCommercialReader(
  options: OpenAiCompatibleCommercialReaderOptions,
): CommercialReaderPort {
  if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
  const endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
  const model = options.model ?? "deepseek-chat";
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async read(input: CommercialExtractorInput): Promise<unknown> {
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
            { role: "system", content: COMMERCIAL_READER_SYSTEM_PROMPT },
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
      if (content === undefined) throw new Error("LLM API response has no commercial claims");
      return JSON.parse(content) as unknown;
    },
  };
}

export function createCommercialReaderFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): CommercialReaderPort | undefined {
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) return undefined;
  if (environment["COMMERCIAL_READER"] === "off") return undefined;
  const timeoutRaw = environment["COMMERCIAL_READER_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
  return createOpenAiCompatibleCommercialReader({
    apiKey,
    ...(environment["LLM_BASE_URL"] === undefined ? {} : { baseUrl: environment["LLM_BASE_URL"] }),
    ...(environment["COMMERCIAL_READER_MODEL"] === undefined
      ? environment["LLM_MODEL"] === undefined
        ? {}
        : { model: environment["LLM_MODEL"] }
      : { model: environment["COMMERCIAL_READER_MODEL"] }),
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