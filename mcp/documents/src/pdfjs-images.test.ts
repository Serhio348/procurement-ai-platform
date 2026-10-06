import { afterEach, describe, expect, it, vi } from "vitest";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PdfJsDocumentExtractor } from "./pdfjs-extractor.js";

const { loadDocument } = vi.hoisted(() => ({ loadDocument: vi.fn() }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getDocument: loadDocument,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function imagePage(name: string, available = true) {
  const image = { width: 1, height: 1, kind: 2, data: new Uint8Array([255, 255, 255]) };
  const local = vi.fn((id: string, callback: (value: unknown) => void) => {
    if (available && !id.startsWith("g_")) callback(image);
  });
  const common = vi.fn((id: string, callback: (value: unknown) => void) => {
    if (available && id.startsWith("g_")) callback(image);
  });
  const destroy = vi.fn(async () => undefined);
  loadDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        getOperatorList: async () => ({ fnArray: [OPS.paintImageXObject], argsArray: [[name]] }),
        objs: { get: local },
        commonObjs: { get: common },
      }),
      destroy,
    }),
  });
  return { local, common, destroy };
}

const bytes = new TextEncoder().encode("%PDF-1.4");
const hash = "0".repeat(64);

describe("PDF image object pools", () => {
  it.each(["img_p0_1", "g_d0_img_p19_1"])("reads %s from its owning pool", async (name) => {
    vi.useFakeTimers();
    const pools = imagePage(name);
    const recognize = vi.fn(async () => ({ text: "Срок оплаты составляет 30 календарных дней", confidence: 1 }));
    const result = new PdfJsDocumentExtractor({ ocr: { recognize } }).extractText(hash, bytes, "application/pdf");
    const outcome = Promise.race([
      result.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 100)),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe("finished");
    expect(recognize).toHaveBeenCalledOnce();
    expect(name.startsWith("g_") ? pools.common : pools.local).toHaveBeenCalledOnce();
    expect(name.startsWith("g_") ? pools.local : pools.common).not.toHaveBeenCalled();
    expect(pools.destroy).toHaveBeenCalledOnce();
  });

  it("fails and destroys the PDF if an image never becomes available", async () => {
    vi.useFakeTimers();
    const pools = imagePage("img_missing", false);
    const result = new PdfJsDocumentExtractor({ ocr: { recognize: vi.fn() } })
      .extractText(hash, bytes, "application/pdf");
    const rejection = expect(result).rejects.toThrow(/изображени.*PDF/i);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    expect(pools.destroy).toHaveBeenCalledOnce();
  }, 1000);
});
