import { describe, expect, it } from "vitest";
import { createMemoryAdminJournal } from "./journal.js";

describe("memory admin journal", () => {
  it("counts recent errors and keeps access rows visible", async () => {
    const journal = createMemoryAdminJournal();
    await journal.record({
      kind: "access",
      level: "info",
      message: "Администратор одобрил доступ: Иван (ivan@example.com) → Специалист",
      actorName: "Администратор",
      actorEmail: "admin@example.com",
    });
    await journal.record({
      kind: "search",
      level: "error",
      message: "Площадка goszakupki.by недоступна",
    });

    const listed = await journal.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.level).toBe("error");
    expect(listed[1]?.kind).toBe("access");
    expect(await journal.errorCount()).toBe(1);
  });

  it("keeps a cleared error in history but stops counting it", async () => {
    const journal = createMemoryAdminJournal();
    await journal.record({ kind: "search", level: "error", message: "Площадка недоступна" });

    expect(await journal.acknowledgeErrors("2026-09-07T09:00:00.000Z")).toBe(1);
    expect(await journal.errorCount()).toBe(0);
    const listed = await journal.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.message).toBe("Площадка недоступна");
    expect(listed[0]?.acknowledgedAt).toBe("2026-09-07T09:00:00.000Z");
    // Clearing twice must not resurrect the badge or re-stamp old rows.
    expect(await journal.acknowledgeErrors()).toBe(0);
  });

  it("counts a new error after the admin cleared the old ones", async () => {
    const journal = createMemoryAdminJournal();
    await journal.record({ kind: "search", level: "error", message: "Площадка недоступна" });
    await journal.acknowledgeErrors();

    await journal.record({ kind: "documents", level: "error", message: "Файл не скачался" });

    expect(await journal.errorCount()).toBe(1);
  });
});
