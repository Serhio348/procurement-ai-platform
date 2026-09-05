import {
  ProcedureCard,
  ProcurementGetChangesResponse,
  ProcurementGetDocumentsResponse,
  ProcurementGetHistoryResponse,
  ProcurementGetLotsResponse,
  ProcurementGetStatusResponse,
  ProcurementSearchResponse,
  SourceId,
  SourceChange,
  SourceClarification,
  SourceDocument,
  type IsoDateTime,
  type ProcurementFileBytes,
  type ProcurementSourcePort,
  type SearchHit,
  type SearchQuery,
  type SourceProcurementId,
} from "@procurement/contracts";
import { z } from "zod";
import { SourceRecordNotFoundError } from "./source-registry.js";

export const FixtureRecord = z.object({
  card: ProcedureCard,
  documents: z.array(SourceDocument).default([]),
  history: z.array(SourceClarification).default([]),
  changes: z.array(SourceChange).default([]),
});
export type FixtureRecord = z.infer<typeof FixtureRecord>;

export const ProcurementFixtureDataset = z
  .object({
    sourceId: SourceId,
    records: z.array(FixtureRecord),
  })
  .superRefine((dataset, context) => {
    const ids = new Set<string>();
    for (const [index, record] of dataset.records.entries()) {
      if (record.card.sourceId !== dataset.sourceId) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "card", "sourceId"],
          message: "card sourceId must match dataset sourceId",
        });
      }
      if (ids.has(record.card.sourceProcurementId)) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "card", "sourceProcurementId"],
          message: "source procurement id must be unique in a fixture dataset",
        });
      }
      ids.add(record.card.sourceProcurementId);
    }
  });
export type ProcurementFixtureDataset = z.infer<typeof ProcurementFixtureDataset>;

export class FixtureProcurementSource implements ProcurementSourcePort {
  readonly sourceId: z.infer<typeof SourceId>;
  readonly #records: ReadonlyMap<string, FixtureRecord>;

  constructor(dataset: unknown) {
    const parsed = ProcurementFixtureDataset.parse(dataset);
    this.sourceId = parsed.sourceId;
    this.#records = new Map(
      parsed.records.map((record) => [record.card.sourceProcurementId, record]),
    );
  }

  async search(query: SearchQuery): Promise<z.infer<typeof ProcurementSearchResponse>> {
    const parsed = query;
    if (parsed.sourceId !== this.sourceId) return { hits: [] };

    const hits = [...this.#records.values()]
      .filter((record) => matchesQuery(record.card, parsed))
      .map((record) => toSearchHit(record.card))
      .slice(parsed.offset, parsed.offset + parsed.limit);

    return ProcurementSearchResponse.parse({ hits });
  }

  async get(id: SourceProcurementId): Promise<z.infer<typeof ProcedureCard>> {
    return this.#getRecord(id).card;
  }

  async getStatus(
    id: SourceProcurementId,
  ): Promise<z.infer<typeof ProcurementGetStatusResponse>> {
    const card = this.#getRecord(id).card;
    return ProcurementGetStatusResponse.parse({
      status: card.status,
      sourceStatus: card.sourceStatus,
      bidsDeadline: card.bidsDeadline,
      fetchedAt: card.fetchedAt,
    });
  }

  async getLots(id: SourceProcurementId): Promise<z.infer<typeof ProcurementGetLotsResponse>> {
    return ProcurementGetLotsResponse.parse({ lots: this.#getRecord(id).card.lots });
  }

  async getDocuments(
    id: SourceProcurementId,
  ): Promise<z.infer<typeof ProcurementGetDocumentsResponse>> {
    return ProcurementGetDocumentsResponse.parse({ documents: this.#getRecord(id).documents });
  }

  async getHistory(
    id: SourceProcurementId,
  ): Promise<z.infer<typeof ProcurementGetHistoryResponse>> {
    return ProcurementGetHistoryResponse.parse({ clarifications: this.#getRecord(id).history });
  }

  async download(_downloadUrl: string): Promise<ProcurementFileBytes> {
    throw new SourceRecordNotFoundError(this.sourceId, "fixture-download");
  }

  async getChanges(
    id: SourceProcurementId,
    since?: IsoDateTime,
  ): Promise<z.infer<typeof ProcurementGetChangesResponse>> {
    const changes = this.#getRecord(id).changes.filter(
      (change) => since === undefined || change.detectedAt > since,
    );
    return ProcurementGetChangesResponse.parse({ changes });
  }

  #getRecord(id: SourceProcurementId): FixtureRecord {
    const record = this.#records.get(id);
    if (record === undefined) {
      throw new SourceRecordNotFoundError(this.sourceId, id);
    }
    return record;
  }
}

function matchesQuery(card: z.infer<typeof ProcedureCard>, query: SearchQuery): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(card.kind)) return false;
  if (!withinPublishedRange(card, query)) return false;

  const haystack = normalise(
    [
      card.title,
      card.sourceStatus,
      card.buyer?.name,
      ...card.parties.map((party) => party.name),
      ...card.lots.flatMap((lot) => [lot.title, lot.description]),
      ...Object.values(card.rawFields),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" "),
  );

  const includes =
    query.keywords.length === 0 ||
    query.keywords.some((keyword) => haystack.includes(normalise(keyword)));
  const excludes = query.excludeKeywords.some((keyword) =>
    haystack.includes(normalise(keyword)),
  );
  return includes && !excludes;
}

function withinPublishedRange(card: z.infer<typeof ProcedureCard>, query: SearchQuery): boolean {
  if (card.publishedAt === undefined) return true;
  if (card.publishedAt.precision === "date") {
    if (
      query.publishedFrom !== undefined &&
      card.publishedAt.date < query.publishedFrom.slice(0, 10)
    ) {
      return false;
    }
    if (
      query.publishedTo !== undefined &&
      card.publishedAt.date > query.publishedTo.slice(0, 10)
    ) {
      return false;
    }
    return true;
  }

  const value = Date.parse(card.publishedAt.at);
  if (query.publishedFrom !== undefined && value < Date.parse(query.publishedFrom)) return false;
  if (query.publishedTo !== undefined && value > Date.parse(query.publishedTo)) return false;
  return true;
}

function normalise(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-BY").replace(/\s+/g, " ").trim();
}

function toSearchHit(card: z.infer<typeof ProcedureCard>): SearchHit {
  const buyerName =
    card.buyer?.name ?? card.parties.find((party) => party.role === "buyer")?.name;
  return {
    sourceId: card.sourceId,
    sourceProcurementId: card.sourceProcurementId,
    url: card.url,
    title: card.title,
    pageFamily: card.pageFamily,
    ...(card.sourceStatus === undefined ? {} : { sourceStatus: card.sourceStatus }),
    ...(buyerName === undefined ? {} : { buyerName }),
    ...(card.startingPrice === undefined ? {} : { startingPrice: card.startingPrice }),
    ...(card.amount === undefined ? {} : { amount: card.amount }),
    ...(card.publishedAt === undefined ? {} : { publishedAt: card.publishedAt }),
    ...(card.bidsDeadline === undefined ? {} : { bidsDeadline: card.bidsDeadline }),
  };
}
