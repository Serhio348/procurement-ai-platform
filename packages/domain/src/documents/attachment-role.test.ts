import { describe, expect, it } from "vitest";
import { classifyAttachmentRole, shouldScanAttachment } from "./attachment-role.js";

describe("classifyAttachmentRole", () => {
  it("skips live goszakupki project albums by drawing-set codes", () => {
    const names = [
      "23-301-50-100-jekn-jelektrosnabzhenie.-seti-04kv_1787914333.pdf",
      "23-301-50-109-kzh-konstrukcii-zhelezobetonnyeizm.1_1787914337.pdf",
      "23-301-50-109-jep-jelektrosnabzhenie.-podstancii-i-_1787914343.pdf",
      "soglasovanaya-shema-04kv_1787914380.pdf",
    ];
    for (const name of names) {
      const decision = classifyAttachmentRole({ name });
      expect(decision.role, name).toBe("skip_project");
      expect(shouldScanAttachment(decision)).toBe(false);
    }
  });

  it("selects auction paperwork and a TZ for scanning", () => {
    expect(classifyAttachmentRole({ name: "Аукционная документация.pdf" }).role).toBe(
      "contest_document",
    );
    expect(classifyAttachmentRole({ name: "Техническое задание.pdf" }).role).toBe("contest_document");
    expect(classifyAttachmentRole({ name: "Скан договора.tiff" }).role).toBe("contest_document");
    expect(shouldScanAttachment(classifyAttachmentRole({ name: "ТЗ.pdf" }))).toBe(true);
    expect(classifyAttachmentRole({ name: "auction_1787914409.docx" }).role).toBe("contest_document");
    expect(classifyAttachmentRole({ name: "tz-na-bktp-sgc-1jj-pusk.docx" }).role).toBe(
      "contest_document",
    );
  });

  it("prefers a TZ filename over a weak electrical-project phrase", () => {
    const decision = classifyAttachmentRole({
      name: "Техническое задание на электроснабжение.pdf",
    });
    expect(decision.role).toBe("contest_document");
  });

  it("does not let a drawing-set code be overridden by a short title-block digital layer", () => {
    const decision = classifyAttachmentRole({
      name: "23-301-50-100-jekn-seti.pdf",
      digitalText: "Строительный проект. Шифр 23-301-50.",
    });
    expect(decision.role).toBe("skip_project");
  });

  it("overrides a drawing-set name when the digital layer is clearly contest text", () => {
    const decision = classifyAttachmentRole({
      name: "23-301-50-100-jekn.pdf",
      digitalText:
        "Извещение о проведении аукциона. Техническое задание. Предоплата 30 процентов. Обеспечение заявки.",
    });
    expect(decision.role).toBe("contest_document");
  });

  it("does not treat a long digital layer with an opaque name as contest paperwork", () => {
    const decision = classifyAttachmentRole({
      name: "23-301-109-tlm-po-zamechaniyam.pdf",
      digitalText: "А".repeat(400),
    });
    expect(decision.role).toBe("unknown");
    expect(shouldScanAttachment(decision)).toBe(false);
  });
});
