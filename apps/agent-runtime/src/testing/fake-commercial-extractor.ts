import type { CommercialExtractorInput } from "@procurement/contracts";
import type { CommercialExtractorPort } from "../agents/commercial-terms/model-port.js";

export type FakeCommercialExtractorResponder = (
  input: CommercialExtractorInput,
) => unknown | Promise<unknown>;

export class FakeCommercialExtractor implements CommercialExtractorPort {
  readonly calls: CommercialExtractorInput[] = [];
  readonly #responder: FakeCommercialExtractorResponder;

  constructor(responder: FakeCommercialExtractorResponder = () => {
    throw new Error("commercial extractor must not run");
  }) {
    this.#responder = responder;
  }

  async extract(input: CommercialExtractorInput): Promise<unknown> {
    this.calls.push(input);
    return this.#responder(input);
  }
}
