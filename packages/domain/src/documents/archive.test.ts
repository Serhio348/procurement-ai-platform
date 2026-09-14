import { describe, expect, it } from "vitest";
import {
  archiveFitsBudget,
  archiveMemberDisplayName,
  archiveMemberSourceUrl,
  isArchiveMemberSourceUrl,
  isJunkArchivePath,
  MAX_ARCHIVE_MEMBER_BYTES,
} from "./archive.js";

describe("archive members", () => {
  it("builds a fragment URL so a zip member is not confused with the pack", () => {
    const parent = "https://goszakupki.by/auction/get-file/1?f=0&download=1";
    const child = archiveMemberSourceUrl(parent, "docs\\ТЗ.docx");
    expect(isArchiveMemberSourceUrl(child)).toBe(true);
    expect(isArchiveMemberSourceUrl(parent)).toBe(false);
    expect(archiveMemberDisplayName("Комплект.zip", "docs/ТЗ.docx")).toBe("Комплект.zip / docs/ТЗ.docx");
  });

  it("drops macOS junk and empty directory entries", () => {
    expect(isJunkArchivePath("__MACOSX/._tz.docx")).toBe(true);
    expect(isJunkArchivePath(".DS_Store")).toBe(true);
    expect(isJunkArchivePath("docs/")).toBe(true);
    expect(isJunkArchivePath("docs/ТЗ.docx")).toBe(false);
  });

  it("caps a zip bomb before inflate results are kept", () => {
    expect(
      archiveFitsBudget({ memberCount: 0, memberBytes: MAX_ARCHIVE_MEMBER_BYTES + 1, totalBytes: 0 }),
    ).toBe(false);
    expect(archiveFitsBudget({ memberCount: 0, memberBytes: 12, totalBytes: 0 })).toBe(true);
  });
});
