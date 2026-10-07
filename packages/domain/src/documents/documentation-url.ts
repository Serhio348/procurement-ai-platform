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
  return isBlockedIpv4(a, b);
}

function isBlockedIpv4(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Checks an already-resolved IP literal, the way `dns.lookup` returns it:
 * IPv4 dotted decimal, IPv6 without brackets, optional `%zone`. Fail-closed:
 * an unrecognised shape is blocked, and IPv6 forms embedding an IPv4
 * (`::ffff:`, NAT64 `64:ff9b::`, 6to4 `2002:`) are decoded and checked too.
 */
export function isBlockedIpAddress(address: string): boolean {
  const ip = (address.trim().split("%", 1)[0] ?? "").toLocaleLowerCase("en-US");
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1).map((part) => Number(part));
    const [a, b] = octets;
    if (a === undefined || b === undefined || octets.some((part) => part > 255)) return true;
    return isBlockedIpv4(a, b);
  }
  if (!ip.includes(":")) return true;
  if (ip === "::" || ip === "::1") return true;
  if (/^f[e-f]/.test(ip)) return true; // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if (/^f[cd]/.test(ip)) return true; // ULA fc00::/7
  const mapped = ip.match(/^::ffff:(.+)$/);
  if (mapped?.[1] !== undefined) {
    const inner = decodeEmbeddedIpv4(mapped[1]);
    return inner === undefined ? true : isBlockedIpAddress(inner);
  }
  if (ip.startsWith("64:ff9b::")) {
    const inner = decodeEmbeddedIpv4(ip.slice("64:ff9b::".length));
    return inner === undefined ? true : isBlockedIpAddress(inner);
  }
  const sixToFour = ip.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (sixToFour?.[1] !== undefined && sixToFour[2] !== undefined) {
    const inner = decodeEmbeddedIpv4(`${sixToFour[1]}:${sixToFour[2]}`);
    return inner === undefined ? true : isBlockedIpAddress(inner);
  }
  return false;
}

/** "1.2.3.4" or two hextets "0a00:0001" → dotted IPv4. */
function decodeEmbeddedIpv4(text: string): string | undefined {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) return text;
  const hex = text.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] === undefined || hex[2] === undefined) return undefined;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
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

/**
 * Legal-reference and standards portals: a document may link to them
 * deliberately («нормативная база»), but they serve HTML pages, never the
 * procurement file pack. Skipping them avoids «HTML вместо файла» noise.
 */
const REFERENCE_HOST_SUFFIXES = [
  "bii.by",
  "pravo.by",
  "pravo.gov.ru",
  "tnpa.by",
  "etalonline.by",
  "tehinformer.by",
  "belstat.gov.by",
  "oos.by",
  "bss.by",
  "fundament.ru",
  "cntd.ru",
  "consultant.ru",
  "garant.ru",
  "kodeksy.by",
  "levonevski.net",
];

export function isReferenceDocumentationHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return REFERENCE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
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
