import { describe, expect, it } from "vitest";
import { discoveryDoneMessage, discoveryTransport } from "./discovery-transport.js";

describe("discoveryTransport", () => {
  it("defaults to one hour on Redis when REDIS_URL is set", () => {
    expect(discoveryTransport({ REDIS_URL: "redis://localhost:6379" })).toEqual({
      kind: "redis",
      intervalMs: 3_600_000,
      redisUrl: "redis://localhost:6379",
    });
  });

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

  it("names the profiles that the hourly pass searched", () => {
    expect(
      discoveryDoneMessage({
        profileNames: ["Кабель"],
        addedCount: 2,
        skippedDecidedCount: 1,
      }),
    ).toBe("Фоновый поиск выполнен (Кабель). Добавлено 2, уже решённых пропущено 1.");
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
