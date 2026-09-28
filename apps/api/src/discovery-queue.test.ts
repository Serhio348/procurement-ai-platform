import { Queue } from "bullmq";
import { silentLogger } from "@procurement/observability";
import { afterAll, describe, expect, it } from "vitest";
import { removeDiscoveryRepeat, startDiscoveryRepeat } from "./discovery-queue.js";

const redisUrl = process.env["TEST_REDIS_URL"];

describe.skipIf(redisUrl === undefined)("Redis discovery scheduler", () => {
  const queue = new Queue("specialist-discovery", {
    connection: { url: redisUrl ?? "" },
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  });

  it("registers the interval, survives a worker stop and is removed when off", async () => {
    await queue.obliterate({ force: true });
    const repeat = await startDiscoveryRepeat({
      redisUrl: redisUrl!,
      intervalMs: 3_600_000,
      run: async () => {},
      logger: silentLogger,
    });
    expect((await queue.getJobSchedulers()).map((item) => item.every)).toEqual([3_600_000]);
    await repeat.close();

    // The schedule persists in Redis after the worker is gone — a restart
    // alone does not clear it.
    expect(await queue.getJobSchedulers()).toHaveLength(1);

    // A disabled pass must unregister the schedule, not just stop consuming.
    await removeDiscoveryRepeat({ redisUrl: redisUrl!, logger: silentLogger });
    expect(await queue.getJobSchedulers()).toEqual([]);
  });
});
