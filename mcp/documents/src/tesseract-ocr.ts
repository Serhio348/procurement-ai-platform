import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorker, type Worker } from "tesseract.js";
import type { OcrEngine } from "./ocr-port.js";

export function defaultTessdataDirectory(): string {
  return fileURLToPath(new URL("../../../data/tessdata/", import.meta.url));
}

export class TesseractOcrEngine implements OcrEngine {
  readonly #langs: string;
  readonly #cachePath: string;
  #worker: Worker | undefined;

  constructor(options: { langs?: string; cachePath?: string } = {}) {
    this.#langs = options.langs ?? "rus+eng";
    this.#cachePath = options.cachePath ?? defaultTessdataDirectory();
  }

  async recognize(png: Uint8Array): Promise<{ text: string; confidence: number }> {
    const worker = await this.#ensureWorker();
    const result = await worker.recognize(Buffer.from(png));
    return {
      text: result.data.text.trim(),
      confidence: clamp01(result.data.confidence / 100),
    };
  }

  async close(): Promise<void> {
    if (this.#worker === undefined) return;
    await this.#worker.terminate();
    this.#worker = undefined;
  }

  async #ensureWorker(): Promise<Worker> {
    if (this.#worker !== undefined) return this.#worker;
    await mkdir(this.#cachePath, { recursive: true });
    this.#worker = await createWorker(this.#langs, 1, {
      cachePath: this.#cachePath,
      gzip: true,
      logger: () => undefined,
    });
    return this.#worker;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
