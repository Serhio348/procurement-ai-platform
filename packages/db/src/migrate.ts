import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

export async function migrateDatabase(connectionString: string): Promise<void> {
  const { db, pool } = createDatabase(connectionString);
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("/migrate.ts") ?? false;
if (invokedDirectly) {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  await migrateDatabase(databaseUrl);
}
