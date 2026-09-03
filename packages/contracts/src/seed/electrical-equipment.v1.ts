import { DomainProfileSeed } from "../seed.js";

/**
 * Editable first-run profile for the customer assignment. Bootstrap loads this
 * object; application code must not branch on these keywords.
 */
export const electricalEquipmentSeedV1 = DomainProfileSeed.parse({
  seedId: "electrical_equipment.v1",
  slug: "electrical_equipment",
  name: "Электротехническое оборудование",
  description:
    "Поиск закупок комплектных трансформаторных подстанций, низковольтных устройств и щитового оборудования.",
  purpose: "Находить актуальные процедуры поставки КТПБ, КТПП, НКУ, ВРУ, ЩО и подстанций.",
  instructions:
    "Считай релевантными промышленные подстанции и щитовое оборудование. Бытовые щитки и мелкий электромонтаж не являются целью, если специалист не добавит их отдельно.",
  keywords: [
    "КТПБ",
    "КТПП",
    "НКУ",
    "ВРУ",
    "ЩО",
    "подстанция",
    "трансформаторная подстанция",
    "2БКТПБ",
    "БКТП",
  ],
  excludeKeywords: [],
  semanticConcepts: [
    "комплектная трансформаторная подстанция",
    "распределительное устройство",
    "щитовое оборудование",
  ],
  positiveCriteria: [
    { text: "Комплектная трансформаторная подстанция или блок-КТП", weight: 0.9 },
    { text: "Низковольтные комплектные устройства промышленного назначения", weight: 0.7 },
  ],
  negativeCriteria: [{ text: "Бытовые щитки и мелкий электромонтаж без подстанции", weight: 0.6 }],
  constraints: [],
  scoringRules: {
    formulaId: "default",
    minRelevanceToInvestigate: 0.4,
    minConfidenceToDecide: 0.7,
  },
  monitoringRules: [
    { watch: "status", intervalMinutes: 480, notifyOnChange: true, urgent: true },
    { watch: "documents", intervalMinutes: 480, notifyOnChange: true, urgent: true },
    { watch: "deadlines", intervalMinutes: 480, notifyOnChange: true, urgent: true },
  ],
  associatedCapabilities: [
    "domain_search",
    "document_ingest",
    "commercial_terms",
    "monitoring",
    "notification",
  ],
  associatedMcpTools: [
    "procurement.search",
    "procurement.get",
    "procurement.get_lots",
    "procurement.get_documents",
    "documents.list",
    "documents.download",
    "documents.extract_text",
    "documents.extract_tables",
    "documents.ocr",
    "documents.search",
    "documents.get_page",
    "files.put",
    "files.get",
    "files.exists",
    "notification.send",
    "telegram.send",
  ],
  enabled: true,
  archived: false,
  priority: 50,
});
