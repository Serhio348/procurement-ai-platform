import type { McpToolCaller } from "@procurement/mcp-client";
import type { Logger } from "@procurement/observability";
import { OpenAiCompatibleSearchClassifier } from "../../llm/openai-compatible-search-classifier.js";
import { DomainSearchAgent } from "./agent.js";
import type { SearchClassifierPort } from "./model-port.js";

export interface DomainSearchEnvironment {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: string;
}

export interface CreateDomainSearchAgentOptions {
  environment: DomainSearchEnvironment;
  caller: McpToolCaller;
  logger?: Logger;
  fetchImplementation?: typeof fetch;
  model?: SearchClassifierPort;
}

export function createDomainSearchAgent(
  options: CreateDomainSearchAgentOptions,
): DomainSearchAgent {
  const model =
    options.model ??
    new OpenAiCompatibleSearchClassifier({
      apiKey: requiredKey(options.environment.LLM_API_KEY),
      timeoutMs: positiveNumber(options.environment.LLM_TIMEOUT_MS, 45_000, "LLM_TIMEOUT_MS"),
      ...(options.environment.LLM_BASE_URL === undefined
        ? {}
        : { baseUrl: options.environment.LLM_BASE_URL }),
      ...(options.environment.LLM_MODEL === undefined
        ? {}
        : { model: options.environment.LLM_MODEL }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
  return new DomainSearchAgent({
    caller: options.caller,
    model,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

function requiredKey(apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("LLM_API_KEY is required");
  }
  return apiKey;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
