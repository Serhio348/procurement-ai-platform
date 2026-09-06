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
});
