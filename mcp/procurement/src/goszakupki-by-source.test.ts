import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SearchQuery, SourceProcurementId } from "@procurement/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  GoszakupkiPageClient,
  GoszakupkiPageResponse,
} from "./goszakupki-by-http.js";
import { GoszakupkiBySource } from "./goszakupki-by-source.js";
import { SourceRecordNotFoundError } from "./source-registry.js";

describe("GoszakupkiBySource", () => {
  let requestHtml: string;
  let searchHtml: string;

  beforeAll(async () => {
    requestHtml = await readFile(
      fileURLToPath(
        new URL("../../../tests/fixtures/goszakupki-by/request.html", import.meta.url),
      ),
      "utf8",
    );
    searchHtml = await readFile(
      fileURLToPath(
        new URL("../../../tests/fixtures/goszakupki-by/search.html", import.meta.url),
      ),
      "utf8",
    );
  });

  it("serves all card projections from one short-lived cached fetch", async () => {
    const get = vi.fn(async (): Promise<GoszakupkiPageResponse> => ({
      status: 200,
      url: "https://goszakupki.by/request/view/9000003",
      body: requestHtml,
    }));
    const source = new GoszakupkiBySource({
      client: { get },
      now: () => new Date("2026-09-02T03:00:00.000Z"),
    });
    const id = SourceProcurementId.parse("request/9000003");

    const card = await source.get(id);
    const status = await source.getStatus(id);
    const lots = await source.getLots(id);
    const documents = await source.getDocuments(id);
    const history = await source.getHistory(id);
    const changes = await source.getChanges(id);

    expect(card.title).toContain("Трансформатор");
    expect(status.status).toBe("accepting_bids");
    expect(lots.lots).toHaveLength(1);
    expect(documents.documents).toHaveLength(2);
    expect(history.clarifications).toEqual([]);
    expect(changes.changes).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/request/view/9000003");
  });

  it("downloads an attachment only from goszakupki.by through the session client", async () => {
    const download = vi.fn(async () => ({
      status: 200,
      url: "https://goszakupki.by/files/get?id=1&download=1",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "application/pdf",
    }));
    const source = new GoszakupkiBySource({
      client: {
        get: async () => {
          throw new Error("must not fetch the card");
        },
        download,
      },
    });

    const file = await source.download("https://goszakupki.by/files/get?id=1&download=1");

    expect(file.contentType).toBe("application/pdf");
    expect(file.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(download).toHaveBeenCalledWith("/files/get?id=1&download=1");
    await expect(source.download("https://example.test/files/1")).rejects.toThrow(
      /outside goszakupki.by/,
    );
  });

  it("keeps the HTTP client bound so private fields stay readable", async () => {
    class SessionClient {
      readonly #token = "session";
      async get(): Promise<never> {
        throw new Error("must not fetch the card");
      }
      async download(path: string) {
        return {
          status: 200,
          url: `https://goszakupki.by${path}`,
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "application/msword",
          token: this.#token,
        };
      }
    }
    const source = new GoszakupkiBySource({ client: new SessionClient() });
    const file = await source.download("https://goszakupki.by/files/get?id=2&download=1");
    expect(file.contentType).toBe("application/msword");
    expect(file.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("maps a source 404 to a typed record-not-found error", async () => {
    const client: GoszakupkiPageClient = {
      get: vi.fn(async () => ({
        status: 404,
        url: "https://goszakupki.by/request/view/9999999",
        body: "not found",
      })),
    };
    const source = new GoszakupkiBySource({ client });

    await expect(source.get(SourceProcurementId.parse("request/9999999"))).rejects.toBeInstanceOf(
      SourceRecordNotFoundError,
    );
  });

  it("rejects ambiguous identifiers that do not carry their page family", async () => {
    const client: GoszakupkiPageClient = {
      get: vi.fn(async () => {
        throw new Error("must not be called");
      }),
    };
    const source = new GoszakupkiBySource({ client });

    await expect(source.get(SourceProcurementId.parse("9000003"))).rejects.toBeInstanceOf(
      SourceRecordNotFoundError,
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("searches through the anonymous source session and applies neutral filters", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const client: GoszakupkiPageClient = {
      get,
    };
    const source = new GoszakupkiBySource({ client });
    const query = SearchQuery.parse({
      sourceId: "goszakupki_by",
      keywords: ["трансформатор"],
      excludeKeywords: ["ремонт"],
      kinds: ["electronic_auction", "request_for_quotations"],
      publishedFrom: "2026-09-01T00:00:00+03:00",
      publishedTo: "2026-09-02T23:59:59+03:00",
      limit: 10,
    });

    await expect(source.search(query)).resolves.toMatchObject({
      hits: [
        { sourceProcurementId: "request/9000103" },
        { sourceProcurementId: "auction/9000101" },
      ],
    });
    expect(get).toHaveBeenCalledWith(
      "/tenders/posted?TendersSearch%5Btext%5D=%D1%82%D1%80%D0%B0%D0%BD%D1%81%D1%84%D0%BE%D1%80%D0%BC%D0%B0%D1%82%D0%BE%D1%80&TendersSearch%5Bcreated_from%5D=01.09.2026&TendersSearch%5Bcreated_to%5D=02.09.2026",
    );
  });

  it("does not query the next profile keyword after the requested limit is filled", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["трансформатор", "кабель"],
        limit: 1,
      }),
    );

    expect(result.hits).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(get.mock.calls[0]?.[0]))).toContain("трансформатор");
    expect(decodeURIComponent(String(get.mock.calls[0]?.[0]))).not.toContain("кабель");
  });
});
