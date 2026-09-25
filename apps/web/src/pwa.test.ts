import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Tests run with cwd = apps/web.
const fromWeb = (relative: string) => join(process.cwd(), relative);

const readPublic = (name: string) => readFileSync(fromWeb(join("public", name)), "utf8");

describe("pwa shell", () => {
  it("ships an installable manifest with raster icons that exist", () => {
    const manifest = JSON.parse(readPublic("manifest.webmanifest")) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    const icons = manifest.icons ?? [];
    const sizes = new Set(icons.map((icon) => icon.sizes));
    // Chrome requires 192 and 512 raster icons for the install prompt.
    expect(sizes.has("192x192")).toBe(true);
    expect(sizes.has("512x512")).toBe(true);
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      expect(existsSync(fromWeb(join("public", icon.src)))).toBe(true);
    }
  });

  it("links the manifest and touch icons from index.html", () => {
    const html = readFileSync(fromWeb("index.html"), "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("keeps api responses out of the service worker cache", () => {
    const sw = readPublic("sw.js");
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    // navigations fall back to the cached shell only when fetch fails
    expect(sw).toContain('caches.match("/index.html")');
  });
});
