import type { SearchClassifierInput } from "@procurement/contracts";
import type { SearchClassifierPort } from "../agents/domain-search/model-port.js";

export type FakeSearchClassifierResponder = (
  input: SearchClassifierInput,
) => unknown | Promise<unknown>;

export class FakeSearchClassifier implements SearchClassifierPort {
  readonly calls: SearchClassifierInput[] = [];
  readonly #responder: FakeSearchClassifierResponder;

  constructor(responder: FakeSearchClassifierResponder = () => {
    throw new Error("search classifier must not run");
  }) {
    this.#responder = responder;
  }

  async classify(input: SearchClassifierInput): Promise<unknown> {
    this.calls.push(input);
    return this.#responder(input);
  }
}
