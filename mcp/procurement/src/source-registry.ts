import { SourceId, type ProcurementSourcePort } from "@procurement/contracts";

export class SourceUnavailableError extends Error {
  constructor(readonly sourceId: string) {
    super(`Procurement source ${sourceId} is not configured`);
    this.name = "SourceUnavailableError";
  }
}

export class SourceAccessError extends Error {
  constructor(
    readonly sourceId: string,
    readonly reason: string,
  ) {
    super(`Procurement source ${sourceId} is unavailable: ${reason}`);
    this.name = "SourceAccessError";
  }
}

export class SourceRecordNotFoundError extends Error {
  constructor(
    readonly sourceId: string,
    readonly sourceProcurementId: string,
  ) {
    super(`Source record ${sourceId}/${sourceProcurementId} not found`);
    this.name = "SourceRecordNotFoundError";
  }
}

/**
 * The caller's deadline fired and the MCP layer cancelled the call. Kept
 * apart from SourceAccessError on purpose: a cancellation is not a transport
 * failure — it must not count against the circuit breaker or read as
 * "source unavailable".
 */
export class SourceAbortedError extends Error {
  constructor(readonly sourceId: string) {
    super(`Operation on ${sourceId} was cancelled by the caller`);
    this.name = "SourceAbortedError";
  }
}

/** Raises SourceAbortedError when the caller's signal already fired. */
export function throwIfAborted(sourceId: string, signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new SourceAbortedError(sourceId);
}

export class ProcurementSourceRegistry {
  readonly #sources: ReadonlyMap<string, ProcurementSourcePort>;

  constructor(sources: readonly ProcurementSourcePort[]) {
    const entries = new Map<string, ProcurementSourcePort>();
    for (const source of sources) {
      if (entries.has(source.sourceId)) {
        throw new Error(`Duplicate procurement source: ${source.sourceId}`);
      }
      entries.set(source.sourceId, source);
    }
    this.#sources = entries;
  }

  get(sourceId: SourceId): ProcurementSourcePort {
    const source = this.#sources.get(sourceId);
    if (source === undefined) throw new SourceUnavailableError(sourceId);
    return source;
  }

  list(): SourceId[] {
    return [...this.#sources.keys()].map((id) => SourceId.parse(id));
  }
}
