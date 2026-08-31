const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgres://procurement:procurement@127.0.0.1:5432/procurement";

export default {
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
} as const;
