import { describe, expect, it, vi } from "vitest";
import {
  isTransientTransportError,
  retryTransientTransport,
} from "./transient-retry.js";
import { GoszakupkiHttpClient } from "./goszakupki-by-http.js";
import { SourceAccessError, SourceAbortedError } from "./source-registry.js";

function connectTimeout(): TypeError {
  const cause = Object.assign(new Error("connect ETIMEDOUT 185.204.117.147:443"), {
    code: "ETIMEDOUT",
  });
  return new TypeError("fetch failed", { cause });
}

describe("isTransientTransportError", () => {
  it("detects a wrapped connect timeout", () => {
    expect(isTransientTransportError(connectTimeout())).toBe(true);
  });

  it("detects transient codes inside an AggregateError", () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
      ],
      "fetch failed",
    );
    expect(isTransientTransportError(new TypeError("fetch failed", { cause: aggregate }))).toBe(
      true,
    );
  });

  it("treats the own request timeout as transient", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(isTransientTransportError(timeout)).toBe(true);
  });

  it("rejects permanent failures", () => {
    expect(isTransientTransportError(new Error("source returned HTTP 500"))).toBe(false);
    expect(
      isTransientTransportError(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }),
        }),
      ),
    ).toBe(false);
  });
});

describe("retryTransientTransport", () => {
  it("succeeds on the second attempt after a transient failure", async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValue("ok");

    await expect(
      retryTransientTransport("butb", operation, undefined, { sleep }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("propagates the final failure after the attempt budget", async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async (): Promise<string> => {
      throw connectTimeout();
    });

    await expect(
      retryTransientTransport("butb", operation, undefined, { sleep, attempts: 3 }),
    ).rejects.toThrow("fetch failed");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-transient error", async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async (): Promise<string> => {
      throw new SourceAccessError("butb", "source returned HTTP 500");
    });

    await expect(
      retryTransientTransport("butb", operation, undefined, { sleep }),
    ).rejects.toThrow("HTTP 500");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("converts a caller cancellation to SourceAbortedError without retrying", async () => {
    const caller = new AbortController();
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async (): Promise<string> => {
      caller.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    });

    await expect(
      retryTransientTransport("butb", operation, caller.signal, { sleep }),
    ).rejects.toThrow(SourceAbortedError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("GoszakupkiHttpClient transient retry", () => {
  it("survives a flapping link: a failed connect is retried, not fatal", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi
      .fn()
      .mockRejectedValueOnce(connectTimeout())
      .mockImplementation(async () =>
        response("<html>tenders</html>", 200, "https://goszakupki.by/tenders/posted"),
      ) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
      sleep,
    });

    await expect(client.get("/tenders/posted")).resolves.toMatchObject({ status: 200 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("still reports a sustained outage after the retry budget", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImplementation = vi.fn(async () => {
      throw connectTimeout();
    }) as unknown as typeof fetch;
    const client = new GoszakupkiHttpClient({
      fetchImplementation,
      requestsPerMinute: 60_000,
      bootstrapSession: false,
      sleep,
    });

    await expect(client.get("/tenders/posted")).rejects.toThrow(/unavailable|fetch failed/);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });
});

function response(body: string, status: number, url: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=UTF-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  const value = new Response(body, { status, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}
