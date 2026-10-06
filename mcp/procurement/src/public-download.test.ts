import { describe, expect, it } from "vitest";
import {
  downloadPublicDocumentation,
  fetchWithValidatedRedirects,
  type PublicDocumentationFetch,
} from "./public-download.js";
import { SourceAccessError } from "./source-registry.js";

const respond = (
  status: number,
  body: string | Uint8Array = "",
  headers: Record<string, string> = {},
): Response => new Response(body, { status, headers });

const fetchFrom = (
  routes: Record<string, Response>,
  calls: string[] = [],
): PublicDocumentationFetch => {
  return async (url) => {
    const key = String(url);
    calls.push(key);
    const response = routes[key];
    if (response === undefined) throw new Error(`unexpected fetch ${key}`);
    return response;
  };
};

describe("downloadPublicDocumentation", () => {
  it("follows a redirect to another public documentation host", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const calls: string[] = [];
    const fetchImpl = fetchFrom(
      {
        "https://files.by/get/1": respond(302, "", {
          location: "https://cdn.example.by/docs/tz.pdf",
        }),
        "https://cdn.example.by/docs/tz.pdf": respond(200, bytes, {
          "content-type": "application/pdf",
        }),
      },
      calls,
    );
    const result = await downloadPublicDocumentation("https://files.by/get/1", fetchImpl);
    expect(result.bytes).toEqual(bytes);
    expect(result.contentType).toBe("application/pdf");
    expect(calls).toEqual([
      "https://files.by/get/1",
      "https://cdn.example.by/docs/tz.pdf",
    ]);
  });

  it("refuses a redirect into a private address", async () => {
    const fetchImpl = fetchFrom({
      "https://files.by/get/1": respond(302, "", { location: "http://192.168.10.4/secret" }),
    });
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("refuses a redirect back to the procurement platform", async () => {
    const fetchImpl = fetchFrom({
      "https://files.by/get/1": respond(302, "", {
        location: "https://goszakupki.by/request/view/1",
      }),
    });
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("refuses a redirect to an IPv6 internal address", async () => {
    const fetchImpl = fetchFrom({
      "https://files.by/get/1": respond(302, "", { location: "https://[fd00::5]/x" }),
    });
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("stops after the redirect limit", async () => {
    const routes: Record<string, Response> = {};
    for (let hop = 0; hop < 8; hop += 1) {
      routes[`https://files.by/hop/${String(hop)}`] = respond(302, "", {
        location: `https://files.by/hop/${String(hop + 1)}`,
      });
    }
    const fetchImpl = fetchFrom(routes);
    await expect(
      downloadPublicDocumentation("https://files.by/hop/0", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("refuses a Location that resolves to a single-label host", async () => {
    const calls: string[] = [];
    const fetchImpl = fetchFrom(
      { "https://files.by/get/1": respond(302, "", { location: "\\\\intranet" }) },
      calls,
    );
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
    expect(calls).toEqual(["https://files.by/get/1"]);
  });

  it("rejects a non-2xx final answer", async () => {
    const fetchImpl = fetchFrom({ "https://files.by/get/1": respond(404, "no") });
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("rejects an oversized body", async () => {
    const fetchImpl = fetchFrom({
      "https://files.by/get/1": respond(200, new Uint8Array(64)),
    });
    await expect(
      downloadPublicDocumentation("https://files.by/get/1", fetchImpl, { maxBytes: 8 }),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });
});

describe("fetchWithValidatedRedirects", () => {
  it("returns the terminal response without consuming its body", async () => {
    const fetchImpl = fetchFrom({
      "https://files.by/tz.pdf": respond(200, "data"),
    });
    const response = await fetchWithValidatedRedirects(
      fetchImpl,
      new URL("https://files.by/tz.pdf"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data");
  });
});
