import {
  DocumentsExtractTablesResponse,
  DocumentsExtractTextResponse,
  ExtractedPage,
} from "@procurement/contracts";
import {
  detectDocumentFormat,
  officeFormatLabel,
  type DocumentFileFormat,
} from "@procurement/domain";
import type { DocumentExtractorPort } from "./extractor-port.js";
import type { OcrEngine } from "./ocr-port.js";
import { extractOleWord } from "./ole-word.js";
import { extractOpenXml, extractOpenXmlTables, inspectOpenXmlFamily } from "./office-xml.js";
import { PdfJsDocumentExtractor } from "./pdfjs-extractor.js";

export interface RoutingDocumentExtractorOptions {
  ocr?: OcrEngine;
  maxOcrPages?: number;
}

export function resolveDocumentFormat(
  bytes: Uint8Array,
  name = "",
  contentType = "application/octet-stream",
): DocumentFileFormat {
  const containerHint = detectDocumentFormat({ bytes, name, contentType });
  if (containerHint === "docx" || containerHint === "xlsx" || containerHint === "pptx") {
    return containerHint;
  }
  const zipFamily = inspectOpenXmlFamily(bytes);
  return detectDocumentFormat({
    bytes,
    name,
    contentType,
    ...(zipFamily === undefined ? {} : { zipFamily }),
  });
}

export class RoutingDocumentExtractor implements DocumentExtractorPort {
  readonly #pdf: PdfJsDocumentExtractor;
  readonly #ocr: OcrEngine | undefined;

  constructor(options: RoutingDocumentExtractorOptions = {}) {
    this.#pdf = new PdfJsDocumentExtractor({
      ...(options.ocr === undefined ? {} : { ocr: options.ocr }),
      ...(options.maxOcrPages === undefined ? {} : { maxOcrPages: options.maxOcrPages }),
    });
    this.#ocr = options.ocr;
  }

  async extractText(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
    name = "",
  ): Promise<ReturnType<typeof DocumentsExtractTextResponse.parse>> {
    const format = resolveDocumentFormat(bytes, name, contentType);
    if (format === "pdf") {
      return this.#pdf.extractText(hash, bytes, "application/pdf");
    }
    if (format === "docx" || format === "xlsx" || format === "pptx") {
      return extractOpenXml(hash, bytes, format);
    }
    if (format === "doc") {
      return extractOleWord(hash, bytes);
    }
    if ((format === "jpeg" || format === "png") && this.#ocr !== undefined) {
      const ocr = await this.#ocr.recognize(bytes);
      const page = ExtractedPage.parse({
        page: 1,
        text: ocr.text,
        ocrApplied: true,
        confidence: ocr.confidence,
      });
      return DocumentsExtractTextResponse.parse({
        hash,
        status: ocr.text.length === 0 ? "ocr_low_confidence" : "extracted",
        text: ocr.text,
        pages: [page],
        ocrApplied: true,
        confidence: ocr.confidence,
      });
    }
    if (format === "jpeg" || format === "png" || format === "tiff") {
      return DocumentsExtractTextResponse.parse({
        hash,
        status: "ocr_required",
        text: "",
        pages: [],
        ocrApplied: false,
        confidence: 0,
      });
    }
    return DocumentsExtractTextResponse.parse({
      hash,
      status: "failed",
      text: "",
      pages: [],
      ocrApplied: false,
      confidence: 0,
    });
  }

  async extractTables(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
    name = "",
  ): Promise<ReturnType<typeof DocumentsExtractTablesResponse.parse>> {
    const format = resolveDocumentFormat(bytes, name, contentType);
    if (format === "xlsx") return extractOpenXmlTables(hash, bytes, format);
    if (format === "pdf") return this.#pdf.extractTables(hash, bytes, "application/pdf");
    return DocumentsExtractTablesResponse.parse({ hash, tables: [] });
  }

  async ocr(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
    name = "",
  ): Promise<ReturnType<typeof DocumentsExtractTextResponse.parse>> {
    return this.extractText(hash, bytes, contentType, name);
  }
}

export function unsupportedFormatNote(format: DocumentFileFormat): string {
  const office = officeFormatLabel(format);
  if (office !== undefined && (format === "xls" || format === "ppt")) {
    return `Формат ${office}: старый OLE, этот конвейер читает xlsx/pptx.`;
  }
  if (format === "unknown") {
    return "Формат файла не опознан — подходящий инструмент не выбран.";
  }
  if (format === "zip") {
    return "ZIP-архив: файлы внутри разбираются отдельно.";
  }
  return `Формат ${format} этим конвейером не читается.`;
}
