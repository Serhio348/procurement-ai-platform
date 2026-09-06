/** PostgreSQL timestamptz often comes back as `2026-09-06 12:00:00+00`. */
export function toIsoDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(0).toISOString();
  }
  return parsed.toISOString();
}
