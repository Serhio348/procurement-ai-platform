import { DocumentsExtractTextResponse, ExtractedPage } from "@procurement/contracts";

/**
 * Conservative text from Word 97–2003 (.doc). The file is OLE/CFB; body text
 * is usually UTF-16LE. We harvest readable runs instead of implementing the
 * full Word FIB/piece-table parser.
 */
export function extractOleWord(
  hash: string,
  bytes: Uint8Array,
): ReturnType<typeof DocumentsExtractTextResponse.parse> {
  const text = extractOleWordText(bytes);
  if (text.length === 0) {
    return DocumentsExtractTextResponse.parse({
      hash,
      status: "failed",
      text: "",
      pages: [],
      ocrApplied: false,
      confidence: 0,
    });
  }
  const page = ExtractedPage.parse({
    page: 1,
    text,
    ocrApplied: false,
    confidence: 0.86,
  });
  return DocumentsExtractTextResponse.parse({
    hash,
    status: "extracted",
    text,
    pages: [page],
    ocrApplied: false,
    confidence: 0.86,
  });
}

export function extractOleWordText(bytes: Uint8Array): string {
  const aligned = harvestUtf16(bytes, 0);
  const shifted = harvestUtf16(bytes, 1);
  const text = aligned.length >= shifted.length ? aligned : shifted;
  return collapseBlankLines(text).slice(0, 100_000);
}

function harvestUtf16(bytes: Uint8Array, offset: number): string {
  const runs: string[] = [];
  let index = offset;
  while (index + 1 < bytes.length) {
    const code = bytes[index]! | (bytes[index + 1]! << 8);
    if (!isWordTextUnit(code)) {
      index += 2;
      continue;
    }
    let run = "";
    while (index + 1 < bytes.length) {
      const next = bytes[index]! | (bytes[index + 1]! << 8);
      if (!isWordTextUnit(next)) break;
      run += next === 0x000d || next === 0x000a ? "\n" : String.fromCharCode(next);
      index += 2;
    }
    const cleaned = run.replaceAll(/[ \t]+/g, " ").trim();
    if (isUsefulRun(cleaned)) runs.push(cleaned);
  }
  return runs.join("\n");
}

function isWordTextUnit(code: number): boolean {
  if (code === 0x0009 || code === 0x000a || code === 0x000d || code === 0x0020) return true;
  if (code >= 0x0021 && code <= 0x007e) return true;
  if (code >= 0x00a0 && code <= 0x00ff) return true;
  if (code >= 0x0400 && code <= 0x04ff) return true;
  if (code === 0x2013 || code === 0x2014 || code === 0x00ab || code === 0x00bb) return true;
  if (code === 0x2116 || code === 0x2026) return true;
  return false;
}

function isUsefulRun(text: string): boolean {
  if (text.length < 8) return false;
  let letters = 0;
  for (const char of text) {
    if (/\p{L}/u.test(char)) letters += 1;
  }
  return letters >= 4 && letters / text.length >= 0.35;
}

function collapseBlankLines(text: string): string {
  return text.replaceAll(/\n{3,}/g, "\n\n").trim();
}
