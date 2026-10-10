import { SpecialistProcurementCard } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProcurementExport,
  exportFolderName,
  exportOwnerId,
  selectExportFolderName,
} from "./card-export.js";

function card(title: string) {
  return SpecialistProcurementCard.parse({
    id: "00000000-0000-4000-8000-000000000901",
    title,
    status: "accepting_bids",
    statusLabel: "Подача предложений",
    url: "https://goszakupki.by/request/view/1",
    sourceProcurementId: "request/1",
    buyerName: "Заказчик",
    documents: [
      {
        name: "ТЗ.pdf",
        sourceUrl: "https://goszakupki.by/files/a",
        hash: "a".repeat(64),
        status: "hashed",
      },
      {
        name: "ТЗ.pdf",
        sourceUrl: "https://goszakupki.by/files/b",
        hash: "b".repeat(64),
        status: "hashed",
      },
      {
        name: "ещё не скачан.docx",
        sourceUrl: "https://goszakupki.by/files/c",
        status: "discovered",
      },
      {
        name: "нет в хранилище.pdf",
        sourceUrl: "https://goszakupki.by/files/d",
        hash: "c".repeat(64),
        status: "hashed",
      },
    ],
  });
}

describe("procurement card export", () => {
  it("names the folder after the card and keeps the title readable", () => {
    expect(exportFolderName('Поставка КТП: корпус "А" / цех')).toBe("Поставка КТП корпус А цех");
    expect(exportFolderName("   ...  ")).toBe("Закупка");
  });

  it("lists only stored files and notes the ones that were not downloaded", () => {
    const exported = buildProcurementExport(card("Поставка КТП"), (hash) => hash.startsWith("a") || hash.startsWith("b"));
    expect(exported.folderName).toBe("Поставка КТП");
    expect(exported.readmeName).toBe("карточка.txt");
    expect(exported.files.map((file) => file.name)).toEqual(["ТЗ.pdf", "ТЗ (2).pdf"]);
    expect(exported.readme).toContain("Номер: request/1");
    expect(exportOwnerId(exported.readme)).toBe("request/1");
    expect(exported.readme).toContain("— ТЗ.pdf");
    expect(exported.readme).toContain("— ещё не скачан.docx");
    expect(exported.readme).toContain("— нет в хранилище.pdf");
    expect(exported.readme).not.toContain("c".repeat(64));
  });

  it("keeps a second card out of a folder that already belongs to another procurement", () => {
    expect(selectExportFolderName("Поставка КТП", "request/1", [])).toBe("Поставка КТП");
    expect(
      selectExportFolderName("Поставка КТП", "request/1", [
        { name: "Поставка КТП", ownerId: "request/1" },
      ]),
    ).toBe("Поставка КТП");
    expect(
      selectExportFolderName("Поставка КТП", "request/2", [
        { name: "Поставка КТП", ownerId: "request/1" },
      ]),
    ).toBe("Поставка КТП 2");
    expect(
      selectExportFolderName("Поставка КТП", "request/2", [
        { name: "Поставка КТП", ownerId: undefined },
      ]),
    ).toBe("Поставка КТП 2");
  });
});
