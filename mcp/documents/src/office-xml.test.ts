import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractOpenXml, inspectOpenXmlFamily } from "./office-xml.js";
import { RoutingDocumentExtractor } from "./routing-extractor.js";
import { zipEntries } from "./zip-entries.js";

const hash = createHash("sha256").update("office").digest("hex");

describe("office Open XML extract", () => {
  it("joins adjacent Word runs so split letters become words", () => {
    const bytes = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>Г</w:t></w:r><w:r><w:t>лавный</w:t></w:r><w:r><w:t xml:space="preserve"> инженер. Срок поставки не более </w:t></w:r><w:r><w:t>6</w:t></w:r><w:r><w:t>0</w:t></w:r><w:r><w:t xml:space="preserve"> календарных дней</w:t></w:r></w:p></w:document>',
    });
    const extracted = extractOpenXml(hash, bytes, "docx");
    expect(extracted.pages[0]?.text).toContain("Главный инженер");
    expect(extracted.pages[0]?.text).toContain("не более 60 календарных дней");
    expect(extracted.pages[0]?.text).not.toContain("Г лавный");
    expect(extracted.pages[0]?.text).not.toMatch(/6 0/);
  });

  it("reads Word document.xml as native text", async () => {
    const bytes = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>Аванс 30 процентов</w:t></w:r></w:p></w:document>',
    });
    expect(inspectOpenXmlFamily(bytes)).toBe("docx");
    const extracted = extractOpenXml(hash, bytes, "docx");
    expect(extracted.status).toBe("extracted");
    expect(extracted.ocrApplied).toBe(false);
    expect(extracted.pages[0]?.text).toContain("Аванс 30");
  });

  it("reads Excel shared strings and cells", () => {
    const bytes = zipEntries({
      "xl/sharedStrings.xml":
        '<?xml version="1.0"?><sst><si><t>Оплата</t></si><si><t>предоплата 40%</t></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<?xml version="1.0"?><worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
    });
    expect(inspectOpenXmlFamily(bytes)).toBe("xlsx");
    const extracted = extractOpenXml(hash, bytes, "xlsx");
    expect(extracted.text).toContain("Оплата");
    expect(extracted.text).toContain("предоплата 40%");
  });

  it("reads PowerPoint slides as separate pages", () => {
    const bytes = zipEntries({
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:t>Лот 1</a:t></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:t>Срок поставки 30 дней</a:t></a:p></p:sld>",
    });
    expect(inspectOpenXmlFamily(bytes)).toBe("pptx");
    const extracted = extractOpenXml(hash, bytes, "pptx");
    expect(extracted.pages).toHaveLength(2);
    expect(extracted.pages[1]?.text).toContain("Срок поставки");
  });
});

describe("RoutingDocumentExtractor", () => {
  it("sends a PDF to pdf.js and a docx to the Word reader", async () => {
    const extractor = new RoutingDocumentExtractor();
    const pdf = await extractor.extractText(
      hash,
      latinPdf("Avans 30"),
      "application/octet-stream",
      "tz.pdf",
    );
    expect(pdf.pages[0]?.text).toContain("Avans 30");

    const docxBytes = zipEntries({
      "word/document.xml": "<w:p><w:t>Техническое задание</w:t></w:p>",
    });
    const word = await extractor.extractText(hash, docxBytes, "application/octet-stream", "tz.docx");
    expect(word.text).toContain("Техническое задание");
    expect(word.ocrApplied).toBe(false);
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
