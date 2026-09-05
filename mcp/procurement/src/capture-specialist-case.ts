import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProcedureCard,
  SearchHit,
  SearchQuery,
  SourceProcurementId,
  SpecialistCaseDocument,
  SpecialistLiveRun,
  electricalEquipmentSeedV1,
  type SpecialistCaseDocument as SpecialistCaseDocumentValue,
  type SpecialistLiveRun as SpecialistLiveRunValue,
} from "@procurement/contracts";
import { classifyAttachmentRole } from "@procurement/domain";
import { createLogger } from "@procurement/observability";
import {
  createDocumentScanEngine,
  recognizeSpecialistDocument,
  resolveDocumentFormat,
  RoutingDocumentExtractor,
  toSpecialistExtraction,
} from "@procurement/mcp-documents";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";

const keyword = electricalEquipmentSeedV1.keywords[0] ?? "КТПБ";
const outputPath = fileURLToPath(
  new URL("../../../tests/fixtures/specialist/live-run.json", import.meta.url),
);

const blobDirectory = fileURLToPath(new URL("../../../data/blobs/", import.meta.url));
const logger = createLogger({
  level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
  sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uuidFromHex(hex: string): string {
  const h = hex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function firstSearchHit(source: GoszakupkiBySource): Promise<ReturnType<typeof SearchHit.parse>> {
  const search = await source.search(
    SearchQuery.parse({
      sourceId: "goszakupki_by",
      keywords: [keyword],
      limit: 1,
    }),
  );
  const hit = search.hits[0];
  if (hit === undefined) {
    throw new Error(`Живой поиск по «${keyword}» не вернул процедур.`);
  }
  return hit;
}

function searchHitFromCard(card: ReturnType<typeof ProcedureCard.parse>): ReturnType<typeof SearchHit.parse> {
  return SearchHit.parse({
    sourceId: card.sourceId,
    sourceProcurementId: card.sourceProcurementId,
    url: card.url,
    title: card.title,
    pageFamily: card.pageFamily,
    ...(card.sourceStatus === undefined ? {} : { sourceStatus: card.sourceStatus }),
    ...(card.buyer?.name === undefined ? {} : { buyerName: card.buyer.name }),
    ...(card.startingPrice === undefined ? {} : { startingPrice: card.startingPrice }),
    ...(card.amount === undefined ? {} : { amount: card.amount }),
    ...(card.publishedAt === undefined ? {} : { publishedAt: card.publishedAt }),
    ...(card.bidsDeadline === undefined ? {} : { bidsDeadline: card.bidsDeadline }),
  });
}

function cardText(card: ReturnType<typeof ProcedureCard.parse>): string {
  return [
    card.title,
    card.sourceStatus,
    card.buyer?.name,
    ...card.lots.flatMap((lot) => [lot.title, lot.paymentTermsRaw, lot.deliveryTerm, lot.contractSecurity]),
    ...Object.values(card.rawFields),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
}

async function main(): Promise<void> {
  await loadDotEnv(fileURLToPath(new URL("../../../.env", import.meta.url)));
  if (process.env["REFRESH_LIVE_OFFICE"] === "1") {
    await refreshOfficeFromBlobs();
    return;
  }
  const client = new GoszakupkiHttpClient({
    timeoutMs: 45_000,
    requestsPerMinute: 30,
    maxResponseBytes: 25 * 1024 * 1024,
  });
  const source = new GoszakupkiBySource({ client });
  const pinnedId = process.env["LIVE_CASE_SOURCE_ID"];
  let hit;
  let card;
  if (pinnedId === undefined || pinnedId.length === 0) {
    hit = await firstSearchHit(source);
    card = ProcedureCard.parse(await source.get(hit.sourceProcurementId));
  } else {
    card = ProcedureCard.parse(await source.get(SourceProcurementId.parse(pinnedId)));
    hit = searchHitFromCard(card);
  }
  const listed = await source.getDocuments(hit.sourceProcurementId);
  const documents: SpecialistCaseDocumentValue[] = [];
  await mkdir(blobDirectory, { recursive: true });
  const scan = createDocumentScanEngine();
  const nativeExtractor = new RoutingDocumentExtractor();
  const scanExtractor = new RoutingDocumentExtractor({
    ocr: scan.ocr,
    maxOcrPages: Number.parseInt(process.env["DOCUMENT_OCR_MAX_PAGES"] ?? "20", 10),
  });
  try {
    for (const document of listed.documents) {
      const downloadUrl = document.downloadUrl;
      if (downloadUrl === undefined) {
        documents.push(
          SpecialistCaseDocument.parse({
            name: document.name,
            sourceUrl: document.sourceUrl,
            status: "discovered",
            note: "Нет downloadUrl.",
          }),
        );
        continue;
      }
      const requestPath = `${new URL(downloadUrl).pathname}${new URL(downloadUrl).search}`;
      try {
        const file = await client.download(requestPath);
        const hash = sha256(file.bytes);
        await writeFile(path.join(blobDirectory, hash), file.bytes);
        const contentType = file.contentType ?? "application/octet-stream";
        let extraction;
        try {
          extraction = await recognizeSpecialistDocument({
            name: document.name,
            hash,
            bytes: file.bytes,
            contentType,
            nativeExtractor,
            scanExtractor,
            usesVision: scan.usesVision,
          });
          logger.info("Recognized specialist document", {
            name: document.name,
            hash,
            role: classifyAttachmentRole({ name: document.name }).role,
            format: resolveDocumentFormat(file.bytes, document.name, contentType),
            status: extraction.status,
            kind: extraction.kind,
            pageCount: extraction.pageCount,
            ocrApplied: extraction.ocrApplied,
            confidence: extraction.confidence,
          });
        } catch (error) {
          logger.error("Document recognition failed", error, { name: document.name, hash });
        }
        documents.push(
          SpecialistCaseDocument.parse({
            name: document.name,
            sourceUrl: document.sourceUrl,
            downloadUrl,
            hash,
            sizeBytes: file.bytes.byteLength,
            status: "hashed",
            note: contentType,
            ...(extraction === undefined ? {} : { extraction }),
          }),
        );
      } catch (error) {
        documents.push(
          SpecialistCaseDocument.parse({
            name: document.name,
            sourceUrl: document.sourceUrl,
            downloadUrl,
            status: "download_failed",
            note: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  } finally {
    await scan.close();
  }

  const text = cardText(card);
  const run = SpecialistLiveRun.parse({
    capturedAt: new Date().toISOString(),
    profileName: electricalEquipmentSeedV1.name,
    keywords: electricalEquipmentSeedV1.keywords,
    procurementId: uuidFromHex(sha256(`goszakupki_by:${hit.sourceProcurementId}`)),
    hit,
    card,
    cardText: text.length > 0 ? text : card.title,
    cardTextHash: sha256(text.length > 0 ? text : card.title),
    documents,
  });
  await writeFile(outputPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  logger.info("Captured live specialist case", {
    outputPath,
    title: card.title,
    sourceProcurementId: card.sourceProcurementId,
    documentCount: documents.length,
    blobDirectory,
  });
}

async function refreshOfficeFromBlobs(): Promise<void> {
  const raw = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
  const run = SpecialistLiveRun.parse(raw);
  const extractor = new RoutingDocumentExtractor();
  const documents: SpecialistCaseDocumentValue[] = [];
  for (const document of run.documents) {
    const hash = document.hash;
    if (hash === undefined || document.extraction?.kind !== "office_text") {
      documents.push(document);
      continue;
    }
    const bytes = await readFile(path.join(blobDirectory, hash));
    const contentType = document.note ?? "application/octet-stream";
    const native = await extractor.extractText(hash, bytes, contentType, document.name);
    const format = resolveDocumentFormat(bytes, document.name, contentType);
    const extraction = toSpecialistExtraction(native, contentType, format);
    documents.push(SpecialistCaseDocument.parse({ ...document, extraction }));
    logger.info("Refreshed office extraction", {
      name: document.name,
      hash,
      textLength: native.pages[0]?.text.length ?? 0,
    });
  }
  const next: SpecialistLiveRunValue = SpecialistLiveRun.parse({ ...run, documents });
  await writeFile(outputPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  logger.info("Refreshed Word/Excel/PowerPoint text in live specialist case", { outputPath });
}

async function loadDotEnv(envPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

await main();
