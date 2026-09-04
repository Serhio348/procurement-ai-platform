import {
  DocumentsExtractTablesResponse,
  DocumentsExtractTextResponse,
  ExtractedPage,
} from "@procurement/contracts";
import { assessDocumentPages, pageIsSparse } from "@procurement/domain";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentExtractorPort } from "./extractor-port.js";
import type { OcrEngine } from "./ocr-port.js";
import { decodedImageToPng, type PdfDecodedImage } from "./pdf-image.js";
import { reconstructPageText, type PdfTextItem } from "./pdf-layout.js";

const PAGE_TEXT_LIMIT = 8_000;
const PREVIEW_LIMIT = 1_800;

export interface PdfJsDocumentExtractorOptions {
  ocr?: OcrEngine;
  maxOcrPages?: number;
}

export class PdfJsDocumentExtractor implements DocumentExtractorPort {
  readonly #ocr: OcrEngine | undefined;
  readonly #maxOcrPages: number;

  constructor(options: PdfJsDocumentExtractorOptions = {}) {
    this.#ocr = options.ocr;
    this.#maxOcrPages = options.maxOcrPages ?? 50;
  }

  async extractText(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<ReturnType<typeof DocumentsExtractTextResponse.parse>> {
    if (!isPdf(contentType, bytes)) {
      return DocumentsExtractTextResponse.parse({
        hash,
        status: "failed",
        text: "",
        pages: [],
        ocrApplied: false,
        confidence: 0,
      });
    }
    const pdf = await getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
    try {
      const pages: ReturnType<typeof ExtractedPage.parse>[] = [];
      let ocrUsed = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = (await pdf.getPage(pageNumber)) as PdfJsPage;
        const digital = reconstructPageText(await readTextItems(page));
        if (!pageIsSparse(digital) || this.#ocr === undefined || ocrUsed >= this.#maxOcrPages) {
          pages.push(
            ExtractedPage.parse({
              page: pageNumber,
              text: clip(digital, PAGE_TEXT_LIMIT),
              ocrApplied: false,
              confidence: pageIsSparse(digital) ? 0 : 0.95,
            }),
          );
          continue;
        }
        const images = await readPageImages(page);
        if (images.length === 0) {
          pages.push(
            ExtractedPage.parse({
              page: pageNumber,
              text: clip(digital, PAGE_TEXT_LIMIT),
              ocrApplied: false,
              confidence: 0,
            }),
          );
          continue;
        }
        const ocr = await this.#ocr.recognize(decodedImageToPng(largestImage(images)));
        ocrUsed += 1;
        const text = ocr.text.length > 0 ? ocr.text : digital;
        pages.push(
          ExtractedPage.parse({
            page: pageNumber,
            text: clip(text, PAGE_TEXT_LIMIT),
            ocrApplied: true,
            confidence: ocr.confidence,
          }),
        );
      }
      const assessed = assessDocumentPages(pages, this.#ocr !== undefined);
      return DocumentsExtractTextResponse.parse({
        hash,
        status: assessed.status,
        text: clip(pages.map((page) => page.text).join("\n\n"), PREVIEW_LIMIT * 4),
        pages,
        ocrApplied: pages.some((page) => page.ocrApplied),
        confidence: assessed.confidence,
      });
    } finally {
      await pdf.destroy();
    }
  }

  async extractTables(
    hash: string,
    _bytes: Uint8Array,
    _contentType: string,
  ): Promise<ReturnType<typeof DocumentsExtractTablesResponse.parse>> {
    return DocumentsExtractTablesResponse.parse({ hash, tables: [] });
  }

  async ocr(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<ReturnType<typeof DocumentsExtractTextResponse.parse>> {
    return this.extractText(hash, bytes, contentType);
  }
}

interface PdfJsPage {
  getTextContent: () => Promise<{ items: unknown[] }>;
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  objs: { get: (name: string, callback: (value: unknown) => void) => void };
}

async function readTextItems(page: PdfJsPage): Promise<PdfTextItem[]> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    if (typeof item !== "object" || item === null) continue;
    if (!("str" in item) || !("transform" in item) || !("width" in item)) continue;
    const transform = item.transform;
    if (!Array.isArray(transform)) continue;
    const str = item.str;
    const width = item.width;
    if (typeof str !== "string" || typeof width !== "number") continue;
    items.push({
      str,
      x: typeof transform[4] === "number" ? transform[4] : 0,
      y: typeof transform[5] === "number" ? transform[5] : 0,
      width,
      height:
        Math.abs(typeof transform[3] === "number" ? transform[3] : 0) ||
        ("height" in item && typeof item.height === "number" ? item.height : 8),
      hasEOL: "hasEOL" in item && item.hasEOL === true,
    });
  }
  return items;
}

async function readPageImages(page: PdfJsPage): Promise<PdfDecodedImage[]> {
  const ops = await page.getOperatorList();
  const names: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    if (ops.fnArray[i] === OPS.paintImageXObject || ops.fnArray[i] === OPS.paintInlineImageXObject) {
      const name = (ops.argsArray[i] as unknown[])[0];
      if (typeof name === "string") names.push(name);
    }
  }
  const images: PdfDecodedImage[] = [];
  for (const name of names) {
    const img = await imageObject(page, name);
    if (img !== undefined) images.push(img);
  }
  return images;
}

function imageObject(page: PdfJsPage, name: string): Promise<PdfDecodedImage | undefined> {
  return new Promise((resolve) => {
    page.objs.get(name, (value: unknown) => {
      if (value === undefined || typeof value !== "object" || value === null) {
        resolve(undefined);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record["width"] !== "number" || typeof record["height"] !== "number") {
        resolve(undefined);
        return;
      }
      const data = record["data"];
      if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
        resolve(undefined);
        return;
      }
      resolve({
        width: record["width"],
        height: record["height"],
        kind: typeof record["kind"] === "number" ? record["kind"] : 1,
        data,
      });
    });
  });
}

function largestImage(images: readonly PdfDecodedImage[]): PdfDecodedImage {
  const first = images[0];
  if (first === undefined) throw new Error("page image list was empty");
  return images.reduce((best, image) =>
    image.width * image.height > best.width * best.height ? image : best,
  );
}

/** Unpack the largest embedded image of one page. Used by the extractor compare CLI. */
export async function pdfPageToPng(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<Uint8Array | undefined> {
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) return undefined;
    const page = (await pdf.getPage(pageNumber)) as PdfJsPage;
    const images = await readPageImages(page);
    if (images.length === 0) return undefined;
    return decodedImageToPng(largestImage(images));
  } finally {
    await pdf.destroy();
  }
}

function isPdf(contentType: string, bytes: Uint8Array): boolean {
  if (contentType.includes("pdf")) return true;
  return bytes.byteLength >= 4 && Buffer.from(bytes.slice(0, 4)).toString("latin1") === "%PDF";
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}
