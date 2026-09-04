import { describe, expect, it } from "vitest";
import { reconstructPageText } from "./pdf-layout.js";

describe("reconstructPageText", () => {
  it("reads a title block left-to-right by visual row, not by PDF item order", () => {
    const text = reconstructPageText([
      { str: "ПРОЕКТ", x: 200, y: 700, width: 80, height: 12, hasEOL: false },
      { str: "Заказчик:", x: 40, y: 640, width: 70, height: 10, hasEOL: false },
      { str: "ОАО", x: 120, y: 640, width: 30, height: 10, hasEOL: false },
      { str: "Шифр", x: 40, y: 500, width: 40, height: 10, hasEOL: true },
    ]);
    expect(text).toBe("ПРОЕКТ\nЗаказчик: ОАО\nШифр");
  });
});
