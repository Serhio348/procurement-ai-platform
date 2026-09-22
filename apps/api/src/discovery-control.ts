import { McpToolCallError } from "@procurement/mcp-client";
import type { SpecialistDiscoveryHealth } from "@procurement/contracts";

export type DiscoveryStartResult =
  | { kind: "started" }
  | { kind: "busy" }
  | { kind: "cooldown" };

export interface DiscoveryResult {
  ran: boolean;
  reason: "watch_off" | "no_keywords" | "ok" | "already_running" | "cooldown";
  addedCount: number;
  skippedDecidedCount: number;
}

export interface DiscoveryController {
  tryStart(now: Date): DiscoveryStartResult;
  finish(result: DiscoveryResult, now: Date): void;
  recordFailure(error: unknown, now: Date): void;
  beforeRequest(now: Date): Promise<void>;
  health(watchingCount: number): SpecialistDiscoveryHealth;
}

export interface CreateDiscoveryControllerOptions {
  requestIntervalMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Process-scoped safety around background discovery. It refuses overlapping
 * passes, opens a circuit after consecutive source outages, and spaces out
 * source requests so a live search cannot hammer the site.
 *
 * State is kept in memory on purpose: a restart resets the counter, which is
 * safer than persisting a stale lock or an outdated circuit.
 */
export function createDiscoveryController(
  options: CreateDiscoveryControllerOptions = {},
): DiscoveryController {
  // Spacing is opt-in here; the production default lives in main.ts env
  // parsing (SPECIALIST_DISCOVERY_REQUEST_INTERVAL_MS, default 5 s).
  const requestIntervalMs = options.requestIntervalMs ?? 0;
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 30 * 60 * 1000;

  let isRunning = false;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let lastAddedCount: number | undefined;
  let lastSkippedCount: number | undefined;
  let lastErrorAt: string | undefined;
  let lastRequestAt = 0;
  let consecutiveFailures = 0;
  let circuitOpen = false;
  let cooldownUntil = 0;

  function isSourceOutage(error: unknown): boolean {
    if (error instanceof McpToolCallError) {
      return error.kind === "source_unavailable" || error.kind === "timeout";
    }
    if (typeof error === "object" && error !== null && "kind" in error) {
      const kind = (error as { kind: unknown }).kind;
      return kind === "source_unavailable" || kind === "timeout";
    }
    return false;
  }

  return {
    tryStart(now) {
      if (isRunning) return { kind: "busy" };
      if (circuitOpen && now.getTime() < cooldownUntil) return { kind: "cooldown" };
      // Cooldown expired: allow one probe. A failure will re-open the circuit.
      circuitOpen = false;
      isRunning = true;
      startedAt = now.toISOString();
      return { kind: "started" };
    },

    finish(result, now) {
      isRunning = false;
      finishedAt = now.toISOString();
      lastAddedCount = result.addedCount;
      lastSkippedCount = result.skippedDecidedCount;
      if (result.ran && result.reason === "ok") {
        consecutiveFailures = 0;
        circuitOpen = false;
        cooldownUntil = 0;
      }
    },

    recordFailure(error, now) {
      isRunning = false;
      finishedAt = now.toISOString();
      lastErrorAt = now.toISOString();
      if (isSourceOutage(error)) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failureThreshold) {
          circuitOpen = true;
          cooldownUntil = now.getTime() + cooldownMs;
        }
      }
    },

    async beforeRequest(now) {
      if (requestIntervalMs <= 0) return;
      const waitMs = lastRequestAt + requestIntervalMs - now.getTime();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastRequestAt = Date.now();
    },

    health(watchingCount) {
      return {
        isRunning,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(lastAddedCount === undefined ? {} : { lastAddedCount }),
        ...(lastSkippedCount === undefined ? {} : { lastSkippedCount }),
        ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
        ...(circuitOpen ? { cooldownUntil: new Date(cooldownUntil).toISOString() } : {}),
        consecutiveFailures,
        circuitOpen,
        watchingCount,
        intervalMs: requestIntervalMs,
      };
    },
  };
}
