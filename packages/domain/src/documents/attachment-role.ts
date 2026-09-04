/**
 * Decide whether a listed file is contest paperwork or a project album.
 * Drawing OCR is a separate feature; ingest must not scan ЭКН/ЭП/КЖ sheets.
 * Patterns are data-shaped constants so a Domain Profile can override later.
 */

export type AttachmentExtractRole = "skip_project" | "contest_document" | "unknown";

export interface AttachmentRoleDecision {
  role: AttachmentExtractRole;
  reason: string;
}

export interface AttachmentRolePatterns {
  strongSkipTokens: readonly string[];
  weakSkipPhrases: readonly string[];
  contestPhrases: readonly string[];
  contestTokens: readonly string[];
  digitalContestPhrases: readonly string[];
}

/** Bootstrap lists. A profile may pass a replacement; code does not branch on industry. */
export const defaultAttachmentRolePatterns: AttachmentRolePatterns = {
  strongSkipTokens: [
    "jekn",
    "ekn",
    "экн",
    "jep",
    "эп",
    "kzh",
    "кж",
    "jeom",
    "эом",
    "chertezh",
    "чертеж",
    "shema",
    "схема",
    "albom",
    "альбом",
    "zhelezobeton",
    "железобетон",
  ],
  weakSkipPhrases: [
    "jelektrosnabzhenie",
    "elektrosnabzhenie",
    "электроснабжен",
    "konstrukc",
    "конструкц",
    "podstanci",
    "подстанц",
    "seti-04",
    "сети-04",
    "seti04",
  ],
  contestPhrases: [
    "аукцион",
    "aukcion",
    "auction",
    "извещ",
    "izvesh",
    "техническ",
    "tehnichesk",
    "техзада",
    "инструкц",
    "instrukc",
    "документац",
    "dokumentac",
    "обеспечен",
    "obespechen",
    "критери",
    "kriter",
    "договор",
    "dogovor",
    "опросн",
    "opros",
    "задание",
    "zadanie",
  ],
  contestTokens: ["тз", "tz"],
  digitalContestPhrases: [
    "аукцион",
    "извещен",
    "техническое задание",
    "аванс",
    "предоплат",
    "обеспечен",
    "инструкц участ",
  ],
};

export function classifyAttachmentRole(
  input: { name: string; digitalText?: string },
  patterns: AttachmentRolePatterns = defaultAttachmentRolePatterns,
): AttachmentRoleDecision {
  const name = normalize(input.name);
  const strongSkip = patterns.strongSkipTokens.find((token) => hasToken(name, token));
  const contestHit =
    patterns.contestPhrases.find((phrase) => name.includes(phrase)) ??
    patterns.contestTokens.find((token) => hasToken(name, token));

  if (strongSkip !== undefined) {
    const digital = input.digitalText === undefined ? "" : normalize(input.digitalText);
    const digitalContest = patterns.digitalContestPhrases.find((phrase) => digital.includes(phrase));
    if (digitalContest !== undefined && letterCount(digital) >= 80) {
      return {
        role: "contest_document",
        reason: `Имя похоже на комплект «${strongSkip}», но в текстовом слое есть формулировки конкурса («${digitalContest}») — читаем как документ закупки.`,
      };
    }
    return {
      role: "skip_project",
      reason: `Файл похож на альбом проекта (признак «${strongSkip}»). Чертежи специалист смотрит сам, распознавание не запускали.`,
    };
  }

  if (contestHit !== undefined) {
    return {
      role: "contest_document",
      reason: `Имя похоже на документ конкурса («${contestHit}»).`,
    };
  }

  const weakSkip = patterns.weakSkipPhrases.find((phrase) => name.includes(phrase));
  if (weakSkip !== undefined) {
    return {
      role: "skip_project",
      reason: `Имя похоже на проектную документацию («${weakSkip}»). Распознавание не запускали.`,
    };
  }

  return {
    role: "unknown",
    reason:
      "По имени не ясно, документ конкурса это или проект. Скан не запускали — откройте файл вручную.",
  };
}

export function shouldScanAttachment(decision: AttachmentRoleDecision): boolean {
  return decision.role === "contest_document";
}

function normalize(value: string): string {
  return value.toLowerCase().replaceAll("ё", "е").replaceAll("_", "-");
}

function hasToken(normalized: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zа-я0-9])${escaped}([^a-zа-я0-9]|$)`, "u").test(normalized);
}

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}
