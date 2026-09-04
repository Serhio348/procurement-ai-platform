import type { ExtractionStatus } from "@procurement/contracts";
import { ocrNeedsHuman } from "./ocr-gate.js";

export const COMMERCIAL_OCR_MIN_CONFIDENCE = 0.6;

export type PdfTextKind =
  | "digital_text"
  | "office_text"
  | "ocr_scan"
  | "skipped_project"
  | "sparse_drawing"
  | "empty"
  | "non_pdf";

export interface AssessedPage {
  text: string;
  ocrApplied: boolean;
  confidence: number;
}

export interface DocumentTextAssessment {
  status: ExtractionStatus;
  kind: PdfTextKind;
  confidence: number;
  letterCount: number;
  notes: string[];
}

const SPARSE_LETTERS = 12;

export function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

export function cyrillicCount(text: string): number {
  return (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
}

export function pageIsSparse(text: string): boolean {
  return letterCount(text) < SPARSE_LETTERS;
}

export function pageSafeForCommercialFacts(page: AssessedPage): boolean {
  if (pageIsSparse(page.text)) return false;
  if (page.ocrApplied && ocrNeedsHuman(page.confidence, COMMERCIAL_OCR_MIN_CONFIDENCE)) {
    return false;
  }
  return true;
}

export function assessDocumentPages(
  pages: readonly AssessedPage[],
  ocrAttempted: boolean,
): DocumentTextAssessment {
  if (pages.length === 0) {
    return {
      status: "ocr_required",
      kind: "empty",
      confidence: 0,
      letterCount: 0,
      notes: ["В файле нет страниц для распознавания."],
    };
  }
  const letters = pages.reduce((sum, page) => sum + letterCount(page.text), 0);
  const ocrPages = pages.filter((page) => page.ocrApplied);
  const meanConfidence =
    pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length;
  const allSparse = pages.every((page) => pageIsSparse(page.text));
  const digitalLetters = pages
    .filter((page) => !page.ocrApplied)
    .reduce((sum, page) => sum + letterCount(page.text), 0);

  if (ocrPages.length === 0 && !allSparse) {
    return {
      status: "extracted",
      kind: "digital_text",
      confidence: Math.min(0.98, 0.7 + Math.min(digitalLetters, 400) / 2000),
      letterCount: letters,
      notes: ["Текст взят из цифрового слоя PDF, OCR не применялся."],
    };
  }

  if (ocrPages.length > 0 && !allSparse) {
    const ocrConfidence =
      ocrPages.reduce((sum, page) => sum + page.confidence, 0) / ocrPages.length;
    const status: ExtractionStatus = ocrNeedsHuman(ocrConfidence, COMMERCIAL_OCR_MIN_CONFIDENCE)
      ? "ocr_low_confidence"
      : "extracted";
    const notes = [
      "Текстового слоя не было или его мало — страница разобрана как изображение (OCR).",
    ];
    if (status === "ocr_low_confidence") {
      notes.push(
        "Уверенность OCR ниже порога: текст показываем специалисту, в коммерческие факты не берём.",
      );
    }
    return {
      status,
      kind: "ocr_scan",
      confidence: ocrConfidence,
      letterCount: letters,
      notes,
    };
  }

  if (allSparse && ocrAttempted) {
    return {
      status: "ocr_low_confidence",
      kind: "sparse_drawing",
      confidence: meanConfidence,
      letterCount: letters,
      notes: [
        "OCR почти не нашёл букв. Похоже на чертёж или плохой скан — нужен просмотр файла.",
      ],
    };
  }

  return {
    status: "ocr_required",
    kind: "sparse_drawing",
    confidence: 0,
    letterCount: letters,
    notes: [
      "Текстового слоя нет. Это скан или чертёж — без OCR текст не извлечь.",
    ],
  };
}
