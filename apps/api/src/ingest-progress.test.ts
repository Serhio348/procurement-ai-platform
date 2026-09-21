import { describe, expect, it } from "vitest";
import { bindIngestScope, createIngestProgressHub } from "./ingest-progress.js";

// Card ids are derived from the source row, so two cabinets hold the same
// id — progress must stay scoped per workspace (R17).
const CARD = "00000000-0000-4000-8000-000000000401";

describe("ingest progress scoping", () => {
  it("keeps identical card ids of different cabinets independent", () => {
    const hub = createIngestProgressHub();
    hub.begin("ws-a", CARD);
    hub.listed("ws-a", CARD, [{ name: "a.pdf", sourceUrl: "https://x/1" }]);

    expect(hub.snapshot("ws-a", CARD).phase).toBe("downloading");
    expect(hub.snapshot("ws-b", CARD).phase).toBe("idle");

    hub.done("ws-b", CARD);
    expect(hub.snapshot("ws-b", CARD).phase).toBe("done");
    expect(hub.snapshot("ws-a", CARD).phase).toBe("downloading");
    expect(hub.snapshot("ws-b", CARD).procurementId).toBe(CARD);
  });

  it("bindIngestScope writes under the cabinet scope", () => {
    const hub = createIngestProgressHub();
    const scoped = bindIngestScope(hub, "ws-a");
    scoped?.listed(CARD, [{ name: "a.pdf", sourceUrl: "https://x/1" }]);

    expect(scoped?.snapshot(CARD).phase).toBe("downloading");
    expect(hub.snapshot("ws-a", CARD).phase).toBe("downloading");
    expect(hub.snapshot("ws-b", CARD).phase).toBe("idle");
  });
});
