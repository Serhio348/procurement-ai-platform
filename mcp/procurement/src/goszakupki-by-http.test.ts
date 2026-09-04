import { describe, expect, it, vi } from "vitest";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import type { SourceAccessError } from "./source-registry.js";

describe("GoszakupkiHttpClient", () => {
  it("bootstraps an anonymous cookie session before opening the tender list", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://goszakupki.by/") {
        return response("<html>home</html>", 200, url, "PHPSESSID=anonymous; Path=/; HttpOnly");
      }
      expect(new Headers(init?.headers).get("cookie")).toBe("PHPSESSID=anonymous");
      return response("<html>tenders</html>", 200, url);
    }) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
    });

    await expect(client.get("/tenders/posted")).resolves.toMatchObject({
      status: 200,
      url: "https://goszakupki.by/tenders/posted",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("maps a repeated login redirect to source_unavailable semantics", async () => {
    const fetchImplementation = vi.fn(async () =>
      response("<html>login</html>", 200, "https://goszakupki.by/site/login"),
    ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
    });

    await expect(client.get("/tenders/posted")).rejects.toEqual(
      expect.objectContaining<Partial<SourceAccessError>>({
        name: "SourceAccessError",
        reason: "anonymous session was redirected to login",
      }),
    );
  });

  it("rejects anti-bot pages even when the HTTP status is successful", async () => {
    const fetchImplementation = vi.fn(async () =>
      response(
        "<html><div class='g-recaptcha'></div></html>",
        200,
        "https://goszakupki.by/auction/view/1",
      ),
    ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
    });

    await expect(client.get("/auction/view/1")).rejects.toThrow(/anti-bot challenge/);
  });

  it("returns a 404 response so the source adapter can map record identity", async () => {
    const fetchImplementation = vi.fn(async () =>
      response("not found", 404, "https://goszakupki.by/request/view/999"),
    ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
    });

    await expect(client.get("/request/view/999")).resolves.toMatchObject({ status: 404 });
  });

  it("serializes request starts according to the configured source rate", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchImplementation = vi.fn(async () =>
      response("<html></html>", 200, "https://goszakupki.by/auction/view/1"),
    ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 20,
      now: () => now,
      sleep,
      bootstrapSession: false,
    });

    await Promise.all([client.get("/auction/view/1"), client.get("/auction/view/1")]);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("opens the circuit after repeated transport failures", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      circuitFailureThreshold: 2,
      now: () => 1_000,
      sleep: async () => undefined,
      bootstrapSession: false,
    });

    await expect(client.get("/auction/view/1")).rejects.toThrow(/network down/);
    await expect(client.get("/auction/view/1")).rejects.toThrow(/network down/);
    await expect(client.get("/auction/view/1")).rejects.toThrow(/circuit is open/);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("downloads a binary attachment that is not HTML", async () => {
    const fetchImplementation = vi.fn(async () => {
      const headers = new Headers({
        "content-type": "application/pdf",
        "content-length": "4",
      });
      const value = new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers });
      Object.defineProperty(value, "url", {
        value: "https://goszakupki.by/files/get?id=1&download=1",
      });
      return value;
    }) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
    });

    const file = await client.download("/files/get?id=1&download=1");
    expect(file.status).toBe(200);
    expect(file.contentType).toContain("pdf");
    expect([...file.bytes]).toEqual([37, 80, 68, 70]);
  });

  it("refuses to turn a source path into a cross-origin request", async () => {
    const client = new GoszakupkiHttpClient();

    await expect(client.get("https://example.test/card")).rejects.toThrow(/cross-origin/);
  });

  it("rejects a cross-origin redirect returned by the source", async () => {
    const fetchImplementation = vi.fn(async () =>
      response("<html></html>", 200, "https://example.test/card"),
    ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
    });

    await expect(client.get("/auction/view/1")).rejects.toThrow(/another origin/);
  });
});

function response(body: string, status: number, url: string, setCookie?: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=UTF-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  if (setCookie !== undefined) headers.append("set-cookie", setCookie);
  const value = new Response(body, {
    status,
    headers,
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}
