import { describe, expect, it } from "vitest";
import { assessDocumentPages, pageSafeForCommercialFacts } from "./text-quality.js";

describe("assessDocumentPages", () => {
  it("treats a digital layer with real sentences as extracted text", () => {
    const assessed = assessDocumentPages(
      [{ text: "Техническое задание на поставку комплектной трансформаторной подстанции. Аванс 30 процентов по договору поставки оборудования.", ocrApplied: false, confidence: 1 }],
      false,
    );
    expect(assessed.status).toBe("extracted");
    expect(assessed.kind).toBe("digital_text");
    expect(assessed.notes.some((note) => note.includes("цифрового слоя"))).toBe(true);
  });

  it("does not promote a noisy drawing OCR into commercial facts", () => {
    const page = {
      text: "МИНСЕЛЬХОЗПРОД РЕСПУБЛИКИ БЕЛАРУСЬ Строительный проект Электроснабжение",
      ocrApplied: true,
      confidence: 0.47,
    };
    const assessed = assessDocumentPages([page], true);
    expect(assessed.status).toBe("ocr_low_confidence");
    expect(assessed.kind).toBe("ocr_scan");
    expect(pageSafeForCommercialFacts(page)).toBe(false);
  });

  it("asks for OCR when the PDF has no letters and OCR was not run", () => {
    const assessed = assessDocumentPages([{ text: "", ocrApplied: false, confidence: 0 }], false);
    expect(assessed.status).toBe("ocr_required");
    expect(assessed.kind).toBe("sparse_drawing");
  });
});
