import type { Logger } from "@procurement/observability";
import { OpenAiCompatibleSupervisorModel } from "../llm/openai-compatible-supervisor-model.js";
import { SupervisorPlanner } from "./supervisor.js";

export interface SupervisorEnvironment {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: string;
}

export interface CreateSupervisorOptions {
  environment: SupervisorEnvironment;
  logger?: Logger;
  fetchImplementation?: typeof fetch;
}

export function createSupervisor(options: CreateSupervisorOptions): SupervisorPlanner {
  const apiKey = options.environment.LLM_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("LLM_API_KEY is required");
  }
  const timeoutMs = positiveNumber(options.environment.LLM_TIMEOUT_MS, 45_000, "LLM_TIMEOUT_MS");
  return new SupervisorPlanner({
    model: new OpenAiCompatibleSupervisorModel({
      apiKey,
      timeoutMs,
      ...(options.environment.LLM_BASE_URL === undefined
        ? {}
        : { baseUrl: options.environment.LLM_BASE_URL }),
      ...(options.environment.LLM_MODEL === undefined
        ? {}
        : { model: options.environment.LLM_MODEL }),
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
