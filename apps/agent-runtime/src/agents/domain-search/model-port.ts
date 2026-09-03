import type { SearchClassifierInput } from "@procurement/contracts";

export interface SearchClassifierPort {
  classify(input: SearchClassifierInput): Promise<unknown>;
}
