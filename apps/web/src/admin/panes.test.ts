import { describe, expect, it } from "vitest";
import { journalForPane, parseAdminPane, type AdminPane } from "./panes.js";
import type { AdminJournalEntry } from "@procurement/contracts";

function entry(
  id: string,
  kind: AdminJournalEntry["kind"],
  level: AdminJournalEntry["level"],
  message: string,
): AdminJournalEntry {
  return {
    id,
    at: "2026-09-06T12:00:00.000Z",
    kind,
    level,
    message,
  };
}

const feed = [
  entry("1", "access", "info", "Иван (ivan@example.com) вошёл в консоль"),
  entry("2", "access", "info", "Иван (ivan@example.com) вышел. В системе 12 мин."),
  entry("3", "access", "info", "Администратор одобрил доступ Ивана"),
  entry("4", "search", "error", "Площадка goszakupki.by недоступна"),
  entry("5", "discovery", "info", "Фоновый поиск выполнен (Кабель). Добавлено 2, уже решённых пропущено 1."),
] as const;

describe("admin panes", () => {
  it("keeps people, presence, watch, and outages on separate windows", () => {
    expect(parseAdminPane("discovery")).toBe("discovery");
    expect(parseAdminPane("unknown")).toBeUndefined();
    expect(messages("presence")).toEqual([
      "Иван (ivan@example.com) вошёл в консоль",
      "Иван (ivan@example.com) вышел. В системе 12 мин.",
    ]);
    expect(messages("errors")).toEqual(["Площадка goszakupki.by недоступна"]);
    expect(messages("discovery")[0]).toContain("Фоновый поиск выполнен");
    expect(messages("access")).toEqual([]);
    expect(messages("cabinets")).toEqual([]);
    expect(messages("journal")).toHaveLength(5);
    expect(parseAdminPane("cabinets")).toBe("cabinets");
  });
});

function messages(pane: AdminPane): string[] {
  return journalForPane(feed, pane).map((item) => item.message);
}
