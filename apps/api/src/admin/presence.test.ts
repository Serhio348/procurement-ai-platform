import { describe, expect, it } from "vitest";
import { formatPresenceDuration } from "./presence.js";

describe("formatPresenceDuration", () => {
  it("uses minutes, then hours, and does not invent a visit shorter than a minute", () => {
    expect(formatPresenceDuration("2026-09-06T12:00:00.000Z", "2026-09-06T12:00:40.000Z")).toBe(
      "менее минуты",
    );
    expect(formatPresenceDuration("2026-09-06T12:00:00.000Z", "2026-09-06T12:12:00.000Z")).toBe(
      "12 мин",
    );
    expect(formatPresenceDuration("2026-09-06T12:00:00.000Z", "2026-09-06T14:00:00.000Z")).toBe(
      "2 ч",
    );
    expect(formatPresenceDuration("2026-09-06T12:00:00.000Z", "2026-09-06T13:07:00.000Z")).toBe(
      "1 ч 7 мин",
    );
  });
});
