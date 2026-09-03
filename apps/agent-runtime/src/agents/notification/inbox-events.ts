import type { InboxFixtureItem } from "@procurement/contracts";

export interface SpecialistInboxEvents {
  record(item: InboxFixtureItem): Promise<void>;
}

export class HttpSpecialistInboxEvents implements SpecialistInboxEvents {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async record(item: InboxFixtureItem): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/api/inbox/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    if (!response.ok) {
      throw new Error(`Specialist inbox projection failed: ${String(response.status)}`);
    }
  }
}
