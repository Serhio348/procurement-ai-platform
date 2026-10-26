import { throwIfAborted } from "./source-registry.js";

/**
 * Transport codes worth a retry: flapping WAN links and DNS resolvers.
 * Permanent failures (TLS errors, HTTP statuses, parse failures) are
 * deliberately absent — retrying those cannot help and only adds delay.
 */
const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * A failure is transient when a transient errno appears anywhere in the
 * cause chain — undici wraps connect errors in a TypeError and may
 * aggregate several resolved addresses into an AggregateError. The
 * client's own per-request AbortSignal.timeout surfaces as TimeoutError,
 * which is transient by definition.
 */
export function isTransientTransportError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const seen = new Set<unknown>();
  const check = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const row = value as { code?: unknown; errors?: unknown; cause?: unknown };
    if (typeof row.code === "string" && TRANSIENT_CODES.has(row.code)) return true;
    if (Array.isArray(row.errors) && row.errors.some(check)) return true;
    return check(row.cause);
  };
  return check(error);
}

export interface TransientRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base delay; attempt N waits delayMs × N before retrying. */
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Retries a transport operation only on transient network failures, so a
 * seconds-long link flap no longer fails the whole source call. The
 * caller's signal always wins — a cancellation is rethrown as
 * SourceAbortedError and never retried. A final failure propagates the
 * original error, so the circuit breaker still sees a sustained outage.
 */
export async function retryTransientTransport<T>(
  sourceId: string,
  operation: () => Promise<T>,
  callerSignal: AbortSignal | undefined,
  options: TransientRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  const delayMs = Math.max(0, options.delayMs ?? 1_000);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      throwIfAborted(sourceId, callerSignal);
      if (attempt >= attempts || !isTransientTransportError(error)) throw error;
      await sleep(delayMs * attempt);
      throwIfAborted(sourceId, callerSignal);
    }
  }
}
