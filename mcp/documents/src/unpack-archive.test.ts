import { describe, expect, it } from "vitest";
import { unpackZipArchive } from "./unpack-archive.js";
import { unzipEntries, zipEntries } from "./zip-entries.js";

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
});
