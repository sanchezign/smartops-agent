import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../common/logger.js";
import { signWhatsAppBody } from "../whatsapp/whatsapp-signature.js";
import type { DemoContent, DemoSampleKind } from "./content/types.js";
import type { DemoMediaStore } from "./demo-graph.js";
import { buildInboundMessage, type SimBusiness, type SimMessage } from "./wa-payloads.js";

/**
 * "Probar el sistema" (phase 9 M8, ADR-021): each button builds a message exactly like Meta
 * would send it and POSTs it SIGNED to our own webhook — the real pipeline from there on
 * (signature check, outbox, worker, media download from the demo Graph API, transcription,
 * n8n, extraction with recorded outputs, catalog, reviews), live in the panel.
 */

export { DEMO_SAMPLE_KINDS, type DemoSampleKind } from "./content/types.js";

export function createDemoInjector(options: {
  assetsDir: string;
  /** The demo content: which files each button sends, and from whom (ADR-031). */
  content: DemoContent;
  store: DemoMediaStore;
  business: SimBusiness;
  webhook: { url: string; appSecret: string };
  logger: Logger;
}) {
  const cache = new Map<string, Uint8Array>();
  const asset = (file: string) => {
    let bytes = cache.get(file);
    if (!bytes) {
      bytes = new Uint8Array(
        readFileSync(join(options.assetsDir, "assets", options.content.assetsSubdir, file)),
      );
      cache.set(file, bytes);
    }
    return bytes;
  };

  return {
    async inject(kind: DemoSampleKind): Promise<{ wamid: string }> {
      const sample = options.content.samples[kind];
      const sender = options.content.sampleSenders[sample.sender];
      let message: SimMessage;
      if (sample.type === "text") {
        message = { type: "text", body: new TextDecoder().decode(asset(sample.file)).trim() };
      } else {
        const bytes = asset(sample.file);
        const mimeType = sample.mimeType!;
        const id = options.store.put({ bytes, mimeType, filename: sample.filename ?? null });
        message = {
          type: sample.type,
          media: {
            id,
            mimeType,
            // The WEBHOOK carries base64 (the media API returns hex), like real Meta.
            sha256: createHash("sha256").update(bytes).digest("base64"),
            filename: sample.filename ?? null,
            ...(sample.voice ? { voice: true } : {}),
          },
        };
      }
      const { wamid, payload } = buildInboundMessage(
        options.business,
        { waId: sender.waId, bsuid: null, name: sender.contactName },
        message,
      );
      const raw = JSON.stringify(payload);
      const res = await fetch(options.webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signWhatsAppBody(raw, options.webhook.appSecret),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`demo webhook answered ${res.status}`);
      options.logger.info({ kind }, "demo sample injected");
      return { wamid };
    },
  };
}
export type DemoInjector = ReturnType<typeof createDemoInjector>;
