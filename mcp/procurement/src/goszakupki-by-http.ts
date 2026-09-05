import * as tls from "node:tls";
import { SourceAccessError } from "./source-registry.js";

export interface GoszakupkiPageResponse {
  status: number;
  url: string;
  body: string;
}

export interface GoszakupkiDownloadResponse {
  status: number;
  url: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface GoszakupkiPageClient {
  get(path: string): Promise<GoszakupkiPageResponse>;
  download?(path: string): Promise<GoszakupkiDownloadResponse>;
}

export interface GoszakupkiHttpClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  requestsPerMinute?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  useSystemCa?: boolean;
  bootstrapSession?: boolean;
}

let systemCaConfigured = false;

export class GoszakupkiHttpClient implements GoszakupkiPageClient {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #minimumIntervalMs: number;
  readonly #maxResponseBytes: number;
  readonly #userAgent: string;
  readonly #circuitFailureThreshold: number;
  readonly #circuitResetMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #bootstrapSession: boolean;
  readonly #cookies = new Map<string, string>();
  #nextRequestAt = 0;
  #queue: Promise<void> = Promise.resolve();
  #consecutiveFailures = 0;
  #circuitOpenedUntil = 0;
  #sessionReady = false;
  #sessionBootstrap: Promise<void> | undefined;

  constructor(options: GoszakupkiHttpClientOptions = {}) {
    if (options.useSystemCa !== false) configureSystemCa();
    this.#baseUrl = new URL(options.baseUrl ?? "https://goszakupki.by");
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    const requestsPerMinute = options.requestsPerMinute ?? 20;
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error("requestsPerMinute must be positive");
    }
    this.#minimumIntervalMs = Math.ceil(60_000 / requestsPerMinute);
    this.#maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.#userAgent =
      options.userAgent ?? "ProcurementAIPlatform/0.1 (read-only procurement adapter)";
    this.#circuitFailureThreshold = options.circuitFailureThreshold ?? 3;
    this.#circuitResetMs = options.circuitResetMs ?? 30_000;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#bootstrapSession = options.bootstrapSession ?? true;
  }

  async get(path: string): Promise<GoszakupkiPageResponse> {
    const loaded = await this.#load(path, "html");
    return { status: loaded.status, url: loaded.url, body: loaded.body ?? "" };
  }

  async download(path: string): Promise<GoszakupkiDownloadResponse> {
    const loaded = await this.#load(path, "binary");
    return {
      status: loaded.status,
      url: loaded.url,
      bytes: loaded.bytes,
      ...(loaded.contentType === undefined ? {} : { contentType: loaded.contentType }),
    };
  }

  async #load(path: string, mode: "html" | "binary"): Promise<{
    status: number;
    url: string;
    bytes: Uint8Array;
    body?: string;
    contentType: string | undefined;
  }> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error("Goszakupki HTTP client refuses cross-origin requests");
    }
    if (this.#circuitOpenedUntil > this.#now()) {
      throw new SourceAccessError("goszakupki_by", "source circuit is open");
    }

    try {
      if (this.#bootstrapSession && url.pathname !== "/") await this.#ensureSession();
      const result = await this.#requestWithSessionRecovery(url, mode);
      this.#recordSuccess();
      return result;
    } catch (error) {
      this.#recordFailure();
      if (error instanceof SourceAccessError) throw error;
      throw new SourceAccessError("goszakupki_by", transportReason(error));
    }
  }

  async #requestWithSessionRecovery(
    url: URL,
    mode: "html" | "binary",
  ): Promise<{
    status: number;
    url: string;
    bytes: Uint8Array;
    body?: string;
    contentType: string | undefined;
  }> {
    try {
      return await this.#request(url, mode);
    } catch (error) {
      if (
        this.#bootstrapSession &&
        error instanceof SourceAccessError &&
        error.reason === "anonymous session was redirected to login"
      ) {
        this.#invalidateSession();
        await this.#ensureSession();
        return this.#request(url, mode);
      }
      throw error;
    }
  }

  async #request(
    url: URL,
    mode: "html" | "binary",
  ): Promise<{
    status: number;
    url: string;
    bytes: Uint8Array;
    body?: string;
    contentType: string | undefined;
  }> {
    await this.#reserveRequestSlot();
    const cookie = this.#cookieHeader();
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        accept: mode === "html" ? "text/html,application/xhtml+xml" : "*/*",
        "user-agent": this.#userAgent,
        ...(cookie.length === 0 ? {} : { cookie }),
      },
    });
    this.#captureCookies(response.headers);
    return this.#readResponse(response, mode);
  }

  async #ensureSession(): Promise<void> {
    if (this.#sessionReady) return;
    if (this.#sessionBootstrap !== undefined) return this.#sessionBootstrap;

    this.#sessionBootstrap = (async () => {
      const response = await this.#request(this.#baseUrl, "html");
      if (response.status < 200 || response.status >= 300) {
        throw new SourceAccessError(
          "goszakupki_by",
          `session bootstrap returned HTTP ${response.status}`,
        );
      }
      this.#sessionReady = true;
    })();
    try {
      await this.#sessionBootstrap;
    } finally {
      this.#sessionBootstrap = undefined;
    }
  }

  #invalidateSession(): void {
    this.#sessionReady = false;
    this.#cookies.clear();
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

  async #readResponse(
    response: Response,
    mode: "html" | "binary" = "html",
  ): Promise<{
    status: number;
    url: string;
    bytes: Uint8Array;
    body?: string;
    contentType: string | undefined;
  }> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
      throw new SourceAccessError("goszakupki_by", "response exceeds configured size limit");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxResponseBytes) {
      throw new SourceAccessError("goszakupki_by", "response exceeds configured size limit");
    }
    const body = new TextDecoder("utf-8").decode(bytes);
    const finalUrl = response.url.length > 0 ? response.url : this.#baseUrl.href;
    const finalLocation = new URL(finalUrl);
    if (finalLocation.origin !== this.#baseUrl.origin) {
      throw new SourceAccessError("goszakupki_by", "source redirected to another origin");
    }
    const finalPath = finalLocation.pathname;
    if (finalPath === "/site/login") {
      throw new SourceAccessError(
        "goszakupki_by",
        "anonymous session was redirected to login",
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new SourceAccessError("goszakupki_by", `source returned HTTP ${response.status}`);
    }
    if (response.status >= 500) {
      throw new SourceAccessError("goszakupki_by", `source returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en") ?? undefined;
    if (mode === "html") {
      if (
        response.status !== 404 &&
        contentType !== undefined &&
        !contentType.includes("text/html") &&
        !contentType.includes("application/xhtml+xml")
      ) {
        throw new SourceAccessError("goszakupki_by", `unexpected content type ${contentType}`);
      }
      if (looksLikeChallenge(body)) {
        throw new SourceAccessError("goszakupki_by", "source returned an anti-bot challenge");
      }
      return { status: response.status, url: finalUrl, bytes, body, contentType };
    }

    if (contentType !== undefined && contentType.includes("text/html") && looksLikeChallenge(body)) {
      throw new SourceAccessError("goszakupki_by", "source returned an anti-bot challenge");
    }
    return { status: response.status, url: finalUrl, bytes, contentType };
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

function transportReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown transport error";
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined || cause.length === 0 ? error.message : `${error.message}: ${cause}`;
}

export function configureSystemCa(): void {
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

function looksLikeChallenge(body: string): boolean {
  const normalized = body.toLocaleLowerCase("ru-BY");
  return (
    normalized.includes("g-recaptcha") ||
    normalized.includes("hcaptcha") ||
    normalized.includes("проверка, что вы не робот")
  );
}
