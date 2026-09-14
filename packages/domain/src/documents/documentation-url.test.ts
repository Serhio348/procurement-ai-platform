import { describe, expect, it } from "vitest";
import {
  isBlockedDocumentationHost,
  isGiasHost,
  isPublicDocumentationUrl,
  isYandexDiskHost,
  looksLikeDocumentationFileName,
} from "./documentation-url.js";

describe("documentation URLs", () => {
  it("refuses loopback and RFC1918 hosts", () => {
    expect(isBlockedDocumentationHost("localhost")).toBe(true);
    expect(isBlockedDocumentationHost("127.0.0.1")).toBe(true);
    expect(isBlockedDocumentationHost("10.0.0.4")).toBe(true);
    expect(isBlockedDocumentationHost("192.168.1.1")).toBe(true);
    expect(isBlockedDocumentationHost("disk.yandex.ru")).toBe(false);
  });

  it("allows a public https disk link and skips GIAS invitations", () => {
    expect(isPublicDocumentationUrl(new URL("https://disk.yandex.ru/d/abc"))).toBe(true);
    expect(isPublicDocumentationUrl(new URL("https://gias.by/gias/#/x"))).toBe(false);
    expect(isPublicDocumentationUrl(new URL("file:///tmp/tz.pdf"))).toBe(false);
    expect(isGiasHost("gias.by")).toBe(true);
    expect(isYandexDiskHost("disk.yandex.ru")).toBe(true);
    expect(looksLikeDocumentationFileName("ТЗ.zip")).toBe(true);
    expect(looksLikeDocumentationFileName("readme")).toBe(false);
  });
});
