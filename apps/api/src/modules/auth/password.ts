import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing (phase 8, ADR-018): Argon2id with Node's built-in `crypto.argon2`
 * (stable since Node 24.19 — no native dependency). Parameters = OWASP Password Storage
 * Cheat Sheet minimum: 19 MiB memory, 2 passes, parallelism 1. Stored as a PHC string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, unpadded base64) so parameters can be
 * raised later: a hash with weaker parameters is re-hashed on the next successful login.
 */

const argon2Async = promisify(argon2);

export interface Argon2Params {
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

export const ARGON2_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

async function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number) {
  return argon2Async("argon2id", {
    message: password,
    nonce: salt,
    parallelism: params.parallelism,
    tagLength,
    memory: params.memory,
    passes: params.passes,
  });
}

/** NFKC so the same passphrase typed on different keyboards/OSes hashes the same (NIST). */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

export async function hashPassword(password: string, params = ARGON2_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(normalizePassword(password), salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  hash: Buffer;
}

export function parsePhc(stored: string): ParsedHash | null {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!match) return null;
  const [, m, t, p, salt, hash] = match;
  return {
    params: { memory: Number(m), passes: Number(t), parallelism: Number(p) },
    salt: Buffer.from(salt as string, "base64"),
    hash: Buffer.from(hash as string, "base64"),
  };
}

function weaker(params: Argon2Params, target: Argon2Params): boolean {
  return (
    params.memory < target.memory ||
    params.passes < target.passes ||
    params.parallelism < target.parallelism
  );
}

/**
 * Constant-time verification. `needsRehash` when the stored parameters are weaker than
 * the current ones (upgrade on the next successful login).
 */
export async function verifyPassword(
  stored: string,
  password: string,
  target = ARGON2_PARAMS,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parsePhc(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const candidate = await derive(
    normalizePassword(password),
    parsed.salt,
    parsed.params,
    parsed.hash.length,
  );
  const ok = candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  return { ok, needsRehash: ok && weaker(parsed.params, target) };
}

/**
 * A precomputed hash of a random value: verifying against it when the email does not exist
 * takes the same time as a real check (no user enumeration by timing).
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(await dummyHash, password);
}
