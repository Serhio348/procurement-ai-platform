import type { PolicyScope, ScopedRule } from "@procurement/contracts";

/**
 * Authority order, strongest first. A task-level instruction can never
 * overrule a system policy, no matter how recent it is.
 */
export const POLICY_PRECEDENCE = [
  "system",
  "company",
  "permanent_intent",
  "domain",
  "procurement",
  "task",
] as const satisfies readonly PolicyScope[];

/** Lower number means stronger authority. */
export function authorityOf(scope: PolicyScope): number {
  return POLICY_PRECEDENCE.indexOf(scope);
}

export type RuleResolution =
  | {
      status: "resolved";
      key: string;
      winner: ScopedRule;
      /**
       * Rules the winner takes precedence over. They are reported rather than
       * deleted: an override is always visible to the specialist.
       */
      overridden: readonly ScopedRule[];
    }
  | {
      status: "needs_human";
      key: string;
      /** Equally authoritative rules that disagree. */
      candidates: readonly ScopedRule[];
      question: string;
    };

export interface RuleSetResolution {
  resolutions: readonly RuleResolution[];
  /** Values of the rules that won, keyed by rule key. */
  effective: ReadonlyMap<string, ScopedRule>;
  conflicts: readonly Extract<RuleResolution, { status: "needs_human" }>[];
  needsHuman: boolean;
}

const sameValue = (a: ScopedRule, b: ScopedRule): boolean =>
  typeof a.value === typeof b.value && a.value === b.value;

/** Stable ordering so the same input always produces the same winner. */
function compareRules(a: ScopedRule, b: ScopedRule): number {
  const byAuthority = authorityOf(a.scope) - authorityOf(b.scope);
  if (byAuthority !== 0) return byAuthority;
  const byAge = a.createdAt.localeCompare(b.createdAt);
  if (byAge !== 0) return byAge;
  return a.id.localeCompare(b.id);
}

function buildConflictQuestion(key: string, candidates: readonly ScopedRule[]): string {
  const scope = candidates[0]?.scope ?? "task";
  const options = candidates.map((rule) => `- ${rule.statement}`).join("\n");
  return [
    `Правила для «${key}» противоречат друг другу на одном уровне (${scope}).`,
    "Ни одно из них не имеет приоритета, поэтому система не выбирает сама.",
    "Какое правило применять?",
    options,
  ].join("\n");
}

/**
 * Resolve one rule key. Stronger scope wins; equal strength with different
 * values is escalated instead of being decided by recency.
 */
export function resolveRule(key: string, rules: readonly ScopedRule[]): RuleResolution {
  const ordered = [...rules].sort(compareRules);
  const strongest = ordered[0];
  if (strongest === undefined) {
    throw new Error(`resolveRule called with no rules for key "${key}"`);
  }

  const topAuthority = authorityOf(strongest.scope);
  const contenders = ordered.filter((rule) => authorityOf(rule.scope) === topAuthority);
  const disagrees = contenders.some((rule) => !sameValue(rule, strongest));

  if (disagrees) {
    return {
      status: "needs_human",
      key,
      candidates: contenders,
      question: buildConflictQuestion(key, contenders),
    };
  }

  return {
    status: "resolved",
    key,
    winner: strongest,
    overridden: ordered.filter((rule) => rule.id !== strongest.id),
  };
}

/**
 * Resolve a whole rule set. Rules touching different keys never conflict, so
 * "always search water treatment" and "also search pumps" both survive.
 */
export function resolveRuleSet(rules: readonly ScopedRule[]): RuleSetResolution {
  const grouped = new Map<string, ScopedRule[]>();
  for (const rule of rules) {
    const bucket = grouped.get(rule.key);
    if (bucket === undefined) {
      grouped.set(rule.key, [rule]);
    } else {
      bucket.push(rule);
    }
  }

  const resolutions: RuleResolution[] = [];
  const effective = new Map<string, ScopedRule>();
  const conflicts: Extract<RuleResolution, { status: "needs_human" }>[] = [];

  for (const key of [...grouped.keys()].sort()) {
    const bucket = grouped.get(key);
    if (bucket === undefined) continue;

    const resolution = resolveRule(key, bucket);
    resolutions.push(resolution);
    if (resolution.status === "resolved") {
      effective.set(key, resolution.winner);
    } else {
      conflicts.push(resolution);
    }
  }

  return {
    resolutions,
    effective,
    conflicts,
    needsHuman: conflicts.length > 0,
  };
}
