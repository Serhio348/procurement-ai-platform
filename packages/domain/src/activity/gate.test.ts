import { describe, expect, it } from "vitest";
import { mayEnqueueDocumentJobs } from "./gate.js";

describe("document job gate", () => {
  it("allows document jobs only for a confirmed active procedure", () => {
    expect(mayEnqueueDocumentJobs("active")).toBe(true);
  });

  it("does not enqueue documents for a closed procedure", () => {
    expect(mayEnqueueDocumentJobs("inactive")).toBe(false);
  });

  it("escalates an unknown status to a human instead of treating it as active", () => {
    expect(mayEnqueueDocumentJobs("needs_human")).toBe(false);
  });
});
