import { z } from "zod";
import type { OcrEngine } from "./ocr-port.js";

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

export interface DeepSeekVisionOcrEngineOptions {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

/** Vision transcript is not a PDF text layer. Keep confidence below 1. */
export const VISION_OCR_CONFIDENCE = 0.72;

export class DeepSeekVisionOcrEngine implements OcrEngine {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: DeepSeekVisionOcrEngineOptions) {
    if (options.apiKey.trim().length === 0) throw new Error("LLM_API_KEY is required");
    this.#endpoint = completionEndpoint(options.baseUrl ?? "https://api.deepseek.com");
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "deepseek-v4-flash-vision-exp";
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async recognize(png: Uint8Array): Promise<{ text: string; confidence: number }> {
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
          {
            role: "user",
            content: [
              { type: "text", text: visionPrompt },
              {
                type: "image_url",
                image_url: {
                  url: imageDataUrl(png),
                  detail: "original",
                },
              },
            ],
          },
        ],
        temperature: 0,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Vision API returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
      throw new Error("Vision API response exceeds configured size limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxResponseBytes) {
      throw new Error("Vision API response exceeds configured size limit");
    }
    const envelope = ChatCompletionResponse.parse(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
    const content = envelope.choices[0]?.message.content?.trim();
    if (content === undefined || content.length === 0) {
      throw new Error("Vision API response has no transcript");
    }
    return { text: content, confidence: VISION_OCR_CONFIDENCE };
  }
}

function imageDataUrl(bytes: Uint8Array): string {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const mime = jpeg ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function completionEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

const visionPrompt = [
  "Это скан страницы закупочной документации (извещение, техническое задание, договор, инструкция участнику).",
  "Перепиши весь читаемый текст как можно ближе к оригиналу.",
  "Не выдумывай цифры, даты и названия. Если фрагмент не читается — напиши [неразборчиво].",
  "Верни только транскрипт, без комментариев.",
].join(" ");
