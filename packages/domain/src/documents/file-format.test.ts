import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  formatHasNativeText,
  formatNeedsRasterScan,
  looksLikeHtmlPage,
  sniffDocumentContainer,
} from "./file-format.js";

describe("detectDocumentFormat", () => {
  it("trusts PDF magic even when the name says Word", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 rest");
    expect(detectDocumentFormat({ bytes, name: "tz.docx" })).toBe("pdf");
    expect(sniffDocumentContainer(bytes)).toBe("pdf");
  });

  it("uses Open XML family for a zip when the inner parts are known", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectDocumentFormat({ bytes: zip, name: "file.bin", zipFamily: "xlsx" })).toBe("xlsx");
    expect(detectDocumentFormat({ bytes: zip, name: "tz.docx" })).toBe("docx");
    expect(detectDocumentFormat({ bytes: zip, name: "auction.pptx" })).toBe("pptx");
    expect(detectDocumentFormat({ bytes: zip, name: "pack.zip" })).toBe("zip");
  });

  it("picks JPEG/PNG from magic, not from Content-Type", () => {
    expect(detectDocumentFormat({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), contentType: "application/pdf" })).toBe(
      "jpeg",
    );
    expect(detectDocumentFormat({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), name: "a.bin" })).toBe("png");
  });

  it("routes native office text away from raster OCR", () => {
    expect(formatHasNativeText("docx")).toBe(true);
    expect(formatHasNativeText("xlsx")).toBe(true);
    expect(formatHasNativeText("pptx")).toBe(true);
    expect(formatHasNativeText("doc")).toBe(true);
    expect(formatNeedsRasterScan("docx")).toBe(false);
    expect(formatNeedsRasterScan("pdf")).toBe(true);
    expect(formatNeedsRasterScan("jpeg")).toBe(true);
  });

  it("detects RAR4/RAR5 and 7z by magic bytes and by name", () => {
    const rar4 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    const rar5 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    const sevenZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    expect(sniffDocumentContainer(rar4)).toBe("rar");
    expect(sniffDocumentContainer(rar5)).toBe("rar");
    expect(sniffDocumentContainer(sevenZ)).toBe("7z");
    expect(detectDocumentFormat({ bytes: rar4, name: "pack.bin" })).toBe("rar");
    expect(detectDocumentFormat({ bytes: sevenZ, name: "pack.bin" })).toBe("7z");
    // No magic — filename and Content-Type still identify the container.
    const stub = new Uint8Array([1, 2, 3]);
    expect(detectDocumentFormat({ bytes: stub, name: "docs.rar" })).toBe("rar");
    expect(
      detectDocumentFormat({ bytes: stub, contentType: "application/x-7z-compressed" }),
    ).toBe("7z");
  });
});

describe("looksLikeHtmlPage", () => {
  it("flags a page answered instead of a binary file", () => {
    const page = new TextEncoder().encode("  <!DOCTYPE html><html><body></body></html>");
    expect(looksLikeHtmlPage(page, "application/zip", "pack.zip")).toBe(true);
    expect(looksLikeHtmlPage(new Uint8Array([1, 2]), "text/html", "pack.zip")).toBe(true);
  });

  it("lets a real file and a listed html document through", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(looksLikeHtmlPage(zip, "application/zip", "pack.zip")).toBe(false);
    const html = new TextEncoder().encode("<html><body>doc</body></html>");
    expect(looksLikeHtmlPage(html, "text/html", "instructions.html")).toBe(false);
  });
});
