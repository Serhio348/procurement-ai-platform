import { describe, expect, it } from "vitest";
import { MemoryBlobStore, sha256Hex } from "./blob-store.js";

describe("MemoryBlobStore", () => {
  it("does not store the same bytes twice", () => {
    const store = new MemoryBlobStore();
    const bytes = new TextEncoder().encode("same-content");
    const first = store.put(bytes, "text/plain");
    const second = store.put(bytes, "text/plain");
    expect(first.hash).toBe(sha256Hex(bytes));
    expect(second.hash).toBe(first.hash);
    expect(store.list()).toHaveLength(1);
  });
});
