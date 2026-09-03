import {
  InboxFixtureItem,
  SpecialistInboxListResponse,
  SpecialistProcurementListResponse,
} from "@procurement/contracts";
import { SpecialistCatalog } from "@procurement/domain";
import { silentLogger, type Logger } from "@procurement/observability";
import Fastify from "fastify";

export interface BuildApiOptions {
  catalog?: SpecialistCatalog;
  logger?: Logger;
}

export async function buildSpecialistApi(options: BuildApiOptions = {}) {
  const catalog = options.catalog ?? new SpecialistCatalog();
  const logger = options.logger ?? silentLogger;
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

  app.get("/api/procurements/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const card = catalog.procurement(params.id);
    if (card === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }
    return card;
  });

  return app;
}
