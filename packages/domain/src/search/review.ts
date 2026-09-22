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
  type ProcedureStatus,
  type SearchHit,
  type SearchClassifierInput as SearchClassifierInputValue,
  type SearchIntentPlan,
} from "@procurement/contracts";
import { cheapClassifyHit, type CheapClassifyProfile, type CheapClassifyResult } from "./cheap-classify.js";
import {
  lotIntentText,
  scoreIntentLots,
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
  /**
   * Code-owned 0–100 score of the platform card behind this outcome. Absent
   * when no card was scored; the model never produces this number.
   */
  score?: number;
  /** Procedure status from procurement.get when the card was fetched. */
  status?: ProcedureStatus;
  /**
   * The platform card fetched for this review. Callers may store it on the
   * case instead of paying a second procurement.get on open.
   */
  card?: ProcedureCard;
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
      score: scored.score,
    };
  }
  if (scored.decision === "veto" || scored.contextRole === "mismatch") {
    return {
      verdict: "irrelevant",
      decidedBy: "card",
      reason: scored.reason,
      matchedTerms: [],
      confidence: 1,
      score: scored.score,
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

/** Both the settled outcome (if any) and the score behind it, for the model prompt. */
export function scoreIntentCard(
  card: ProcedureCard,
  plan: SearchIntentPlan,
): { scored: SearchIntentScore; outcome: ReviewOutcome | undefined } {
  const scored = scoreSearchIntentFromProcedure(card, plan);
  return { scored, outcome: outcomeFromIntentCard(scored) };
}

const CLASSIFIER_LOT_TITLE_LIMIT = 8;
const CLASSIFIER_LOT_EXCERPT_LIMIT = 8;
const CLASSIFIER_LOT_EXCERPT_CHARS = 600;
const CLASSIFIER_RAW_FIELD_LIMIT = 12;

/**
 * Card projection for the model. The scorer reads every lot title,
 * description and position; the model used to see only the first eight lot
 * titles, so an object found in a position or a later lot vanished exactly
 * at the semantic check (R14). Excerpts quote the full text of the lots
 * that actually matched the plan first, then fill remaining slots in card
 * order; `lotCount` tells the model how much was not shown. Without a plan
 * the first lots are quoted verbatim — still better than bare titles.
 */
export function classifierCardProjection(
  card: ProcedureCard,
  plan?: SearchIntentPlan,
): NonNullable<SearchClassifierInputValue["card"]> {
  // scoreIntentLots already returns lots in the stable (number, text)
  // order; the same ordering drives the excerpt pick so a «lot» is the
  // same object on both sides.
  const entries =
    plan === undefined
      ? scoreIntentLotsOrdered(card).map((lot) => ({ lot, hit: false }))
      : scoreIntentLots(card, plan).map(({ lot, scored }) => ({
          lot,
          hit:
            scored.matchedObjects.length > 0 ||
            scored.matchedDesired.length > 0 ||
            scored.excludedActions.length > 0 ||
            scored.matchedContext.length > 0,
        }));
  const excerpted = [...entries]
    .sort((left, right) => Number(right.hit) - Number(left.hit))
    .slice(0, CLASSIFIER_LOT_EXCERPT_LIMIT);
  return {
    title: card.title,
    lotTitles: card.lots.map((lot) => lot.title).slice(0, CLASSIFIER_LOT_TITLE_LIMIT),
    lotExcerpts: excerpted.map(({ lot }) => ({
      number: lot.number,
      text: lotIntentText(lot).slice(0, CLASSIFIER_LOT_EXCERPT_CHARS),
    })),
    lotCount: card.lots.length,
    rawFields: Object.fromEntries(
      Object.entries(card.rawFields).slice(0, CLASSIFIER_RAW_FIELD_LIMIT),
    ),
  };
}

function scoreIntentLotsOrdered(card: ProcedureCard): ProcedureCard["lots"] {
  return [...card.lots].sort(
    (left, right) =>
      left.number.localeCompare(right.number, "ru", { numeric: true }) ||
      lotIntentText(left).localeCompare(lotIntentText(right), "ru"),
  );
}

export function buildSearchClassifierInput(
  profile: ReviewProfile,
  hit: SearchHit,
  card: ProcedureCard | undefined,
  scored?: SearchIntentScore,
): SearchClassifierInputValue {
  const mixed = scored?.mixedActions;
  return SearchClassifierInput.parse({
    ...(mixed === undefined
      ? {}
      : {
          mixedActions: {
            desired: [...mixed.desired],
            excluded: [...mixed.excluded],
            question: `В предмете закупки перечислены и ${mixed.desired.join(", ")}, и ${mixed.excluded.join(", ")}. Профиль ищет ${profile.intent?.intent === "works" ? "работы" : "поставку оборудования"}. Что является основным предметом закупки — то, что ищет профиль, или другое? Если доли сопоставимы или это закупка «под ключ», верни needs_human.`,
          },
        }),
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
      : { card: classifierCardProjection(card, profile.intent) }),
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
