import { randomUUID } from "node:crypto";
import {
  ProcurementSourcesRequest,
  ProcurementSourcesResponse,
  RequestId,
} from "@procurement/contracts";
import {
  McpToolCallError,
  callValidatedTool,
  ToolPolicyGate,
  type McpToolCaller,
} from "@procurement/mcp-client";
import { silentLogger, type Logger } from "@procurement/observability";

export type LaneSourceStatus =
  | "ok"
  | "not_started"
  | "dead"
  | "probe_failed"
  | "stale"
  | "pending";

/**
 * One lane×source cell as /api/health reports it. `registered` is the last
 * source list the child's own registry answered — it proves the MCP process
 * answers and knows the source, never that the external site is reachable.
 */
export interface LaneSourceHealth {
  status: LaneSourceStatus;
  alive: boolean;
  lastError?: string;
  lastProbeAt?: string;
  lastOkAt?: string;
  registered?: readonly string[];
}

export interface SourcesHealthSnapshot {
  lanes: Record<string, Record<string, LaneSourceHealth>>;
  /** Union of registries answered by live lanes — for components.sources. */
  sources: readonly string[];
  /** Sources currently "ok" on the background lane — the serving set. */
  servingSources: readonly string[];
}

interface Entry {
  readonly lane: string;
  readonly sourceId: string;
  caller?: McpToolCaller;
  started: boolean;
  alive: boolean;
  lastError: string | undefined;
  probe: {
    running: boolean;
    lastStartedAt?: number;
    lastFinishedAt?: number;
    ok: boolean;
    registered: readonly string[] | undefined;
  };
}

export interface SourceHealthMonitor {
  /** The child connected — its caller is attached for probing. */
  noteStarted(lane: string, sourceId: string, caller: McpToolCaller): void;
  /** Spawn failed at boot — the source never entered this lane's pipe. */
  noteFailed(lane: string, sourceId: string, error: unknown): void;
  /** The stdio transport closed — the process is gone, not merely slow. */
  noteClosed(lane: string, sourceId: string, error?: unknown): void;
  /**
   * One probe cycle: sequential per child so a burst cannot pile onto a
   * busy pipe, and skipped entirely while a cycle is still in flight —
   * repeated calls never grow the queue.
   */
  probeOnce(): Promise<void>;
  /** Periodic probing. The timer is unref'd — it never holds the process. */
  start(): void;
  stop(): void;
  /** Instant answer for /api/health — reads the cache, never the pipe. */
  snapshot(): SourcesHealthSnapshot;
}

