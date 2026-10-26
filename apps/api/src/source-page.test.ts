import { describe, expect, it } from "vitest";
import { renderSourcePageSnapshot } from "./source-page.js";

const ORIGIN = "https://zakupki.butb.by";

describe("renderSourcePageSnapshot", () => {
  it("injects a <base> so relative links resolve on the source origin", () => {
    const page = renderSourcePageSnapshot(
      `<html><head><title>Карточка</title></head><body>` +
        `<a href="/auctions/download?id=1&name=X/f.pdf">f.pdf</a>` +
        `<link href="/assets/app.css" rel="stylesheet">` +
        `</body></html>`,
      ORIGIN,
    );
    expect(page).toContain(`<base href="${ORIGIN}/">`);
    // The download link stays relative — <base> resolves it on the site.
    expect(page).toContain('href="/auctions/download?id=1&name=X/f.pdf"');
  });

  it("strips scripts and inline handlers", () => {
    const page = renderSourcePageSnapshot(
      `<html><head><script src="/js/ice.js"></script></head><body>` +
        `<script>ice.ace.create("x");</script>` +
        `<input onclick="iceSubmit(form,this,event);return false;" onfocus='setFocus(this.id);'>` +
        `</body></html>`,
      ORIGIN,
    );
    expect(page).not.toContain("<script");
    expect(page).not.toContain("ice.ace.create");
    expect(page).not.toContain("onclick");
    expect(page).not.toContain("onfocus");
  });

  it("replaces a document-level <base> instead of adding a second one", () => {
    const page = renderSourcePageSnapshot(
      `<html><head><base href="https://other.example/"></head><body></body></html>`,
      ORIGIN,
    );
    expect(page).toContain(`<base href="${ORIGIN}/">`);
    expect(page).not.toContain("other.example");
  });

  it("prepends a base when the fragment has no <head>", () => {
    const page = renderSourcePageSnapshot(`<div>row</div>`, ORIGIN);
    expect(page.startsWith(`<base href="${ORIGIN}/">`)).toBe(true);
  });
});
