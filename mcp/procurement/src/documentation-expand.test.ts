import { SourceDocument } from "@procurement/contracts";
import { describe, expect, it, vi } from "vitest";
import { expandPublicDocumentation } from "./documentation-expand.js";

describe("expandPublicDocumentation", () => {
  it("turns a Yandex Disk folder link into downloadable files", async () => {
    const listed = SourceDocument.parse({
      name: "Документация",
      sourceUrl: "https://disk.yandex.ru/d/pack",
      downloadUrl: "https://disk.yandex.ru/d/pack",
      mimeType: "application/octet-stream",
      discoveredAt: "2026-09-14T00:00:00.000Z",
    });
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("public/resources") && !href.includes("download")) {
        return new Response(
          JSON.stringify({
            type: "dir",
            _embedded: {
              items: [
                {
                  type: "file",
                  name: "ТЗ.docx",
                  file: "https://downloader.disk.yandex.ru/disk/tz",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const documents = await expandPublicDocumentation([listed], fetchImpl, () => listed.discoveredAt);

    expect(documents).toEqual([
      expect.objectContaining({
        name: "ТЗ.docx",
        downloadUrl: "https://downloader.disk.yandex.ru/disk/tz",
      }),
    ]);
  });
});
