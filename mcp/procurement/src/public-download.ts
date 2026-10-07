import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ProcurementFileBytes } from "@procurement/contracts";
import {
  isBlockedDocumentationHost,
  isBlockedIpAddress,
  isGoszakupkiHost,
  isPublicDocumentationUrl,
  isYandexDiskHost,
} from "@procurement/domain";
import { SourceAccessError } from "./source-registry.js";
import { Agent, request as undiciRequest } from "undici";

export interface PublicDocumentationFetch {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type PublicAddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: PublicAddressResolver = (hostname) =>
  new Promise((resolvePromise, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) reject(error);
      else resolvePromise(addresses);
    });
  });

/**
 * A public-looking hostname may resolve to an internal address (DNS
 * rebinding). Every resolved address is vetted, and any private or
 * unrecognised answer fails the whole lookup — a CDN legitimately returns
 * public addresses only.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolve: PublicAddressResolver = systemResolver,
): Promise<ResolvedAddress[]> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new SourceAccessError(
      "goszakupki_by",
      `DNS lookup for ${hostname} returned no addresses`,
    );
  }
  const blocked = addresses.find((entry) => isBlockedIpAddress(entry.address));
  if (blocked !== undefined) {
    throw new SourceAccessError(
      "goszakupki_by",
      `DNS lookup for ${hostname} resolved to a blocked address`,
    );
  }
  return addresses;
}

/**
 * The socket connects to an already-validated address from the single
 * lookup above, so a TTL-flip between "check" and "connect" cannot smuggle
 * an internal target past the vetting.
 */
function createPinnedLookup(resolve: PublicAddressResolver): LookupFunction {
  return (hostname, options, callback) => {
    void resolvePublicAddresses(hostname, resolve).then(
      (addresses) => {
        if ("all" in options && options.all === true) {
          callback(null, addresses, 0);
          return;
        }
        const first = addresses[0];
        if (first === undefined) {
          callback(new Error(`DNS lookup for ${hostname} returned no addresses`), "", 0);
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), "", 0);
      },
    );
  };
}

/**
 * Global `fetch` hides 3xx responses under `redirect:"manual"` (the spec's
 * opaqueredirect filter), which makes per-hop SSRF validation impossible.
 * This adapter exposes the raw status and Location header instead, and its
 * dispatcher pins connections to DNS answers vetted by
 * `resolvePublicAddresses`.
 */
export function createSafePublicFetch(
  resolve: PublicAddressResolver = systemResolver,
): PublicDocumentationFetch {
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(resolve) as LookupFunction },
  });
  return async (url, init) => {
    const { statusCode, headers, body } = await undiciRequest(String(url), {
      method: (init?.method ?? "GET") as "GET",
      dispatcher,
      ...(init?.headers === undefined ? {} : { headers: init.headers as Record<string, string> }),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") responseHeaders.set(name, value);
      else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
    }
    const webBody = Readable.toWeb(body as unknown as Readable) as ReadableStream;
    return new Response(webBody, { status: statusCode, headers: responseHeaders });
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

export async function downloadPublicDocumentation(
  downloadUrl: string,
  fetchImpl: PublicDocumentationFetch,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ProcurementFileBytes> {
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new SourceAccessError("goszakupki_by", "document URL is not valid");
  }
  if (!isPublicDocumentationUrl(parsed) || isGoszakupkiHost(parsed.hostname)) {
    throw new SourceAccessError("goszakupki_by", "document URL is not a public documentation host");
  }
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const target = await resolvePublicDownloadUrl(parsed, fetchImpl, timeoutMs);
  const response = await fetchWithValidatedRedirects(fetchImpl, target, timeoutMs);
  if (response.status < 200 || response.status >= 300) {
    throw new SourceAccessError(
      "goszakupki_by",
      `document download returned unexpected HTTP ${String(response.status)}`,
    );
  }
  const bytes = await readCappedBytes(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  return { bytes, contentType };
}

/**
 * Document links come from untrusted file contents: a public-looking URL may
 * redirect to an internal address. `redirect:"follow"` cannot vet hops, so
 * each Location is validated before the next request goes out.
 */
export async function fetchWithValidatedRedirects(
  fetchImpl: PublicDocumentationFetch,
  url: URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxHops = MAX_REDIRECT_HOPS,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "*/*", "user-agent": "ProcurementAIPlatform/0.1 (documentation fetch)" },
    });
    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect || location === null) return response;
    await response.arrayBuffer().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SourceAccessError("goszakupki_by", "document download returned an invalid redirect");
    }
    if (!isPublicDocumentationUrl(next) || isGoszakupkiHost(next.hostname)) {
      throw new SourceAccessError(
        "goszakupki_by",
        `document download redirected to a blocked host ${next.hostname}`,
      );
    }
    current = next;
  }
  throw new SourceAccessError("goszakupki_by", "document download exceeded the redirect limit");
}

export async function resolvePublicDownloadUrl(
  url: URL,
  fetchImpl: PublicDocumentationFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<URL> {
  const driveId = googleDriveFileId(url);
  if (driveId !== undefined) {
    return new URL(`https://drive.google.com/uc?export=download&id=${driveId}`);
  }
  const direct = directShareDownloadUrl(url);
  if (direct !== undefined) return direct;
  if (!isYandexDiskHost(url.hostname)) return url;
  const api = new URL("https://cloud-api.yandex.net/v1/disk/public/resources/download");
  api.searchParams.set("public_key", url.href);
  const response = await fetchImpl(api, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "ProcurementAIPlatform/0.1 (documentation fetch)" },
  });
  if (response.status < 200 || response.status >= 300) return url;
  const body = (await response.json()) as { href?: unknown };
  if (typeof body.href !== "string" || body.href.length === 0) return url;
  try {
    const href = new URL(body.href);
    if (isBlockedDocumentationHost(href.hostname)) return url;
    return href;
  } catch {
    return url;
  }
}

/**
 * Share pages show a «Скачать» button to a browser; each supported shape has
 * a deterministic direct form, so no HTML/JS is ever executed.
 * - Nextcloud/ownCloud `host/s/<token>` → `host/s/<token>/download` returns
 *   the file (or a zip of the shared folder).
 * - Dropbox preview `?dl=0` → `?dl=1`.
 */
function directShareDownloadUrl(url: URL): URL | undefined {
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    if (url.searchParams.get("dl") === "1") return url;
    const next = new URL(url.href);
    next.searchParams.set("dl", "1");
    return next;
  }
  if (/^\/(?:index\.php\/)?s\/[A-Za-z0-9]{8,}\/?$/.test(url.pathname)) {
    const next = new URL(url.href);
    next.pathname = `${url.pathname.replace(/\/$/, "")}/download`;
    return next;
  }
  return undefined;
}

function googleDriveFileId(url: URL): string | undefined {
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (host !== "drive.google.com" && host !== "docs.google.com") return undefined;
  const fromPath = url.pathname.match(/\/file\/d\/([^/]+)/);
  if (fromPath?.[1] !== undefined) return fromPath[1];
  const fromQuery = url.searchParams.get("id");
  return fromQuery === null || fromQuery.length === 0 ? undefined : fromQuery;
}

async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new SourceAccessError(
        "goszakupki_by",
        `document download exceeded size limit ${String(maxBytes)}`,
      );
    }
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new SourceAccessError(
      "goszakupki_by",
      `document download exceeded size limit ${String(maxBytes)}`,
    );
  }
  return buffer;
}
