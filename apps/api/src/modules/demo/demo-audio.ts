/**
 * A small, valid Ogg/Opus voice note generated in code for the demo (phase 9 M8): 5 s of
 * silence at 48 kHz, mono — the same container WhatsApp uses for voice notes. No binary asset
 * in the repo, deterministic bytes (so its SHA-256 keys the demo transcript). Players show a
 * 0:05 silent clip; the demo's fake transcriber returns the recorded transcript.
 */

const SAMPLE_RATE = 48_000;
const PRE_SKIP = 312;
const FRAME_SAMPLES = 960; // 20 ms
/** A silent 20 ms CELT fullband mono frame (TOC 0xF8 + 2 bytes). */
const SILENT_FRAME = [0xf8, 0xff, 0xfe];
const PACKETS_PER_PAGE = 50;
const SERIAL = 0x534d4f50; // "SMOP"

let crcTable: Uint32Array | null = null;
/** Ogg CRC-32: polynomial 0x04C11DB7, not reflected, init 0, no final xor. */
function oggCrc(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let r = i << 24;
      for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

function page(
  packets: Uint8Array[],
  options: { granule: bigint; seq: number; flags: number },
): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  out[4] = 0; // version
  out[5] = options.flags;
  view.setBigUint64(6, options.granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, options.seq, true);
  view.setUint32(22, 0, true); // checksum placeholder
  out[26] = lacing.length;
  out.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, offset);
    offset += p.length;
  }
  view.setUint32(22, oggCrc(out), true);
  return out;
}

export function demoVoiceNoteOgg(seconds = 5): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  const hv = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = 1; // channels
  hv.setUint16(10, PRE_SKIP, true);
  hv.setUint32(12, SAMPLE_RATE, true);
  hv.setInt16(16, 0, true); // output gain
  head[18] = 0; // mapping family

  const vendor = new TextEncoder().encode("smartops-demo");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  // user comment list length = 0 (already zero)

  const pages: Uint8Array[] = [
    page([head], { granule: 0n, seq: 0, flags: 0x02 }),
    page([tags], { granule: 0n, seq: 1, flags: 0 }),
  ];
  const total = Math.round((seconds * SAMPLE_RATE) / FRAME_SAMPLES);
  const frame = new Uint8Array(SILENT_FRAME);
  for (let done = 0, seq = 2; done < total; seq += 1) {
    const count = Math.min(PACKETS_PER_PAGE, total - done);
    done += count;
    pages.push(
      page(
        Array.from({ length: count }, () => frame),
        {
          granule: BigInt(PRE_SKIP + done * FRAME_SAMPLES),
          seq,
          flags: done === total ? 0x04 : 0,
        },
      ),
    );
  }
  const size = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
