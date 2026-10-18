import { Agent, fetch as undiciFetch } from "undici";
import { readFileSync } from "node:fs";
import * as tls from "node:tls";
import { butbPartialUpdate, parseButbViewState, type ButbViewState } from "./butb-parser.js";
import { SourceAccessError } from "./source-registry.js";

export interface ButbPage {
  status: number;
  url: string;
  body: string;
}

export interface ButbDownload {
  status: number;
  url: string;
  bytes: Uint8Array;
  contentType?: string;
}

/** Structural port so tests can fake the session without HTTP. */
export interface ButbPageClient {
  registryPage(page: number): Promise<ButbPage>;
  openCard(cardLinkId: string): Promise<ButbPage>;
  download(path: string): Promise<ButbDownload>;
  /**
   * Runs `fn` holding the session lock. A card link id is valid only while
   * the session's table shows its row, so «scan pages → openCard» must run
   * as one atomic sequence — other calls wait until `fn` resolves.
   */
  withSession<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Transport for zakupki.butb.by — an ICEfaces/JSF server-side-session site.
 * Three conversation shapes, all verified live:
 *
 *  1. `GET /auctions/reestrauctions.html` opens an anonymous session:
 *     cookies + `javax.faces.ViewState` + `ice.window`/`ice.view` tokens.
 *     The registry table renders fully only on this pristine view.
 *  2. `POST` with `javax.faces.behavior.event=pageChange` paginates the
 *     registry and answers a partial-response XML whose
 *     `<update id="fra:reestrAu">` CDATA carries the next page's table.
 *  3. `POST` `{cardLinkId: cardLinkId}` (a row's name-link component id)
 *     302-redirects to `/auctions/viewinvitation.html` — the card exists
 *     only inside the session.
 *
 * The search panel is intentionally unused: expanding it permanently
 * degrades the session's table to a single «Вид закупки» column, so the
 * source filters rows locally instead. Returning to the registry after a
 * card page degrades the table the same way — once a card was opened the
 * session is finished and a fresh one must be bootstrapped.
 */
export interface ButbHttpClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  requestsPerMinute?: number;
  maxResponseBytes?: number;
  maxDownloadBytes?: number;
  userAgent?: string;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const REGISTRY_PATH = "/auctions/reestrauctions.html";
const CARD_PATH = "/auctions/viewinvitation.html";
const TABLE_ID = "fra:reestrAu";
const REGISTRY_PAGE_SIZE = 20;

/**
 * The registry answers a plain GET with whatever page the session's table
 * is on, not with page 1 — so the only ground truth about position is the
 * absolute row index inside `fra:reestrAu:<index>:_tNNN` link ids.
 */
function detectRegistryPage(body: string): number | undefined {
  const match = /reestrAu:(\d+):/.exec(body);
  if (match === null) return undefined;
  return Math.floor(Number(match[1]) / REGISTRY_PAGE_SIZE) + 1;
}

export class ButbHttpClient implements ButbPageClient {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #minimumIntervalMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxDownloadBytes: number;
  readonly #userAgent: string;
  readonly #circuitFailureThreshold: number;
  readonly #circuitResetMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #cookies = new Map<string, string>();
  #nextRequestAt = 0;
  #queue: Promise<void> = Promise.resolve();
  #consecutiveFailures = 0;
  #circuitOpenedUntil = 0;
  #state: ButbViewState | undefined;
  #sessionBootstrap: Promise<ButbPage> | undefined;
  /** Which JSF view the session currently renders. */
  #view: "registry" | "card" = "registry";
  /** Page the session's registry table actually shows (detected, not asked). */
  #currentPage: number | undefined;
  /** Whole-operation lock; #queue only paces individual requests. */
  #operationQueue: Promise<void> = Promise.resolve();
  /** >0 while inside withSession — inner calls skip the lock. */
  #sessionDepth = 0;

  constructor(options: ButbHttpClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? "https://zakupki.butb.by");
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    const requestsPerMinute = options.requestsPerMinute ?? 20;
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error("requestsPerMinute must be positive");
    }
    this.#minimumIntervalMs = Math.ceil(60_000 / requestsPerMinute);
    this.#maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? 512 * 1024 * 1024;
    this.#userAgent =
      options.userAgent ?? "ProcurementAIPlatform/0.1 (read-only procurement adapter)";
    this.#circuitFailureThreshold = options.circuitFailureThreshold ?? 3;
    this.#circuitResetMs = options.circuitResetMs ?? 30_000;
    this.#fetch = options.fetchImplementation ?? createDefaultFetch();
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /**
   * Page `page` (1-based) of the registry. A GET on the registry URL does
   * NOT reset the table — the server answers with the page the session is
   * already on — so navigation beyond the freshly-bootstrapped view always
   * goes through pageChange postbacks. After a card was opened the whole
   * session is degraded, so it is dropped and rebuilt instead of reused.
   */
  async registryPage(page: number): Promise<ButbPage> {
    if (page < 1) throw new Error("registryPage pages are 1-based");
    return this.#serialized(() => this.#guarded(async () => {
      if (this.#view === "card") this.#resetSession();
      const boot = await this.#ensureSession();
      if (boot !== undefined && this.#currentPage === page) return boot;
      const body = await this.#pageChange(page);
      return { status: 200, url: this.#registryUrl(), body };
    }));
  }

  /**
   * Opens the card behind a row's name-link component id. The link id only
   * exists while the session's dataTable shows the row's page — callers must
   * page to it first. Returns the rendered card page.
   */
  async openCard(cardLinkId: string): Promise<ButbPage> {
    if (!/^fra:reestrAu:\d+:_t\d+$/.test(cardLinkId)) {
      throw new Error(`not a registry row link id: ${cardLinkId}`);
    }
    return this.#serialized(() => this.#guarded(async () => {
      // A row link id only resolves while the registry table renders its
      // page — and a card view leaves the session degraded, so reopen.
      if (this.#view === "card") this.#resetSession();
      await this.#ensureSession();
      return this.#postbackForCard(cardLinkId);
    }));
  }

  async download(path: string): Promise<ButbDownload> {
    return this.#serialized(() => this.#guarded(async () => {
      const url = new URL(path, this.#baseUrl);
      if (url.origin !== this.#baseUrl.origin) {
        throw new SourceAccessError("butb", "refused cross-origin download");
      }
      await this.#ensureSession();
      const loaded = await this.#request(url, "binary");
      return {
        status: loaded.status,
        url: loaded.url,
        bytes: loaded.bytes,
        ...(loaded.contentType === undefined ? {} : { contentType: loaded.contentType }),
      };
    }));
  }

  async withSession<T>(fn: () => Promise<T>): Promise<T> {
    return this.#serialized(async () => {
      this.#sessionDepth += 1;
      try {
        return await fn();
      } finally {
        this.#sessionDepth -= 1;
      }
    });
  }

  /**
   * FIFO lock over session-mutating calls. The JSF view is one shared
   * mutable cursor: without this, a pageChange of one logical operation can
   * land between another's locate and card postback. `withSession` holds the
   * lock across several calls — inner calls see #sessionDepth and pass
   * through instead of deadlocking on it.
   */
  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#sessionDepth > 0) return operation();
    const previous = this.#operationQueue;
    let release = (): void => undefined;
    this.#operationQueue = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Circuit, retry-once-on-expired-view and error normalization. */
  async #guarded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#circuitOpenedUntil > this.#now()) {
      throw new SourceAccessError("butb", "source circuit is open");
    }
    try {
      try {
        const result = await operation();
        this.#recordSuccess();
        return result;
      } catch (error) {
        if (error instanceof ButbViewExpiredError) {
          // Session/view died: reopen and run the operation once more.
          this.#invalidateSession();
          const result = await operation();
          this.#recordSuccess();
          return result;
        }
        throw error;
      }
    } catch (error) {
      this.#recordFailure();
      if (error instanceof SourceAccessError) throw error;
      throw new SourceAccessError("butb", transportReason(error));
    }
  }

  /**
   * Opens the session if needed. Returns the freshly rendered registry page
   * when a bootstrap GET happened, undefined when a session was already live.
   */
  async #ensureSession(): Promise<ButbPage | undefined> {
    if (this.#state !== undefined) return undefined;
    if (this.#sessionBootstrap !== undefined) return this.#sessionBootstrap;
    this.#sessionBootstrap = (async () => {
      const page = await this.#request(new URL(REGISTRY_PATH, this.#baseUrl), "html");
      if (page.status < 200 || page.status >= 300) {
        throw new SourceAccessError("butb", `session bootstrap returned HTTP ${page.status}`);
      }
      this.#adoptRegistry(page.body);
      if (this.#state === undefined) {
        throw new SourceAccessError("butb", "registry page carries no JSF view state");
      }
      return { status: page.status, url: page.url, body: page.body };
    })();
    try {
      return await this.#sessionBootstrap;
    } finally {
      this.#sessionBootstrap = undefined;
    }
  }

  /** Adopts JSF state and records which registry page was actually rendered. */
  #adoptRegistry(body: string): void {
    this.#adoptState(body);
    this.#view = "registry";
    this.#currentPage = detectRegistryPage(body) ?? this.#currentPage ?? 1;
  }

  /**
   * Drops the whole server-side session — cookies included. A degraded
   * registry table (seen after card views and the search panel) survives
   * plain GETs on the same jsessionid, so the session cannot be salvaged.
   */
  #resetSession(): void {
    this.#state = undefined;
    this.#cookies.clear();
    this.#currentPage = undefined;
    this.#view = "registry";
  }

  #invalidateSession(): void {
    this.#resetSession();
  }

  #adoptState(html: string): void {
    const parsed = parseButbViewState(html);
    if (parsed === undefined) return;
    // ice.window/ice.view live on the page, not in partial responses —
    // keep the previously captured values when the update omits them.
    const iceWindow = parsed.iceWindow ?? this.#state?.iceWindow;
    const iceView = parsed.iceView ?? this.#state?.iceView;
    const formAction = parsed.formAction ?? this.#state?.formAction;
    this.#state = {
      viewState: parsed.viewState,
      ...(iceWindow === undefined ? {} : { iceWindow }),
      ...(iceView === undefined ? {} : { iceView }),
      ...(formAction === undefined ? {} : { formAction }),
    };
  }

  async #pageChange(page: number): Promise<string> {
    const state = this.#requireState();
    const fields: Record<string, string> = {
      "javax.faces.source": TABLE_ID,
      "javax.faces.partial.ajax": "true",
      "javax.faces.partial.execute": TABLE_ID,
      "javax.faces.partial.render": TABLE_ID,
      "javax.faces.behavior.event": "pageChange",
      [`${TABLE_ID}_paging`]: "true",
      [`${TABLE_ID}_page`]: String(page),
      [`${TABLE_ID}_rows`]: "20",
      "ice.submit.partial": "true",
      "ice.event.captured": TABLE_ID,
      "ice.event.type": "onpagechange",
    };
    const response = await this.#post(state, fields, { ajax: true });
    const table = butbPartialUpdate(response.body, TABLE_ID);
    if (table === undefined) {
      // Any framed answer without our table means the view no longer
      // matches the session: a full page, a bare ViewState update, or an
      // ICEfaces <error>/<redirect> partial-response — reopen once.
      if (
        response.body.includes("ViewState") ||
        response.body.includes("<html") ||
        response.body.includes("partial-response")
      ) {
        throw new ButbViewExpiredError();
      }
      const snippet = response.body.replace(/\s+/g, " ").slice(0, 160);
      throw new SourceAccessError(
        "butb",
        `pageChange returned no table update (HTTP ${String(response.status)}): ${snippet}`,
      );
    }
    this.#adoptState(response.body);
    this.#view = "registry";
    this.#currentPage = detectRegistryPage(table) ?? page;
    return table;
  }

  async #postbackForCard(cardLinkId: string): Promise<ButbPage> {
    const state = this.#requireState();
    // mojarra.jsfcljs convention: the link posts its own id as name=value.
    const response = await this.#post(state, { [cardLinkId]: cardLinkId }, { ajax: false });
    if (!response.redirectedToCard) {
      // Redirected back to the registry with a fresh jsessionid = dead view.
      if (response.url.includes("reestrauctions")) throw new ButbViewExpiredError();
      throw new SourceAccessError(
        "butb",
        `card postback did not redirect (HTTP ${String(response.status)})`,
      );
    }
    const cardUrl = new URL(response.url, this.#baseUrl);
    const card = await this.#request(cardUrl, "html");
    this.#view = "card";
    return card;
  }

  async #post(
    state: ButbViewState,
    fields: Record<string, string>,
    options: { ajax: boolean },
  ): Promise<{ status: number; url: string; body: string; redirectedToCard: boolean }> {
    await this.#reserveRequestSlot();
    const action = state.formAction ?? REGISTRY_PATH;
    const params = new URLSearchParams();
    params.set("fra", "fra");
    params.set("javax.faces.ViewState", state.viewState);
    if (state.iceWindow !== undefined) params.set("ice.window", state.iceWindow);
    if (state.iceView !== undefined) params.set("ice.view", state.iceView);
    for (const [key, value] of Object.entries(fields)) params.set(key, value);

    const url = new URL(action, this.#baseUrl);
    const cookie = this.#cookieHeader();
    const response = await this.#fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.#userAgent,
        referer: this.#registryUrl(),
        ...(options.ajax
          ? { "faces-request": "partial/ajax", "x-requested-with": "XMLHttpRequest" }
          : {}),
        ...(cookie.length === 0 ? {} : { cookie }),
      },
      body: params.toString(),
    });
    this.#captureCookies(response.headers);

    const location = response.headers.get("location");
    if (location !== null && (response.status === 301 || response.status === 302)) {
      const target = new URL(location, this.#baseUrl);
      if (target.pathname.endsWith(CARD_PATH)) {
        return {
          status: response.status,
          url: target.href,
          body: "",
          redirectedToCard: true,
        };
      }
      return {
        status: response.status,
        url: target.href,
        body: "",
        redirectedToCard: false,
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxResponseBytes) {
      throw new SourceAccessError("butb", "response exceeds configured size limit");
    }
    const body = new TextDecoder("utf-8").decode(bytes);
    return { status: response.status, url: response.url, body, redirectedToCard: false };
  }

  #requireState(): ButbViewState {
    if (this.#state === undefined) throw new ButbViewExpiredError();
    return this.#state;
  }

  #registryUrl(): string {
    return new URL(REGISTRY_PATH, this.#baseUrl).href;
  }

  async #request(
    url: URL,
    mode: "html" | "binary",
  ): Promise<{ status: number; url: string; bytes: Uint8Array; body: string; contentType?: string }> {
    if (url.origin !== this.#baseUrl.origin) {
      throw new SourceAccessError("butb", "refused cross-origin request");
    }
    await this.#reserveRequestSlot();
    const cookie = this.#cookieHeader();
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        accept: mode === "html" ? "text/html,application/xhtml+xml" : "*/*",
        "user-agent": this.#userAgent,
        referer: this.#registryUrl(),
        ...(cookie.length === 0 ? {} : { cookie }),
      },
    });
    this.#captureCookies(response.headers);

    const limit = mode === "binary" ? this.#maxDownloadBytes : this.#maxResponseBytes;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      throw new SourceAccessError("butb", "response exceeds configured size limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new SourceAccessError("butb", "response exceeds configured size limit");
    }
    const body = new TextDecoder("utf-8").decode(bytes);
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new SourceAccessError("butb", `source returned HTTP ${response.status}`);
    }
    const finalUrl = response.url.length > 0 ? response.url : url.href;
    if (new URL(finalUrl).origin !== this.#baseUrl.origin) {
      throw new SourceAccessError("butb", "source redirected to another origin");
    }
    return {
      status: response.status,
      url: finalUrl,
      bytes,
      body,
      ...(response.headers.get("content-type") === null
        ? {}
        : { contentType: response.headers.get("content-type")! }),
    };
  }

  #captureCookies(headers: Headers): void {
    const values =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [headers.get("set-cookie")].filter((value): value is string => value !== null);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
      if (cookieValue.length === 0) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }

  #cookieHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async #reserveRequestSlot(): Promise<void> {
    const previous = this.#queue;
    let release = (): void => undefined;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#nextRequestAt - this.#now());
      if (waitMs > 0) await this.#sleep(waitMs);
      this.#nextRequestAt = this.#now() + this.#minimumIntervalMs;
    } finally {
      release();
    }
  }

  #recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#circuitOpenedUntil = 0;
  }

  #recordFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#circuitFailureThreshold) {
      this.#circuitOpenedUntil = this.#now() + this.#circuitResetMs;
      this.#consecutiveFailures = 0;
    }
  }
}

