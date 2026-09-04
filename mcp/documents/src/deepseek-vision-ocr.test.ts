import { describe, expect, it } from "vitest";
import { DeepSeekVisionOcrEngine, VISION_OCR_CONFIDENCE } from "./deepseek-vision-ocr.js";

describe("DeepSeekVisionOcrEngine", () => {
  it("sends a page PNG to the vision model and returns the transcript", async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    let body = "";
    const engine = new DeepSeekVisionOcrEngine({
      apiKey: "sk-test",
      fetchImplementation: async (input, init) => {
        expect(String(input)).toContain("/chat/completions");
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Аукционная документация. Аванс 30 процентов." } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await engine.recognize(png);

    expect(result.text).toContain("Аванс 30");
    expect(result.confidence).toBe(VISION_OCR_CONFIDENCE);
    expect(body).toContain("deepseek-v4-flash-vision-exp");
    expect(body).toContain("data:image/png;base64");
    expect(body).not.toContain("sk-test");
  });

  it("does not treat HTTP 400 as extracted text", async () => {
    const engine = new DeepSeekVisionOcrEngine({
      apiKey: "sk-test",
      fetchImplementation: async () => new Response("no vision", { status: 400 }),
    });
    await expect(engine.recognize(new Uint8Array([1]))).rejects.toThrow(/HTTP 400/);
  });
});
