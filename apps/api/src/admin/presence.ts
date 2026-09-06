/** Russian presence length for the admin journal. Not a score. */
export function formatPresenceDuration(startedAt: string, endedAt: string): string {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 60_000) return "менее минуты";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(minutes)} мин`;
  if (rest === 0) return `${String(hours)} ч`;
  return `${String(hours)} ч ${String(rest)} мин`;
}
