import { describe, expect, it } from "vitest";
import { type LogRecord, createLogger } from "./logger.js";

function capture() {
  const records: LogRecord[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (record) => records.push(record),
    clock: () => new Date("2026-08-25T09:00:00.000Z"),
    context: { component: "test" },
  });
  return { records, logger };
}

describe("log record", () => {
  it("writes level, timestamp and message as structured fields", () => {
    const { records, logger } = capture();

    logger.info("search started", { hits: 12 });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      time: "2026-08-25T09:00:00.000Z",
      msg: "search started",
      component: "test",
      hits: 12,
    });
  });

  it("drops records below the configured level", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "warn", sink: (record) => records.push(record) });

    logger.debug("noise");
    logger.info("still noise");
    logger.warn("worth knowing");

    expect(records.map((record) => record.msg)).toEqual(["worth knowing"]);
  });
});

describe("correlation ids", () => {
  it("carries the ids needed to reconstruct who ran what", () => {
    const { records, logger } = capture();

    const runLogger = logger
      .child({ requestId: "req-1", taskId: "task-1" })
      .child({ agentId: "domain_search", runId: "run-1", procurementId: "proc-1" });

    runLogger.info("agent finished");

    expect(records[0]).toMatchObject({
      requestId: "req-1",
      taskId: "task-1",
      agentId: "domain_search",
      runId: "run-1",
      procurementId: "proc-1",
      component: "test",
    });
  });

  it("does not leak child context back into the parent logger", () => {
    const { records, logger } = capture();

    logger.child({ runId: "run-1" }).info("child");
    logger.info("parent");

    expect(records[0]?.["runId"]).toBe("run-1");
    expect(records[1]?.["runId"]).toBeUndefined();
  });
});

describe("secret redaction", () => {
  it("redacts sensitive field names at any nesting level", () => {
    const { records, logger } = capture();

    logger.info("tool call", {
      toolName: "procurement.search",
      args: { query: "водоподготовка", auth: { token: "super-secret" } },
    });

    const args = records[0]?.["args"] as { query: string; auth: { token: string } };
    expect(args.query).toBe("водоподготовка");
    expect(args.auth.token).toBe("[redacted]");
  });

  it("matches field names regardless of case", () => {
    const { records, logger } = capture();

    logger.info("config", { API_KEY: "abc", Password: "xyz" });

    expect(records[0]?.["API_KEY"]).toBe("[redacted]");
    expect(records[0]?.["Password"]).toBe("[redacted]");
  });
});

describe("errors", () => {
  it("flattens an Error so the line stays valid JSON", () => {
    const { records, logger } = capture();

    logger.error("download failed", new TypeError("socket hang up"), { attempt: 3 });

    const record = records[0];
    expect(record?.["attempt"]).toBe(3);
    expect(record?.["err"]).toMatchObject({ name: "TypeError", message: "socket hang up" });
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  it("accepts a thrown value that is not an Error", () => {
    const { records, logger } = capture();

    logger.error("adapter failed", "goszakupki timed out");

    expect(records[0]?.["err"]).toMatchObject({ message: "goszakupki timed out" });
  });
});
