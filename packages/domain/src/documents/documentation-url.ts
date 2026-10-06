/** Host and URL checks for documentation that lives off goszakupki.by. */

export function isGoszakupkiHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "goszakupki.by" || host.endsWith(".goszakupki.by");
}

export function isGiasHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === "gias.by" || host.endsWith(".gias.by");
}

export function isBlockedDocumentationHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return true;
  }
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal") return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    if (inner === "::1") return true;
    if (/^fe[89ab]/i.test(inner)) return true;
    if (/^f[cd]/i.test(inner)) return true;
    const mapped = inner.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped?.[1] !== undefined) return isBlockedDocumentationHost(mapped[1]);
    return false;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 === null) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part > 255)) return true;
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isPublicDocumentationUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (isBlockedDocumentationHost(url.hostname)) return false;
  if (isGiasHost(url.hostname)) return false;
  // A label without a dot can resolve through search domains into the LAN;
  // public documentation never lives on a single-label or literal-v6 host.
  if (!url.hostname.includes(".")) return false;
  return true;
}

export function isYandexDiskHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    host === "yadi.sk" ||
    host === "disk.yandex.ru" ||
    host === "disk.yandex.com" ||
    host.endsWith(".yadi.sk") ||
    host.endsWith(".disk.yandex.ru") ||
    host.endsWith(".disk.yandex.com")
  );
}

export function looksLikeDocumentationFileName(name: string): boolean {
  return /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|rtf|odt)$/iu.test(name.trim());
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLocaleLowerCase("en-US").replace(/\.$/, "");
}
