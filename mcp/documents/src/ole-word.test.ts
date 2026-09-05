import { describe, expect, it } from "vitest";
import { RoutingDocumentExtractor } from "./routing-extractor.js";
import { extractOleWord } from "./ole-word.js";

describe("extractOleWord", () => {
  it("reads UTF-16 commercial wording from an old Word container", async () => {
    const quote = "Аванс 30 процентов. Срок поставки 60 календарных дней.";
    const bytes = oleWithUtf16(quote);
    const extracted = extractOleWord("a".repeat(64), bytes);

    expect(extracted.status).toBe("extracted");
    expect(extracted.ocrApplied).toBe(false);
    expect(extracted.text).toContain("Аванс 30");
    expect(extracted.text).toContain("Срок поставки 60");

    const routed = await new RoutingDocumentExtractor().extractText(
      "a".repeat(64),
      bytes,
      "application/msword",
      "proekt-dogovora-tovar.doc",
    );
    expect(routed.text).toContain("Аванс 30 процентов");
  });
});

function oleWithUtf16(text: string): Uint8Array {
  const payload = Buffer.from(`\0\0${text}\0\0`, "utf16le");
  const bytes = new Uint8Array(32 + payload.length);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  bytes.set(payload, 32);
  return bytes;
}
