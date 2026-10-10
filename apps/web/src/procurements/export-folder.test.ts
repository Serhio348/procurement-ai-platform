import { SpecialistProcurementExport } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import { writeExportFolder, type ExportDirectory, type ExportFileHandle, type ExportWritable } from "./export-folder.js";

interface StoredFile {
  text: string;
  bytes?: Uint8Array;
}

interface FakeDir extends ExportDirectory {
  dirs: Map<string, FakeDir>;
  files: Map<string, StoredFile>;
}

function fakeDirectory(): FakeDir {
  const dirs = new Map<string, FakeDir>();
  const files = new Map<string, StoredFile>();
  return {
    dirs,
    files,
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const found = dirs.get(name);
      if (found !== undefined) return found;
      if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
      const created = fakeDirectory();
      dirs.set(name, created);
      return created;
    },
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<ExportFileHandle> {
      if (!files.has(name)) {
        if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
        files.set(name, { text: "" });
      }
      return {
        async getFile() {
          const stored = files.get(name) ?? { text: "" };
          return { text: async () => stored.text };
        },
        async createWritable(): Promise<ExportWritable> {
          let text = "";
          let bytes: Uint8Array | undefined;
          return {
            async write(data: string | BufferSource) {
              if (typeof data === "string") {
                text += data;
                return;
              }
              bytes = toBytes(data);
            },
            async close() {
              files.set(name, { text, ...(bytes === undefined ? {} : { bytes }) });
            },
          };
        },
      };
    },
  };
}

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function plan(id: string, files: { name: string; hash: string }[] = []): SpecialistProcurementExport {
  return SpecialistProcurementExport.parse({
    folderName: "Поставка КТП",
    sourceProcurementId: id,
    readmeName: "карточка.txt",
    readme: `Название: Поставка КТП\nНомер: ${id}\n`,
    files,
  });
}

describe("writeExportFolder", () => {
  it("writes the card text and the downloaded file into a folder named as the card", async () => {
    const parent = fakeDirectory();
    const hash = "a".repeat(64);
    const bytes = new Uint8Array([9, 8, 7]);
    const folderName = await writeExportFolder(
      parent,
      plan("request/1", [{ name: "ТЗ.pdf", hash }]),
      async () => new Response(bytes),
    );
    const folder = parent.dirs.get(folderName);
    expect(folderName).toBe("Поставка КТП");
    expect(folder?.files.get("карточка.txt")?.text).toContain("Номер: request/1");
    expect(folder?.files.get("ТЗ.pdf")?.bytes).toEqual(bytes);
  });

  it("updates the same folder for the same procurement and leaves a foreign folder alone", async () => {
    const parent = fakeDirectory();
    const hash = "b".repeat(64);
    await writeExportFolder(parent, plan("request/1", [{ name: "ТЗ.pdf", hash }]), async () => new Response(new Uint8Array([1])));
    const again = await writeExportFolder(
      parent,
      plan("request/1", [{ name: "ТЗ.pdf", hash }]),
      async () => new Response(new Uint8Array([2])),
    );
    expect(again).toBe("Поставка КТП");
    expect(parent.dirs.get("Поставка КТП")?.files.get("ТЗ.pdf")?.bytes).toEqual(new Uint8Array([2]));

    const other = await writeExportFolder(parent, plan("request/2"), async () => new Response(new Uint8Array()));
    expect(other).toBe("Поставка КТП 2");
    expect(parent.dirs.get("Поставка КТП")?.files.get("карточка.txt")?.text).toContain("Номер: request/1");
    expect(parent.dirs.get("Поставка КТП 2")?.files.get("карточка.txt")?.text).toContain("Номер: request/2");
  });

  it("does not write into a folder that has no card marker", async () => {
    const parent = fakeDirectory();
    const foreign = fakeDirectory();
    foreign.files.set("своё.txt", { text: "не трогать" });
    parent.dirs.set("Поставка КТП", foreign);
    const written = await writeExportFolder(parent, plan("request/9"), async () => new Response(new Uint8Array()));
    expect(written).toBe("Поставка КТП 9");
    expect(foreign.files.has("карточка.txt")).toBe(false);
    expect(foreign.files.get("своё.txt")?.text).toBe("не трогать");
  });
});
