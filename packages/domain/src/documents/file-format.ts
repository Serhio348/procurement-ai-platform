export const DOCUMENT_FILE_FORMATS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "jpeg",
  "png",
  "tiff",
  "rtf",
  "zip",
  "rar",
  "7z",
  "unknown",
] as const;

export type DocumentFileFormat = (typeof DOCUMENT_FILE_FORMATS)[number];

export type DocumentContainer =
  | "pdf"
  | "zip"
  | "rar"
  | "7z"
  | "ole"
  | "jpeg"
  | "png"
  | "tiff"
  | "rtf"
  | "unknown";

export interface DetectDocumentFormatInput {
  bytes: Uint8Array;
  name?: string;
  contentType?: string;
  zipFamily?: "docx" | "xlsx" | "pptx";
}

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47] as const;

export function sniffDocumentContainer(bytes: Uint8Array): DocumentContainer {
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return "zip";
  }
  if (bytes.length >= 8 && OLE.every((value, index) => bytes[index] === value)) return "ole";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 4 && PNG.every((value, index) => bytes[index] === value)) return "png";
  if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a))) {
    return "tiff";
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "{\\rtf") return "rtf";
  // RAR4 «Rar!\x1A\x07\x00» and RAR5 «Rar!\x1A\x07\x01\x00».
  if (
    bytes.length >= 7 &&
    ascii(bytes, 0, 4) === "Rar!" &&
    bytes[4] === 0x1a &&
    bytes[5] === 0x07 &&
    (bytes[6] === 0x00 || bytes[6] === 0x01)
  ) {
    return "rar";
  }
  // 7z magic «7z\xBC\xAF\x27\x1C».
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x37 &&
    bytes[1] === 0x7a &&
    bytes[2] === 0xbc &&
    bytes[3] === 0xaf &&
    bytes[4] === 0x27 &&
    bytes[5] === 0x1c
  ) {
    return "7z";
  }
  return "unknown";
}

export function formatFromFileName(name: string): DocumentFileFormat | undefined {
  const base = name.split(/[?#]/)[0] ?? name;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = base.slice(dot + 1).toLowerCase();
  const mapped: Record<string, DocumentFileFormat> = {
    pdf: "pdf",
    docx: "docx",
    xlsx: "xlsx",
    pptx: "pptx",
    doc: "doc",
    xls: "xls",
    ppt: "ppt",
    jpeg: "jpeg",
    jpg: "jpeg",
    png: "png",
    tif: "tiff",
    tiff: "tiff",
    rtf: "rtf",
    zip: "zip",
    rar: "rar",
    "7z": "7z",
  };
  return mapped[extension];
}

export function formatFromContentType(contentType: string): DocumentFileFormat | undefined {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.includes("pdf")) return "pdf";
  if (type.includes("wordprocessingml") || type.endsWith("docx")) return "docx";
  if (type.includes("spreadsheetml") || type.endsWith("xlsx")) return "xlsx";
  if (type.includes("presentationml") || type.endsWith("pptx")) return "pptx";
  if (type === "application/msword") return "doc";
  if (type.includes("ms-excel") && !type.includes("openxml")) return "xls";
  if (type.includes("ms-powerpoint") && !type.includes("openxml")) return "ppt";
  if (type === "image/jpeg") return "jpeg";
  if (type === "image/png") return "png";
  if (type === "image/tiff") return "tiff";
  if (type === "application/rtf" || type === "text/rtf") return "rtf";
  if (type === "application/zip" || type === "application/x-zip-compressed") return "zip";
  if (type === "application/vnd.rar" || type === "application/x-rar-compressed") return "rar";
  if (type === "application/x-7z-compressed") return "7z";
  return undefined;
}

/**
 * Bytes win over a lying Content-Type. Zip subtype comes from Open XML parts
 * when provided, otherwise from the filename.
 */
export function detectDocumentFormat(input: DetectDocumentFormatInput): DocumentFileFormat {
  const container = sniffDocumentContainer(input.bytes);
  if (container === "pdf") return "pdf";
  if (container === "jpeg") return "jpeg";
  if (container === "png") return "png";
  if (container === "tiff") return "tiff";
  if (container === "rtf") return "rtf";
  if (container === "zip") {
    if (input.zipFamily !== undefined) return input.zipFamily;
    const named = namedOfficeXml(input);
    return named ?? "zip";
  }
  if (container === "rar") return "rar";
  if (container === "7z") return "7z";
  if (container === "ole") {
    const named = formatFromFileName(input.name ?? "") ?? formatFromContentType(input.contentType ?? "");
    if (named === "doc" || named === "xls" || named === "ppt") return named;
    return "doc";
  }
  return (
    formatFromFileName(input.name ?? "") ??
    formatFromContentType(input.contentType ?? "") ??
    "unknown"
  );
}

/**
 * A download endpoint answered with an HTML page (preview stub, expired
 * session, anti-bot) instead of the binary file. A listed .html document
 * is real content, not a stub, so the name is consulted first.
 */
export function looksLikeHtmlPage(
  bytes: Uint8Array,
  contentType: string,
  name = "",
): boolean {
  const base = name.split(/[?#]/)[0] ?? "";
  const extension = base.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "html" || extension === "htm") return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return true;
  // Skip a UTF-8 BOM before reading the page head.
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = ascii(bytes, start, Math.min(bytes.length - start, 512))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

export function formatNeedsRasterScan(format: DocumentFileFormat): boolean {
  return format === "pdf" || format === "jpeg" || format === "png" || format === "tiff";
}

export function formatHasNativeText(format: DocumentFileFormat): boolean {
  return (
    format === "pdf" ||
    format === "docx" ||
    format === "xlsx" ||
    format === "pptx" ||
    format === "doc" ||
    format === "rtf"
  );
}

export function officeFormatLabel(format: DocumentFileFormat): string | undefined {
  switch (format) {
    case "docx":
      return "Word";
    case "xlsx":
      return "Excel";
    case "pptx":
      return "PowerPoint";
    case "doc":
      return "Word (.doc)";
    case "xls":
      return "Excel (.xls)";
    case "ppt":
      return "PowerPoint (.ppt)";
    default:
      return undefined;
  }
}

function namedOfficeXml(input: DetectDocumentFormatInput): "docx" | "xlsx" | "pptx" | undefined {
  const named = formatFromFileName(input.name ?? "") ?? formatFromContentType(input.contentType ?? "");
  if (named === "docx" || named === "xlsx" || named === "pptx") return named;
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const code = bytes[start + index];
    if (code === undefined) break;
    text += String.fromCharCode(code);
  }
  return text;
}
