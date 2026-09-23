import {
  SpecialistDocumentExtraction,
  type DocumentsExtractTextResponse,
} from "@procurement/contracts";
import { assessDocumentPages, officeFormatLabel, type DocumentFileFormat } from "@procurement/domain";
import { unsupportedFormatNote } from "./routing-extractor.js";

export function toSpecialistExtraction(
  extracted: DocumentsExtractTextResponse,
  contentType: string,
  format: DocumentFileFormat = "unknown",
): ReturnType<typeof SpecialistDocumentExtraction.parse> {
  void contentType;
  if (extracted.status === "failed") {
    return SpecialistDocumentExtraction.parse({
      status: "failed",
      kind: "non_pdf",
      pageCount: 0,
      letterCount: 0,
      confidence: 0,
      ocrApplied: false,
      textPreview: "",
      pages: [],
      notes: [unsupportedFormatNote(format)],
    });
  }
  const assessed = assessDocumentPages(extracted.pages, extracted.ocrApplied);
  const office = officeFormatLabel(format);
  const kind =
    (format === "docx" || format === "xlsx" || format === "pptx" || format === "doc") &&
    assessed.kind === "digital_text"
      ? "office_text"
      : assessed.kind;
  const notes =
    office !== undefined && kind === "office_text"
      ? [`Текст взят из ${office}, без OCR.`]
      : assessed.notes;
  return SpecialistDocumentExtraction.parse({
    status: extracted.status,
    kind,
    pageCount: extracted.pages.length,
    letterCount: assessed.letterCount,
    confidence: extracted.confidence,
    ocrApplied: extracted.ocrApplied,
    textPreview: extracted.text.slice(0, 1_800),
    pages: extracted.pages,
    notes,
  });
}

export function archiveContainerExtraction(
  memberCount: number,
  error?: string,
): ReturnType<typeof SpecialistDocumentExtraction.parse> {
  return SpecialistDocumentExtraction.parse({
    status: "extracted",
    kind: "archive",
    pageCount: 0,
    letterCount: 0,
    confidence: 1,
    ocrApplied: false,
    textPreview: "",
    pages: [],
    notes: [
      error !== undefined
        ? `Архив скачан, но не открылся: ${error}`
        : memberCount === 0
          ? "Архив скачан, внутри не удалось разобрать файлы."
          : `Архив: внутри ${String(memberCount)} файл(ов), разобраны отдельно.`,
    ],
  });
}

export function skippedProjectExtraction(
  reason: string,
): ReturnType<typeof SpecialistDocumentExtraction.parse> {
  return SpecialistDocumentExtraction.parse({
    status: "skipped_project",
    kind: "skipped_project",
    pageCount: 0,
    letterCount: 0,
    confidence: 1,
    ocrApplied: false,
    textPreview: "",
    pages: [],
    notes: [reason],
  });
}

export function unscannedUnknownExtraction(
  reason: string,
): ReturnType<typeof SpecialistDocumentExtraction.parse> {
  return SpecialistDocumentExtraction.parse({
    status: "ocr_required",
    kind: "sparse_drawing",
    pageCount: 0,
    letterCount: 0,
    confidence: 0,
    ocrApplied: false,
    textPreview: "",
    pages: [],
    notes: [reason],
  });
}
