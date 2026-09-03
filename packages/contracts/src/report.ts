import { z } from "zod";
import { CommercialTerms } from "./analysis.js";
import { IsoDateTime, Sha256 } from "./common.js";
import { BlobStorageKey } from "./documents.js";
import { ChangeEvent } from "./procurement.js";
import { ScoreSnapshot } from "./scoring.js";

export const ReportSection = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
});
export type ReportSection = z.infer<typeof ReportSection>;

export const ReportInput = z.object({
  terms: CommercialTerms.optional(),
  changes: z.array(ChangeEvent).default([]),
  score: ScoreSnapshot.optional(),
});
export type ReportInput = z.infer<typeof ReportInput>;

export const ReportOutput = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
  sections: z.array(ReportSection).min(1),
  missing: z.array(z.string()),
  storageKey: BlobStorageKey.optional(),
  hash: Sha256.optional(),
  generatedAt: IsoDateTime,
});
export type ReportOutput = z.infer<typeof ReportOutput>;
