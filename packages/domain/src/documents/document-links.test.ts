import { describe, expect, it } from "vitest";
import {
  extractUrlsFromText,
  isDocumentationShareLink,
  isLinkedDocumentSourceUrl,
  linkedDocumentDisplayName,
  linkedDocumentName,
  linkedDocumentSourceUrl,
  MAX_DOCUMENT_LINKS_PER_FILE,
  normalizeLinkUrl,
  selectDocumentLinkCandidates,
} from "./document-links.js";

describe("extractUrlsFromText", () => {
  it("pulls urls and strips trailing sentence punctuation", () => {
    const urls = extractUrlsFromText(
      "Документация: https://cloud.beloil.by/s/AbC12. Также https://x.by/tz.pdf, и (https://a.by/p.zip)",
    );
    expect(urls).toEqual([
      "https://cloud.beloil.by/s/AbC12",
      "https://x.by/tz.pdf",
      "https://a.by/p.zip",
    ]);
  });
});

describe("isDocumentationShareLink", () => {
  it("recognises nextcloud-style /s/ shares on any host", () => {
    expect(isDocumentationShareLink(new URL("https://cloud.beloil.by/s/STkDLdaRzEGropD"))).toBe(true);
    expect(isDocumentationShareLink(new URL("https://cloud.example.by/index.php/s/abc123"))).toBe(true);
    expect(isDocumentationShareLink(new URL("https://drive.google.com/file/d/xyz"))).toBe(true);
    expect(isDocumentationShareLink(new URL("https://www.goszakupki.by/request/view/1"))).toBe(false);
    expect(isDocumentationShareLink(new URL("https://example.by/about"))).toBe(false);
  });
});

describe("selectDocumentLinkCandidates", () => {
  it("accepts embedded hyperlinks to public hosts", () => {
    const { accepted, rejected } = selectDocumentLinkCandidates([
      { url: "https://cloud.beloil.by/s/STkDLdaRzEGropD", embedded: true },
    ]);
    expect(accepted).toEqual(["https://cloud.beloil.by/s/STkDLdaRzEGropD"]);
    expect(rejected).toEqual([]);
  });

  it("requires a document hint for plain-text urls", () => {
    const { accepted, rejected } = selectDocumentLinkCandidates([
      { url: "https://example.by/docs/pack.zip", embedded: false },
      { url: "https://example.by/news/article", embedded: false },
    ]);
    expect(accepted).toEqual(["https://example.by/docs/pack.zip"]);
    expect(rejected).toEqual([
      { url: "https://example.by/news/article", reason: "not_documentation" },
    ]);
  });

  it("rejects internal hosts even from embedded hyperlinks", () => {
    const { rejected } = selectDocumentLinkCandidates([
      { url: "http://192.168.0.5/docs/tz.docx", embedded: true },
      { url: "http://127.0.0.1/a.pdf", embedded: true },
      { url: "ftp://files.by/tz.zip", embedded: true },
    ]);
    expect(rejected.map((item) => item.reason)).toEqual([
      "blocked_host",
      "blocked_host",
      "unsupported_scheme",
    ]);
  });

  it("rejects platform card pages but accepts get-file downloads", () => {
    const { accepted, rejected } = selectDocumentLinkCandidates([
      { url: "https://goszakupki.by/request/view/3677151", embedded: true },
      { url: "https://goszakupki.by/request/get-file/3677151?f=9&download=1", embedded: true },
    ]);
    expect(accepted).toEqual(["https://goszakupki.by/request/get-file/3677151?f=9&download=1"]);
    expect(rejected).toEqual([
      { url: "https://goszakupki.by/request/view/3677151", reason: "platform_page" },
    ]);
  });

  it("dedupes and caps the accepted set", () => {
    const { accepted } = selectDocumentLinkCandidates(
      Array.from({ length: MAX_DOCUMENT_LINKS_PER_FILE + 3 }, (_, index) => ({
        url: `https://files.by/pack${index}.zip`,
        embedded: true,
      })),
    );
    expect(accepted).toHaveLength(MAX_DOCUMENT_LINKS_PER_FILE);

    const { rejected } = selectDocumentLinkCandidates([
      { url: "https://files.by/pack0.zip", embedded: true },
      { url: "https://files.by/pack0.zip", embedded: true },
      { url: "https://FILES.by/pack0.zip", embedded: true },
    ]);
    expect(rejected.map((item) => item.reason)).toEqual(["duplicate", "duplicate"]);
  });

  it("excludes links already listed for the job", () => {
    const { rejected } = selectDocumentLinkCandidates(
      [{ url: "https://files.by/tz.pdf", embedded: true }],
      { excludeUrls: new Set(["https://files.by/tz.pdf"]) },
    );
    expect(rejected).toEqual([{ url: "https://files.by/tz.pdf", reason: "self" }]);
  });
});

describe("linked document provenance", () => {
  it("appends a link fragment to a plain parent url", () => {
    const source = linkedDocumentSourceUrl(
      "https://goszakupki.by/request/get-file/1?f=8",
      "https://cloud.beloil.by/s/tok",
    );
    expect(isLinkedDocumentSourceUrl(source)).toBe(true);
    expect(source).toContain("#link/");
    expect(decodeURIComponent(source.split("#link/")[1] ?? "")).toBe("https://cloud.beloil.by/s/tok");
  });

  it("chains onto an archive-member fragment preserving both", () => {
    const parent = "https://goszakupki.by/get-file/1?f=1#member/pack%2Flink.docx";
    const source = linkedDocumentSourceUrl(parent, "https://files.by/tz.pdf");
    expect(source).toContain("#member/pack%2Flink.docx/link/");
    expect(isLinkedDocumentSourceUrl(source)).toBe(true);
  });

  it("derives a readable name and display name", () => {
    expect(linkedDocumentName("https://files.by/docs/%D0%A2%D0%97.pdf")).toBe("ТЗ.pdf");
    expect(linkedDocumentName("https://cloud.beloil.by/s/tok")).toBe("tok");
    expect(linkedDocumentDisplayName("link.docx", "https://files.by/tz.pdf")).toBe(
      "tz.pdf — ссылка из «link.docx»",
    );
  });
});

describe("normalizeLinkUrl", () => {
  it("normalizes equivalent urls to one dedup key", () => {
    expect(normalizeLinkUrl("https://Files.by/a.pdf#")).toBe(normalizeLinkUrl("https://files.by/a.pdf"));
    expect(normalizeLinkUrl("not a url")).toBeUndefined();
  });
});
