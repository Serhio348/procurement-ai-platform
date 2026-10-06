import { extractUrlsFromText, type DocumentFileFormat } from "@procurement/domain";
import { extractPdfLinkAnnotations } from "./pdf-links.js";
import { unzipEntries } from "./zip-entries.js";

export interface DocumentLinkCandidate {
  url: string;
  /** True when the URL came from a deliberately placed hyperlink, not text. */
  embedded: boolean;
}

/**
 * Links an attachment points at — visible URLs in the extracted text plus
 * hyperlinks hidden under display text (OOXML relationships, PDF link
 * annotations). Selection and filtering stay in packages/domain.
 */
export async function collectDocumentLinks(input: {
  name: string;
  bytes: Uint8Array;
  format: DocumentFileFormat;
  text: string;
}): Promise<DocumentLinkCandidate[]> {
  const candidates: DocumentLinkCandidate[] = extractUrlsFromText(input.text).map((url) => ({
    url,
    embedded: false,
  }));
  if (input.format === "docx" || input.format === "xlsx" || input.format === "pptx") {
    candidates.push(...officeHyperlinkTargets(input.bytes));
  }
  if (input.format === "pdf") {
    try {
      const urls = await extractPdfLinkAnnotations(input.bytes);
      candidates.push(...urls.map((url) => ({ url, embedded: true })));
    } catch {
      // Annotation pass is best-effort; the text pass above still applies.
    }
  }
  return candidates;
}

/**
 * OOXML stores click-targets in `dir/_rels/name.xml.rels` files — the URL under a
 * «Скачать документацию» label never appears in the visible text.
 */
export function officeHyperlinkTargets(bytes: Uint8Array): DocumentLinkCandidate[] {
  let files: Map<string, Uint8Array>;
  try {
    files = unzipEntries(bytes);
  } catch {
    return [];
  }
  const decoder = new TextDecoder("utf-8");
  const candidates: DocumentLinkCandidate[] = [];
  for (const [name, data] of files) {
    if (!/(^|\/)_rels\/.+\.rels$/i.test(name.replaceAll("\\", "/"))) continue;
    const xml = decoder.decode(data);
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/Type="[^"]*\/hyperlink"/i.test(tag)) continue;
      const target = tag.match(/\bTarget="([^"]*)"/i)?.[1];
      if (target === undefined || !/^https?:\/\//i.test(target)) continue;
      candidates.push({ url: target, embedded: true });
    }
  }
  return candidates;
}
