import type { PolicyScope, ScopedRule } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { authorityOf, resolveRule, resolveRuleSet } from "./resolve.js";

const rule = (
  id: string,
  scope: PolicyScope,
  key: string,
  value: string | number | boolean,
  createdAt = "2026-01-01T00:00:00.000Z",
): ScopedRule => ({
  id,
  scope,
  key,
  value,
  statement: `${key} = ${String(value)} (${scope})`,
  createdAt,
});

describe("policy precedence", () => {
  it("ranks a system policy above every other scope", () => {
    expect(authorityOf("system")).toBeLessThan(authorityOf("company"));
    expect(authorityOf("company")).toBeLessThan(authorityOf("permanent_intent"));
    expect(authorityOf("permanent_intent")).toBeLessThan(authorityOf("domain"));
    expect(authorityOf("domain")).toBeLessThan(authorityOf("procurement"));
    expect(authorityOf("procurement")).toBeLessThan(authorityOf("task"));
  });

  it("lets a stronger scope win and reports what it overrode", () => {
    const company = rule("r1", "company", "search.include_household", false);
    const task = rule("r2", "task", "search.include_household", true);

    const resolution = resolveRule("search.include_household", [task, company]);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.winner.id).toBe("r1");
    expect(resolution.overridden.map((r) => r.id)).toEqual(["r2"]);
  });

  it("does not let a task instruction overrule a system policy", () => {
    const system = rule("sys", "system", "tools.allow_delete", false);
    const task = rule("t", "task", "tools.allow_delete", true);

    const resolution = resolveRule("tools.allow_delete", [task, system]);

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.winner.value).toBe(false);
  });
});

describe("unresolvable conflicts", () => {
  it("escalates instead of picking the newer rule at the same scope", () => {
    const older = rule("a", "domain", "advance.max_percent", 30, "2026-01-01T00:00:00.000Z");
    const newer = rule("b", "domain", "advance.max_percent", 50, "2026-06-01T00:00:00.000Z");

    const resolution = resolveRule("advance.max_percent", [older, newer]);

    expect(resolution.status).toBe("needs_human");
    if (resolution.status !== "needs_human") return;
    expect(resolution.candidates.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(resolution.question).toContain("advance.max_percent");
  });

  it("treats identical values at the same scope as agreement, not conflict", () => {
    const first = rule("a", "domain", "advance.max_percent", 30);
    const second = rule("b", "domain", "advance.max_percent", 30);

    expect(resolveRule("advance.max_percent", [first, second]).status).toBe("resolved");
  });

  it("distinguishes a numeric value from its string form", () => {
    const numeric = rule("a", "domain", "advance.max_percent", 30);
    const textual = rule("b", "domain", "advance.max_percent", "30");

    expect(resolveRule("advance.max_percent", [numeric, textual]).status).toBe("needs_human");
  });
});

describe("independent rules coexist", () => {
  it("keeps unrelated permanent intents alive side by side", () => {
    const domainA = rule("a", "permanent_intent", "search.domain_a", true);
    const domainB = rule("b", "permanent_intent", "search.domain_b", true);

    const result = resolveRuleSet([domainA, domainB]);

    expect(result.needsHuman).toBe(false);
    expect(result.effective.get("search.domain_a")?.value).toBe(true);
    expect(result.effective.get("search.domain_b")?.value).toBe(true);
  });

  it("isolates a conflict to its own key", () => {
    const result = resolveRuleSet([
      rule("d", "permanent_intent", "search.domain_a", true),
      rule("a", "domain", "advance.max_percent", 30),
      rule("b", "domain", "advance.max_percent", 50),
    ]);

    expect(result.needsHuman).toBe(true);
    expect(result.conflicts.map((c) => c.key)).toEqual(["advance.max_percent"]);
    expect(result.effective.get("search.domain_a")?.value).toBe(true);
    expect(result.effective.has("advance.max_percent")).toBe(false);
  });

  it("produces the same winner regardless of input order", () => {
    const a = rule("a", "company", "k", 1, "2026-01-01T00:00:00.000Z");
    const b = rule("b", "task", "k", 2, "2026-02-01T00:00:00.000Z");

    const forward = resolveRuleSet([a, b]).effective.get("k")?.id;
    const backward = resolveRuleSet([b, a]).effective.get("k")?.id;

    expect(forward).toBe("a");
    expect(backward).toBe("a");
  });
});
