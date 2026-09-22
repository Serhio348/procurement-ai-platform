import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, createDatabase, migrateDatabase, type Database } from "@procurement/db";
import { AuthConflictError } from "./errors.js";
import { createPostgresAuthDirectory } from "./postgres-directory.js";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const integration = describe.skipIf(testDatabaseUrl === undefined);

integration("postgres auth directory", () => {
  let db: Database;
  let pool: ReturnType<typeof createDatabase>["pool"];

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");
    await migrateDatabase(testDatabaseUrl);
    ({ db, pool } = createDatabase(testDatabaseUrl));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("never lets two concurrent mutations strip the last admins (R39)", async () => {
    const suffix = Date.now().toString(36);
    const first = `admin-a-${suffix}@test.local`;
    const second = `admin-b-${suffix}@test.local`;
    const specialist = `spec-${suffix}@test.local`;
    await db.execute(sql`
      insert into auth_users (id, email, name, password_hash, role, access_status)
      values
        (gen_random_uuid(), ${first}, 'A', 'x', 'admin', 'active'),
        (gen_random_uuid(), ${second}, 'B', 'x', 'admin', 'active'),
        (gen_random_uuid(), ${specialist}, 'S', 'x', 'specialist', 'active')
    `);
    const directory = createPostgresAuthDirectory(db);
    const admins = (await directory.listUsers()).filter(
      (user) => user.email === first || user.email === second,
    );
    expect(admins).toHaveLength(2);
    // Other suites may have added admins; keep exactly these two active.
    await db.execute(sql`
      update auth_users set role = 'specialist'
      where role = 'admin' and email not in (${first}, ${second})
    `);

    const results = await Promise.allSettled([
      directory.revoke(admins[0]!.id),
      directory.revoke(admins[1]!.id),
    ]);
    const rejected = results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AuthConflictError &&
        result.reason.code === "last_admin",
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");

    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    const remaining = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(sql`role = 'admin' and access_status = 'active'`);
    expect(remaining).toHaveLength(1);
  });
});
