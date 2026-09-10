export const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

export type DiscoveryTransport =
  | { kind: "off" }
  | { kind: "redis"; intervalMs: number; redisUrl: string }
  | { kind: "interval"; intervalMs: number };

export function discoveryDoneMessage(input: {
  profileNames: readonly string[];
  addedCount: number;
  skippedDecidedCount: number;
}): string {
  const who = input.profileNames.length === 0 ? "профили" : input.profileNames.join(", ");
  return `Фоновый поиск выполнен (${who}). Добавлено ${String(input.addedCount)}, уже решённых пропущено ${String(input.skippedDecidedCount)}.`;
}

export function discoveryFailedMessage(profileName: string, error: unknown): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind: unknown }).kind
      : undefined;
  const cause =
    kind === "source_unavailable"
      ? "площадка goszakupki.by недоступна"
      : kind === "timeout"
        ? "площадка отвечала слишком долго"
        : "ошибка поиска";
  return `Фоновый поиск не выполнен (${profileName}): ${cause}.`;
}

export function discoveryTransport(env: NodeJS.ProcessEnv): DiscoveryTransport {
  const intervalMs = Number.parseInt(
    env["SPECIALIST_DISCOVERY_INTERVAL_MS"] ?? String(DISCOVERY_INTERVAL_MS),
    10,
  );
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { kind: "off" };
  const redisUrl = env["REDIS_URL"]?.trim() ?? "";
  if (redisUrl.length > 0) return { kind: "redis", intervalMs, redisUrl };
  return { kind: "interval", intervalMs };
}