export function createSourceHealthMonitor(options: {
  logger?: Logger;
  /** Per-probe budget — covers queue wait plus execution on that pipe. */
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Finished probes older than this stop being fresh evidence. */
  staleAfterMs?: number;
  now?: () => number;
}): SourceHealthMonitor {
  const logger = options.logger ?? silentLogger;
  const probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
  const probeIntervalMs = options.probeIntervalMs ?? 15_000;
  const staleAfterMs = options.staleAfterMs ?? 45_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const gate = new ToolPolicyGate({ agentAllowedTools: ["procurement.sources"] });
  let timer: ReturnType<typeof setInterval> | undefined;

  const key = (lane: string, sourceId: string) => `${lane}|${sourceId}`;
  const entry = (lane: string, sourceId: string): Entry => {
    const existing = entries.get(key(lane, sourceId));
    if (existing !== undefined) return existing;
    const created: Entry = {
      lane,
      sourceId,
      started: false,
      alive: false,
      lastError: undefined,
      probe: { running: false, ok: false, registered: undefined },
    };
    entries.set(key(lane, sourceId), created);
    return created;
  };

  const probeEntry = async (item: Entry): Promise<void> => {
    if (item.caller === undefined || item.probe.running) return;
    item.probe.running = true;
    item.probe.lastStartedAt = now();
    try {
      const result = await callValidatedTool({
        toolName: "procurement.sources",
        input: {},
        inputSchema: ProcurementSourcesRequest,
        outputSchema: ProcurementSourcesResponse,
        caller: item.caller,
        policyGate: gate,
        requestId: RequestId.parse(randomUUID()),
        timeoutMs: probeTimeoutMs,
        // High priority jumps the pipe's queue ahead of bulk search work:
        // a probe on a busy-but-healthy child only waits for the in-flight
        // request instead of expiring behind every queued page read — a
        // slow source must not flap "не отвечает" while it is just working.
        priority: "high",
        logger,
      });
      item.probe.ok = true;
      item.probe.registered = result.sources.map(String);
      item.lastError = undefined;
    } catch (error) {
      item.probe.ok = false;
      item.probe.registered = undefined;
      // "not connected" means the routing map knows the child died — treat it
      // as a process-level fact, not a probe glitch.
      if (error instanceof McpToolCallError && error.kind === "source_unavailable") {
        item.alive = false;
      }
      item.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      item.probe.running = false;
      item.probe.lastFinishedAt = now();
    }
  };

  const statusOf = (item: Entry): LaneSourceStatus => {
    if (!item.started) return "not_started";
    if (!item.alive) return "dead";
    const finished = item.probe.lastFinishedAt;
    if (finished === undefined) return "pending";
    if (now() - finished > staleAfterMs) return "stale";
    return item.probe.ok ? "ok" : "probe_failed";
  };

  return {
    noteStarted(lane, sourceId, caller) {
      const item = entry(lane, sourceId);
      item.caller = caller;
      item.started = true;
      item.alive = true;
    },
    noteFailed(lane, sourceId, error) {
      const item = entry(lane, sourceId);
      item.started = false;
      item.alive = false;
      item.lastError = error instanceof Error ? error.message : String(error);
    },
    noteClosed(lane, sourceId, error) {
      const item = entry(lane, sourceId);
      item.alive = false;
      if (error !== undefined) {
        item.lastError = error instanceof Error ? error.message : String(error);
      }
    },
    async probeOnce() {
      // One probe per child at a time (probe.running) — children run in
      // parallel because each owns a separate pipe. No global in-flight
      // flag: a hung probe on one child must not stall every sibling's
      // freshness, and repeat calls just skip entries already probing.
      await Promise.all(
        [...entries.values()]
          .filter((item) => item.started && item.alive && !item.probe.running)
          .map((item) => probeEntry(item)),
      );
    },
    start() {
      if (timer !== undefined) return;
      void this.probeOnce();
      timer = setInterval(() => {
        void this.probeOnce();
      }, probeIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    snapshot() {
      const lanes: Record<string, Record<string, LaneSourceHealth>> = {};
      const registered = new Set<string>();
      const serving = new Set<string>();
      for (const item of entries.values()) {
        const status = statusOf(item);
        (lanes[item.lane] ??= {})[item.sourceId] = {
          status,
          alive: item.alive,
          ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
          ...(item.probe.lastFinishedAt === undefined
            ? {}
            : { lastProbeAt: new Date(item.probe.lastFinishedAt).toISOString() }),
          ...(item.probe.ok && item.probe.lastFinishedAt !== undefined
            ? { lastOkAt: new Date(item.probe.lastFinishedAt).toISOString() }
            : {}),
          ...(item.probe.registered === undefined
            ? {}
            : { registered: item.probe.registered }),
        };
        if (status === "ok" && item.probe.registered !== undefined) {
          for (const source of item.probe.registered) registered.add(source);
        }
        // Serving means the child answers *and* registers this source — a
        // live process that dropped it from the registry cannot serve it.
        if (
          item.lane === "background" &&
          status === "ok" &&
          item.probe.registered?.includes(item.sourceId) === true
        ) {
          serving.add(item.sourceId);
        }
      }
      return {
        lanes,
        sources: [...registered].sort(),
        servingSources: [...serving].sort(),
      };
    },
  };
}
