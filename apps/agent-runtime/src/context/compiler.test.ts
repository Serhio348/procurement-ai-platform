import {
  DomainProfile,
  Intent,
  ProcurementCaseHeader,
  ProcurementId,
  RequestId,
  electricalEquipmentSeedV1,
  type ContextCompileRequest,
} from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { capabilityRegistry } from "../registry/capabilities.js";
import { ContextCompiler } from "./compiler.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T06:00:00.000Z";

describe("ContextCompiler", () => {
  it("gives domain_search only the selected profile and never the raw specialist message", () => {
    const equipment = equipmentProfile();
    const pumps = otherProfile();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "domain_search",
        domainProfileId: equipment.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment, pumps],
        scopedRules: [householdRule()],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.intent).toEqual({
      type: "one_time_task",
      scope: "task",
      statement: "Найти закупки комплектных трансформаторных подстанций",
    });
    expect(result.context.intent).not.toHaveProperty("rawMessage");
    expect(result.context.domainProfile?.slug).toBe("electrical_equipment");
    expect(result.context.domainProfile?.keywords).toContain("КТПБ");
    expect(result.context.domainProfile?.keywords).not.toContain("насос");
    expect(result.context.constraints.map((item) => item.statement)).toEqual([
      "Не искать бытовые щитки",
    ]);
    expect(result.context.allowedTools).toEqual([
      "procurement.search",
      "procurement.get",
      "procurement.get_lots",
      "procurement.get_status",
    ]);
    expect(result.context.allowedTools).not.toContain("telegram.send");
    expect(result.context.estimatedTokens).toBeGreaterThan(0);
    expect(result.context.estimatedTokens).toBeLessThanOrEqual(
      capabilityRegistry.domain_search.maxContextTokens,
    );
  });

  it("does not hand notification agents a domain profile or search tools", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "notification",
        procurementId: procurement.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
        procurement,
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.domainProfile).toBeUndefined();
    expect(result.context.procurement?.id).toBe(procurement.id);
    expect(result.context.allowedTools).toEqual(["notification.send", "telegram.send"]);
    expect(result.context.allowedTools).not.toContain("procurement.search");
  });

  it("keeps only history for the current procurement and drops older items first", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const otherCase = ProcurementId.parse(uuid(21));
    const compiler = new ContextCompiler({ maxHistoryItems: 2 });

    const result = compiler.compile(
      request({
        capability: "monitoring",
        domainProfileId: equipment.id,
        procurementId: procurement.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
        procurement,
        relevantHistory: [
          {
            at: "2026-09-01T00:00:00.000Z",
            summary: "Старая проверка этой закупки",
            procurementId: procurement.id,
          },
          {
            at: "2026-09-02T00:00:00.000Z",
            summary: "Средняя проверка этой закупки",
            procurementId: procurement.id,
          },
          {
            at: "2026-09-03T00:00:00.000Z",
            summary: "Свежая проверка этой закупки",
            procurementId: procurement.id,
          },
          {
            at: "2026-09-03T01:00:00.000Z",
            summary: "Чужая закупка",
            procurementId: otherCase,
          },
        ],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.relevantHistory.map((item) => item.summary)).toEqual([
      "Свежая проверка этой закупки",
      "Средняя проверка этой закупки",
    ]);
  });

  it("escalates equal-authority conflicts instead of compiling a context", () => {
    const equipment = equipmentProfile();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "domain_search",
        domainProfileId: equipment.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
        scopedRules: [
          householdRule(),
          {
            ...householdRule(),
            id: "b",
            value: true,
            statement: "Искать бытовые щитки",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(result.status).toBe("needs_human");
    if (result.status !== "needs_human") return;
    expect(result.humanQuestion).toContain("противоречат");
  });

  it("asks a human when active constraints cannot fit the token budget", () => {
    const equipment = equipmentProfile();
    const compiler = new ContextCompiler({
      registry: {
        ...capabilityRegistry,
        domain_search: {
          ...capabilityRegistry.domain_search,
          maxContextTokens: 80,
        },
      },
    });

    const result = compiler.compile(
      request({
        capability: "domain_search",
        domainProfileId: equipment.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
        scopedRules: [
          {
            id: "huge",
            scope: "company",
            key: "search.policy",
            value: false,
            statement: "Очень длинное обязательное ограничение. ".repeat(40),
            createdAt: now,
          },
        ],
      }),
    );

    expect(result.status).toBe("needs_human");
    if (result.status !== "needs_human") return;
    expect(result.humanQuestion).toContain("не помещаются");
  });

  it("trims profile prose before dropping keywords when the budget is tight", () => {
    const equipment = DomainProfile.parse({
      ...equipmentProfile(),
      instructions: "Подробная инструкция для агента. ".repeat(80),
    });
    const compiler = new ContextCompiler({
      registry: {
        ...capabilityRegistry,
        domain_search: {
          ...capabilityRegistry.domain_search,
          maxContextTokens: 900,
        },
      },
    });

    const result = compiler.compile(
      request({
        capability: "domain_search",
        domainProfileId: equipment.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.domainProfile?.keywords).toContain("КТПБ");
    expect(result.context.domainProfile?.instructions).toBe("");
    expect(result.context.estimatedTokens).toBeLessThanOrEqual(900);
  });

  it("keeps extract and OCR tools for document_ingest after the profile intersection", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "document_ingest",
        domainProfileId: equipment.id,
        procurementId: procurement.id,
        procurement,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.allowedTools).toEqual(
      expect.arrayContaining([
        "procurement.get_documents",
        "procurement.download",
        "documents.download",
        "documents.extract_text",
        "documents.extract_tables",
        "documents.ocr",
        "files.put",
        "files.get",
        "files.exists",
      ]),
    );
    expect(result.context.allowedTools).not.toContain("telegram.send");
    expect(result.context.allowedTools).not.toContain("files.delete");
  });

  it("gives commercial_terms ingested document hashes and never search tools", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const compiler = new ContextCompiler();
    const hash = "a".repeat(64);

    const result = compiler.compile(
      request({
        capability: "commercial_terms",
        domainProfileId: equipment.id,
        procurementId: procurement.id,
        procurement,
        documents: [{ hash, name: "Техническое задание.pdf", status: "extracted" }],
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.documents).toEqual([
      { hash, name: "Техническое задание.pdf", status: "extracted" },
    ]);
    expect(result.context.allowedTools).toEqual(
      expect.arrayContaining(["documents.search", "documents.get_page"]),
    );
    expect(result.context.allowedTools).not.toContain("procurement.search");
    expect(result.context.allowedTools).not.toContain("telegram.send");
  });

  it("gives monitoring the profile watch list and never telegram", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "monitoring",
        domainProfileId: equipment.id,
        procurementId: procurement.id,
        procurement,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.domainProfile?.monitoringRules.map((rule) => rule.watch)).toEqual([
      "status",
      "documents",
      "deadlines",
    ]);
    expect(result.context.allowedTools).toEqual(
      expect.arrayContaining([
        "procurement.get_status",
        "procurement.get_changes",
        "procurement.get_documents",
      ]),
    );
    expect(result.context.allowedTools).not.toContain("telegram.send");
  });

  it("gives report file storage and never telegram", () => {
    const equipment = equipmentProfile();
    const procurement = caseHeader();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "report",
        domainProfileId: equipment.id,
        procurementId: procurement.id,
        procurement,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") return;
    expect(result.context.allowedTools).toEqual(expect.arrayContaining(["files.put"]));
    expect(result.context.allowedTools).not.toContain("telegram.send");
    expect(result.context.allowedTools).not.toContain("procurement.search");
  });

  it("does not compile when the profile forbids the capability", () => {
    const equipment = equipmentProfile();
    const compiler = new ContextCompiler();

    const result = compiler.compile(
      request({
        capability: "risk_analysis",
        domainProfileId: equipment.id,
        intents: [searchIntent(equipment.id)],
        domainProfiles: [equipment],
      }),
    );

    expect(result.status).toBe("needs_human");
    if (result.status !== "needs_human") return;
    expect(result.humanQuestion).toContain("не разрешает");
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

function otherProfile() {
  return DomainProfile.parse({
    ...electricalEquipmentSeedV1,
    id: uuid(11),
    slug: "pumps",
    name: "Насосы",
    purpose: "Искать насосное оборудование",
    keywords: ["насос", "помпа"],
    createdBy: uuid(2),
    companyId: uuid(1),
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

function householdRule() {
  return {
    id: "a",
    scope: "company" as const,
    key: "search.include_household",
    value: false,
    statement: "Не искать бытовые щитки",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(
  input: Pick<ContextCompileRequest, "capability"> &
    Partial<Omit<ContextCompileRequest, "capability" | "requestId" | "event">>,
): ContextCompileRequest {
  return {
    requestId: RequestId.parse("req-stage6"),
    event: {
      kind: "plan_step",
      description: "Запустить шаг плана Supervisor",
      occurredAt: now,
    },
    intents: [],
    domainProfiles: [],
    scopedRules: [],
    documents: [],
    relevantHistory: [],
    systemForbiddenTools: [],
    ...input,
  };
}
