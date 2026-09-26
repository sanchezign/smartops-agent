/**
 * Regenerates src/modules/auth/common-passwords.ts from SecLists (MIT License).
 * Keeps only entries with >= 15 characters (shorter ones already fail the length rule),
 * NFKC + lowercased, stored as SHA-256 (the repo never ships the plain list).
 *
 *   node scripts/auth/build-common-passwords.mjs
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SOURCE =
  "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt";
const MIN_LENGTH = 15;

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const passwords = (await res.text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => [...line].length >= MIN_LENGTH)
  .map((line) => line.normalize("NFKC").toLowerCase());
const hashes = [
  ...new Set(passwords.map((p) => createHash("sha256").update(p).digest("hex"))),
].sort();
const today = new Date().toISOString().slice(0, 10);

writeFileSync(
  new URL("../../src/modules/auth/common-passwords.ts", import.meta.url),
  `/**
 * Common / breached passwords of 15+ characters (shorter ones already fail the length rule),
 * stored as SHA-256 of the NFKC-normalized, lowercased value so the repo does not ship the
 * plain list. Source: SecLists Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt
 * (MIT License, https://github.com/danielmiessler/SecLists), fetched ${today}: ${hashes.length} entries.
 * Regenerate with scripts/auth/build-common-passwords.mjs if the source is updated.
 */
export const COMMON_PASSWORD_SHA256: ReadonlySet<string> = new Set([
${hashes.map((h) => `  "${h}",`).join("\n")}
]);
`,
);
process.stdout.write(`${hashes.length} entries written\n`);
