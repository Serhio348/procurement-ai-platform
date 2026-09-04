import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PdfJsDocumentExtractor } from "./pdfjs-extractor.js";

describe("PdfJsDocumentExtractor", () => {
  it("extracts a digital Latin text layer without OCR", async () => {
    const bytes = latinPdf("Avans 30 procentov");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extracted = await new PdfJsDocumentExtractor().extractText(hash, bytes, "application/pdf");
    expect(extracted.ocrApplied).toBe(false);
    expect(extracted.pages).toHaveLength(1);
    expect(extracted.pages[0]?.text).toContain("Avans 30");
  });
});

function latinPdf(text: string): Uint8Array {
  const safe = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const chunks: Buffer[] = [];
  const offsets = [0];
  const write = (chunk: string) => {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    return buf.byteLength;
  };
  let cursor = write("%PDF-1.4\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${String(Buffer.byteLength(stream))} >> stream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  for (const object of objects) {
    offsets.push(cursor);
    cursor += write(object);
  }
  const xrefStart = cursor;
  write("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i += 1) {
    write(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  write(`trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
