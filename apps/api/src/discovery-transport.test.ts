import { describe, expect, it } from "vitest";
import { discoveryTransport } from "./discovery-transport.js";

describe("discoveryTransport", () => {
  it("uses Redis when REDIS_URL is set and the interval is positive", () => {
    expect(
      discoveryTransport({
        REDIS_URL: "redis://localhost:6379",
        SPECIALIST_DISCOVERY_INTERVAL_MS: "600000",
      }),
    ).toEqual({
      kind: "redis",
      intervalMs: 600_000,
      redisUrl: "redis://localhost:6379",
    });
  });

  it("falls back to an in-process timer when Redis is not configured", () => {
    expect(discoveryTransport({ SPECIALIST_DISCOVERY_INTERVAL_MS: "1000" })).toEqual({
      kind: "interval",
      intervalMs: 1000,
    });
  });

  it("stays off when the interval is disabled", () => {
    expect(
      discoveryTransport({
        REDIS_URL: "redis://localhost:6379",
        SPECIALIST_DISCOVERY_INTERVAL_MS: "0",
      }),
    ).toEqual({ kind: "off" });
  });
});
