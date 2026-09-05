import { describe, expect, it } from "vitest";
import { blobStorageKey } from "./specialist-store.js";

describe("blobStorageKey", () => {
  it("keeps the sha256 as the object name so PostgreSQL stores the hash, not the bytes", () => {
    const hash = "a".repeat(64);
    expect(blobStorageKey(hash)).toBe(`blobs/${hash}`);
  });
});
