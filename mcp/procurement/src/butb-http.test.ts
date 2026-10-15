import { describe, expect, it } from "vitest";
import { ButbHttpClient } from "./butb-http.js";

const BASE = "https://zakupki.butb.by";
const REGISTRY = `${BASE}/auctions/reestrauctions.html`;
const CARD = `${BASE}/auctions/viewinvitation.html`;

const registryHtml = (viewState: string) =>
  `<html><body><form action="/auctions/reestrauctions.html" id="fra">` +
  `<input type="hidden" name="javax.faces.ViewState" value="${viewState}"/>` +
  `<input type="hidden" name="ice.window" value="w-1"/>` +
  `<input type="hidden" name="ice.view" value="v-1"/>` +
  `<table><tr id="fra:reestrAu_row_0"><td>AU20261015396707</td>` +
  `<td><a id="fra:reestrAu:0:_t344" onclick="mojarra.jsfcljs()">Lot</a></td>` +
  `</tr></table></form></body></html>`;

const pageChangeXml = (viewState: string) =>
  `<?xml version="1.0"?><partial-response>` +
  `<update id="fra:reestrAu"><![CDATA[<table><tr id="fra:reestrAu_row_20">` +
  `<td>AU20261001396000</td></tr></table>]]></update>` +
  `<update id="javax.faces.ViewState"><![CDATA[${viewState}]]></update>` +
  `</partial-response>`;

interface Recorded {
  url: string;
  method: string;
  body?: string;
  cookie?: string;
}

/**
 * Scriptable fetch: each handler answers one request and may consult the
 * recorded history so later calls can echo session state.
 */
function scriptedFetch(
  handler: (request: Recorded, index: number) => Response,
): { run: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request: Recorded = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(init?.headers !== undefined
        ? { cookie: new Headers(init.headers).get("cookie") ?? "" }
        : {}),
    };
    calls.push(request);
    return handler(request, calls.length - 1);
  };
  return { run: fetchImpl, calls };
}

const htmlResponse = (body: string, cookie?: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html;charset=utf-8",
      ...(cookie === undefined ? {} : { "set-cookie": cookie }),
    },
  });

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ButbHttpClient({
    baseUrl: BASE,
    requestsPerMinute: 60_000,
    sleep: () => Promise.resolve(),
    fetchImplementation: fetchImpl,
    ...extra,
  });
}

describe("ButbHttpClient session", () => {
  it("bootstraps cookies and JSF tokens, then echoes them on postbacks", async () => {
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        return htmlResponse(registryHtml("VS1"), "JSESSIONID=abc; Path=/auctions");
      }
      if (request.method === "POST" && request.body?.includes("pageChange")) {
        return htmlResponse(pageChangeXml("VS2"));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    const first = await c.registryPage(1);
    const second = await c.registryPage(2);

    expect(first.body).toContain("reestrAu_row_0");
    expect(second.body).toContain("reestrAu_row_20");
    const post = calls.find((call) => call.method === "POST");
    expect(post?.cookie).toContain("JSESSIONID=abc");
    expect(post?.body).toContain("javax.faces.ViewState=VS1");
    expect(post?.body).toContain("javax.faces.behavior.event=pageChange");
    expect(post?.body).toContain("ice.window=w-1");
    expect(post?.body).toContain("ice.view=v-1");
  });

  it("opens the card through the row link postback and 302", async () => {
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        return htmlResponse(registryHtml("VS1"));
      }
      if (request.method === "POST" && request.body?.includes("_t344")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/auctions/viewinvitation.html" },
        });
      }
      if (request.method === "GET" && request.url === CARD) {
        return htmlResponse("<html>card body</html>");
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    await c.registryPage(1);
    const card = await c.openCard("fra:reestrAu:0:_t344");

    expect(card.body).toContain("card body");
    const post = calls.find((call) => call.method === "POST" && call.body?.includes("_t344"));
    expect(post?.body).toContain("fra%3AreestrAu%3A0%3A_t344");
    expect(post?.body).toContain("javax.faces.ViewState=VS1");
  });

  it("reopens the session once when the server drops the view", async () => {
    let bootstraps = 0;
    let pageChanges = 0;
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        bootstraps += 1;
        return htmlResponse(registryHtml(`VS${bootstraps}`));
      }
      if (request.method === "POST" && request.body?.includes("pageChange")) {
        pageChanges += 1;
        // First postback answers a full page — the view is dead.
        return pageChanges === 1
          ? htmlResponse("<html>full page, lost view</html>")
          : htmlResponse(pageChangeXml("VS9"));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    const page2 = await c.registryPage(2);

    expect(page2.body).toContain("reestrAu_row_20");
    expect(pageChanges).toBe(2);
    // Bootstrap GET + page-1 GET happen per session opening.
    expect(bootstraps).toBeGreaterThanOrEqual(2);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts[1]?.body).toContain("javax.faces.ViewState=VS2");
  });
});

describe("ButbHttpClient resilience", () => {
  it("opens the circuit after repeated failures and lets it reset", async () => {
    let now = 0;
    const { run: fetch, calls } = scriptedFetch(() => {
      throw new Error("socket reset");
    });
    const c = client(fetch, {
      circuitFailureThreshold: 2,
      circuitResetMs: 1_000,
      now: () => now,
    });

    await expect(c.registryPage(1)).rejects.toMatchObject({ name: "SourceAccessError" });
    await expect(c.registryPage(1)).rejects.toMatchObject({ name: "SourceAccessError" });
    const callsBefore = calls.length;
    await expect(c.registryPage(1)).rejects.toThrow("circuit");
    expect(calls.length).toBe(callsBefore);

    now += 2_000;
    await expect(c.registryPage(1)).rejects.toMatchObject({ name: "SourceAccessError" });
    expect(calls.length).toBeGreaterThan(callsBefore);
  });

  it("refuses cross-origin document downloads", async () => {
    const { run: fetch, calls } = scriptedFetch(() => htmlResponse(registryHtml("VS1")));
    const c = client(fetch);

    await expect(c.download("https://evil.example/x")).rejects.toThrow(/cross-origin/);
    expect(calls).toHaveLength(0);
  });
});
