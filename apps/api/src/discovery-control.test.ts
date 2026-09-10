import { describe, expect, it } from "vitest";
import { McpToolCallError } from "@procurement/mcp-client";
import { createDiscoveryController, type DiscoveryResult } from "./discovery-control.js";

describe("discovery-control", () => {
  it("allows a fresh pass to start", () => {
    const controller = createDiscoveryController();
    expect(controller.tryStart(new Date("2026-09-02T00:00:00Z"))).toEqual({ kind: "started" });
  });

  it("refuses a second overlapping pass", () => {
    const controller = createDiscoveryController();
    const now = new Date("2026-09-02T00:00:00Z");
    controller.tryStart(now);
    expect(controller.tryStart(now)).toEqual({ kind: "busy" });
  });

  it("opens a circuit after repeated source outages", () => {
    const controller = createDiscoveryController({ failureThreshold: 2, cooldownMs: 60_000 });
    const base = new Date("2026-09-02T00:00:00Z").getTime();

    controller.tryStart(new Date(base));
    controller.recordFailure(
      new McpToolCallError("source_unavailable", "procurement.search", "blocked"),
      new Date(base),
    );
    expect(controller.health(1).consecutiveFailures).toBe(1);
    expect(controller.health(1).circuitOpen).toBe(false);

    controller.tryStart(new Date(base + 1));
    controller.recordFailure(
      new McpToolCallError("timeout", "procurement.search", "slow"),
      new Date(base + 1),
    );
    const after = controller.health(1);
    expect(after.consecutiveFailures).toBe(2);
    expect(after.circuitOpen).toBe(true);
    expect(after.cooldownUntil).toBe(new Date(base + 1 + 60_000).toISOString());
  });

  it("ignores non-source failures for the circuit", () => {
    const controller = createDiscoveryController({ failureThreshold: 1 });
    const now = new Date("2026-09-02T00:00:00Z");
    controller.tryStart(now);
    controller.recordFailure(new Error("something else"), now);
    expect(controller.health(1).circuitOpen).toBe(false);
  });

  it("stays in cooldown until the cooldown window passes", () => {
    const controller = createDiscoveryController({ failureThreshold: 1, cooldownMs: 60_000 });
    const base = new Date("2026-09-02T00:00:00Z").getTime();
    controller.tryStart(new Date(base));
    controller.recordFailure(
      new McpToolCallError("source_unavailable", "procurement.search", "blocked"),
      new Date(base),
    );
    expect(controller.tryStart(new Date(base))).toEqual({ kind: "cooldown" });
    expect(controller.tryStart(new Date(base + 60_000))).toEqual({ kind: "started" });
  });

  it("resets failure count after a successful pass", () => {
    const controller = createDiscoveryController({ failureThreshold: 1, cooldownMs: 60_000 });
    const now = new Date("2026-09-02T00:00:00Z");
    controller.tryStart(now);
    controller.recordFailure(
      new McpToolCallError("source_unavailable", "procurement.search", "blocked"),
      now,
    );
    expect(controller.health(1).consecutiveFailures).toBe(1);
    controller.tryStart(new Date(now.getTime() + 60_000));
    const ok: DiscoveryResult = {
      ran: true,
      reason: "ok",
      addedCount: 2,
      skippedDecidedCount: 1,
    };
    controller.finish(ok, new Date(now.getTime() + 60_000));
    expect(controller.health(1).consecutiveFailures).toBe(0);
    expect(controller.health(1).circuitOpen).toBe(false);
    expect(controller.health(1).lastAddedCount).toBe(2);
  });
});
