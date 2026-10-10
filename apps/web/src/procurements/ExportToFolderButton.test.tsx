import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportToFolderButton } from "./ExportToFolderButton.js";
import type { ExportDirectory } from "./export-folder.js";

const parent = vi.hoisted(() => ({
  name: "Закупки",
  queryPermission: async () => "granted" as PermissionState,
  requestPermission: async () => "granted" as PermissionState,
  getDirectoryHandle: vi.fn(),
  getFileHandle: vi.fn(),
}));

vi.mock("./export-folder.js", async () => {
  const actual = await vi.importActual("./export-folder.js");
  return {
    ...(actual as Record<string, unknown>),
    loadExportDirectory: vi.fn(async () => undefined),
    acquireExportDirectory: vi.fn(async () => parent),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExportToFolderButton", () => {
  it("saves the card into the chosen folder when the specialist clicks Выгрузить в папку", async () => {
    const user = userEvent.setup();
    const hash = "a".repeat(64);
    const directories = new Map<string, ExportDirectory>();
    parent.getDirectoryHandle.mockImplementation(async (name: string, options?: { create?: boolean }) => {
      const found = directories.get(name);
      if (found !== undefined) return found;
      if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
      const created: ExportDirectory = {
        async getDirectoryHandle() {
          throw new DOMException("missing", "NotFoundError");
        },
        async getFileHandle(_fileName: string, fileOptions?: { create?: boolean }) {
          if (fileOptions?.create !== true) throw new DOMException("missing", "NotFoundError");
          return {
            async getFile() {
              return { text: async () => "" };
            },
            async createWritable() {
              return { write: async () => undefined, close: async () => undefined };
            },
          };
        },
      };
      directories.set(name, created);
      return created;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/export")) {
          return new Response(
            JSON.stringify({
              folderName: "Поставка КТП",
              sourceProcurementId: "request/1",
              readmeName: "карточка.txt",
              readme: "Номер: request/1\n",
              files: [{ name: "ТЗ.pdf", hash }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );

    render(<ExportToFolderButton procurementId="00000000-0000-4000-8000-000000000901" />);
    await user.click(screen.getByRole("button", { name: "Выгрузить в папку" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Сохранено в «Закупки/Поставка КТП»");
    });
    expect(screen.getByRole("status").textContent).toContain("Файлов: 1");
    expect(directories.has("Поставка КТП")).toBe(true);
  });
});
