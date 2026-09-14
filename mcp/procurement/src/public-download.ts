import type { ProcurementFileBytes } from "@procurement/contracts";
import {
  isBlockedDocumentationHost,
  isGoszakupkiHost,
  isPublicDocumentationUrl,
  isYandexDiskHost,
} from "@procurement/domain";
import { SourceAccessError } from "./source-registry.js";

export interface PublicDocumentationFetch {
  (url: string | URL, init?: RequestInit): Promise<Response>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

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
  const response = await fetchImpl(target, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "*/*", "user-agent": "ProcurementAIPlatform/0.1 (documentation fetch)" },
  });
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

export async function resolvePublicDownloadUrl(
  url: URL,
  fetchImpl: PublicDocumentationFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<URL> {
  const driveId = googleDriveFileId(url);
  if (driveId !== undefined) {
    return new URL(`https://drive.google.com/uc?export=download&id=${driveId}`);
  }
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
