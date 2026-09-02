import type {
  SupervisorModelInput,
  SupervisorModelPort,
} from "../supervisor/model-port.js";

export type FakeSupervisorResponder = (
  input: SupervisorModelInput,
) => unknown | Promise<unknown>;

export class FakeSupervisorModel implements SupervisorModelPort {
  readonly calls: SupervisorModelInput[] = [];
  readonly #responder: FakeSupervisorResponder;

  constructor(responder: FakeSupervisorResponder) {
    this.#responder = responder;
  }

  async createPlan(input: SupervisorModelInput): Promise<unknown> {
    this.calls.push(input);
    return this.#responder(input);
  }
}
