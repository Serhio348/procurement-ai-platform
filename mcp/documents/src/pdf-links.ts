import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Link annotations live on pages; a hostile PDF cannot fan the scan out. */
const MAX_LINK_SCAN_PAGES = 300;

interface PdfLinkAnnotation {
  subtype?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
}

interface PdfAnnotationPage {
  getAnnotations: () => Promise<unknown[]>;
}

/**
 * URI annotations are deliberate author placements — collecting them is a
 * separate cheap pass that never feeds OCR.
 */
export async function extractPdfLinkAnnotations(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    const urls: string[] = [];
    const pageCount = Math.min(pdf.numPages, MAX_LINK_SCAN_PAGES);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = (await pdf.getPage(pageNumber)) as PdfAnnotationPage;
      const annotations = await page.getAnnotations();
      for (const raw of annotations) {
        const annotation = raw as PdfLinkAnnotation;
        if (annotation.subtype !== "Link") continue;
        const url = annotation.url ?? annotation.unsafeUrl;
        if (typeof url === "string" && url.length > 0) urls.push(url);
      }
    }
    return urls;
  } finally {
    await pdf.destroy();
  }
}
