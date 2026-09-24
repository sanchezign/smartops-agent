import { signWhatsAppBody } from "../../src/modules/whatsapp/whatsapp-signature.js";

/**
 * Sends a webhook exactly like Meta: JSON body + X-Hub-Signature-256 computed over
 * the exact bytes sent, with the App Secret.
 */
export async function postSignedWebhook(
  url: string,
  payload: unknown,
  appSecret: string,
  options: { timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "facebookexternalua (smartops simulator)",
      "X-Hub-Signature-256": signWhatsAppBody(body, appSecret),
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  return { status: response.status, body: await response.text() };
}
