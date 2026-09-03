import {
  DomainProfile,
  Intent,
  ProcurementCaseHeader,
  RequestId,
  SupervisorRequest,
  electricalEquipmentSeedV1,
  type SupervisorPlan,
  type SupervisorRequest as SupervisorRequestValue,
} from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { FakeSupervisorModel } from "../testing/fake-supervisor-model.js";
import { SupervisorPlanner } from "./supervisor.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T06:00:00.000Z";

describe("SupervisorPlanner", () => {
  it("routes a one-time search intent to domain_search for the selected profile", async () => {
    const profile = equipmentProfile();
    const model = new FakeSupervisorModel((input) =>
      searchPlan(input.domainProfiles[0]?.id ?? profile.id),
    );
    const planner = new SupervisorPlanner({ model });

    const plan = await planner.plan(
      request({
        intents: [searchIntent(profile.id)],
        domainProfiles: [profile],
      }),
    );

    expect(plan.needsHuman).toBe(false);
    expect(plan.selectedDomainProfileIds).toEqual([profile.id]);
    expect(plan.steps).toEqual([
      expect.objectContaining({
        capability: "domain_search",
        domainProfileId: profile.id,
      }),
    ]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.intents[0]).not.toHaveProperty("rawMessage");
  });

  it("keeps independent search and monitoring intents in one plan", async () => {
    const profile = equipmentProfile();
    const procurement = caseHeader();
    const model = new FakeSupervisorModel(() => ({
      intentSummary: "Найти закупки и следить за выбранной процедурой",
      selectedDomainProfileIds: [profile.id],
      steps: [
        {
          capability: "domain_search",
          reason: "Нужен поиск по профилю электрооборудования",
          domainProfileId: profile.id,
        },
        {
          capability: "monitoring",
          reason: "Нужно отслеживать изменения выбранной закупки",
          domainProfileId: profile.id,
          procurementId: procurement.id,
        },
        {
          capability: "notification",
          reason: "Специалиста нужно уведомить об изменениях",
        },
      ],
      needsHuman: false,
      confidence: 0.91,
    }));
    const planner = new SupervisorPlanner({ model });

    const plan = await planner.plan(
      request({
        intents: [
          searchIntent(profile.id),
          Intent.parse({
            ...searchIntent(profile.id),
            id: uuid(4),
            type: "monitoring_request",
            statement: "Следи за этой закупкой",
            procurementId: procurement.id,
          }),
        ],
        domainProfiles: [profile],
        procurement,
      }),
    );

    expect(plan.steps.map((step) => step.capability)).toEqual([
      "domain_search",
      "monitoring",
      "notification",
    ]);
  });

  it("escalates equal-authority policy conflicts without calling the model", async () => {
    const profile = equipmentProfile();
    const model = new FakeSupervisorModel(() => {
      throw new Error("model must not run");
    });
    const planner = new SupervisorPlanner({ model });

    const plan = await planner.plan(
      request({
        intents: [searchIntent(profile.id)],
        domainProfiles: [profile],
        scopedRules: [
          {
            id: "a",
            scope: "company",
            key: "search.include_household",
            value: false,
            statement: "Не искать бытовые щитки",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "b",
            scope: "company",
            key: "search.include_household",
            value: true,
            statement: "Искать бытовые щитки",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(model.calls).toHaveLength(0);
    expect(plan.needsHuman).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(plan.humanQuestion).toContain("противоречат");
  });

  it("rejects a capability the selected profile does not allow", async () => {
    const profile = equipmentProfile();
    const model = new FakeSupervisorModel(() => ({
      intentSummary: "Оценить риски",
      selectedDomainProfileIds: [profile.id],
      steps: [
        {
          capability: "risk_analysis",
          reason: "Нужен анализ рисков",
          domainProfileId: profile.id,
        },
      ],
      needsHuman: false,
      confidence: 0.9,
    }));
    const planner = new SupervisorPlanner({ model });

    const plan = await planner.plan(
      request({
        intents: [searchIntent(profile.id)],
        domainProfiles: [profile],
      }),
    );

    expect(plan.needsHuman).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(plan.humanQuestion).toContain("проверку разрешений");
  });

  it("escalates invalid JSON, empty plans and low confidence", async () => {
    const profile = equipmentProfile();
    const cases: Array<{ label: string; output: unknown; question: string }> = [
      { label: "invalid", output: { confidence: "high" }, question: "некорректный план" },
      {
        label: "empty",
        output: {
          intentSummary: "Неясно",
          selectedDomainProfileIds: [profile.id],
          steps: [],
          needsHuman: false,
          confidence: 0.9,
        },
        question: "ни одного действия",
      },
      {
        label: "low-confidence",
        output: searchPlan(profile.id, 0.2),
        question: "недостаточна",
      },
    ];

    for (const sample of cases) {
      const planner = new SupervisorPlanner({
        model: new FakeSupervisorModel(() => sample.output),
      });
      const plan = await planner.plan(
        request({
          intents: [searchIntent(profile.id)],
          domainProfiles: [profile],
        }),
      );
      expect(plan.needsHuman, sample.label).toBe(true);
      expect(plan.humanQuestion?.toLocaleLowerCase("ru-BY"), sample.label).toContain(
        sample.question,
      );
    }
  });

  it("asks a human when the model transport fails", async () => {
    const profile = equipmentProfile();
    const planner = new SupervisorPlanner({
      model: new FakeSupervisorModel(() => {
        throw new Error("LLM API returned HTTP 503");
      }),
    });

    const plan = await planner.plan(
      request({
        intents: [searchIntent(profile.id)],
        domainProfiles: [profile],
      }),
    );

    expect(plan.needsHuman).toBe(true);
    expect(plan.humanQuestion).toContain("Не удалось составить план");
  });
});

function equipmentProfile() {
  return DomainProfile.parse({
    ...electricalEquipmentSeedV1,
    id: uuid(10),
    companyId: uuid(1),
    createdBy: uuid(2),
    createdAt: now,
    updatedAt: now,
  });
}

function searchIntent(profileId: ReturnType<typeof equipmentProfile>["id"]) {
  return Intent.parse({
    id: uuid(3),
    companyId: uuid(1),
    createdBy: uuid(2),
    type: "one_time_task",
    scope: "task",
    rawMessage: "Найди закупки КТПБ",
    statement: "Найти закупки комплектных трансформаторных подстанций",
    domainProfileIds: [profileId],
    active: true,
    createdAt: now,
    updatedAt: now,
  });
}

function caseHeader() {
  return ProcurementCaseHeader.parse({
    id: uuid(20),
    sourceId: "goszakupki_by",
    sourceProcurementId: "auction/3545578",
    url: "https://goszakupki.by/auction/view/3545578",
    year: 2026,
    title: "Поставка комплектной трансформаторной подстанции",
    kind: "electronic_auction",
    status: "accepting_bids",
    stage: "card_fetched",
    createdAt: now,
    updatedAt: now,
  });
}

function request(
  input: Pick<SupervisorRequestValue, "intents"> &
    Partial<Omit<SupervisorRequestValue, "intents" | "requestId">>,
): SupervisorRequestValue {
  return SupervisorRequest.parse({
    requestId: RequestId.parse("req-stage5"),
    domainProfiles: [],
    scopedRules: [],
    ...input,
  });
}

function searchPlan(profileId: string, confidence = 0.93): SupervisorPlan {
  return {
    intentSummary: "Найти закупки комплектных трансформаторных подстанций",
    selectedDomainProfileIds: [profileId as never],
    steps: [
      {
        capability: "domain_search",
        reason: "Нужен поиск по выбранному профилю",
        domainProfileId: profileId as never,
      },
    ],
    needsHuman: false,
    confidence,
  };
}
