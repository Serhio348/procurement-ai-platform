import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DocumentsExtractTablesResponse,
  DocumentsExtractTextResponse,
} from "@procurement/contracts";
import { z } from "zod";
import type { DocumentExtractorPort } from "./extractor-port.js";
import { sha256Hex } from "./blob-store.js";

const CatalogFile = z.object({
  items: z.array(
    z.object({
      sourceUrl: z.string().url(),
      file: z.string().min(1),
      contentType: z.string().min(1),
      extraction: DocumentsExtractTextResponse.omit({ hash: true }).extend({
        tables: DocumentsExtractTablesResponse.shape.tables,
      }),
    }),
  ),
});

export interface FixtureDocumentItem {
  sourceUrl: string;
  contentType: string;
  bytes: Uint8Array;
  hash: string;
  extraction: z.infer<typeof CatalogFile>["items"][number]["extraction"];
}

export class FixtureDocumentCatalog implements DocumentExtractorPort {
  readonly #byUrl: ReadonlyMap<string, FixtureDocumentItem>;
  readonly #byHash: ReadonlyMap<string, FixtureDocumentItem>;

  constructor(items: readonly FixtureDocumentItem[]) {
    this.#byUrl = new Map(items.map((item) => [item.sourceUrl, item]));
    this.#byHash = new Map(items.map((item) => [item.hash, item]));
  }

  static async load(catalogPath: string): Promise<FixtureDocumentCatalog> {
    const parsed = CatalogFile.parse(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
    const root = dirname(catalogPath);
    const items: FixtureDocumentItem[] = [];
    for (const item of parsed.items) {
      const bytes = await readFile(join(root, item.file));
      items.push({
        sourceUrl: item.sourceUrl,
        contentType: item.contentType,
        bytes,
        hash: sha256Hex(bytes),
        extraction: item.extraction,
      });
    }
    return new FixtureDocumentCatalog(items);
  }

  download(sourceUrl: string): FixtureDocumentItem {
    const item = this.#byUrl.get(sourceUrl);
    if (item === undefined) {
      throw new DocumentSourceNotFoundError(sourceUrl);
    }
    return item;
  }

  async extractText(hash: string, _bytes: Uint8Array, _contentType: string): Promise<DocumentsExtractTextResponse> {
    return this.#text(hash, "extract");
  }

  async extractTables(
    hash: string,
    _bytes: Uint8Array,
    _contentType: string,
  ): Promise<DocumentsExtractTablesResponse> {
    const item = this.#item(hash);
    return DocumentsExtractTablesResponse.parse({
      hash,
      tables: item.extraction.tables,
    });
  }

  async ocr(hash: string, _bytes: Uint8Array, _contentType: string): Promise<DocumentsExtractTextResponse> {
    return this.#text(hash, "ocr");
  }

  #text(hash: string, mode: "extract" | "ocr"): DocumentsExtractTextResponse {
    const item = this.#item(hash);
    const extraction = item.extraction;
    if (mode === "extract" && extraction.ocrApplied && extraction.status !== "extracted") {
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
      status: extraction.status,
      text: extraction.text,
      pages: extraction.pages,
      ocrApplied: extraction.ocrApplied,
      confidence: extraction.confidence,
    });
  }

  #item(hash: string): FixtureDocumentItem {
    const item = this.#byHash.get(hash);
    if (item === undefined) throw new DocumentSourceNotFoundError(hash);
    return item;
  }
}

export class DocumentSourceNotFoundError extends Error {
  constructor(locator: string) {
    super(`Document source not found: ${locator}`);
    this.name = "DocumentSourceNotFoundError";
  }
}

export class DocumentTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(`Document exceeds size limit (${sizeBytes} > ${maxBytes})`);
    this.name = "DocumentTooLargeError";
  }
}
