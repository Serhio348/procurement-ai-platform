import { deflateRawSync, inflateRawSync } from "node:zlib";

export function unzipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const fromCentral = unzipFromCentralDirectory(bytes);
  if (fromCentral !== undefined) return fromCentral;
  return unzipFromLocalHeaders(bytes);
}

/**
 * Central directory carries sizes even when local headers use a data
 * descriptor (flag 0x08). Windows-made contest zips almost always do that.
 */
function unzipFromCentralDirectory(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocdOffset(view, bytes.length);
  if (eocd === undefined) return undefined;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return undefined;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeZipName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    offset += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x01) !== 0 || compressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
      continue;
    }
    const inflated = inflateZipMember(bytes, view, localOffset, compressedSize, method, flags);
    if (inflated !== undefined && !name.endsWith("/")) {
      files.set(name.replaceAll("\\", "/"), inflated);
    }
  }
  return files;
}

function unzipFromLocalHeaders(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const magic = view.getUint32(offset, true);
    if (magic === 0x02014b50 || magic === 0x06054b50) break;
    if (magic !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + nameLength), flags);
    const dataStart = nameStart + nameLength + extraLength;
    if ((flags & 0x08) !== 0 || (flags & 0x01) !== 0) {
      break;
    }
    const inflated = inflateZipPayload(
      bytes.subarray(dataStart, dataStart + compressedSize),
      method,
    );
    if (inflated !== undefined && !name.endsWith("/")) {
      files.set(name.replaceAll("\\", "/"), inflated);
    }
    offset = dataStart + compressedSize;
  }
  return files;
}

function inflateZipMember(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  compressedSize: number,
  method: number,
  flags: number,
): Uint8Array | undefined {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
    return undefined;
  }
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  void flags;
  return inflateZipPayload(bytes.subarray(dataStart, dataStart + compressedSize), method);
}

function inflateZipPayload(compressed: Uint8Array, method: number): Uint8Array | undefined {
  if (method === 0) return compressed.slice();
  if (method !== 8) return undefined;
  try {
    return new Uint8Array(inflateRawSync(Buffer.from(compressed)));
  } catch {
    return undefined;
  }
}

function findEocdOffset(view: DataView, length: number): number | undefined {
  const min = Math.max(0, length - 22 - 65_535);
  for (let index = length - 22; index >= min; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) return index;
  }
  return undefined;
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  void flags;
  return decoder.decode(bytes);
}

export function zipEntries(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const raw = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([localBlob, centralBlob, eocd]));
}

const decoder = new TextDecoder("utf-8");

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}
