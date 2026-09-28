import type { Logger } from "@procurement/observability";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

export interface DiscoveryRepeat {
  close: () => Promise<void>;
}

const DISCOVERY_QUEUE_NAME = "specialist-discovery";
const DISCOVERY_SCHEDULER_ID = "specialist-discovery";

/**
 * Repeatable discovery on Redis. Lost Redis does not lose PostgreSQL cases;
 * the next tick just does not fire until Redis is back.
 */
export async function startDiscoveryRepeat(options: {
  redisUrl: string;
  intervalMs: number;
  run: () => Promise<void>;
  logger: Logger;
}): Promise<DiscoveryRepeat> {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = connection.duplicate();
  connection.on("error", (error) => {
    options.logger.warn("Redis discovery connection error", { error: error.message });
  });
  workerConnection.on("error", (error) => {
    options.logger.warn("Redis discovery worker error", { error: error.message });
  });
  const queue = new Queue(DISCOVERY_QUEUE_NAME, { connection });
  const worker = new Worker(
    DISCOVERY_QUEUE_NAME,
    async () => {
      await options.run();
    },
    { connection: workerConnection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => {
    options.logger.error("Specialist discovery job failed", error, {
      jobId: job?.id,
    });
  });
  try {
    await queue.upsertJobScheduler(
      DISCOVERY_SCHEDULER_ID,
      { every: options.intervalMs },
      { name: "tick" },
    );
    // Schedulers persist in Redis across restarts — log the full set so a
    // stale entry from an older process or interval is visible at a glance.
    const schedulers = await queue.getJobSchedulers();
    options.logger.info("Specialist discovery queued on Redis", {
      intervalMs: options.intervalMs,
      schedulers: schedulers.map((item) => ({ key: item.key, every: item.every })),
    });
  } catch (error) {
    await worker.close();
    await queue.close();
    workerConnection.disconnect();
    connection.disconnect();
    throw error;
  }
  return {
    async close() {
      await worker.close();
      await queue.close();
      workerConnection.disconnect();
      connection.disconnect();
    },
  };
}

/**
 * Discovery disabled via config must be honestly off: a job scheduler lives in
 * Redis, not in the process, so without this removal a previously registered
 * schedule keeps feeding the queue to any worker that ever attaches.
 */
export async function removeDiscoveryRepeat(options: {
  redisUrl: string;
  logger: Logger;
}): Promise<void> {
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (error) => {
    options.logger.warn("Redis discovery connection error", { error: error.message });
  });
  const queue = new Queue(DISCOVERY_QUEUE_NAME, { connection });
  try {
    const removed = await queue.removeJobScheduler(DISCOVERY_SCHEDULER_ID);
    options.logger.info("Specialist discovery scheduler state", { removed });
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
