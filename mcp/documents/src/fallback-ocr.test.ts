import { describe, expect, it } from "vitest";
import { FallbackOcrEngine } from "./fallback-ocr.js";
import type { OcrEngine } from "./ocr-port.js";

describe("FallbackOcrEngine", () => {
  it("uses Tesseract when vision throws", async () => {
    const primary: OcrEngine = {
      recognize: async () => {
        throw new Error("Vision API returned HTTP 400");
      },
    };
    const fallback: OcrEngine = {
      recognize: async () => ({ text: "tesseract text", confidence: 0.4 }),
    };
    const engine = new FallbackOcrEngine(primary, fallback);
    await expect(engine.recognize(new Uint8Array([1]))).resolves.toEqual({
      text: "tesseract text",
      confidence: 0.4,
    });
  });
});
