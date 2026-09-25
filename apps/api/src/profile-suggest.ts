import { z } from "zod";
import { ProcedureStatus, type ProcedureStatus as ProcedureStatusValue } from "@procurement/contracts";

const ChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

/**
 * Lenient parse of model output: a broken field degrades to its default
 * instead of failing the whole suggestion.
 */
const ModelDraft = z.object({
  name: z.string().max(200).catch(""),
  purpose: z.string().max(4000).catch(""),
  keywords: z.array(z.string().min(1).max(200)).catch([]),
  excludeKeywords: z.array(z.string().min(1).max(200)).catch([]),
  statuses: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = ProcedureStatus.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  excludeSingleSource: z.boolean().catch(false),
  /** Short phrases the model wants checked against the real listing. */
  probeTerms: z.array(z.string().min(1).max(200)).catch([]),
  explanation: z.string().max(4000).catch(""),
});

export interface ProfileSuggestDraft {
  name: string;
  purpose: string;
  keywords: string[];
  excludeKeywords: string[];
  statuses: ProcedureStatusValue[];
  excludeSingleSource: boolean;
  probeTerms: string[];
  explanation: string;
}

export interface ProfileSuggestPort {
  /** Free text → first draft + terms to probe on the source listing. */
  draft(text: string): Promise<ProfileSuggestDraft>;
  /** Draft + real listing titles → refined draft in the site's vocabulary. */
  refine(input: {
    text: string;
    draft: ProfileSuggestDraft;
    sampledTitles: readonly string[];
  }): Promise<ProfileSuggestDraft>;
}

export interface OpenAiCompatibleProfileSuggestOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

export function createOpenAiCompatibleProfileSuggest(
  options: OpenAiCompatibleProfileSuggestOptions,
): ProfileSuggestPort {
  if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
  const endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
  const model = options.model ?? "deepseek-chat";
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const fetchImplementation = options.fetchImplementation ?? fetch;

  async function complete(systemPrompt: string, input: unknown): Promise<unknown> {
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
    if (content === undefined) throw new Error("LLM API response has no suggestion");
    return JSON.parse(content) as unknown;
  }

  const clampDraft = (raw: unknown): ProfileSuggestDraft => {
    const parsed = ModelDraft.parse(raw ?? {});
    return {
      name: parsed.name.trim().slice(0, 200),
      purpose: parsed.purpose.trim().slice(0, 4000),
      keywords: dedupe(parsed.keywords).slice(0, 50),
      excludeKeywords: dedupe(parsed.excludeKeywords).slice(0, 50),
      statuses: parsed.statuses,
      excludeSingleSource: parsed.excludeSingleSource,
      probeTerms: dedupe(parsed.probeTerms).slice(0, 5),
      explanation: parsed.explanation.trim().slice(0, 4000),
    };
  };

  return {
    async draft(text) {
      return clampDraft(await complete(DRAFT_PROMPT, { text }));
    },
    async refine(input) {
      if (input.sampledTitles.length === 0) return input.draft;
      const refined = clampDraft(
        await complete(REFINE_PROMPT, {
          text: input.text,
          draft: input.draft,
          sampledTitles: [...input.sampledTitles],
        }),
      );
      // The probe may only sharpen words, never empty a working draft.
      return {
        ...refined,
        keywords: refined.keywords.length > 0 ? refined.keywords : input.draft.keywords,
        probeTerms: input.draft.probeTerms,
      };
    },
  };
}

export function createProfileSuggestFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): ProfileSuggestPort | undefined {
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) return undefined;
  const timeoutRaw = environment["LLM_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? Number.NaN : Number.parseInt(timeoutRaw, 10);
  return createOpenAiCompatibleProfileSuggest({
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

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (item.length === 0 || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

const DRAFT_PROMPT = [
  "Ты помогаешь специалисту по закупкам составить профиль поиска на goszakupki.by.",
  "На вход — свободный текст о том, что компания поставляет или делает, и чего не делает.",
  "Верни только один JSON-объект без markdown:",
  '{ "name": "", "purpose": "", "keywords": [], "excludeKeywords": [], "statuses": [], "excludeSingleSource": false, "probeTerms": [], "explanation": "" }.',
  "name — короткое название направления, до 80 символов.",
  "purpose — одно-два предложения: что именно ищет профиль и что не нужно. Этот текст читает проверка релевантности.",
  "keywords — 3–10 поисковых фраз: товарные термины, аббревиатуры и их расшифровки (КТП и «комплектная трансформаторная подстанция» — две разные строки выдачи).",
  "excludeKeywords — только то, что специалист явно отверг в тексте; не выдумывай исключения.",
  'statuses — из списка: "accepting_bids", "bidding_closed", "auction_in_progress", "under_review", "completed", "cancelled", "failed", "unknown". Если не сказано иначе — ["accepting_bids"].',
  "excludeSingleSource — true, только если специалист явно не хочет закупки из единственного источника.",
  "probeTerms — до 3 самых вероятных фраз из keywords, по которым стоит проверить реальную выдачу площадки.",
  "explanation — одно предложение по-русски: как понял направление.",
  "Никогда не предлагай следить за профилем и не выдумывай номера, цены и регионы.",
].join("\n");

const REFINE_PROMPT = [
  "Ты уточняешь профиль поиска закупок по реальной выдаче goszakupki.by.",
  "На вход JSON: { text, draft, sampledTitles } — описание специалиста, первый черновик и реальные заголовки процедур с площадки.",
  "Верни только один JSON-объект без markdown в той же схеме, что пришёл в draft.",
  "Подправь keywords под лексику заголовков: добавь синонимы и формулировки, которыми заказчики реально пишут предмет (например «КТП киоскового типа»), убери фразы, по которым выдача пустая или совсем чужая.",
  "По заголовкам, которые явно не про направление, добавь термины в excludeKeywords — но только если такой мусор реально виден в sampledTitles.",
  "probeTerms оставь как были.",
  "explanation — одно-два предложения: сколько заголовков посмотрел и что уточнил.",
].join("\n");
