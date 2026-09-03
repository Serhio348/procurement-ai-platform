/**
 * Content-addressed versions. The same bytes are the same document version;
 * a new hash is a new version. Recency never overwrites the old blob.
 */

export interface ContentVersionInput {
  newHash: string;
  previousHash?: string;
  previousVersion?: number;
}

export type ContentVersionDecision =
  | { status: "unchanged"; version: number }
  | { status: "new"; version: number };

export function resolveContentVersion(input: ContentVersionInput): ContentVersionDecision {
  if (input.newHash.length !== 64) {
    throw new Error("newHash must be a sha256 hex digest");
  }
  if (input.previousHash !== undefined && input.previousHash === input.newHash) {
    return { status: "unchanged", version: input.previousVersion ?? 1 };
  }
  if (input.previousVersion === undefined || input.previousHash === undefined) {
    return { status: "new", version: 1 };
  }
  return { status: "new", version: input.previousVersion + 1 };
}

export function blobStorageKey(hash: string): `blobs/${string}` {
  if (hash.length !== 64) throw new Error("hash must be a sha256 hex digest");
  return `blobs/${hash}`;
}
