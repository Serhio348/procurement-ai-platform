import type { SpecialistCaseDocument, SpecialistProcurementCard } from "@procurement/contracts";
import { printInstant } from "./source-card.js";

const FORBIDDEN_NAME_CHARS = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);

/** Windows rejects these in a file or folder name, including control characters. */
function withoutForbiddenNameChars(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 32 || FORBIDDEN_NAME_CHARS.has(char) ? " " : char;
  }
  return cleaned;
}

export const CARD_EXPORT_README_NAME = "карточка.txt";

export interface ProcurementExportFile {
  /** File name inside the card folder, without the folder itself. */
  name: string;
  hash: string;
}

export interface ProcurementExport {
  /** Directory the browser creates under the place the specialist picked. */
  folderName: string;
  sourceProcurementId: string;
  readmeName: typeof CARD_EXPORT_README_NAME;
  readme: string;
  files: ProcurementExportFile[];
}

export interface ExistingExportFolder {
  name: string;
  /** Owner read from карточка.txt. Absent when the directory is not our export. */
  ownerId: string | undefined;
}

/**
 * A download name Windows will accept. The card title is the
 * folder the specialist asked for; characters that break a path are spaces.
 */
export function exportFolderName(title: string): string {
  const cleaned = withoutForbiddenNameChars(title).replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  const limited = [...cleaned].slice(0, 80).join("").trim().replace(/[. ]+$/g, "");
  return limited.length > 0 ? limited : "Закупка";
}

function exportFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = withoutForbiddenNameChars(base).replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  const limited = [...cleaned].slice(0, 120).join("").trim().replace(/[. ]+$/g, "");
  return limited.length > 0 ? limited : "файл";
}

function uniqueFileName(name: string, used: Set<string>): string {
  const safe = exportFileName(name);
  const key = safe.toLocaleLowerCase("ru-BY");
  if (!used.has(key)) {
    used.add(key);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  let index = 2;
  let next = `${stem} (${String(index)})${extension}`;
  while (used.has(next.toLocaleLowerCase("ru-BY"))) {
    index += 1;
    next = `${stem} (${String(index)})${extension}`;
  }
  used.add(next.toLocaleLowerCase("ru-BY"));
  return next;
}

function line(label: string, value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return `${label}: ${value.trim()}`;
}

/** «Номер:» in карточка.txt is how a second save finds the same folder. */
export function exportOwnerId(readme: string): string | undefined {
  for (const line of readme.split(/\r?\n/)) {
    if (!line.startsWith("Номер: ")) continue;
    const id = line.slice("Номер: ".length).trim();
    return id.length > 0 ? id : undefined;
  }
  return undefined;
}

function folderWithSuffix(folderName: string, suffix: string): string {
  const cleaned = withoutForbiddenNameChars(suffix).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return folderName;
  const combined = `${folderName} ${cleaned}`.replace(/\s+/g, " ").trim();
  const limited = [...combined].slice(0, 80).join("").trim().replace(/[. ]+$/g, "");
  return limited.length > 0 ? limited : folderName;
}

/** Same title, different procurement: the public number is added to the folder. */
export function disambiguatedExportFolderName(folderName: string, sourceProcurementId: string): string {
  const number = sourceProcurementId.split("/").filter((part) => part.length > 0).pop() ?? sourceProcurementId;
  return folderWithSuffix(folderName, number);
}

/**
 * Names to look up before creating a directory. The first free name, or the
 * one that already belongs to this procurement, is the one to write.
 */
export function exportFolderCandidates(folderName: string, sourceProcurementId: string): readonly string[] {
  const names = [folderName];
  const numbered = disambiguatedExportFolderName(folderName, sourceProcurementId);
  if (!names.includes(numbered)) names.push(numbered);
  const full = folderWithSuffix(folderName, sourceProcurementId.replace(/\//g, " "));
  if (!names.includes(full)) names.push(full);
  return names;
}

/**
 * A directory that already holds another card, or a folder the specialist
 * created themselves, is left as it is. This card then gets the next name.
 */
export function selectExportFolderName(
  folderName: string,
  sourceProcurementId: string,
  existing: readonly ExistingExportFolder[],
): string {
  const candidates = exportFolderCandidates(folderName, sourceProcurementId);
  for (const name of candidates) {
    const found = existing.find((item) => item.name === name);
    if (found === undefined || found.ownerId === sourceProcurementId) return name;
  }
  const tail = candidates[candidates.length - 1] ?? folderName;
  return folderWithSuffix(tail, "2");
}

/**
 * One folder named as the card, a text copy of the card, and every file that
 * was actually stored. A listed file that never downloaded stays in the text
 * and is not written as an empty file.
 */
export function buildProcurementExport(
  card: SpecialistProcurementCard,
  blobAvailable: (hash: string) => boolean = () => true,
): ProcurementExport {
  const folderName = exportFolderName(card.title);
  const used = new Set<string>([CARD_EXPORT_README_NAME]);
  const files: ProcurementExportFile[] = [];
  const included: string[] = [];
  const missing: string[] = [];
  for (const document of card.documents) {
    const stored = storedDocument(document, blobAvailable);
    if (stored === undefined) {
      missing.push(document.name);
      continue;
    }
    const name = uniqueFileName(document.name, used);
    files.push({ name, hash: stored });
    included.push(name);
  }
  const source = card.sourceCard;
  const readme = [
    line("Название", card.title),
    line("Номер", card.sourceProcurementId),
    line("Статус", card.statusLabel),
    line("Ссылка", card.url),
    line("Заказчик", card.buyerName),
    line("Сумма", card.amountLabel),
    line("Дата размещения", printInstant(source?.publishedAt)),
    line("Окончание приёма", printInstant(source?.bidsDeadline)),
    "",
    "Скачанные файлы:",
    ...(included.length === 0 ? ["— нет"] : included.map((name) => `— ${name}`)),
    "",
    "Не скачаны:",
    ...(missing.length === 0 ? ["— нет"] : missing.map((name) => `— ${name}`)),
    "",
  ]
    .filter((row): row is string => row !== undefined)
    .join("\n");
  return {
    folderName,
    sourceProcurementId: card.sourceProcurementId,
    readmeName: CARD_EXPORT_README_NAME,
    readme,
    files,
  };
}

function storedDocument(
  document: SpecialistCaseDocument,
  blobAvailable: (hash: string) => boolean,
): string | undefined {
  if (document.status !== "hashed" || document.hash === undefined) return undefined;
  if (!blobAvailable(document.hash)) return undefined;
  return document.hash;
}
