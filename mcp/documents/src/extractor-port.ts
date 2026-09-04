import type {
  DocumentsExtractTablesResponse,
  DocumentsExtractTextResponse,
} from "@procurement/contracts";

export interface DocumentExtractorPort {
  extractText(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<DocumentsExtractTextResponse>;
  extractTables(
    hash: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<DocumentsExtractTablesResponse>;
  ocr(hash: string, bytes: Uint8Array, contentType: string): Promise<DocumentsExtractTextResponse>;
}
