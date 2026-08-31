import {
  ScoringFormula,
  electricalEquipmentSeedV1,
  type DomainProfileSeed,
} from "@procurement/contracts";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import { companies, domainProfiles, scoringFormulas, seedRuns } from "./schema.js";

export const SYSTEM_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_FORMULA_ID = "default";
export const DEFAULT_FORMULA_VERSION = 1;

const defaultFormula = ScoringFormula.parse({
  id: DEFAULT_FORMULA_ID,
  version: DEFAULT_FORMULA_VERSION,
  weights: {
    technical: 3,
    commercial: 2,
    deadline: 2,
    risk: 2,
    companyMatch: 1,
  },
  riskPenalty: { low: 2, medium: 5, high: 10, critical: 25 },
  thresholds: { review: 50, accept: 75 },
  minConfidence: 0.7,
});

export async function applyBootstrap(db: Database): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx
      .insert(companies)
      .values({ id: SYSTEM_COMPANY_ID, name: "Основная компания" })
      .onConflictDoNothing();

    await tx
      .insert(scoringFormulas)
      .values({
        id: defaultFormula.id,
        version: defaultFormula.version,
        config: defaultFormula,
      })
      .onConflictDoNothing();

    const claimed = await tx
      .insert(seedRuns)
      .values({ seedId: electricalEquipmentSeedV1.seedId })
      .onConflictDoNothing()
      .returning({ seedId: seedRuns.seedId });

    if (claimed.length === 0) return false;

    await insertDomainProfileSeed(tx, electricalEquipmentSeedV1);
    return true;
  });
}

async function insertDomainProfileSeed(
  db: Pick<Database, "insert">,
  seed: DomainProfileSeed,
): Promise<void> {
  await db
    .insert(domainProfiles)
    .values({
      companyId: SYSTEM_COMPANY_ID,
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      purpose: seed.purpose,
      instructions: seed.instructions,
      keywords: seed.keywords,
      excludeKeywords: seed.excludeKeywords,
      semanticConcepts: seed.semanticConcepts,
      positiveCriteria: seed.positiveCriteria,
      negativeCriteria: seed.negativeCriteria,
      constraints: seed.constraints,
      formulaId: seed.scoringRules.formulaId,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      minRelevance: String(seed.scoringRules.minRelevanceToInvestigate),
      minConfidence: String(seed.scoringRules.minConfidenceToDecide),
      monitoringRules: seed.monitoringRules,
      associatedCapabilities: seed.associatedCapabilities,
      associatedMcpTools: seed.associatedMcpTools,
      enabled: seed.enabled,
      archived: seed.archived,
      priority: seed.priority,
    })
    .onConflictDoNothing();
}

export async function bootstrapFromEnvironment(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  const { db, pool } = createDatabase(databaseUrl);
  try {
    await applyBootstrap(db);
    const rows = await db
      .select({ id: scoringFormulas.id })
      .from(scoringFormulas)
      .where(eq(scoringFormulas.id, DEFAULT_FORMULA_ID));
    if (rows.length === 0) throw new Error("default scoring formula bootstrap failed");
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("/bootstrap.ts") ?? false;
if (invokedDirectly) {
  await bootstrapFromEnvironment();
}
