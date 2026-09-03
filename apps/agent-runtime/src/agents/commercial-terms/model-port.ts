import type { CommercialExtractorInput } from "@procurement/contracts";

export interface CommercialExtractorPort {
  extract(input: CommercialExtractorInput): Promise<unknown>;
}
