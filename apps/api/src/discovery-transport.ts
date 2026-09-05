export type DiscoveryTransport =
  | { kind: "off" }
  | { kind: "redis"; intervalMs: number; redisUrl: string }
  | { kind: "interval"; intervalMs: number };

export function discoveryTransport(env: NodeJS.ProcessEnv): DiscoveryTransport {
  const intervalMs = Number.parseInt(env["SPECIALIST_DISCOVERY_INTERVAL_MS"] ?? "600000", 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { kind: "off" };
  const redisUrl = env["REDIS_URL"]?.trim() ?? "";
  if (redisUrl.length > 0) return { kind: "redis", intervalMs, redisUrl };
  return { kind: "interval", intervalMs };
}
