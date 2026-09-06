import { describe, expect, it } from "vitest";
import { toIsoDateTime } from "./instant.js";

describe("toIsoDateTime", () => {
  it("turns a PostgreSQL timestamptz into an offset ISO string", () => {
    expect(toIsoDateTime("2026-09-06 12:00:00+00")).toBe("2026-09-06T12:00:00.000Z");
  });
});
