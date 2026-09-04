import { DeepSeekVisionOcrEngine } from "./deepseek-vision-ocr.js";
import { FallbackOcrEngine } from "./fallback-ocr.js";
import type { OcrEngine } from "./ocr-port.js";
import { TesseractOcrEngine } from "./tesseract-ocr.js";

export interface DocumentScanEngine {
  ocr: OcrEngine;
  usesVision: boolean;
  close: () => Promise<void>;
}

export function createDocumentScanEngine(
  environment: NodeJS.ProcessEnv = process.env,
): DocumentScanEngine {
  const tesseract = new TesseractOcrEngine();
  const apiKey = environment["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) {
    return {
      ocr: tesseract,
      usesVision: false,
      close: () => tesseract.close(),
    };
  }
  const timeoutRaw = environment["LLM_VISION_TIMEOUT_MS"];
  const timeoutMs = timeoutRaw === undefined ? undefined : Number.parseInt(timeoutRaw, 10);
  const vision = new DeepSeekVisionOcrEngine({
    apiKey,
    ...(environment["LLM_BASE_URL"] === undefined ? {} : { baseUrl: environment["LLM_BASE_URL"] }),
    ...(environment["LLM_VISION_MODEL"] === undefined
      ? {}
      : { model: environment["LLM_VISION_MODEL"] }),
    ...(timeoutMs === undefined || !Number.isFinite(timeoutMs) ? {} : { timeoutMs }),
  });
  return {
    ocr: new FallbackOcrEngine(vision, tesseract),
    usesVision: true,
    close: () => tesseract.close(),
  };
}
