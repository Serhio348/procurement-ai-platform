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
    await expect(source.download("http://127.0.0.1/tz.pdf")).rejects.toThrow(
      /public documentation host/,
    );
  });

  it("downloads a public storage URL without the goszakupki session", async () => {
    const publicFetch = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("cloud-api.yandex.net") && href.includes("download")) {
        return new Response(JSON.stringify({ href: "https://downloader.disk.yandex.ru/zip/1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === "https://downloader.disk.yandex.ru/zip/1") {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    const source = new GoszakupkiBySource({
      client: {
        get: async () => {
          throw new Error("must not fetch the card");
        },
      },
      publicFetch,
    });

    const file = await source.download("https://disk.yandex.ru/d/abc");
    expect(file.contentType).toContain("zip");
    expect(file.bytes[0]).toBe(0x50);
    expect(publicFetch).toHaveBeenCalled();
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

  it("puts the profile status checkbox on the site URL as TendersSearch[status][]", async () => {
    const formHtml = await readFile(
      fileURLToPath(
        new URL("../../../tests/fixtures/goszakupki-by/search-filters.html", import.meta.url),
      ),
      "utf8",
    );
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body:
        path === "/tenders/posted"
          ? formHtml
          : searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТПБ"],
        statuses: ["accepting_bids"],
        limit: 10,
      }),
    );

    expect(get).toHaveBeenNthCalledWith(1, "/tenders/posted");
    const searchPath = String(get.mock.calls[1]?.[0]);
    expect(decodeURIComponent(searchPath)).toContain("TendersSearch[text]=КТПБ");
    expect(decodeURIComponent(searchPath)).toContain("TendersSearch[status][]=1");
    expect(decodeURIComponent(searchPath)).not.toContain("TendersSearch[status][]=2");
    expect(decodeURIComponent(searchPath)).not.toContain("TendersSearch[type]");
  });

  it("sends Submission when the listing page has no search form", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body:
        path === "/tenders/posted"
          ? "<html><body></body></html>"
          : searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТПБ"],
        statuses: ["accepting_bids"],
        limit: 10,
      }),
    );

    const searchPath = decodeURIComponent(String(get.mock.calls[1]?.[0]));
    expect(searchPath).toContain("TendersSearch[status][]=Submission");
    expect(searchPath).not.toContain("TendersSearch[status][]=1");
  });

  it("still returns a completed listing row the site leaked so the console can show the status skip", async () => {
    const listingHtml = `<!doctype html><table>
      <thead><tr>
        <th></th>
        <th>Номер закупки</th>
        <th>Организация / Предмет закупки</th>
        <th>Вид процедуры закупки</th>
        <th>Статус</th>
        <th>Предложения, документы до</th>
        <th>Ориентировочная/предельная стоимость</th>
      </tr></thead>
      <tbody>
        <tr data-key="0">
          <td><input type="checkbox"></td>
          <td><a href="https://gias.by/gias/#/purchase/current/view/4761844">4761844</a></td>
          <td>Гродноэнерго<br><a href="/auction/view/3664806">Выбор поставщика блочной комплектной подстанции (БКТПБ №3)</a></td>
          <td>Электронный аукцион</td>
          <td><span class="badge">Подача предложений</span></td>
          <td>27.09.2026</td>
          <td>526 056.26 BYN</td>
        </tr>
        <tr data-key="1">
          <td><input type="checkbox"></td>
          <td><a href="https://gias.by/gias/#/purchase/current/view/1037877">1037877</a></td>
          <td>Заказчик<br><a href="/marketing/view/1037877">шкаф АСКУЭ</a></td>
          <td>Запрос ценовых предложений</td>
          <td><span class="badge">Завершен</span></td>
          <td>01.01.2020</td>
          <td>1 BYN</td>
        </tr>
      </tbody>
    </table>`;
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: path === "/tenders/posted" ? "<html></html>" : listingHtml,
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТПБ"],
        statuses: ["accepting_bids"],
        limit: 10,
      }),
    );

    expect(result.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "auction/3664806",
      "marketing/1037877",
    ]);
    expect(result.hits[0]?.title).toContain("БКТПБ №3");
    expect(result.hits[1]?.sourceStatus).toBe("Завершен");
  });

  it("puts every filled advanced-search window on the site URL", async () => {
    const formHtml = await readFile(
      fileURLToPath(
        new URL("../../../tests/fixtures/goszakupki-by/search-filters.html", import.meta.url),
      ),
      "utf8",
    );
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body:
        path === "/tenders/posted"
          ? formHtml
          : searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТПБ"],
        buyerUnp: "123456789",
        buyerText: "Гродноэнерго",
        procurementNumber: "auc0003664806",
        priceFrom: 1000,
        priceTo: 500000,
        publishedFrom: "2026-09-01T00:00:00+03:00",
        publishedTo: "2026-09-30T00:00:00+03:00",
        requestEndFrom: "2026-09-16T00:00:00+03:00",
        requestEndTo: "2026-10-01T00:00:00+03:00",
        auctionFrom: "2026-09-20T00:00:00+03:00",
        auctionTo: "2026-09-25T00:00:00+03:00",
        typeIds: ["Auction"],
        statuses: ["accepting_bids"],
        regionIds: ["4"],
        limit: 10,
      }),
    );

    const searchPath = decodeURIComponent(String(get.mock.calls[1]?.[0]));
    expect(searchPath).toContain("TendersSearch[text]=КТПБ");
    expect(searchPath).toContain("TendersSearch[unp]=123456789");
    expect(searchPath).toContain("TendersSearch[customer_text]=Гродноэнерго");
    expect(searchPath).toContain("TendersSearch[num]=auc0003664806");
    expect(searchPath).toContain("TendersSearch[price_from]=1000");
    expect(searchPath).toContain("TendersSearch[price_to]=500000");
    expect(searchPath).toContain("TendersSearch[created_from]=01.09.2026");
    expect(searchPath).toContain("TendersSearch[created_to]=30.09.2026");
    expect(searchPath).toContain("TendersSearch[request_end_from]=16.09.2026");
    expect(searchPath).toContain("TendersSearch[request_end_to]=01.10.2026");
    expect(searchPath).toContain("TendersSearch[auction_date_from]=20.09.2026");
    expect(searchPath).toContain("TendersSearch[auction_date_to]=25.09.2026");
    expect(searchPath).toContain("TendersSearch[type][]=Auction");
    expect(searchPath).toContain("TendersSearch[status][]=1");
    expect(searchPath).not.toContain("TendersSearch[status][]=2");
    expect(searchPath).toContain("TendersSearch[region][]=4");
  });

  it("queries every profile phrase even when the first phrase fills the result limit", async () => {
    const get = vi.fn(async (path: string) => {
      const body = path.includes(encodeURIComponent("кабель"))
        ? searchHtml.replaceAll("900010", "900020")
        : searchHtml;
      return {
        status: 200,
        url: `https://goszakupki.by${path}`,
        body: body.replace('class="next"', 'class="next disabled"'),
      };
    });
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["трансформатор", "кабель"],
        limit: 2,
      }),
    );

    expect(result.hits.map((hit) => hit.sourceProcurementId)).toEqual([
      "single-source/9000104",
      "single-source/9000204",
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(get.mock.calls[0]?.[0]))).toContain("трансформатор");
    expect(decodeURIComponent(String(get.mock.calls[1]?.[0]))).toContain("кабель");
  });

  it("sends every profile phrase to the site as its own query, never one joined phrase", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТПБ", "КТП", "сети электроснабжения"],
        limit: 100,
      }),
    );

    const texts = get.mock.calls.map((call) => {
      const url = new URL(`https://goszakupki.by${String(call[0])}`);
      return url.searchParams.get("TendersSearch[text]");
    });
    expect(texts).toEqual(["КТПБ", "КТП", "сети электроснабжения"]);
  });

  it("returns one candidate for a procedure found by two phrases and lists both phrases", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТП", "сети электроснабжения"],
        limit: 100,
      }),
    );

    const ids = result.hits.map((hit) => hit.sourceProcurementId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.hits.length).toBe(4);
    for (const hit of result.hits) {
      expect(hit.matchedSearchTerms).toEqual(["КТП", "сети электроснабжения"]);
    }
  });

  it("gives every phrase its share of the limit instead of letting a broad first phrase take it all", async () => {
    // Phrase A has pages of rows; phrases B..E have one page each with fresh ids.
    const get = vi.fn(async (path: string) => {
      const url = new URL(`https://goszakupki.by${path}`);
      const text = url.searchParams.get("TendersSearch[text]") ?? "";
      const page = Number(url.searchParams.get("page") ?? "1");
      const termIndex = ["A", "B", "C", "D", "E"].indexOf(text) + 1;
      const body = searchHtml.replaceAll(/90001(\d\d)/gu, (_match, tail: string) =>
        `9${String(termIndex)}${String(page).padStart(2, "0")}${tail}`,
      );
      const last = text === "A" ? page >= 10 : true;
      return {
        status: 200,
        url: `https://goszakupki.by${path}`,
        body: last ? body.replace('class="next"', 'class="next disabled"') : body,
      };
    });
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["A", "B", "C", "D", "E"],
        limit: 20,
      }),
    );

    expect(result.hits).toHaveLength(20);
    const byTerm = new Map<string, number>();
    for (const hit of result.hits) {
      for (const term of hit.matchedSearchTerms ?? []) {
        byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
      }
    }
    expect([...byTerm.keys()].sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(byTerm.get("A")).toBe(4);
    expect(byTerm.get("E")).toBe(4);
    // The page budget of a broad phrase is bounded by its share, not by the whole limit.
    const pagesForA = get.mock.calls.filter((call) => String(call[0]).includes("text%5D=A")).length;
    expect(pagesForA).toBeLessThanOrEqual(3);
  });

  it("keeps reading pages until the unique-candidate budget is met (R11)", async () => {
    // Both phrases return the same first page of 20 rows and own a second
    // page. Splitting the budget before dedup used to stop after page 1 of
    // each term and reported 20 hits for limit 40 — hiding page 2.
    const pageOf = (page: number): string => {
      const rows = Array.from({ length: 20 }, (_unused, index) => {
        const id = 9000000 + page * 100 + index;
        return `<tr data-key="${index}">
          <td><input type="checkbox"></td>
          <td><a href="https://gias.by/gias/#/purchase/current/view/${id}">${id}</a></td>
          <td>Заказчик<br><a href="/auction/view/${id}">Закупка ${id}</a></td>
          <td>Электронный аукцион</td>
          <td><span class="badge">Подача предложений</span></td>
          <td>27.09.2026</td>
          <td>1 BYN</td>
        </tr>`;
      }).join("\n");
      const pager =
        page < 2
          ? `<ul class="pagination"><li class="next"><a href="/tenders/posted?page=${page + 1}">›</a></li></ul>`
          : "";
      return `<!doctype html><table><thead><tr>
        <th></th><th>Номер закупки</th><th>Организация / Предмет закупки</th>
        <th>Вид процедуры закупки</th><th>Статус</th>
        <th>Предложения, документы до</th><th>Стоимость</th>
      </tr></thead><tbody>${rows}</tbody></table>${pager}`;
    };
    const get = vi.fn(async (path: string) => {
      const url = new URL(`https://goszakupki.by${path}`);
      const page = Number(url.searchParams.get("page") ?? "1");
      return {
        status: 200,
        url: `https://goszakupki.by${path}`,
        body: pageOf(page),
      };
    });
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["A", "B"],
        limit: 40,
      }),
    );

    expect(result.hits).toHaveLength(40);
    // Shared rows are credited to every phrase that found them.
    const shared = result.hits.find(
      (hit) => hit.sourceProcurementId === "auction/9000100",
    );
    expect(shared?.matchedSearchTerms).toHaveLength(2);
    expect(shared?.matchedSearchTerms).toEqual(expect.arrayContaining(["A", "B"]));
    // The second phrase still owns unread rows — the source is not exhausted.
    expect(result.hasMore).toBe(true);
  });

  it("reports no more pages only once every phrase is exhausted", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["КТП", "сети электроснабжения"],
        limit: 100,
      }),
    );

    expect(result.hasMore).toBe(false);
  });

  it("keeps a listing row the site returned when the keyword is not in the title", async () => {
    const get = vi.fn(async (path: string) => ({
      status: 200,
      url: `https://goszakupki.by${path}`,
      body: searchHtml.replace('class="next"', 'class="next disabled"'),
    }));
    const source = new GoszakupkiBySource({ client: { get } });

    const result = await source.search(
      SearchQuery.parse({
        sourceId: "goszakupki_by",
        keywords: ["АСКУЭ"],
        limit: 10,
      }),
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((item) => !item.title.includes("АСКУЭ"))).toBe(true);
  });

  it("loads a limited contest card by family/id the same way as other families", async () => {
    const limitedHtml = await readFile(
      fileURLToPath(
        new URL("../../../tests/fixtures/goszakupki-by/limited.html", import.meta.url),
      ),
      "utf8",
    );
    const get = vi.fn(async (): Promise<GoszakupkiPageResponse> => ({
      status: 200,
      url: "https://goszakupki.by/limited/view/3669746",
      body: limitedHtml,
    }));
    const source = new GoszakupkiBySource({
      client: { get },
      now: () => new Date("2026-09-15T12:00:00.000Z"),
    });

    const card = await source.get(SourceProcurementId.parse("limited/3669746"));

    expect(get).toHaveBeenCalledWith("/limited/view/3669746");
    expect(card.title).toContain("Жлобине");
    expect(card.lots[0]?.title).toMatch(/монтаж.*электрооборудования/i);
    expect(card.lots[0]?.title).toMatch(/АСКУЭ/);
    expect(card.lots[0]?.positions[0]?.title).toMatch(/электрооборудования/i);
  });
});
