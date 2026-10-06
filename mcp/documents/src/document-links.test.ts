import { describe, expect, it, vi } from "vitest";
import { collectDocumentLinks, officeHyperlinkTargets } from "./document-links.js";
import { zipEntries } from "./zip-entries.js";

function linkDocx(target: string): Uint8Array {
  return zipEntries({
    "word/document.xml": '<w:p><w:t>Скачать документацию</w:t></w:p>',
    "word/_rels/document.xml.rels":
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  });
}

describe("officeHyperlinkTargets", () => {
  it("returns hidden hyperlink targets from docx relationships", () => {
    const candidates = officeHyperlinkTargets(linkDocx("https://cloud.beloil.by/s/STkDLdaRzEGropD"));
    expect(candidates).toEqual([
      { url: "https://cloud.beloil.by/s/STkDLdaRzEGropD", embedded: true },
    ]);
  });

  it("reads rels from headers and footers, and skips non-http targets", () => {
    const bytes = zipEntries({
      "word/document.xml": "<w:p/>",
      "word/_rels/document.xml.rels":
        '<Relationships><Relationship Type="http://x/hyperlink" Target="file:///C:/secret.txt"/><Relationship Type="http://x/hyperlink" Target="https://files.by/tz.zip"/></Relationships>',
      "word/_rels/header1.xml.rels":
        '<Relationships><Relationship Type="http://x/hyperlink" Target="https://files.by/spec.pdf"/></Relationships>',
    });
    expect(officeHyperlinkTargets(bytes).map((item) => item.url)).toEqual([
      "https://files.by/tz.zip",
      "https://files.by/spec.pdf",
    ]);
  });

  it("returns nothing for bytes that are not a zip", () => {
    expect(officeHyperlinkTargets(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe("collectDocumentLinks", () => {
  it("combines visible text urls and embedded docx hyperlinks", async () => {
    const candidates = await collectDocumentLinks({
      name: "link.docx",
      bytes: linkDocx("https://cloud.beloil.by/s/STkDLdaRzEGropD"),
      format: "docx",
      text: "Документация здесь: https://files.by/docs/tz.pdf.",
    });
    expect(candidates).toContainEqual({ url: "https://files.by/docs/tz.pdf", embedded: false });
    expect(candidates).toContainEqual({
      url: "https://cloud.beloil.by/s/STkDLdaRzEGropD",
      embedded: true,
    });
  });

  it("reads pdf link annotations", async () => {
    const candidates = await collectDocumentLinks({
      name: "spec.pdf",
      bytes: annotatedPdf("https://files.by/spec.pdf"),
      format: "pdf",
      text: "",
    });
    expect(candidates).toContainEqual({ url: "https://files.by/spec.pdf", embedded: true });
  });

  it("survives a malformed pdf during the annotation pass", async () => {
    const candidates = await collectDocumentLinks({
      name: "broken.pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      format: "pdf",
      text: "https://files.by/tz.pdf",
    });
    expect(candidates).toEqual([{ url: "https://files.by/tz.pdf", embedded: false }]);
  });
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: ({ data }: { data: Uint8Array }) => ({
    promise: (async () => {
      const marker = new TextDecoder().decode(data);
      const url = marker.match(/\/URI\s*\((https?:[^)]+)\)/)?.[1];
      return {
        numPages: 1,
        getPage: async () => ({
          getAnnotations: async () =>
            url === undefined ? [] : [{ subtype: "Link", url }],
        }),
        destroy: async () => {},
      };
    })(),
  }),
  OPS: {},
}));

function annotatedPdf(url: string): Uint8Array {
  const safe = url.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const body = [
    "%PDF-1.4",
    "1 0 obj<</Type/Page/Annots[<</Subtype/Link/A<</Type/Action/S/URI/URI(" + safe + ")>>>>]>>endobj",
    "trailer<</Root 2 0 R>>",
    "%%EOF",
  ].join("\n");
  return new TextEncoder().encode(body);
}
