/**
 * Links embedded inside downloaded attachments (DOCX hyperlinks, PDF
 * annotations, plain text URLs) may point at the real documentation pack.
 * Selection lives here so the rules stay pure; byte/HTML/annotation digging
 * lives next to the extractors in mcp/documents.
 */

import {
  isBlockedDocumentationHost,
  isGoszakupkiHost,
  isPublicDocumentationUrl,
  isYandexDiskHost,
  looksLikeDocumentationFileName,
} from "./documentation-url.js";

/** Safety bound: a hostile or bloated document cannot fan out the ingest. */
export const MAX_DOCUMENT_LINKS_PER_FILE = 8;
export const MAX_LINKED_DOCUMENTS_PER_JOB = 24;
/** One document may point at a file that itself points further — two hops max. */
export const MAX_DOCUMENT_LINK_DEPTH = 2;

const LINK_FRAGMENT_PREFIX = "link/";
const TRAILING_JUNK = /[.,;:!?)\]}"'»’”\u00a0]+$/u;
const URL_PATTERN = /https?:\/\/[^\s<>"'«»“”(){}[\]|\\^`]+/giu;

const SHARE_HOST_SUFFIXES = [
  "yadi.sk",
  "dropbox.com",
  "dropboxusercontent.com",
  "1drv.ms",
  "onedrive.live.com",
  "sharepoint.com",
  "box.com",
  "mega.nz",
  "mega.co.nz",
  "proton.me",
  "terabox.com",
];

export function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_JUNK, "");
    if (raw.length > "https://a.by".length) urls.push(raw);
  }
  return urls;
}

/** Nextcloud/ownCloud/Seafile share links look like `host/s/<token>` on any host. */
export function isDocumentationShareLink(url: URL): boolean {
  if (/^\/(?:index\.php\/)?s\/[^/]+/.test(url.pathname)) return true;
  if (isYandexDiskHost(url.hostname)) return true;
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (host === "drive.google.com" || host === "docs.google.com") return true;
  return SHARE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * A goszakupki link inside a document is noise unless it names a file
 * download endpoint — card and legal-reference links are navigation.
 */
export function isGoszakupkiFileLink(url: URL): boolean {
  if (!isGoszakupkiHost(url.hostname)) return false;
  const path = url.pathname.toLocaleLowerCase("en-US");
  if (path.includes("/get-file") || path.includes("/files/get")) return true;
  return url.searchParams.has("download") || url.searchParams.has("downloadzip");
}

export type DocumentLinkRejectReason =
  | "not_documentation"
  | "blocked_host"
  | "platform_page"
  | "unsupported_scheme"
  | "duplicate"
  | "self";

export interface DocumentLinkSelection {
  accepted: string[];
  rejected: { url: string; reason: DocumentLinkRejectReason }[];
}

/**
 * `embedded` candidates are deliberately placed hyperlinks (DOCX rels, PDF
 * annotations) — any public URL qualifies. Plain-text URLs must additionally
 * name a document file or a known share shape, or they are navigation noise.
 */
export function selectDocumentLinkCandidates(
  candidates: readonly { url: string; embedded: boolean }[],
  options: { excludeUrls?: ReadonlySet<string>; maxPerFile?: number } = {},
): DocumentLinkSelection {
  const max = options.maxPerFile ?? MAX_DOCUMENT_LINKS_PER_FILE;
  const accepted: string[] = [];
  const rejected: { url: string; reason: DocumentLinkRejectReason }[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (accepted.length >= max) break;
    const normalized = normalizeLinkUrl(candidate.url);
    if (normalized === undefined) continue;
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      rejected.push({ url: candidate.url, reason: "unsupported_scheme" });
      continue;
    }
    if (isBlockedDocumentationHost(url.hostname)) {
      rejected.push({ url: normalized, reason: "blocked_host" });
      continue;
    }
    if (isGoszakupkiHost(url.hostname)) {
      if (!isGoszakupkiFileLink(url)) {
        rejected.push({ url: normalized, reason: "platform_page" });
        continue;
      }
    } else if (!isPublicDocumentationUrl(url)) {
      rejected.push({ url: normalized, reason: "blocked_host" });
      continue;
    }
    if (options.excludeUrls?.has(normalized) === true) {
      rejected.push({ url: normalized, reason: "self" });
      continue;
    }
    if (seen.has(normalized)) {
      rejected.push({ url: normalized, reason: "duplicate" });
      continue;
    }
    if (!candidate.embedded && !qualifiesAsPlainTextLink(url)) {
      rejected.push({ url: normalized, reason: "not_documentation" });
      continue;
    }
    seen.add(normalized);
    accepted.push(normalized);
  }
  return { accepted, rejected };
}

function qualifiesAsPlainTextLink(url: URL): boolean {
  return (
    looksLikeDocumentationFileName(url.pathname) ||
    isDocumentationShareLink(url) ||
    isGoszakupkiFileLink(url)
  );
}

/** Dedup key for a discovered link — one fetch per normalized URL per job. */
export function normalizeLinkUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hash === "#" || url.hash === "") url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Provenance for a file fetched through a link inside a parent document:
 * the link URL rides in the fragment, chained after an existing archive
 * fragment so `#member/x.docx/link/<enc>` still reads as archive lineage.
 */
export function linkedDocumentSourceUrl(parentSourceUrl: string, linkUrl: string): string {
  const url = new URL(parentSourceUrl);
  const inherited = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  url.hash =
    inherited.length === 0
      ? `${LINK_FRAGMENT_PREFIX}${encodeURIComponent(linkUrl)}`
      : `${inherited}/${LINK_FRAGMENT_PREFIX}${encodeURIComponent(linkUrl)}`;
  return url.href;
}

export function isLinkedDocumentSourceUrl(sourceUrl: string): boolean {
  try {
    const hash = new URL(sourceUrl).hash;
    return hash.startsWith(`#${LINK_FRAGMENT_PREFIX}`) || hash.includes(`/${LINK_FRAGMENT_PREFIX}`);
  } catch {
    return false;
  }
}

/** Best-effort filename for a linked file — the path basename or the host. */
export function linkedDocumentName(linkUrl: string): string {
  try {
    const url = new URL(linkUrl);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (last.length > 0 && last !== url.hostname) return clip(last, 120);
    return clip(url.hostname, 120);
  } catch {
    return clip(linkUrl, 120);
  }
}

export function linkedDocumentDisplayName(parentName: string, linkUrl: string): string {
  return clip(`${linkedDocumentName(linkUrl)} — ссылка из «${parentName}»`, 160);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
