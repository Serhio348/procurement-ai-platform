import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleProfileSuggest } from "./profile-suggest.js";

function fakeFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

const options = {
  apiKey: "test-key",
  baseUrl: "https://llm.example.test",
  model: "test-model",
};

describe("profile suggest model port", () => {
  it("parses a draft and clamps junk fields to safe defaults", async () => {
    const suggest = createOpenAiCompatibleProfileSuggest({
      ...options,
      fetchImplementation: fakeFetch({
        name: "КТП и сети",
        purpose: "Поставка подстанций",
        keywords: ["КТП", "ктп", "  ", "КТПБ"],
        excludeKeywords: "монтаж",
        statuses: ["accepting_bids", "bogus_status"],
        excludeSingleSource: "да",
        probeTerms: ["КТП"],
        explanation: 42,
      }),
    });

    const draft = await suggest.draft("Поставляем КТП");
    expect(draft.keywords).toEqual(["КТП", "КТПБ"]);
    expect(draft.excludeKeywords).toEqual([]);
    expect(draft.statuses).toEqual(["accepting_bids"]);
    expect(draft.excludeSingleSource).toBe(false);
    expect(draft.probeTerms).toEqual(["КТП"]);
    expect(draft.explanation).toBe("");
  });

  it("keeps the first draft when there were no titles to refine against", async () => {
    const first = {
      name: "НКУ",
      purpose: "",
      keywords: ["НКУ"],
      excludeKeywords: [],
      statuses: ["accepting_bids" as const],
      excludeSingleSource: false,
      probeTerms: ["НКУ"],
      explanation: "Черновик.",
    };
    const calls: string[] = [];
    const suggest = createOpenAiCompatibleProfileSuggest({
      ...options,
      fetchImplementation: (async () => {
        calls.push("called");
        return new Response("{}");
      }) as typeof fetch,
    });

    // Without sampled titles refine must not spend a second model call.
    const refined = await suggest.refine({ text: "НКУ", draft: first, sampledTitles: [] });
    expect(refined).toBe(first);
    expect(calls).toHaveLength(0);
  });

  it("refine never empties keywords the first draft produced", async () => {
    const suggest = createOpenAiCompatibleProfileSuggest({
      ...options,
      fetchImplementation: fakeFetch({
        name: "КТП",
        purpose: "",
        keywords: [],
        excludeKeywords: [],
        statuses: ["accepting_bids"],
        probeTerms: [],
        explanation: "Уточнено.",
      }),
    });
    const first = {
      name: "КТП",
      purpose: "",
      keywords: ["КТП"],
      excludeKeywords: [],
      statuses: ["accepting_bids" as const],
      excludeSingleSource: false,
      probeTerms: ["КТП"],
      explanation: "",
    };
    const refined = await suggest.refine({
      text: "КТП",
      draft: first,
      sampledTitles: ["КТП киоскового типа"],
    });
    expect(refined.keywords).toEqual(["КТП"]);
    expect(refined.explanation).toBe("Уточнено.");
  });
});
