import { describe, expect, it } from "vitest";
import {
  isBlockedDocumentationHost,
  isBlockedIpAddress,
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

  it("blocks resolved addresses an attacker DNS could return", () => {
    for (const blocked of [
      "10.0.0.5",
      "192.168.1.20",
      "169.254.169.254",
      "172.16.0.8",
      "127.0.0.1",
      "::1",
      "::",
      "fd00::5",
      "fe80::a00:27ff:fe8e:1234",
      "fec0::5",
      "ff02::1",
      "::ffff:10.0.0.5",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b::10.0.0.1",
      "2002:0a00:0001::",
      "fe80::5%eth0",
      "not-an-ip",
      "",
    ]) {
      expect(isBlockedIpAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ["93.184.216.34", "178.124.130.200", "2606:4700:4700::1111"]) {
      expect(isBlockedIpAddress(allowed), allowed).toBe(false);
    }
  });
});
