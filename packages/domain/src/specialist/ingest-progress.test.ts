import { SpecialistCaseDocument } from "@procurement/contracts";
import { describe, expect, it } from "vitest";
import {
  ingestFileFinishState,
  ingestOverallPercent,
  isIngestRunning,
  specialistDocumentWasRead,
} from "./ingest-progress.js";

describe("ingest progress", () => {
  it("weights download below indexing and treats finished files as 100%", () => {
    expect(
      ingestOverallPercent([
        { state: "read", percent: 100 },
        { state: "indexing", percent: 0 },
      ]),
    ).toBe(60);
    expect(ingestOverallPercent([{ state: "downloading", percent: 10 }])).toBe(10);
    expect(ingestOverallPercent([])).toBe(0);
  });

  it("treats listing/download/index as still running after the specialist leaves the card", () => {
    expect(isIngestRunning("listing")).toBe(true);
    expect(isIngestRunning("downloading")).toBe(true);
    expect(isIngestRunning("indexing")).toBe(true);
    expect(isIngestRunning("done")).toBe(false);
    expect(isIngestRunning("failed")).toBe(false);
    expect(isIngestRunning("idle")).toBe(false);
  });

  it("marks only extracted text as read by the agent", () => {
    const read = SpecialistCaseDocument.parse({
      name: "договор.doc",
      sourceUrl: "https://example.test/files/1",
      hash: "a".repeat(64),
      status: "hashed",
      extraction: {
        status: "extracted",
        kind: "office_text",
        pageCount: 1,
        letterCount: 20,
        confidence: 0.8,
        ocrApplied: false,
        textPreview: "аванс",
        pages: [],
      },
    });
    const skipped = SpecialistCaseDocument.parse({
      name: "альбом.pdf",
      sourceUrl: "https://example.test/files/2",
      hash: "b".repeat(64),
      status: "hashed",
      extraction: {
        status: "skipped_project",
        kind: "skipped_project",
        pageCount: 10,
        letterCount: 0,
        confidence: 1,
        ocrApplied: false,
        textPreview: "",
        pages: [],
      },
    });
    expect(specialistDocumentWasRead(read)).toBe(true);
    expect(specialistDocumentWasRead(skipped)).toBe(false);
    expect(ingestFileFinishState(read)).toBe("read");
    expect(ingestFileFinishState(skipped)).toBe("skipped");
  });
});
