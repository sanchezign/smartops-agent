/**
 * Minimal byte samples for media tests (generated in code: no binary fixtures in git).
 * They only need valid magic bytes; they are not complete, openable files.
 */

const bytes = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
  );

export const SAMPLES = {
  pdf: bytes("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0], "\0\x10JFIF\0", [0xff, 0xd9]),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "\0\0\0\rIHDR"),
  webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "),
  ogg: bytes("OggS", [0, 2], "\0\0\0\0\0\0\0\0OpusHead"),
  mp3: bytes("ID3", [3, 0, 0, 0, 0, 0, 0]),
  m4a: bytes([0, 0, 0, 0x20], "ftypM4A ", [0, 0, 0, 0]),
  amr: bytes("#!AMR\n", [0x3c]),
  xlsx: bytes([0x50, 0x4b, 0x03, 0x04], "\x14\0\0\0[Content_Types].xml"),
  xls: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "\0\0\0\0"),
  csv: bytes("producto,precio,moneda\ntornillo 6mm,12,UYU\n"),
  /** Windows executable ("MZ") — never allowed, whatever mime it claims. */
  exe: bytes("MZ", [0x90, 0, 3, 0, 0, 0], "This program cannot be run in DOS mode"),
};
