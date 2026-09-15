/**
 * Second look at a hit the title alone could not settle. Two steps, both
 * decided by code: the platform card (lots, description, raw fields) is run
 * through the same term matcher as the title; only if that is still
 * inconclusive does a model see the case, and its answer is accepted only
 * above a confidence threshold. The model never produces a score.
 */
import {
  DomainSearchCandidate,
  SearchClassifierInput,
  type ProcedureCard,
  type SearchHit,
  type SearchClassifierInput as SearchClassifierInputValue,
  type SearchIntentPlan,
} from "@procurement/contracts";
import { cheapClassifyHit, type CheapClassifyProfile, type CheapClassifyResult } from "./cheap-classify.js";
import {
  scoreSearchIntentFromProcedure,
  type SearchIntentScore,
} from "./intent-score.js";

/** Profile slice the review step may see. Free-text fields help the model. */
export interface ReviewProfile extends CheapClassifyProfile {
  name: string;
  purpose?: string;
  description?: string;
  /** When set, lot subject is scored with the same plan as the listing. */
  intent?: SearchIntentPlan;
}

export type ReviewVerdict = "relevant" | "irrelevant" | "needs_human";

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  /** Where the answer came from; "title" means no extra work was needed. */
  decidedBy: "card" | "model" | "quota" | "none";
  reason: string;
  matchedTerms: readonly string[];
  confidence: number;
}

/** Text from the platform card that a keyword may legitimately appear in. */
export function cardReviewText(card: ProcedureCard): string {
  const parts: string[] = [card.title];
  for (const lot of card.lots) {
    parts.push(lot.title);
    if (lot.description !== undefined) parts.push(lot.description);
    if (lot.okrbCode !== undefined) parts.push(lot.okrbCode);
    for (const position of lot.positions) parts.push(position.title);
  }
  parts.push(...Object.values(card.rawFields));
  return parts.join("\n");
}

/**
 * Re-runs the cheap classifier over the card text. A term exact in a lot is as
 * good as a term exact in the title; an exclude word anywhere still wins.
 */
export function reviewByCard(card: ProcedureCard, profile: CheapClassifyProfile): CheapClassifyResult {
  return cheapClassifyHit({ title: cardReviewText(card) }, profile);
}

export function outcomeFromCardReview(result: CheapClassifyResult): ReviewOutcome | undefined {
  if (result.verdict === "relevant") {
    return {
      verdict: "relevant",
      decidedBy: "card",
      reason: `В лотах или описании есть ${result.matchedTerms.join(", ")}.`,
      matchedTerms: result.matchedTerms,
      confidence: 1,
    };
  }
  if (result.verdict === "irrelevant") {
    return {
      verdict: "irrelevant",
      decidedBy: "card",
      reason: `В карточке есть исключённое слово «${result.excludedBy[0] ?? ""}».`,
      matchedTerms: [],
      confidence: 1,
    };
  }
  return undefined;
}

/**
 * Listing-score on the full card text. Match settles the case, as do the
 * two explicit negatives: a veto (the work itself is excluded) and a purpose
 * the profile does not want. A plain «no object found» is not proof of
 * anything — the platform returned the row for a reason the term matcher
 * may not see — so it stays open for the model or a human.
 */
export function outcomeFromIntentCard(scored: SearchIntentScore): ReviewOutcome | undefined {
  if (scored.decision === "match") {
    return {
      verdict: "relevant",
      decidedBy: "card",
      reason: scored.reason,
      matchedTerms: [...scored.matchedObjects, ...scored.matchedDesired],
      confidence: 1,
    };
  }
  if (scored.decision === "veto" || scored.contextRole === "mismatch") {
    return {
      verdict: "irrelevant",
      decidedBy: "card",
      reason: scored.reason,
      matchedTerms: [],
      confidence: 1,
    };
  }
  return undefined;
}

export function reviewByIntentCard(
  card: ProcedureCard,
  plan: SearchIntentPlan,
): ReviewOutcome | undefined {
  return outcomeFromIntentCard(scoreSearchIntentFromProcedure(card, plan));
}

export function buildSearchClassifierInput(
  profile: ReviewProfile,
  hit: SearchHit,
  card: ProcedureCard | undefined,
): SearchClassifierInputValue {
  return SearchClassifierInput.parse({
    profile: {
      name: profile.name,
      purpose: profile.purpose ?? "",
      instructions: profile.description ?? "",
      keywords: profile.keywords,
      excludeKeywords: profile.excludeKeywords,
      semanticConcepts: [],
      positiveCriteria: [],
      negativeCriteria: [],
    },
    hit,
    ...(card === undefined
      ? {}
      : {
          card: {
            title: card.title,
            lotTitles: card.lots.map((lot) => lot.title).slice(0, 8),
            rawFields: Object.fromEntries(Object.entries(card.rawFields).slice(0, 12)),
          },
        }),
  });
}

const ModelClassification = DomainSearchCandidate.pick({
  verdict: true,
  confidence: true,
  reason: true,
  needDeeper: true,
  matchedTerms: true,
});

/**
 * Turns a raw model answer into an outcome. Anything malformed, and any
 * "relevant" or "irrelevant" below `minConfidence`, is handed to a human: the
 * model may suggest, the threshold decides.
 */
export function outcomeFromModel(raw: unknown, minConfidence: number): ReviewOutcome {
  const parsed = ModelClassification.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: "needs_human",
      decidedBy: "model",
      reason: "Модель вернула некорректный ответ — нужна проверка специалиста.",
      matchedTerms: [],
      confidence: 0,
    };
  }
  const { verdict, confidence, reason, matchedTerms } = parsed.data;
  if (verdict !== "needs_human" && confidence < minConfidence) {
    return {
      verdict: "needs_human",
      decidedBy: "model",
      reason: `Модель склоняется к «${verdict === "relevant" ? "подходит" : "не подходит"}», но не уверена: ${reason}`,
      matchedTerms,
      confidence,
    };
  }
  return { verdict, decidedBy: "model", reason, matchedTerms, confidence };
}

export function quotaOutcome(): ReviewOutcome {
  return {
    verdict: "needs_human",
    decidedBy: "quota",
    reason: "Лимит проверок моделью за один поиск исчерпан — уточните ключевые слова профиля.",
    matchedTerms: [],
    confidence: 0,
  };
}

export function unavailableOutcome(): ReviewOutcome {
  return {
    verdict: "needs_human",
    decidedBy: "none",
    reason: "Точных совпадений по словам нет — проверьте по смыслу.",
    matchedTerms: [],
    confidence: 0,
  };
}
