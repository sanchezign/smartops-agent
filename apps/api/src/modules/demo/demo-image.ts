import { crc32, deflateSync } from "node:zlib";

/**
 * A small, valid PNG drawn in code for the demo chat (phase 9 M3): a paper-like sheet with
 * "rows" of a price list. No binary asset in the repo, deterministic bytes.
 */
export function demoListPng(width = 360, height = 480): Uint8Array<ArrayBuffer> {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const inHeader = y >= 24 && y < 56 && x >= 24 && x < width - 24;
      const line = y >= 80 && (y - 80) % 36 < 14 && x >= 24;
      const nameCell = line && x < width * 0.62;
      const priceCell = line && x >= width * 0.72 && x < width - 24;
      const [r, g, b] = inHeader
        ? [30, 64, 120]
        : nameCell
          ? [200, 204, 210]
          : priceCell
            ? [90, 150, 110]
            : [250, 248, 242];
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(
    png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
  );
}
