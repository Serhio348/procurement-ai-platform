import { ChangeEvent, TELEGRAM_MAX_TEXT_LENGTH } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { compileChangeAlert, compileTelegramText, truncateTelegramText } from "./message.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-03T10:00:00.000Z";

describe("compileChangeAlert", () => {
  it("copies status strings from the event and does not invent an advance percent", () => {
    const compiled = compileChangeAlert(
      [
        ChangeEvent.parse({
          id: uuid(1),
          procurementId: uuid(2),
          kind: "status_changed",
          previous: "accepting_bids",
          current: "cancelled",
          detectedAt: now,
          urgent: true,
        }),
      ],
      {
        title: "Поставка КТПБ",
        sourceProcurementId: "auction/001",
        url: "https://goszakupki.by/auction/view/001",
      },
    );

    expect(compiled?.title).toBe("Поставка КТПБ");
    expect(compiled?.body).toContain("Статус (срочно): accepting_bids → cancelled.");
    expect(compiled?.body).toContain("Номер: auction/001.");
    expect(compiled?.body).not.toMatch(/аванс/i);
    expect(compiled?.body).not.toMatch(/\d+%/);
  });

  it("returns nothing when there are no changes to deliver", () => {
    expect(compileChangeAlert([])).toBeUndefined();
  });
});

describe("truncateTelegramText", () => {
  it("fits the Bot API limit without dropping a short message", () => {
    expect(truncateTelegramText("короткий текст")).toBe("короткий текст");
  });

  it("cuts a long payload to 4096 characters so telegram.send can accept it", () => {
    const text = "я".repeat(TELEGRAM_MAX_TEXT_LENGTH + 40);
    const truncated = truncateTelegramText(text);
    expect(truncated).toHaveLength(TELEGRAM_MAX_TEXT_LENGTH);
    expect(truncated.endsWith("…")).toBe(true);
    expect(compileTelegramText("Заголовок", "тело")).toBe("Заголовок\n\nтело");
  });
});
