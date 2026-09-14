import {
  SourceDocument,
  type IsoDateTime,
  type SourceDocument as SourceDocumentValue,
} from "@procurement/contracts";
import {
  isGoszakupkiHost,
  isPublicDocumentationUrl,
  isYandexDiskHost,
  looksLikeDocumentationFileName,
} from "@procurement/domain";
import * as cheerio from "cheerio";
import type { PublicDocumentationFetch } from "./public-download.js";

const MAX_EXPANDED_FILES = 40;

interface YandexResource {
  type?: unknown;
  name?: unknown;
  file?: unknown;
  path?: unknown;
  _embedded?: { items?: unknown };
}

/**
 * A storage URL on the card is not itself the TZ. Resolve Yandex public
 * folders and HTML indexes into downloadable files before ingest.
 */
export async function expandPublicDocumentation(
  documents: readonly SourceDocumentValue[],
  fetchImpl: PublicDocumentationFetch,
  now: () => IsoDateTime,
): Promise<SourceDocumentValue[]> {
  const expanded: SourceDocumentValue[] = [];
  const seen = new Set<string>();
  const add = (document: SourceDocumentValue): void => {
    if (seen.has(document.sourceUrl) || seen.has(document.downloadUrl ?? "")) return;
    seen.add(document.sourceUrl);
    if (document.downloadUrl !== undefined) seen.add(document.downloadUrl);
    expanded.push(document);
  };

  for (const document of documents) {
    const target = document.downloadUrl ?? document.sourceUrl;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      add(document);
      continue;
    }
    if (!isPublicDocumentationUrl(url) || isGoszakupkiHost(url.hostname)) {
      add(document);
      continue;
    }
    try {
      if (isYandexDiskHost(url.hostname)) {
        const listed = await listYandexPublic(url, fetchImpl, document, now());
        if (listed.length > 0) {
          for (const item of listed) add(item);
          continue;
        }
      }
      const fromPage = await listHtmlDocumentation(url, fetchImpl, document, now());
      if (fromPage.length > 0) {
        for (const item of fromPage) add(item);
        continue;
      }
    } catch {
      add(document);
      continue;
    }
    add(document);
  }
  return expanded;
}

async function listYandexPublic(
  url: URL,
  fetchImpl: PublicDocumentationFetch,
  listed: SourceDocumentValue,
  discoveredAt: IsoDateTime,
): Promise<SourceDocumentValue[]> {
  const api = new URL("https://cloud-api.yandex.net/v1/disk/public/resources");
  api.searchParams.set("public_key", url.href);
  api.searchParams.set("limit", String(MAX_EXPANDED_FILES));
  const response = await fetchImpl(api, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json", "user-agent": "ProcurementAIPlatform/0.1 (documentation fetch)" },
  });
  if (response.status < 200 || response.status >= 300) return [];
  const body = (await response.json()) as YandexResource;
  if (body.type === "file") {
    const file = asDownloadUrl(body.file);
    if (file === undefined) return [];
    return [
      SourceDocument.parse({
        name: asName(body.name) ?? listed.name,
        sourceUrl: url.href,
        downloadUrl: file,
        mimeType: listed.mimeType,
        discoveredAt,
      }),
    ];
  }
  const items = Array.isArray(body._embedded?.items) ? body._embedded.items : [];
  const documents: SourceDocumentValue[] = [];
  for (const raw of items) {
    if (documents.length >= MAX_EXPANDED_FILES) break;
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as YandexResource;
    if (item.type !== "file") continue;
    const file = asDownloadUrl(item.file);
    const name = asName(item.name);
    if (file === undefined || name === undefined) continue;
    documents.push(
      SourceDocument.parse({
        name,
        sourceUrl: file,
        downloadUrl: file,
        mimeType: mimeFromName(name),
        discoveredAt,
      }),
    );
  }
  return documents;
}

async function listHtmlDocumentation(
  url: URL,
  fetchImpl: PublicDocumentationFetch,
  listed: SourceDocumentValue,
  discoveredAt: IsoDateTime,
): Promise<SourceDocumentValue[]> {
  if (looksLikeDocumentationFileName(url.pathname) || looksLikeDocumentationFileName(listed.name)) {
    return [];
  }
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "ProcurementAIPlatform/0.1 (documentation fetch)",
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status < 200 || response.status >= 300) return [];
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return [];
  const html = await response.text();
  const $ = cheerio.load(html);
  const documents: SourceDocumentValue[] = [];
  $("a[href]").each((_, element) => {
    if (documents.length >= MAX_EXPANDED_FILES) return;
    const href = $(element).attr("href");
    const label = $(element).text().replace(/\s+/g, " ").trim();
    if (href === undefined) return;
    let absolute: URL;
    try {
      absolute = new URL(href, url);
    } catch {
      return;
    }
    if (!isPublicDocumentationUrl(absolute)) return;
    if (
      !looksLikeDocumentationFileName(absolute.pathname) &&
      !looksLikeDocumentationFileName(label)
    ) {
      return;
    }
    const name = label.length > 0 ? label : (absolute.pathname.split("/").at(-1) ?? listed.name);
    documents.push(
      SourceDocument.parse({
        name,
        sourceUrl: absolute.href,
        downloadUrl: absolute.href,
        mimeType: mimeFromName(name),
        discoveredAt,
      }),
    );
  });
  return documents;
}

function asDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

function asName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mimeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "zip") return "application/zip";
  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === "doc") return "application/msword";
  return "application/octet-stream";
}
