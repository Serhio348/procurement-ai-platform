import type { ProcurementSourcePort, SourceId } from "@procurement/contracts";

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
}
