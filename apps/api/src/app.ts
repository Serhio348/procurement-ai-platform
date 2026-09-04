import {
  InboxFixtureItem,
  SpecialistInboxListResponse,
  SpecialistProcurementListResponse,
  SpecialistSearchRequest,
  SpecialistSearchResponse,
  electricalEquipmentSeedV1,
  type SearchHit,
  type SpecialistCaseDocument,
} from "@procurement/contracts";
import { selectRelevantSearchCards, SpecialistCatalog } from "@procurement/domain";
import { silentLogger, type Logger } from "@procurement/observability";
import Fastify from "fastify";
import {
  contentDisposition,
  contentTypeForName,
  defaultBlobDirectory,
  getBlob,
  isSha256Hex,
} from "./blobs.js";
import { loadFixtureSearchHits } from "./load-fixture.js";

export interface SpecialistSearchHitsPort {
  search: (limit: number) => Promise<readonly SearchHit[]>;
}

export interface BuildApiOptions {
  catalog?: SpecialistCatalog;
  logger?: Logger;
  blobDirectory?: string;
  searchHits?: SpecialistSearchHitsPort;
}

export async function buildSpecialistApi(options: BuildApiOptions = {}) {
  const catalog = options.catalog ?? new SpecialistCatalog();
  const logger = options.logger ?? silentLogger;
  const blobDirectory = options.blobDirectory ?? defaultBlobDirectory();
  const searchHits = options.searchHits ?? { search: loadDefaultSearchHits };
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({ ok: true as const }));

  app.get("/api/inbox", async () =>
    SpecialistInboxListResponse.parse({ items: catalog.urgentInbox() }),
  );

  app.post("/api/inbox/events", async (request, reply) => {
    const parsed = InboxFixtureItem.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const recorded = catalog.record(parsed.data);
    logger.info("Specialist inbox event recorded", {
      duplicate: recorded.duplicate,
      changeId: recorded.item.change.id,
    });
    return reply.code(recorded.duplicate ? 200 : 201).send(
      SpecialistInboxListResponse.parse({ items: catalog.urgentInbox() }),
    );
  });

  app.get("/api/procurements", async () =>
    SpecialistProcurementListResponse.parse({ items: catalog.procurements() }),
  );

  app.post("/api/procurements/search", async (request, reply) => {
    const parsed = SpecialistSearchRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const hits = await searchHits.search(parsed.data.limit);
    const selected = selectRelevantSearchCards(
      hits,
      {
        keywords: electricalEquipmentSeedV1.keywords,
        excludeKeywords: electricalEquipmentSeedV1.excludeKeywords,
      },
      parsed.data.limit,
    );
    for (const card of selected.cards) {
      catalog.upsertCase(card);
    }
    logger.info("Specialist profile search recorded", {
      profileName: electricalEquipmentSeedV1.name,
      relevantCount: selected.cards.length,
      discardedCount: selected.discardedCount,
    });
    return SpecialistSearchResponse.parse({
      profileName: electricalEquipmentSeedV1.name,
      relevantCount: selected.cards.length,
      discardedCount: selected.discardedCount,
      items: catalog.procurements(),
    });
  });

  app.get("/api/procurements/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const card = catalog.procurement(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return card;
  });

  app.get("/api/documents/:hash", async (request, reply) => {
    const params = request.params as { hash: string };
    if (!isSha256Hex(params.hash)) {
      return reply.code(400).send({ error: "invalid_hash" });
    }
    const document = findCatalogDocument(catalog, params.hash);
    if (document === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    const bytes = await getBlob(blobDirectory, params.hash);
    if (bytes === undefined) {
      return reply.code(404).send({ error: "blob_missing" });
    }
    return reply
      .header("content-type", contentTypeForName(document.name))
      .header("content-disposition", contentDisposition(document.name))
      .send(Buffer.from(bytes));
  });

  return app;
}

async function loadDefaultSearchHits(_limit: number): Promise<readonly SearchHit[]> {
  return loadFixtureSearchHits();
}

function findCatalogDocument(
  catalog: SpecialistCatalog,
  hash: string,
): SpecialistCaseDocument | undefined {
  for (const card of catalog.procurements()) {
    const document = card.documents.find((item) => item.hash === hash);
    if (document !== undefined) return document;
  }
  return undefined;
}
