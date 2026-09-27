/**
 * Normalization applied to UNTRUSTED text before the deterministic prompt-injection defenses
 * see it (phase 10, user request 2026-09-27, addressing findings from
 * test/unit/prompt-injection.test.ts): our own tag-neutralization regex
 * (`message-input.ts`) and the spreadsheet keyword detector (`sheets/list-rules.ts`) matched
 * literal ASCII, so an attacker could dodge both with full-width characters
 * (fullwidth "</message_text>"), zero-width characters inserted mid-word ("ignZWSPora"), or
 * extra whitespace inside a tag ("< /message_text>"). This does NOT change what is sent to the
 * model for legitimate content -- it only removes characters that have no legitimate purpose in
 * a WhatsApp price list (zero-width/format marks) and folds compatibility variants (full-width,
 * ligatures) to their plain form, exactly what NFKC is for.
 */

/** Zero-width and bidi-control characters: no legitimate use in a price list, only obfuscation. */
const INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex -- stripping invisible/control marks is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** NFKC (full-width to ASCII, compatibility ligatures to plain) + invisible characters removed. */
export function normalizeUntrusted(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CHARS, "");
}
