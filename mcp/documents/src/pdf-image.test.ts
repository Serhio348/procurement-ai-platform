import { describe, expect, it } from "vitest";
import { unpack1bpp } from "./pdf-image.js";

describe("unpack1bpp", () => {
  it("expands a packed CCITT row so ink bits become black pixels", () => {
    const packed = Uint8Array.of(0b1000_0000);
    const rgba = unpack1bpp(8, 1, packed, true);
    expect([...rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...rgba.slice(4, 8)]).toEqual([0, 0, 0, 255]);
  });
});
