import { z } from "zod";
import { DomainProfileDraft } from "./domain-profile.js";
import { IsoDateTime } from "./common.js";
import { SeedRunId } from "./ids.js";

/**
 * File format for a first-run Domain Profile. Bootstrap inserts this row once
 * and never overwrites specialist edits. Subject-matter values belong here,
 * not in TypeScript control flow.
 */
export const DomainProfileSeed = DomainProfileDraft.extend({
  seedId: SeedRunId,
});
export type DomainProfileSeed = z.infer<typeof DomainProfileSeed>;

export const SeedRun = z.object({
  seedId: SeedRunId,
  appliedAt: IsoDateTime,
});
export type SeedRun = z.infer<typeof SeedRun>;