/**
 * The session's JSF view died (or a card postback resolved against a fresh
 * session where the row link id does not exist). Exported so a caller whose
 * operation spans several calls — locate-then-open — can retry the whole
 * sequence, which the per-call retry inside `#guarded` cannot do.
 */
export class ButbViewExpiredError extends SourceAccessError {
  constructor() {
    super("butb", "JSF view expired");
    this.name = "ButbViewExpiredError";
  }
}

function transportReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown transport error";
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined || cause.length === 0 ? error.message : `${error.message}: ${cause}`;
}

let systemCaConfigured = false;

function configureSystemCa(): void {
  if (systemCaConfigured) return;
  if (
    typeof tls.getCACertificates === "function" &&
    typeof tls.setDefaultCACertificates === "function"
  ) {
    tls.setDefaultCACertificates([
      ...tls.getCACertificates("default"),
      ...tls.getCACertificates("system"),
    ]);
  }
  systemCaConfigured = true;
}

const linuxCaBundle = "/etc/ssl/certs/ca-certificates.crt";

function createDefaultFetch(): typeof fetch {
  configureSystemCa();
  const insecure = process.env["BUTB_TLS_INSECURE"] === "1";
  const bundles: Array<string | Buffer> = [];
  const extra = process.env["NODE_EXTRA_CA_CERTS"]?.trim();
  for (const file of [extra, linuxCaBundle]) {
    if (file === undefined || file.length === 0) continue;
    try {
      bundles.push(readFileSync(file));
    } catch {
      // Optional bundle path differs across platforms.
    }
  }
  const agent = new Agent({
    connect: {
      rejectUnauthorized: !insecure,
      ...(bundles.length > 0 ? { ca: bundles } : {}),
    },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return ((input, init) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher: agent })) as typeof fetch;
}
