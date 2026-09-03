import { describe, expect, it } from "vitest";
import { TechnicalAnalysis } from "./analysis.js";
import {
  ActivityAssessment,
  RelevanceAssessment,
  RelevanceVerdict,
} from "./assessment.js";
import { EvidenceLocation, Fact, IsoDate, PlatformInstant } from "./common.js";
import { DomainProfileDraft } from "./domain-profile.js";
import { JobErrorKind, JobRun } from "./job.js";
import {
  DocumentVersion,
  ProcedureCard,
  ProcurementDocument,
  SearchQuery,
  SourceDocument,
  SourceLot,
} from "./procurement.js";
import { Risk } from "./scoring.js";
import { DomainProfileSeed } from "./seed.js";
import { electricalEquipmentSeedV1 } from "./seed/electrical-equipment.v1.js";
import { ContextCompilation, SupervisorPlan } from "./agent.js";
import { CommercialClaim } from "./commercial-terms.js";
import { DocumentsExtractTextResponse } from "./documents.js";
import { DomainSearchCandidate } from "./domain-search.js";
import { ProcurementGetStatusResponse, ProcurementSearchRequest } from "./source-port.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-08-25T09:00:00.000Z";
const hash = "a".repeat(64);

describe("provenance invariant", () => {
  const base = {
    id: uuid(1),
    procurementId: uuid(2),
    key: "commercial.advance_percent",
    value: 30,
    confidence: 0.9,
    extractedBy: "commercial_terms",
    extractedAt: now,
  };

  it("accepts a fact that cites evidence", () => {
    const parsed = Fact.safeParse({ ...base, evidenceIds: [uuid(3)] });
    expect(parsed.success).toBe(true);
  });

  it("rejects a fact with no evidence", () => {
    const parsed = Fact.safeParse({ ...base, evidenceIds: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a risk that is not grounded in facts", () => {
    const parsed = Risk.safeParse({
      id: uuid(4),
      procurementId: uuid(2),
      type: "large_advance_required",
      severity: "high",
      description: "Advance of 50% required",
      factIds: [],
      confidence: 0.8,
      detectedBy: "risk_analysis",
      detectedAt: now,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an HTML snippet as evidence location", () => {
    const parsed = EvidenceLocation.safeParse({
      kind: "html_snippet",
      procurementId: uuid(2),
      field: "status",
      line: 42,
      url: "https://goszakupki.by/auction/view/1",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("domain profile draft", () => {
  const scoringRules = {
    formulaId: "default",
    minRelevanceToInvestigate: 0.4,
    minConfidenceToDecide: 0.7,
  };

  it("fills optional configuration with defaults so the UI can post a minimal form", () => {
    const parsed = DomainProfileDraft.parse({
      slug: "domain_a",
      name: "Направление A",
      scoringRules,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.archived).toBe(false);
    expect(parsed.priority).toBe(50);
    expect(parsed.keywords).toEqual([]);
    expect(parsed.excludeKeywords).toEqual([]);
    expect(parsed.associatedCapabilities).toEqual([]);
  });

  it("rejects a slug that is not a lowercase identifier", () => {
    const parsed = DomainProfileDraft.safeParse({
      slug: "Domain A",
      name: "Направление A",
      scoringRules,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts two unrelated profiles against the same schema", () => {
    const first = DomainProfileDraft.parse({
      slug: "domain_a",
      name: "Направление A",
      keywords: ["keyword_x"],
      excludeKeywords: ["noise_term"],
      scoringRules,
    });
    const second = DomainProfileDraft.parse({
      slug: "domain_b",
      name: "Направление B",
      keywords: ["keyword_y"],
      scoringRules,
    });

    expect(first.keywords).toEqual(["keyword_x"]);
    expect(first.excludeKeywords).toEqual(["noise_term"]);
    expect(second.keywords).toEqual(["keyword_y"]);
    expect(second.excludeKeywords).toEqual([]);
  });

  it("does not carry score weights on the profile", () => {
    const parsed = DomainProfileDraft.safeParse({
      slug: "domain_a",
      name: "Направление A",
      scoringRules: {
        ...scoringRules,
        weights: { technical: 1, commercial: 1, deadline: 1, risk: 1, companyMatch: 1 },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect("weights" in parsed.data.scoringRules).toBe(false);
  });
});

describe("equipment seed format", () => {
  it("validates the first-run electrical equipment seed as data, not code", () => {
    const parsed = DomainProfileSeed.parse(electricalEquipmentSeedV1);
    expect(parsed.seedId).toBe("electrical_equipment.v1");
    expect(parsed.slug).toBe("electrical_equipment");
    expect(parsed.keywords).toContain("КТПБ");
    expect(parsed.scoringRules.formulaId).toBe("default");
  });
});

describe("incomplete procedure card", () => {
  it("accepts a card that only has a title and a url", () => {
    const parsed = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auc0003629820",
      url: "https://goszakupki.by/auction/view/1",
      title: "Поставка оборудования",
      fetchedAt: now,
    });

    expect(parsed.lots).toEqual([]);
    expect(parsed.parties).toEqual([]);
    expect(parsed.amount).toBeUndefined();
    expect(parsed.pageFamily).toBe("other");
  });

  it("keeps a date-only deadline without inventing a time of day", () => {
    const deadline = PlatformInstant.parse({
      precision: "date",
      date: "2026-09-15",
      timeZone: "Europe/Minsk",
    });
    expect(deadline.precision).toBe("date");
    if (deadline.precision !== "date") return;
    expect(deadline.date).toBe("2026-09-15");
    expect(IsoDate.safeParse("2026-09-15T00:00:00.000Z").success).toBe(false);
  });

  it("stores a missing amount as null with the original wording", () => {
    const parsed = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "1",
      url: "https://goszakupki.by/auction/view/1",
      title: "Закупка",
      amount: { kind: "limit", amount: null, raw: "не установлена" },
      fetchedAt: now,
    });
    expect(parsed.amount?.amount).toBeNull();
  });

  it("accepts a lot with several positions and a separate organizer", () => {
    const parsed = ProcedureCard.parse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "1",
      url: "https://goszakupki.by/auction/view/1",
      title: "Закупка",
      pageFamily: "auction",
      parties: [
        { role: "buyer", name: "Заказчик", registrationNumber: "123456789" },
        { role: "organizer", name: "Организатор" },
      ],
      lots: [
        {
          id: uuid(10),
          procurementId: uuid(2),
          number: "1",
          title: "Лот 1",
          positions: [
            { id: uuid(11), lotId: uuid(10), externalNumber: "1.1", title: "Позиция 1" },
            { id: uuid(12), lotId: uuid(10), externalNumber: "1.2", title: "Позиция 2" },
          ],
        },
      ],
      fetchedAt: now,
    });

    expect(parsed.lots[0]?.positions).toHaveLength(2);
    expect(parsed.parties.map((party) => party.role)).toEqual(["buyer", "organizer"]);
  });
});

describe("document lifecycle", () => {
  it("keeps the last version when a document is marked deleted", () => {
    const document = ProcurementDocument.parse({
      id: uuid(20),
      procurementId: uuid(2),
      name: "tz.docx",
      sourceUrl: "https://goszakupki.by/auction/get-file/1?f=0",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceFileKey: "0",
      currentVersionId: uuid(21),
      lifecycle: "deleted",
      discoveredAt: now,
    });
    const version = DocumentVersion.parse({
      id: uuid(21),
      documentId: uuid(20),
      version: 1,
      hash,
      sizeBytes: 1024,
      downloadedAt: now,
      storageKey: `blobs/${hash}`,
    });

    expect(document.lifecycle).toBe("deleted");
    expect(document.currentVersionId).toBe(version.id);
  });
});

describe("relevance and activity assessments", () => {
  it("does not treat a borderline relevance verdict as automatically relevant", () => {
    const parsed = RelevanceAssessment.parse({
      id: uuid(30),
      procurementId: uuid(2),
      domainProfileId: uuid(3),
      formulaId: "relevance.default",
      formulaVersion: 1,
      verdict: "needs_human",
      score: 0.45,
      confidence: 0.6,
      explanation: "Пограничное совпадение, требуется проверка специалиста.",
      assessedAt: now,
    });

    expect(parsed.verdict).toBe("needs_human");
    expect(RelevanceVerdict.options.includes("relevant")).toBe(true);
    expect(parsed.verdict).not.toBe("relevant");
  });

  it("records an unknown status as human review rather than inactive", () => {
    const parsed = ActivityAssessment.parse({
      id: uuid(31),
      procurementId: uuid(2),
      sourceStatus: "не удалось разобрать подпись",
      normalizedStatus: "unknown",
      verdict: "needs_human",
      reason: "Статус карточки не распознан.",
      evidenceIds: [uuid(32)],
      assessedAt: now,
    });

    expect(parsed.verdict).toBe("needs_human");
    expect(parsed.normalizedStatus).toBe("unknown");
  });

  it("records a closed procedure as inactive", () => {
    const parsed = ActivityAssessment.parse({
      id: uuid(33),
      procurementId: uuid(2),
      sourceStatus: "процедура завершена",
      normalizedStatus: "completed",
      verdict: "inactive",
      reason: "Подача предложений закрыта.",
      evidenceIds: [uuid(34)],
      assessedAt: now,
    });

    expect(parsed.verdict).toBe("inactive");
  });
});

describe("source port envelopes", () => {
  it("accepts a search query with exclude keywords and no profile payload", () => {
    const parsed = ProcurementSearchRequest.parse({
      sourceId: "goszakupki_by",
      keywords: ["keyword_x"],
      excludeKeywords: ["noise_term"],
    });
    expect(parsed.excludeKeywords).toEqual(["noise_term"]);
    expect("domainProfile" in parsed).toBe(false);
  });

  it("rejects profile data crossing the source-neutral boundary", () => {
    const parsed = ProcurementSearchRequest.safeParse({
      sourceId: "goszakupki_by",
      domainProfile: { slug: "domain_a" },
    });

    expect(parsed.success).toBe(false);
  });

  it("keeps normalized and original source status together", () => {
    const parsed = ProcurementGetStatusResponse.parse({
      status: "unknown",
      sourceStatus: "Неизвестная подпись площадки",
      fetchedAt: now,
    });

    expect(parsed.status).toBe("unknown");
    expect(parsed.sourceStatus).toBe("Неизвестная подпись площадки");
  });

  it("does not require internal database ids from a source adapter", () => {
    expect(
      SourceLot.parse({
        number: "1",
        title: "Source lot",
        positions: [{ title: "Source position" }],
      }),
    ).not.toHaveProperty("procurementId");
    expect(
      SourceDocument.parse({
        name: "spec.pdf",
        sourceUrl: "https://example.test/spec.pdf",
        mimeType: "application/pdf",
        discoveredAt: now,
      }),
    ).not.toHaveProperty("id");
  });
});

describe("job run", () => {
  it("requires an idempotency key and a typed error kind", () => {
    const parsed = JobRun.parse({
      id: uuid(40),
      kind: "search",
      status: "failed",
      idempotencyKey: "goszakupki_by:domain_a:2026-08-31T06:00",
      payload: { sourceId: "goszakupki_by" },
      error: { kind: "retryable", message: "source timeout" },
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.idempotencyKey.length).toBeGreaterThan(0);
    expect(JobErrorKind.options).toEqual(["retryable", "terminal", "needs_human"]);
  });
});

describe("technical analysis provenance", () => {
  it("rejects unsourced equipment strings", () => {
    const parsed = TechnicalAnalysis.safeParse({
      equipment: ["item_a"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("search query", () => {
  it("defaults exclude keywords to an empty list", () => {
    const parsed = SearchQuery.parse({ sourceId: "goszakupki_by" });
    expect(parsed.excludeKeywords).toEqual([]);
  });
});

describe("supervisor plan", () => {
  it("requires a Russian human question when the plan is escalated", () => {
    const parsed = SupervisorPlan.safeParse({
      intentSummary: "Найти закупки подстанций",
      needsHuman: true,
      confidence: 0.4,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("context compilation", () => {
  it("rejects an escalation without a human question", () => {
    const parsed = ContextCompilation.safeParse({ status: "needs_human" });
    expect(parsed.success).toBe(false);
  });
});

describe("domain search candidate", () => {
  it("stores a verdict instead of a 0-100 model score", () => {
    const parsed = DomainSearchCandidate.safeParse({
      sourceId: "goszakupki_by",
      sourceProcurementId: "auction/1",
      url: "https://goszakupki.by/auction/view/1",
      title: "КТПБ",
      verdict: 87,
      confidence: 0.9,
      reason: "Похоже",
      needDeeper: true,
      classifiedBy: "model",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("document extraction", () => {
  it("keeps OCR confidence on 0..1 and names a low-confidence scan explicitly", () => {
    const parsed = DocumentsExtractTextResponse.parse({
      hash: "a".repeat(64),
      status: "ocr_low_confidence",
      text: "ав нс",
      ocrApplied: true,
      confidence: 0.31,
      pages: [{ page: 1, text: "ав нс", ocrApplied: true, confidence: 0.31 }],
    });
    expect(parsed.status).toBe("ocr_low_confidence");
    expect(parsed.confidence).toBeLessThan(0.75);
  });
});

describe("commercial claim", () => {
  it("rejects a claim without a verbatim quote", () => {
    const parsed = CommercialClaim.safeParse({
      key: "commercial.advance_percent",
      value: 30,
      confidence: 0.9,
      hash: "a".repeat(64),
      page: 1,
    });
    expect(parsed.success).toBe(false);
  });
});

