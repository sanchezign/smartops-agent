/**
 * Anonymizes real WhatsApp webhook payloads into test fixtures (pure, unit tested).
 * Every identifier is replaced by a deterministic fake shared across the whole batch
 * (a status keeps pointing at the same fake wamid, a contact keeps the same fake phone):
 *   contact phones → 59899000111, 59899000222, …   business display phone → 15550000000
 *   phone_number_id → 100000000000001               WABA id (entry.id) → 200000000000002
 *   BSUIDs → <CC>.1000000000000001, …               wamids → wamid.ANON_<label>_0001, …
 *   media ids → 9000000000000001, …                 profile names → Test Supplier, …
 *   media URLs → lookaside URL with fake mid and hash=ANONYMIZED
 * Message bodies, captions, filenames, mime types, sha256 and timestamps are kept (the
 * user sends fictitious test content). Finally every original identifier is searched
 * in the output; any leftover throws.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const PHONE_KEYS = new Set(["wa_id", "from", "recipient_id"]);
const USER_ID_KEYS = new Set([
  "user_id",
  "from_user_id",
  "recipient_user_id",
  "parent_user_id",
  "from_parent_user_id",
  "recipient_parent_user_id",
]);
const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

export interface AnonymizedFixture {
  name: string;
  payload: Json;
}

export function createAnonymizer() {
  const maps = {
    phone: new Map<string, string>(),
    userId: new Map<string, string>(),
    wamid: new Map<string, string>(),
    mediaId: new Map<string, string>(),
    name: new Map<string, string>(),
  };
  const originals = new Set<string>();
  const fakeNames = ["Test Supplier", "Test Customer", "Test Staff", "Test Contact"];

  function map(kind: keyof typeof maps, value: string, make: (index: number) => string): string {
    originals.add(value);
    const existing = maps[kind].get(value);
    if (existing) return existing;
    const fake = make(maps[kind].size + 1);
    maps[kind].set(value, fake);
    return fake;
  }

  const phone = (v: string) => map("phone", v, (i) => `59899000${String(i).repeat(3).slice(0, 3)}`);
  const userId = (v: string) =>
    map("userId", v, (i) => `${v.split(".")[0] ?? "UY"}.${String(1_000_000_000_000_000 + i)}`);
  const mediaId = (v: string) => map("mediaId", v, (i) => String(9_000_000_000_000_000 + i));
  const name = (v: string) => map("name", v, (i) => fakeNames[i - 1] ?? `Test Contact ${i}`);

  function wamid(v: string, label: string): string {
    return map(
      "wamid",
      v,
      (i) => `wamid.ANON_${label.toUpperCase()}_${String(i).padStart(4, "0")}`,
    );
  }

  function mediaUrl(url: string, fakeMediaId: string): string {
    const parsed = new URL(url);
    const mid = parsed.searchParams.get("mid");
    if (mid) originals.add(mid);
    const hash = parsed.searchParams.get("hash");
    if (hash) originals.add(hash);
    parsed.searchParams.set("mid", fakeMediaId);
    if (hash) parsed.searchParams.set("hash", "ANONYMIZED");
    return parsed.toString();
  }

  function walk(node: Json, key: string | null, parentKey: string | null, label: string): Json {
    if (Array.isArray(node)) return node.map((item) => walk(item, key, parentKey, label));
    if (node && typeof node === "object") {
      const out: { [k: string]: Json } = {};
      // Media objects: map the id first so the URL can reuse the fake id.
      let fakeMedia: string | null = null;
      if (key !== null && MEDIA_TYPES.has(key) && typeof node.id === "string") {
        fakeMedia = mediaId(node.id);
      }
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string") {
          if (PHONE_KEYS.has(k)) out[k] = phone(v);
          else if (USER_ID_KEYS.has(k)) out[k] = userId(v);
          else if (k === "display_phone_number") {
            originals.add(v);
            out[k] = "15550000000";
          } else if (k === "phone_number_id") {
            originals.add(v);
            out[k] = "100000000000001";
          } else if (k === "id" && fakeMedia) out[k] = fakeMedia;
          else if (k === "id" && (key === "messages" || key === "statuses" || key === "context")) {
            out[k] = wamid(v, label);
          } else if (k === "id" && key === "entry") {
            originals.add(v);
            out[k] = v === "0" ? v : "200000000000002";
          } else if (k === "url" && fakeMedia) out[k] = mediaUrl(v, fakeMedia);
          else if (k === "name" && key === "profile") out[k] = name(v);
          else if (k === "username" && key === "profile") {
            originals.add(v);
            out[k] = "test.username";
          } else out[k] = v;
        } else {
          out[k] = walk(v, k, key, label);
        }
      }
      return out;
    }
    return node;
  }

  return {
    anonymize(name: string, payload: Json): AnonymizedFixture {
      const label = name.replace(/^(message|status)-/, "").replace(/[^a-z0-9]+/gi, "_");
      return { name, payload: walk(payload, null, null, label) };
    },

    /** Throws if any original identifier survived in any anonymized fixture. */
    assertClean(fixtures: AnonymizedFixture[]): void {
      const text = JSON.stringify(fixtures.map((f) => f.payload));
      const leaks = [...originals].filter((value) => value.length >= 4 && text.includes(value));
      if (leaks.length > 0) {
        throw new Error(`anonymization leaked ${leaks.length} original value(s)`);
      }
    },

    stats() {
      return Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, m.size]));
    },
  };
}
