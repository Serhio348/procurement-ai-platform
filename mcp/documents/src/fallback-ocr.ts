import type { OcrEngine } from "./ocr-port.js";

export class FallbackOcrEngine implements OcrEngine {
  readonly #primary: OcrEngine;
  readonly #fallback: OcrEngine;

  constructor(primary: OcrEngine, fallback: OcrEngine) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async recognize(png: Uint8Array): Promise<{ text: string; confidence: number }> {
    try {
      return await this.#primary.recognize(png);
    } catch {
      return this.#fallback.recognize(png);
    }
  }
}
