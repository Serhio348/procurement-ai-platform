export const SESSION_COOKIE = "procurement.sid";

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

export function sessionCookie(token: string, options: { secure: boolean; maxAgeSec: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.maxAgeSec)}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", { secure, maxAgeSec: 0 });
}
