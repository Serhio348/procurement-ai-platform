import { describe, expect, it } from "vitest";
import {
  detectDocumentFormat,
  formatHasNativeText,
  formatNeedsRasterScan,
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
});
