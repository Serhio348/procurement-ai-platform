import { createRequire } from "node:module";
import type { SevenZipModuleFactory } from "7z-wasm";
import { describe, expect, it } from "vitest";
import { rarEntries } from "./rar-entries.js";
import { unpackArchive, unpackZipArchive } from "./unpack-archive.js";
import { unzipEntries, zipEntries } from "./zip-entries.js";

const SevenZip = createRequire(import.meta.url)("7z-wasm") as SevenZipModuleFactory;

describe("unpackZipArchive", () => {
  it("reads members through the central directory, including a nested office file", () => {
    const inner = zipEntries({
      "word/document.xml":
        '<?xml version="1.0"?><w:document><w:p><w:r><w:t>оплата 30 дней</w:t></w:r></w:p></w:document>',
    });
    const pack = zipEntries({
      "docs/ТЗ.docx": inner,
      "__MACOSX/._ТЗ.docx": new Uint8Array([1, 2, 3]),
    });

    const members = unpackZipArchive(pack);
    expect(members.map((item) => item.path)).toEqual(["docs/ТЗ.docx"]);
    expect(unzipEntries(members[0]?.bytes ?? new Uint8Array()).has("word/document.xml")).toBe(
      true,
    );
  });

  it("decodes a CP1251 member name when the UTF-8 flag is absent", () => {
    // Windows-made contest zips store Cyrillic names as CP1251 without the
    // UTF-8 bit; the reader must not turn them into mojibake.
    const name = Buffer.from([0xd2, 0xc7, 0x2e, 0x74, 0x78, 0x74]); // «ТЗ.txt» в CP1251
    const data = Buffer.from("hello");
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // no UTF-8 flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);

    const entries = unzipEntries(new Uint8Array(local));
    expect([...entries.keys()]).toEqual(["ТЗ.txt"]);
    expect(Buffer.from(entries.get("ТЗ.txt") ?? []).toString()).toBe("hello");
  });
});

describe("unpackArchive (7z-wasm)", () => {
  it("extracts a RAR4 archive with stored members", async () => {
    const rar = rarEntries({
      "ТЗ.txt": "условия конкурса",
      "вложенная/смета.txt": "1000 руб",
    });

    const result = await unpackArchive("rar", rar);

    expect(result.error).toBeUndefined();
    expect(result.members.map((item) => item.path).sort()).toEqual([
      "ТЗ.txt",
      "вложенная/смета.txt",
    ]);
    expect(Buffer.from(result.members[0]?.bytes ?? []).length).toBeGreaterThan(0);
  });

  it("extracts a 7z archive", async () => {
    const seven = await SevenZip({ print: () => undefined, printErr: () => undefined });
    seven.FS.writeFile("/note.txt", Buffer.from("содержимое файла", "utf8"));
    seven.callMain(["a", "/pack.7z", "/note.txt"]);
    const pack = seven.FS.readFile("/pack.7z");

    const result = await unpackArchive("7z", pack);

    expect(result.error).toBeUndefined();
    expect(result.members.map((item) => item.path)).toEqual(["note.txt"]);
    expect(Buffer.from(result.members[0]?.bytes ?? []).toString()).toBe("содержимое файла");
  });

  it("reports a broken container as an error instead of an empty archive", async () => {
    const result = await unpackArchive("rar", new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0xff, 0xff]));
    expect(result.members).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });
});
