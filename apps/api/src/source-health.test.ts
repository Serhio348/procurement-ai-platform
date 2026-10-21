import { describe, expect, it, vi } from "vitest";
import { McpToolCallError, type McpToolCaller } from "@procurement/mcp-client";
import { createSourceHealthMonitor } from "./source-health.js";

const okCaller = (sources: readonly string[]): McpToolCaller => ({
  callTool: vi.fn<McpToolCaller["callTool"]>().mockResolvedValue({
    structuredContent: { sources },
  }),
});

const monitor = (now: { t: number }) =>
  createSourceHealthMonitor({ now: () => now.t, staleAfterMs: 45_000 });

describe("source health monitor (R42)", () => {
  it("keeps background and interactive state apart: live lane stays ok while a dead lane reports dead", async () => {
    const now = { t: 1_000 };
    const health = monitor(now);
    health.noteStarted("background", "goszakupki_by", okCaller(["goszakupki_by"]));
    health.noteStarted("interactive", "goszakupki_by", okCaller(["goszakupki_by"]));
    await health.probeOnce();

    health.noteClosed("background", "goszakupki_by");
    const snap = health.snapshot();
    expect(snap.lanes["background"]?.["goszakupki_by"]?.status).toBe("dead");
    expect(snap.lanes["interactive"]?.["goszakupki_by"]?.status).toBe("ok");
    // The dead lane contributes nothing to the serving set.
    expect(snap.servingSources).toEqual([]);
    expect(snap.sources).toEqual(["goszakupki_by"]);
  });

  it("marks a child that failed to spawn as not_started next to a healthy sibling", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    health.noteStarted("background", "goszakupki_by", okCaller(["goszakupki_by"]));
    health.noteFailed("background", "butb", new Error("spawn ENOENT"));
    await health.probeOnce();

    const snap = health.snapshot();
    expect(snap.lanes["background"]?.["butb"]?.status).toBe("not_started");
    expect(snap.lanes["background"]?.["butb"]?.lastError).toContain("ENOENT");
    expect(snap.lanes["background"]?.["goszakupki_by"]?.status).toBe("ok");
  });

  it("reports the answered registry verbatim — a source absent from it stays ok-but-missing", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    // The process answers, but its registry lacks the configured source.
    health.noteStarted("background", "butb", okCaller(["goszakupki_by"]));
    await health.probeOnce();

    const cell = health.snapshot().lanes["background"]?.["butb"];
    expect(cell?.status).toBe("ok");
    expect(cell?.registered).toEqual(["goszakupki_by"]);
  });

  it("a probe error is probe_failed — never confused with an answered empty registry", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    const caller: McpToolCaller = {
      callTool: vi.fn<McpToolCaller["callTool"]>().mockRejectedValue(
        new Error("timed out"),
      ),
    };
    health.noteStarted("background", "goszakupki_by", caller);
    await health.probeOnce();

    const cell = health.snapshot().lanes["background"]?.["goszakupki_by"];
    expect(cell?.status).toBe("probe_failed");
    expect(cell?.lastError).toContain("timed out");
    expect(cell?.registered).toBeUndefined();
    expect(health.snapshot().servingSources).toEqual([]);
  });

  it("a queue-expired probe keeps the last verdict — busy is not broken", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    let fail = false;
    const caller: McpToolCaller = {
      callTool: vi.fn<McpToolCaller["callTool"]>().mockImplementation(async () => {
        if (fail) {
          throw new McpToolCallError(
            "timeout",
            "procurement.sources",
            "MCP tool procurement.sources timed out waiting in the queue",
          );
        }
        return { structuredContent: { sources: ["goszakupki_by"] } };
      }),
    };
    health.noteStarted("background", "goszakupki_by", caller);
    await health.probeOnce();
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("ok");

    // The pipe is busy: the probe died in the queue without reaching the
    // child — the last real verdict stands while it is fresh.
    fail = true;
    await health.probeOnce();
    const cell = health.snapshot().lanes["background"]?.["goszakupki_by"];
    expect(cell?.status).toBe("ok");
    expect(cell?.registered).toEqual(["goszakupki_by"]);
    expect(cell?.lastError).toContain("waiting in the queue");

    // Age it past the freshness window — sustained busyness ages the
    // verdict into an honest stale, never a fabricated probe_failed.
    now.t += 46_000;
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("stale");
  });

  it("a busy pipe that never answers stays pending — not 'not registered'", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    const caller: McpToolCaller = {
      callTool: vi.fn<McpToolCaller["callTool"]>().mockImplementation(
        () => new Promise(() => undefined), // queue holds it forever
      ),
    };
    health.noteStarted("background", "goszakupki_by", caller);
    const probe = health.probeOnce(); // in flight, never resolves
    now.t += 60_000;

    const cell = health.snapshot().lanes["background"]?.["goszakupki_by"];
    // Probe has not finished: the cell must not claim any registry answer.
    expect(cell?.status).toBe("pending");
    expect(cell?.registered).toBeUndefined();
    probe.catch(() => undefined);
  });

  it("a finished probe older than the freshness window reads as stale", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    health.noteStarted("background", "goszakupki_by", okCaller(["goszakupki_by"]));
    await health.probeOnce();
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("ok");

    now.t += 46_000;
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("stale");
  });

  it("a partial failure keeps the healthy child's data intact", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    health.noteStarted("background", "goszakupki_by", okCaller(["goszakupki_by"]));
    health.noteStarted("background", "butb", {
      callTool: vi.fn<McpToolCaller["callTool"]>().mockRejectedValue(new Error("pipe closed")),
    });
    await health.probeOnce();

    const snap = health.snapshot();
    expect(snap.lanes["background"]?.["goszakupki_by"]?.status).toBe("ok");
    expect(snap.lanes["background"]?.["butb"]?.status).toBe("probe_failed");
    expect(snap.sources).toEqual(["goszakupki_by"]);
    expect(snap.servingSources).toEqual(["goszakupki_by"]);
  });

  it("reading the snapshot never touches a caller — repeated health costs zero pipe work", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    const caller = okCaller(["goszakupki_by"]);
    health.noteStarted("background", "goszakupki_by", caller);
    await health.probeOnce();
    expect(caller.callTool).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 5; index += 1) health.snapshot();
    expect(caller.callTool).toHaveBeenCalledTimes(1);
  });

  it("an in-flight probe blocks the next cycle — probes cannot pile onto a busy queue", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    let release!: () => void;
    const caller: McpToolCaller = {
      callTool: vi
        .fn<McpToolCaller["callTool"]>()
        .mockImplementation(
          () => new Promise((resolve) => {
            release = () => resolve({ structuredContent: { sources: ["goszakupki_by"] } });
          }),
        ),
    };
    health.noteStarted("background", "goszakupki_by", caller);
    const first = health.probeOnce();
    await health.probeOnce(); // skipped: cycle already running
    release();
    await first;
    expect(caller.callTool).toHaveBeenCalledTimes(1);
  });

  it("a close event overrides a previously healthy probe — lifecycle beats cached registry", async () => {
    const now = { t: 0 };
    const health = monitor(now);
    health.noteStarted("background", "goszakupki_by", okCaller(["goszakupki_by"]));
    await health.probeOnce();
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("ok");

    health.noteClosed("background", "goszakupki_by");
    expect(health.snapshot().lanes["background"]?.["goszakupki_by"]?.status).toBe("dead");
  });
});
