/**
 * Audio duration without ffmpeg (pure, phase 6 M1). Meta's webhook does not include the
 * duration of audio messages (fields: id, mime_type, sha256, url, voice), so it is read
 * from the file:
 * - OGG/Opus (WhatsApp voice notes): granule position of the LAST page minus the OpusHead
 *   pre-skip, at Opus' fixed 48 kHz.
 * - MP4/M4A: duration / timescale of the movie header box (mvhd).
 * Anything else → null (the caller decides, e.g. by size).
 */

const OPUS_RATE = 48_000;

function lastIndexOf(bytes: Uint8Array, needle: string): number {
  const codes = [...needle].map((c) => c.charCodeAt(0));
  for (let i = bytes.length - codes.length; i >= 0; i -= 1) {
    let ok = true;
    for (let j = 0; j < codes.length; j += 1) {
      if (bytes[i + j] !== codes[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function indexOf(bytes: Uint8Array, needle: string, limit = bytes.length): number {
  const codes = [...needle].map((c) => c.charCodeAt(0));
  const end = Math.min(limit, bytes.length) - codes.length;
  for (let i = 0; i <= end; i += 1) {
    let ok = true;
    for (let j = 0; j < codes.length; j += 1) {
      if (bytes[i + j] !== codes[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function oggOpusDuration(bytes: Uint8Array): number | null {
  const head = indexOf(bytes, "OpusHead", 4096);
  if (head < 0 || head + 12 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const preSkip = view.getUint16(head + 10, true);
  const last = lastIndexOf(bytes, "OggS");
  if (last < 0 || last + 14 > bytes.length) return null;
  const granule = view.getBigInt64(last + 6, true);
  if (granule <= 0n) return null;
  const seconds = (Number(granule) - preSkip) / OPUS_RATE;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function mp4Duration(bytes: Uint8Array): number | null {
  const at = indexOf(bytes, "mvhd");
  if (at < 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[at + 4];
  try {
    if (version === 1) {
      const timescale = view.getUint32(at + 4 + 4 + 16, false);
      const duration = Number(view.getBigUint64(at + 4 + 4 + 20, false));
      return timescale > 0 ? duration / timescale : null;
    }
    const timescale = view.getUint32(at + 4 + 4 + 8, false);
    const duration = view.getUint32(at + 4 + 4 + 12, false);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

export function audioDurationSeconds(bytes: Uint8Array, mimeType: string): number | null {
  const mime = mimeType.toLowerCase();
  if (mime.includes("ogg") || mime.includes("opus")) return oggOpusDuration(bytes);
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac"))
    return mp4Duration(bytes);
  return null;
}

/** Unknown duration: files above this size are treated as long (≈ 3 min of typical audio). */
export const UNKNOWN_DURATION_LONG_BYTES = 3 * 1024 * 1024;
