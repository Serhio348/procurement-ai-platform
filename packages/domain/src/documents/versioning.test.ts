import { describe, expect, it } from "vitest";
import { blobStorageKey, resolveContentVersion } from "./versioning.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("resolveContentVersion", () => {
  it("keeps the existing version when the content hash did not change", () => {
    expect(
      resolveContentVersion({ newHash: hashA, previousHash: hashA, previousVersion: 2 }),
    ).toEqual({ status: "unchanged", version: 2 });
  });

  it("opens version 1 for a first download and increments when bytes change", () => {
    expect(resolveContentVersion({ newHash: hashA })).toEqual({ status: "new", version: 1 });
    expect(
      resolveContentVersion({ newHash: hashB, previousHash: hashA, previousVersion: 1 }),
    ).toEqual({ status: "new", version: 2 });
  });
});

describe("blobStorageKey", () => {
  it("addresses blobs by hash so duplicates are not stored twice", () => {
    expect(blobStorageKey(hashA)).toBe(`blobs/${hashA}`);
  });
});
