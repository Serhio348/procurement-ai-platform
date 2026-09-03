import { createHash } from "node:crypto";
import { Sha256 as Sha256Schema, type Sha256 } from "@procurement/contracts";

export interface StoredBlob {
  hash: Sha256;
  storageKey: `blobs/${string}`;
  contentType: string;
  bytes: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): Sha256 {
  return Sha256Schema.parse(createHash("sha256").update(bytes).digest("hex"));
}

function storageKey(hash: Sha256): `blobs/${string}` {
  return `blobs/${hash}`;
}

export class MemoryBlobStore {
  readonly #blobs = new Map<string, StoredBlob>();

  put(bytes: Uint8Array, contentType: string): StoredBlob {
    const hash = sha256Hex(bytes);
    const existing = this.#blobs.get(hash);
    if (existing !== undefined) return existing;
    const stored: StoredBlob = {
      hash,
      storageKey: storageKey(hash),
      contentType,
      bytes,
    };
    this.#blobs.set(hash, stored);
    return stored;
  }

  get(hash: string): StoredBlob | undefined {
    return this.#blobs.get(hash);
  }

  exists(hash: string): boolean {
    return this.#blobs.has(hash);
  }

  list(): StoredBlob[] {
    return [...this.#blobs.values()].sort((left, right) => left.hash.localeCompare(right.hash));
  }
}
