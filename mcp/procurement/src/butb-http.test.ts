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
        // First postback answers an ICEfaces error frame — the view is dead.
        return pageChanges === 1
          ? htmlResponse(
              `<?xml version="1.0"?><partial-response><error><error-name>session expired</error-name></error></partial-response>`,
            )
          : htmlResponse(pageChangeXml("VS9"));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    const page2 = await c.registryPage(2);

    expect(page2.body).toContain("reestrAu_row_20");
    expect(pageChanges).toBe(2);
    expect(bootstraps).toBeGreaterThanOrEqual(2);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts[1]?.body).toContain("javax.faces.ViewState=VS2");
  });

  it("pages only with postbacks — a registry GET keeps the session's page", async () => {
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        return htmlResponse(registryHtml("VS1"));
      }
      if (request.method === "POST" && request.body?.includes("pageChange")) {
        return htmlResponse(pageChangeXml("VS2"));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    await c.registryPage(1);
    await c.registryPage(3);
    // Back to page 1: a GET would return page 3 again — must postback.
    await c.registryPage(1);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toContain("reestrAu_page=3");
    expect(posts[1]?.body).toContain("reestrAu_page=1");
    // One bootstrap GET only: no extra GETs that the server would answer
    // with whatever page the session is parked on.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("reopens the session before paging after a card was opened", async () => {
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
      if (request.method === "POST" && request.body?.includes("pageChange")) {
        return htmlResponse(pageChangeXml("VS2"));
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    await c.registryPage(1);
    await c.openCard("fra:reestrAu:0:_t344");
    await c.registryPage(2);

    // GET bootstrap, POST card link, GET card, GET bootstrap (the
    // card view degrades the session's table), POST pageChange.
    const gets = calls.filter((call) => call.method === "GET" && call.url === REGISTRY);
    expect(gets).toHaveLength(2);
    const last = calls[calls.length - 1];
    expect(last?.method).toBe("POST");
    expect(last?.body).toContain("reestrAu_page=2");
  });

  it("downloads a document under the session rebuilt after the card view", async () => {
    // The card's document URL is captured under one JSESSIONID; the next
    // registry read drops that session (the card view degrades the table)
    // and bootstraps a new one. The file GET must still go out — with the
    // *new* session's cookie — because document URLs carry no view tokens.
    let bootstraps = 0;
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        bootstraps += 1;
        return htmlResponse(
          registryHtml(`VS${bootstraps}`),
          `JSESSIONID=s${bootstraps}; Path=/auctions`,
        );
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
      if (request.method === "POST" && request.body?.includes("pageChange")) {
        return htmlResponse(pageChangeXml("VS9"));
      }
      if (request.method === "GET" && request.url.startsWith(`${BASE}/auctions/download`)) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    await c.registryPage(1); // session s1
    await c.openCard("fra:reestrAu:0:_t344"); // card view under s1
    await c.registryPage(1); // card view → session dropped, s2 bootstrapped
    const file = await c.download("/auctions/download?id=6119854&name=x.pdf");

    expect(bootstraps).toBe(2);
    expect(Buffer.from(file.bytes).toString("latin1")).toBe("%PDF");
    expect(file.contentType).toBe("application/pdf");
    const fileGet = calls.find((call) => call.url.includes("/auctions/download"));
    expect(fileGet?.cookie).toContain("JSESSIONID=s2");
    expect(fileGet?.cookie).not.toContain("JSESSIONID=s1");
  });

  it("bootstraps a session for a download even with no prior page read", async () => {
    // A monitoring/watch download may arrive on a client that has not read
    // any page this run — the client must open a session itself first.
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET" && request.url === REGISTRY) {
        return htmlResponse(registryHtml("VS1"), "JSESSIONID=fresh; Path=/auctions");
      }
      if (request.method === "GET" && request.url.startsWith(`${BASE}/auctions/download`)) {
        return new Response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), {
          status: 200,
          headers: { "content-type": "application/vnd.ms-excel" },
        });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const c = client(fetch);

    const file = await c.download("/auctions/download?id=1&name=a.xls");

    expect(file.bytes.length).toBe(4);
    const fileGet = calls.find((call) => call.url.includes("/auctions/download"));
    expect(fileGet?.cookie).toContain("JSESSIONID=fresh");
    expect(calls[0]?.url).toBe(REGISTRY);
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

  it("aborts before any request and does not count toward the circuit", async () => {
    const { run: fetch, calls } = scriptedFetch(() => htmlResponse(registryHtml("VS1")));
    const c = client(fetch, { circuitFailureThreshold: 1 });
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    // Repeatedly aborted calls must neither reach fetch nor trip the circuit
    // (threshold 1: a single counted failure would open it).
    await expect(c.registryPage(1, signal)).rejects.toMatchObject({
      name: "SourceAbortedError",
    });
    await expect(c.registryPage(1, signal)).rejects.toMatchObject({
      name: "SourceAbortedError",
    });
    expect(calls).toHaveLength(0);

    const page = await c.registryPage(1);
    expect(page.body).toContain("VS1");
    expect(calls).toHaveLength(1);
  });

  it("lets the circuit record a real failure after aborted calls", async () => {
    let fail = false;
    const { run: fetch, calls } = scriptedFetch(() => {
      if (fail) throw new Error("socket reset");
      return htmlResponse(registryHtml("VS1"));
    });
    const c = client(fetch, { circuitFailureThreshold: 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(c.registryPage(1, controller.signal)).rejects.toMatchObject({
      name: "SourceAbortedError",
    });
    fail = true;
    await expect(c.registryPage(1)).rejects.toMatchObject({ name: "SourceAccessError" });
    await expect(c.registryPage(1)).rejects.toThrow("circuit");
    expect(calls).toHaveLength(1);
  });
});

describe("ButbHttpClient registry search", () => {
  /** Registry page that exposes the «Раскрыть форму поиска» toggle link. */
  const searchableRegistryHtml = (viewState: string) =>
    `<html><body><form action="/auctions/reestrauctions.html" id="fra">` +
    `<input type="hidden" name="javax.faces.ViewState" value="${viewState}"/>` +
    `<input type="hidden" name="ice.window" value="w-1"/>` +
    `<input type="hidden" name="ice.view" value="v-1"/>` +
    `<a id="fra:j_idt210" onclick="var form=document.getElementById('fra');` +
    `form['fra:j_idcl'].value='fra:j_idt210';return false;">` +
    `Раскрыть форму поиска</a>` +
    `<table><tr id="fra:reestrAu_row_0"><td>AU20261015396707</td>` +
    `<td><a id="fra:reestrAu:0:_t344" onclick="mojarra.jsfcljs()">Lot</a></td>` +
    `</tr></table></form></body></html>`;

  /** The post-expand page: search fields + a degraded one-column table. */
  const expandedHtml = (viewState: string) =>
    `<html><body><form action="/auctions/reestrauctions.html" id="fra">` +
    `<input type="hidden" name="javax.faces.ViewState" value="${viewState}"/>` +
    `<input type="hidden" name="ice.window" value="w-1"/>` +
    `<input type="hidden" name="ice.view" value="v-1"/>` +
    `<a onclick="var form=document.getElementById('fra');` +
    `form['fra:j_idcl'].value='fra:j_idt210';return false;">` +
    `Закрыть форму поиска</a>` +
    `<span>Предмет закупки</span><input class="iceInpTxt" name="fra:j_idt216" type="text"/>` +
    `<span>Регистрационный номер</span><input class="iceInpTxt" name="fra:j_idt241" type="text"/>` +
    `<span>Наименование заказчика (организатора)</span>` +
    `<input class="iceInpTxt" name="fra:j_idt259" type="text"/>` +
    `<input id="fra:selectStatus:_0" name="fra:selectStatus" type="checkbox" value="2"/>` +
    `<label for="fra:selectStatus:_0">подача предложений / документов</label>` +
    `<input id="fra:selectStatus:_1" name="fra:selectStatus" type="checkbox" value="4"/>` +
    `<label for="fra:selectStatus:_1">на рассмотрении предложений</label>` +
    `<input name="fra:_t326:0:_t329" type="checkbox"/>` +
    `<input name="fra:_t326:1:_t329" type="checkbox"/>` +
    `<a onclick="self.id = 'fra:_t331'; ice.s(event,self);">Сохранить</a>` +
    `<input type="submit" name="fra:_t317" value="Искать"/>` +
    `</form></body></html>`;

  /**
   * A filtered+restored page: criteria banner plus the 12-column table —
   * `butbTableUsable` keys on the ui-header-text header cells.
   */
  const filteredHtml = (viewState: string) =>
    `<html><body><form action="/auctions/reestrauctions.html" id="fra">` +
    `<input type="hidden" name="javax.faces.ViewState" value="${viewState}"/>` +
    `<span>Критерии поиска: Предмет закупки: 'Подстанция'.</span>` +
    `<table><thead><tr>` +
    Array.from({ length: 11 }, (_v, i) => `<th><span class="ui-header-text">h${i}</span></th>`).join("") +
    `</tr></thead><tbody><tr id="fra:reestrAu_row_0">` +
    `<td><span>AU20261007394983</span></td>` +
    `<td><a id="fra:reestrAu:0:_t339" onclick="mojarra.jsfcljs()">Подстанция</a></td>` +
    `</tr></tbody></table></form></body></html>`;

  const filteredPageXml = (viewState: string, row: string) =>
    `<?xml version="1.0"?><partial-response>` +
    `<update id="fra:reestrAu"><![CDATA[<table><tr id="fra:reestrAu_${row}">` +
    `<td>AU20261001396000</td></tr></table>]]></update>` +
    `<update id="javax.faces.ViewState"><![CDATA[${viewState}]]></update>` +
    `</partial-response>`;

  it("runs expand → submit → restore-columns and serves the filtered page", async () => {
    const posted: string[] = [];
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET") return htmlResponse(searchableRegistryHtml("VS1"));
      posted.push(request.body ?? "");
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      if (body.includes("pageChange")) return htmlResponse(filteredPageXml("VS5", "row_20"));
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    const page1 = await c.filteredPage({ subject: "Подстанция" }, 1);
    const page2 = await c.filteredPage({ subject: "Подстанция" }, 2);

    expect(page1.body).toContain("Критерии поиска");
    expect(page2.body).toContain("reestrAu_row_20");
    const [expand, submit, restore, pageChange] = posted;
    expect(expand).toContain("j_idcl=fra%3Aj_idt210");
    expect(expand).toContain("fra%3Aj_idt210=fra%3Aj_idt210");
    expect(submit).toContain("j_idcl=fra%3A_t317");
    expect(submit).toContain("fra%3A_t317=%D0%98%D1%81%D0%BA%D0%B0%D1%82%D1%8C");
    expect(submit).toContain(
      "fra%3Aj_idt216=%D0%9F%D0%BE%D0%B4%D1%81%D1%82%D0%B0%D0%BD%D1%86%D0%B8%D1%8F",
    );
    expect(restore).toContain("j_idcl=fra%3A_t331");
    expect(restore).toContain("fra%3A_t326%3A0%3A_t329=on");
    expect(restore).toContain("fra%3A_t326%3A1%3A_t329=on");
    expect(pageChange).toContain("reestrAu_page=2");
    // One bootstrap GET — every later step is a session postback.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("maps normalized statuses onto the discovered checkbox values", async () => {
    const posted: string[] = [];
    const { run: fetch } = scriptedFetch((request) => {
      if (request.method === "GET") return htmlResponse(searchableRegistryHtml("VS1"));
      posted.push(request.body ?? "");
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    await c.filteredPage(
      { subject: "x", statuses: ["accepting_bids", "under_review"] },
      1,
    );

    const submit = posted.find((body) => body.includes("j_idcl=fra%3A_t317"))!;
    // Values 2 and 4 come from the checkbox labels, not a hardcoded map.
    expect(submit).toContain("fra%3AselectStatus=2");
    expect(submit).toContain("fra%3AselectStatus=4");
  });

  it("re-submits new criteria without re-expanding the panel", async () => {
    const posted: string[] = [];
    const { run: fetch } = scriptedFetch((request) => {
      if (request.method === "GET") return htmlResponse(searchableRegistryHtml("VS1"));
      posted.push(request.body ?? "");
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    await c.filteredPage({ subject: "Подстанция" }, 1);
    posted.length = 0;
    await c.filteredPage({ subject: "НКУ" }, 1);

    // submit + restore only — the panel stays expanded inside the session.
    expect(posted).toHaveLength(2);
    expect(posted[0]).toContain("j_idcl=fra%3A_t317");
    expect(posted[0]).toContain("fra%3Aj_idt216=%D0%9D%D0%9A%D0%A3");
    expect(posted[0]).not.toContain("j_idt210");
    expect(posted[1]).toContain("j_idcl=fra%3A_t331");
  });

  it("re-applies the criteria when the session died between pages", async () => {
    let bootstraps = 0;
    let pageChanges = 0;
    const { run: fetch } = scriptedFetch((request) => {
      if (request.method === "GET") {
        bootstraps += 1;
        return htmlResponse(searchableRegistryHtml(`VS${bootstraps}`));
      }
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      if (body.includes("pageChange")) {
        pageChanges += 1;
        // First pageChange answers a dead-view frame — no table update.
        return pageChanges === 1
          ? htmlResponse(
              `<?xml version="1.0"?><partial-response>` +
                `<update id="javax.faces.ViewState"><![CDATA[VSDEAD]]></update>` +
                `</partial-response>`,
            )
          : htmlResponse(filteredPageXml("VS9", "row_20"));
      }
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    await c.filteredPage({ subject: "Подстанция" }, 1);
    const page2 = await c.filteredPage({ subject: "Подстанция" }, 2);

    expect(page2.body).toContain("reestrAu_row_20");
    // Dead view → #guarded rebuilds the session: a second bootstrap GET and
    // a full re-apply (expand+submit+restore) precede the retried pageChange.
    expect(bootstraps).toBe(2);
    expect(pageChanges).toBe(2);
  });

  it("rebuilds the session after clearSearch instead of trusting the filter", async () => {
    let bootstraps = 0;
    const { run: fetch, calls } = scriptedFetch((request) => {
      if (request.method === "GET") {
        bootstraps += 1;
        return htmlResponse(searchableRegistryHtml(`VS${bootstraps}`));
      }
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      if (body.includes("pageChange")) return htmlResponse(pageChangeXml("VS5"));
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    await c.filteredPage({ subject: "Подстанция" }, 1);
    c.clearSearch();
    await c.filteredPage({ subject: "Подстанция" }, 1);

    // clearSearch dropped the session, so the same criteria re-ran the
    // whole sequence on a new bootstrap instead of trusting stale state.
    expect(bootstraps).toBe(2);
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.some((call) => call.body?.includes("j_idcl=fra%3Aj_idt210"))).toBe(true);
  });

  it("drops the filtered session for the next plain registry read", async () => {
    let bootstraps = 0;
    const { run: fetch } = scriptedFetch((request) => {
      if (request.method === "GET") {
        bootstraps += 1;
        return htmlResponse(searchableRegistryHtml(`VS${bootstraps}`));
      }
      const body = request.body ?? "";
      if (body.includes("j_idcl=fra%3Aj_idt210")) return htmlResponse(expandedHtml("VS2"));
      if (body.includes("j_idcl=fra%3A_t317")) return htmlResponse(filteredHtml("VS3"));
      if (body.includes("j_idcl=fra%3A_t331")) return htmlResponse(filteredHtml("VS4"));
      throw new Error(`unexpected post: ${body.slice(0, 140)}`);
    });
    const c = client(fetch);

    await c.filteredPage({ subject: "Подстанция" }, 1);
    await c.registryPage(1);

    // A plain registry read after a search must NOT reuse the filtered
    // session — its table is filtered and its columns were re-saved.
    expect(bootstraps).toBe(2);
  });
});

