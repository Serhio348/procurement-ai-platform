import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

export async function migrateDatabase(connectionString: string): Promise<void> {
  const { db, pool } = createDatabase(connectionString);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  try {
    await migrate(db, { migrationsFolder });
    const tables = await db.execute<{ tablename: string }>(sql`
      select tablename
      from pg_tables
      where schemaname = 'public'
        and tablename in ('specialist_workspaces', 'specialist_cases')
    `);
    if (tables.rows.length < 2) {
      throw new Error(
        "specialist_workspaces/specialist_cases missing after migrate; journal timestamps may have skipped 0001",
      );
    }
  } finally {
    await pool.end();
  }
}

/** tsx/npm put `src/migrate.ts` in argv, not always a leading slash. */
function invokedAsCli(scriptBase: string): boolean {
  return process.argv.some((arg) => {
    const normalized = arg.replaceAll("\\", "/");
    return normalized.endsWith(`/${scriptBase}`) || normalized.endsWith(scriptBase);
  });
}

if (invokedAsCli("migrate.ts") || invokedAsCli("migrate.js")) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  await migrateDatabase(databaseUrl);
  process.stderr.write("PostgreSQL migrations applied\n");
}
