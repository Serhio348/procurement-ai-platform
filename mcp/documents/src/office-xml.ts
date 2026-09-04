import { DocumentsExtractTablesResponse, DocumentsExtractTextResponse, ExtractedPage, ExtractedTable } from "@procurement/contracts";
import { assessDocumentPages, type DocumentFileFormat } from "@procurement/domain";
import { unzipEntries } from "./zip-entries.js";

const PAGE_TEXT_LIMIT = 8_000;
const PREVIEW_LIMIT = 1_800;

export function inspectOpenXmlFamily(bytes: Uint8Array): "docx" | "xlsx" | "pptx" | undefined {
  const files = safeUnzip(bytes);
  if (files === undefined) return undefined;
  const names = [...files.keys()].map((name) => name.replaceAll("\\", "/").toLowerCase());
  if (names.some((name) => name.startsWith("word/"))) return "docx";
  if (names.some((name) => name.startsWith("xl/"))) return "xlsx";
  if (names.some((name) => name.startsWith("ppt/"))) return "pptx";
  return undefined;
}

export function extractOpenXml(
  hash: string,
  bytes: Uint8Array,
  format: "docx" | "xlsx" | "pptx",
): ReturnType<typeof DocumentsExtractTextResponse.parse> {
  const files = safeUnzip(bytes);
  if (files === undefined) {
    return emptyFailed(hash);
  }
  if (format === "docx") {
    const xml = readXml(files, (name) => name.startsWith("word/document.xml") || /^word\/header\d*\.xml$/.test(name) || /^word\/footer\d*\.xml$/.test(name));
    return nativeText(hash, xml.length === 0 ? [] : [xmlToText(xml.join("\n"))]);
  }
  if (format === "pptx") {
    const slides = [...files.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name.replaceAll("\\", "/")))
      .sort((left, right) => slideNumber(left) - slideNumber(right))
      .map((name) => xmlToText(decodeUtf8(files.get(name))));
    return nativeText(hash, slides.filter((text) => text.length > 0));
  }
  const strings = parseSharedStrings(readXml(files, (name) => name === "xl/sharedstrings.xml").join(""));
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name.replaceAll("\\", "/")))
    .sort()
    .map((name) => sheetToText(decodeUtf8(files.get(name)), strings));
  return nativeText(hash, sheets.filter((text) => text.length > 0));
}

export function extractOpenXmlTables(
  hash: string,
  bytes: Uint8Array,
  format: DocumentFileFormat,
): ReturnType<typeof DocumentsExtractTablesResponse.parse> {
  if (format !== "xlsx") {
    return DocumentsExtractTablesResponse.parse({ hash, tables: [] });
  }
  const files = safeUnzip(bytes);
  if (files === undefined) {
    return DocumentsExtractTablesResponse.parse({ hash, tables: [] });
  }
  const strings = parseSharedStrings(readXml(files, (name) => name === "xl/sharedstrings.xml").join(""));
  const tables: ReturnType<typeof ExtractedTable.parse>[] = [];
  const sheets = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name.replaceAll("\\", "/")))
    .sort();
  sheets.forEach((name, index) => {
    const rows = sheetToRows(decodeUtf8(files.get(name)), strings);
    if (rows.length > 0) {
      tables.push(ExtractedTable.parse({ page: index + 1, rows }));
    }
  });
  return DocumentsExtractTablesResponse.parse({ hash, tables });
}

function nativeText(
  hash: string,
  pagesText: readonly string[],
): ReturnType<typeof DocumentsExtractTextResponse.parse> {
  const pages = pagesText.map((text, index) =>
    ExtractedPage.parse({
      page: index + 1,
      text: clip(text, PAGE_TEXT_LIMIT),
      ocrApplied: false,
      confidence: 0.95,
    }),
  );
  const assessed = assessDocumentPages(pages, false);
  return DocumentsExtractTextResponse.parse({
    hash,
    status: assessed.status === "extracted" ? "extracted" : assessed.status,
    text: clip(pages.map((page) => page.text).join("\n\n"), PREVIEW_LIMIT * 4),
    pages,
    ocrApplied: false,
    confidence: assessed.confidence,
  });
}

function safeUnzip(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  try {
    const unzipped = unzipEntries(bytes);
    return new Map([...unzipped.entries()].map(([name, data]) => [name.replaceAll("\\", "/").toLowerCase(), data]));
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array | undefined): string {
  return new TextDecoder("utf-8").decode(bytes ?? new Uint8Array());
}

function readXml(files: Map<string, Uint8Array>, match: (name: string) => boolean): string[] {
  return [...files.entries()]
    .filter(([name]) => match(name))
    .map(([, data]) => decodeUtf8(data));
}

function xmlToText(xml: string): string {
  const withBreaks = xml
    .replaceAll(/<\/w:p>/gi, "\n")
    .replaceAll(/<\/a:p>/gi, "\n")
    .replaceAll(/<w:tab\/>/gi, "\t")
    .replaceAll(/<w:br\/>/gi, "\n");
  return decodeEntities(withBreaks.replaceAll(/<[^>]+>/g, " "))
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  const siBlocks = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi);
  for (const block of siBlocks) {
    const inner = block[1] ?? "";
    const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => decodeEntities(match[1] ?? ""));
    values.push(parts.join(""));
  }
  return values;
}

function sheetToRows(xml: string, strings: readonly string[]): string[][] {
  const rows: string[][] = [];
  for (const rowXml of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells: string[] = [];
    for (const cellXml of (rowXml[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      cells.push(cellValue(cellXml[1] ?? "", cellXml[2] ?? "", strings));
    }
    if (cells.some((cell) => cell.length > 0)) rows.push(cells);
  }
  return rows;
}

function sheetToText(xml: string, strings: readonly string[]): string {
  return sheetToRows(xml, strings)
    .map((row) => row.join("\t"))
    .join("\n")
    .trim();
}

function cellValue(attrs: string, inner: string, strings: readonly string[]): string {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1];
  if (type === "inlineStr") {
    return decodeEntities([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => match[1] ?? "").join(""));
  }
  const raw = inner.match(/<v>([\s\S]*?)<\/v>/i)?.[1] ?? "";
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) ? (strings[index] ?? "") : "";
  }
  return decodeEntities(raw);
}

function slideNumber(name: string): number {
  const match = name.toLowerCase().match(/slide(\d+)\.xml$/);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll(/&#(\d+);/g, (_all, code: string) => String.fromCharCode(Number(code)));
}

function emptyFailed(hash: string): ReturnType<typeof DocumentsExtractTextResponse.parse> {
  return DocumentsExtractTextResponse.parse({
    hash,
    status: "failed",
    text: "",
    pages: [],
    ocrApplied: false,
    confidence: 0,
  });
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}
