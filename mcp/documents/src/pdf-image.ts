import { createCanvas } from "@napi-rs/canvas";

export const IMAGE_KIND = {
  GRAYSCALE_1BPP: 1,
  RGB_24BPP: 2,
  RGBA_32BPP: 3,
} as const;

export interface PdfDecodedImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

const MAX_EDGE = 1600;

/**
 * Unpack a pdf.js image object into a PNG. Scanned goszakupki drawings are
 * typically CCITT 1-bit; we invert so ink is dark, matching Tesseract's bias.
 */
export function decodedImageToPng(image: PdfDecodedImage): Uint8Array {
  const rgba = toRgba(image);
  const src = createCanvas(image.width, image.height);
  const context = src.getContext("2d");
  const imageData = context.createImageData(image.width, image.height);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) {
    return src.toBuffer("image/png");
  }
  const dst = createCanvas(width, height);
  dst.getContext("2d").drawImage(src, 0, 0, width, height);
  return dst.toBuffer("image/png");
}

export function unpack1bpp(
  width: number,
  height: number,
  packed: Uint8Array | Uint8ClampedArray,
  invert = true,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = packed[y * rowBytes + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      const ink = invert ? bit === 0 : bit === 1;
      const value = ink ? 0 : 255;
      const i = (y * width + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function toRgba(image: PdfDecodedImage): Uint8ClampedArray {
  if (image.kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    return unpack1bpp(image.width, image.height, image.data, true);
  }
  if (image.kind === IMAGE_KIND.RGBA_32BPP) {
    return image.data instanceof Uint8ClampedArray
      ? image.data
      : new Uint8ClampedArray(image.data);
  }
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  if (image.kind === IMAGE_KIND.RGB_24BPP) {
    for (let i = 0, o = 0; o < rgba.length; i += 3, o += 4) {
      rgba[o] = image.data[i] ?? 0;
      rgba[o + 1] = image.data[i + 1] ?? 0;
      rgba[o + 2] = image.data[i + 2] ?? 0;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  return unpack1bpp(image.width, image.height, image.data, true);
}
