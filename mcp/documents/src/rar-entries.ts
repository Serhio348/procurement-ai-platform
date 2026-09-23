import { crc32 } from "node:zlib";

/**
 * Builds a minimal RAR4 archive with «stored» (uncompressed) members — the
 * test counterpart of `zipEntries`: RAR compression is proprietary, so a
 * stored-entry container is the honest way to fixture a real .rar.
 */
export function rarEntries(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const chunks: Buffer[] = [
    // Marker block «Rar!\x1A\x07\x00».
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]),
    // MAIN_HEAD: type 0x73, flags 0x0000, body = 6 reserved bytes.
    rarHead(0x73, 0x0000, Buffer.alloc(6)),
  ];
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(25 + nameBytes.length);
    header.writeUInt32LE(data.length, 0); // pack size
    header.writeUInt32LE(data.length, 4); // unpacked size
    header.writeUInt8(0x02, 8); // host OS: Windows
    header.writeUInt32LE(crc32(data), 9); // file crc
    header.writeUInt32LE(0, 13); // MS-DOS timestamp
    header.writeUInt8(0x14, 17); // unpack version 2.0 (stored)
    header.writeUInt8(0x30, 18); // method: store, no compression
    header.writeUInt16LE(nameBytes.length, 19);
    header.writeUInt32LE(0x20, 21); // attribute: archive
    nameBytes.copy(header, 25);
    // 0x8000 in HEAD_FLAGS marks that file data follows the header.
    chunks.push(rarHead(0x74, 0x8000, header));
    chunks.push(data);
  }
  // ENDARC_HEAD.
  chunks.push(rarHead(0x7b, 0x0000, Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

function rarHead(type: number, flags: number, body: Buffer): Buffer {
  const header = Buffer.alloc(7 + body.length);
  header.writeUInt8(type, 2);
  header.writeUInt16LE(flags, 3);
  header.writeUInt16LE(7 + body.length, 5);
  body.copy(header, 7);
  // HEAD_CRC is the lower 16 bits of CRC32 over HEAD_TYPE..end of header.
  header.writeUInt16LE(crc32(header.subarray(2)) & 0xffff, 0);
  return header;
}
