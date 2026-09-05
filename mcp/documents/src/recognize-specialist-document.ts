import {
  SpecialistDocumentExtraction,
  type SpecialistDocumentExtraction as SpecialistDocumentExtractionValue,
} from "@procurement/contracts";
import { classifyAttachmentRole, shouldScanAttachment } from "@procurement/domain";
import { resolveDocumentFormat, type RoutingDocumentExtractor } from "./routing-extractor.js";
import {
  skippedProjectExtraction,
  toSpecialistExtraction,
  unscannedUnknownExtraction,
} from "./specialist-extraction.js";

export async function recognizeSpecialistDocument(input: {
  name: string;
  hash: string;
  bytes: Uint8Array;
  contentType: string;
  nativeExtractor: RoutingDocumentExtractor;
  scanExtractor: RoutingDocumentExtractor;
  usesVision: boolean;
}): Promise<SpecialistDocumentExtractionValue> {
  const format = resolveDocumentFormat(input.bytes, input.name, input.contentType);
  const native = await input.nativeExtractor.extractText(
    input.hash,
    input.bytes,
    input.contentType,
    input.name,
  );
  const role = classifyAttachmentRole({ name: input.name, digitalText: native.text });
  if (role.role === "skip_project") {
    return skippedProjectExtraction(role.reason);
  }
  if (native.status === "extracted") {
    return toSpecialistExtraction(native, input.contentType, format);
  }
  if (!shouldScanAttachment(role)) {
    return unscannedUnknownExtraction(role.reason);
  }
  const scanned = toSpecialistExtraction(
    await input.scanExtractor.extractText(input.hash, input.bytes, input.contentType, input.name),
    input.contentType,
    format,
  );
  if (scanned.status === "failed") {
    return SpecialistDocumentExtraction.parse({
      ...scanned,
      notes: [role.reason, ...scanned.notes],
    });
  }
  if (!input.usesVision || !scanned.ocrApplied) return scanned;
  return SpecialistDocumentExtraction.parse({
    ...scanned,
    notes: [...scanned.notes, "Скан прочитан DeepSeek vision, не Tesseract."],
  });
}
