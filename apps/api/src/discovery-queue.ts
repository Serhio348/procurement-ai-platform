import type { Logger } from "@procurement/observability";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

export interface DiscoveryRepeat {
  close: () => Promise<void>;
}

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
  const queueName = "specialist-discovery";
  const queue = new Queue(queueName, { connection });
  const worker = new Worker(
    queueName,
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
      "specialist-discovery",
      { every: options.intervalMs },
      { name: "tick" },
    );
  } catch (error) {
    await worker.close();
    await queue.close();
    workerConnection.disconnect();
    connection.disconnect();
    throw error;
  }
  options.logger.info("Specialist discovery queued on Redis", {
    intervalMs: options.intervalMs,
  });
  return {
    async close() {
      await worker.close();
      await queue.close();
      workerConnection.disconnect();
      connection.disconnect();
    },
  };
}
