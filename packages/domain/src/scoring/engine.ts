import type {
  RiskSeverity,
  ScoreComponents,
  ScoreVerdict,
  ScoringFormula,
} from "@procurement/contracts";

/**
 * Scoring is deliberately kept out of the model's hands. The LLM supplies
 * facts, evidence and confidence; the numbers below are produced here, by
 * code, from a versioned formula.
 *
 * Every component is normalised to 0..1 where 1 is always the better outcome -
 * including `risk`, where 1 means "nothing worrying found".
 */

export interface ScoreRequest {
  components: ScoreComponents;
  risks: readonly { severity: RiskSeverity }[];
  /** Aggregate extraction confidence for the facts behind the components. */
  confidence: number;
  formula: ScoringFormula;
}

export interface ScoreResult {
  components: ScoreComponents;
  weightedScore: number;
  riskPenalty: number;
  finalScore: number;
  verdict: ScoreVerdict;
  /** Human-readable breakdown, generated here so it always matches the math. */
  explanation: string[];
}

export class ScoringConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoringConfigurationError";
  }
}

const COMPONENT_LABELS: Record<keyof ScoreComponents, string> = {
  technical: "Техническое соответствие",
  commercial: "Коммерческие условия",
  deadline: "Сроки",
  risk: "Отсутствие рисков",
  companyMatch: "Соответствие компании",
};

const SEVERITY_ORDER: readonly RiskSeverity[] = ["critical", "high", "medium", "low"];

const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function computeScore(request: ScoreRequest): ScoreResult {
  const { components, risks, confidence, formula } = request;
  const { weights } = formula;

  const totalWeight =
    weights.technical + weights.commercial + weights.deadline + weights.risk + weights.companyMatch;

  if (totalWeight <= 0) {
    throw new ScoringConfigurationError(
      `formula "${formula.id}" v${formula.version} has no positive weights`,
    );
  }

  const explanation: string[] = [];
  let weightedSum = 0;

  for (const key of Object.keys(COMPONENT_LABELS) as (keyof ScoreComponents)[]) {
    const value = components[key];
    const weight = weights[key];
    weightedSum += value * weight;
    if (weight > 0) {
      explanation.push(
        `${COMPONENT_LABELS[key]}: ${roundTo(value, 2)} × вес ${weight} = ${roundTo(value * weight, 2)}`,
      );
    }
  }

  const weightedScore = roundTo((weightedSum / totalWeight) * 100, 2);
  explanation.push(`Взвешенная оценка: ${weightedScore} из 100`);

  let riskPenalty = 0;
  for (const severity of SEVERITY_ORDER) {
    const count = risks.filter((risk) => risk.severity === severity).length;
    if (count === 0) continue;
    const penalty = formula.riskPenalty[severity] * count;
    riskPenalty += penalty;
    explanation.push(`Риски ${severity}: ${count} шт. − ${roundTo(penalty, 2)}`);
  }
  riskPenalty = roundTo(riskPenalty, 2);

  const finalScore = roundTo(clamp(weightedScore - riskPenalty, 0, 100), 2);
  explanation.push(`Итоговая оценка: ${finalScore}`);

  const verdict = decideVerdict(finalScore, confidence, formula, explanation);

  return { components, weightedScore, riskPenalty, finalScore, verdict, explanation };
}

function decideVerdict(
  finalScore: number,
  confidence: number,
  formula: ScoringFormula,
  explanation: string[],
): ScoreVerdict {
  if (confidence < formula.minConfidence) {
    explanation.push(
      `Уверенность ${roundTo(confidence, 2)} ниже порога ${formula.minConfidence} — решение передано специалисту`,
    );
    return "needs_human";
  }

  const { accept, review } = formula.thresholds;
  if (finalScore >= accept) {
    explanation.push(`Вердикт: accept (порог ${accept})`);
    return "accept";
  }
  if (finalScore >= review) {
    explanation.push(`Вердикт: review (порог ${review}, accept от ${accept})`);
    return "review";
  }
  explanation.push(`Вердикт: reject (ниже порога review ${review})`);
  return "reject";
}
